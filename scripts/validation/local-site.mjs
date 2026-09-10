import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const base = '/ff14-web/';
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gz': 'application/gzip',
};
export async function findAssetRelease(root, explicit) {
  const candidate = explicit || process.env.ASSET_PIPELINE_DIR || 'work/asset-performance/packed-all-final';
  const directory = path.resolve(root, candidate);
  try {
    await fs.access(path.join(directory, 'publish-manifest.json'));
    return directory;
  } catch (error) {
    if (explicit || process.env.ASSET_PIPELINE_DIR) throw new Error(`Asset release not found: ${directory}`);
    return null;
  }
}

export async function prepareLocalSite({ root, out, assetRelease, skipBuild = false }) {
  const active = JSON.parse(await fs.readFile(path.join(root, 'public/extracted/active.json'), 'utf8'));
  let catalogIdentity = JSON.stringify(active);
  if (assetRelease) {
    const published = JSON.parse(await fs.readFile(path.join(assetRelease, 'publish-manifest.json'), 'utf8'));
    const catalog = JSON.parse(await fs.readFile(path.join(assetRelease, published.entry), 'utf8'));
    const missing = Object.keys(active.scenes).filter(id => !catalog.maps[id]);
    if (missing.length) throw new Error(`Asset release omits active maps: ${missing.join(', ')}`);
    active.assetPipeline = { manifest: `../assets/world/${published.entry}`, base: '../assets/world/' };
    catalogIdentity = published.entry;
  } else {
    delete active.assetPipeline;
  }
  if (!skipBuild) {
    // Compile current source only. Existing immutable resources are served in
    // place, not recopied by the production release plugin.
    await build({
      root, configFile: false, publicDir: false, base, logLevel: 'error',
      build: {
        outDir: out, emptyOutDir: true, target: 'es2022',
        rollupOptions: { output: { manualChunks: { three: ['three'], icons: ['lucide'] } } },
      },
    });
  }
  await fs.access(path.join(out, 'index.html'));
  await fs.mkdir(path.join(out, 'extracted'), { recursive: true });
  await fs.writeFile(path.join(out, 'extracted/active.json'), JSON.stringify(active));
  return { active, catalogIdentity };
}

function safeFile(root, relative) {
  const file = path.resolve(root, relative);
  const inside = path.relative(root, file);
  return inside.startsWith('..') || path.isAbsolute(inside) ? null : file;
}

export async function serveLocalSite({ root, out, assetRelease }) {
  const server = http.createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405); response.end(); return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === base.slice(0, -1)) {
        response.writeHead(308, { Location: `${base}${url.search}` }); response.end(); return;
      }
      if (!url.pathname.startsWith(base)) { response.writeHead(404); response.end(); return; }
      const relative = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
      const candidates = [
        safeFile(out, relative),
        ...(assetRelease && relative.startsWith('assets/world/')
          ? [safeFile(assetRelease, relative.slice('assets/world/'.length))] : []),
        safeFile(path.join(root, 'public'), relative),
      ].filter(Boolean);
      let file, stat;
      for (const candidate of candidates) {
        try {
          const found = await fs.stat(candidate);
          if (found.isFile()) { file = candidate; stat = found; break; }
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
      }
      if (!file) { response.writeHead(404); response.end(); return; }
      const compressedJson = file.endsWith('.json.gz');
      const headers = {
        'Content-Type': compressedJson ? 'application/json' : mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': file.endsWith('active.json') ? 'no-store' : 'public, max-age=3600',
        'Content-Length': stat.size, 'Accept-Ranges': 'bytes',
        ...(compressedJson ? { 'Content-Encoding': 'gzip' } : {}),
      };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      let start = 0, end = stat.size - 1;
      if (range && !compressedJson) {
        start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || start >= stat.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
        headers['Content-Length'] = end - start + 1;
      }
      response.writeHead(range && !compressedJson ? 206 : 200, headers);
      if (request.method === 'HEAD') response.end();
      else createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}${base}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
