// Serves the committed site/ build using Node alone; npm install is unnecessary.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const root = path.resolve(project, option('dir', 'site'));
const port = Number(option('port', process.env.PORT || '8080'));
const host = option('host', process.env.HOST || '0.0.0.0');
const baseValue = option('base', process.env.BASE_PATH || '/');
const prefix = baseValue.split('/').filter(Boolean).join('/');
const base = prefix ? `/${prefix}/` : '/';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.gz': 'application/gzip',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
};
const contentHash = /[a-f0-9]{64}/;
const etagFor = info => `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
const parseRange = (value, size) => {
  if (!value || !value.startsWith('bytes=') || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !size) return false;
  const [, startValue, endValue] = match;
  if (!startValue && !endValue) return false;
  if (!startValue) {
    const suffix = Number(endValue);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(startValue);
  const requestedEnd = endValue ? Number(endValue) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) return false;
  return { start, end: Math.min(requestedEnd, size - 1) };
};
await stat(path.join(root, 'index.html')).catch(() => {
  throw new Error(`No built site at ${root}. Restore site/ from Git or run npm ci && npm run release.`);
});
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (base !== '/' && pathname === base.slice(0, -1)) {
      res.writeHead(308, { Location: `${base}${url.search}` }); res.end(); return;
    }
    if (!pathname.startsWith(base)) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(root, pathname.slice(base.length) || 'index.html');
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404); res.end(); return; }
    const etag = etagFor(info);
    const immutable = path.extname(file) === '.aethpak' && contentHash.test(path.basename(file));
    const compressedJson = file.endsWith('.json.gz');
    const headers = {
      'Content-Type': compressedJson ? types['.json'] : types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : /\.(html|json)$/.test(file) ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'ETag': etag,
      'Accept-Ranges': 'bytes',
      ...(compressedJson ? { 'Content-Encoding': 'gzip' } : {}),
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    const requestedRange = parseRange(req.headers.range, info.size);
    const allowRange = requestedRange && (!req.headers['if-range'] || req.headers['if-range'] === etag);
    if (requestedRange === false) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }); res.end(); return;
    }
    if (allowRange) {
      const { start, end } = requestedRange;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400); res.end();
  }
});
server.listen(port, host, () => console.log(`Aetheryte: http://${host}:${port}${base}`));
