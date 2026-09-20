import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(fileURLToPath(import.meta.url));
const appBase = '/ff14-web/';
const assetPrefix = '/__ff14_preview_assets__/';
const sandboxPrefix = '/__ff14_preview_sandbox__/';
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const defaultMapId = 'e3t1';
const world = path.resolve(repo, process.env.BABYLON_ASSET_DIR || process.env.ASSET_PIPELINE_DIR || 'work/asset-performance/packed-all-final');
const worldPublish = (() => {
  try { return readJson(path.join(world, 'publish-manifest.json')); } catch { return null; }
})();
const catalogEntry = process.env.BABYLON_CATALOG_ENTRY || worldPublish?.entry || 'catalog_5e743913257385546b7b52c79e80f26ade94a6dfdd98f5a8d3b5f5a59f3baf99.json';
const worldCatalog = worldPublish ? readJson(path.join(world, catalogEntry)) : null;
const mapManifest = 'maps/e3t1/manifest_ab686a714791aad26083e35fe8348e409998a6b3c1d970342f9286f9bd0d33b4.json.gz';
const activePath = process.env.BABYLON_ACTIVE || 'public/extracted/active.json';
const active = readJson(path.resolve(repo, activePath));
const expectedMaps = process.env.BABYLON_EXPECTED_MAPS ? Number(process.env.BABYLON_EXPECTED_MAPS) : null;
if (expectedMaps !== null && (!Number.isInteger(expectedMaps) || Object.keys(active.scenes || {}).length !== expectedMaps)) {
  throw new Error(`active.json scene count ${Object.keys(active.scenes || {}).length} does not match BABYLON_EXPECTED_MAPS=${expectedMaps}`);
}
if (worldCatalog?.maps) {
  const activeIds = Object.keys(active.scenes || {}).sort();
  const catalogIds = Object.keys(worldCatalog.maps).sort();
  if (activeIds.join(',') !== catalogIds.join(',')) {
    throw new Error(`active.json scene IDs differ from ${catalogEntry}`);
  }
}
const ticketPath = process.env.ASSET_CDN_TICKET || '';
const publishedActive = ticketPath
  ? {
      ...active,
      scenes: Object.fromEntries(Object.entries(active.scenes || {}).map(([id, record]) => [
        id,
        { ...record, base: `${active.runId}/${id}/` },
      ])),
      assetPipeline: { ticket: ticketPath },
    }
  : active;
const profiles = readJson(path.join(repo, 'src/world/environment/source-profiles.json'));
let lightingObjects = {};
try {
  lightingObjects = readJson(path.join(repo, 'src/world/environment/source-lights.json'));
} catch {
  lightingObjects = {};
}
const visualReferencesPath = path.join(repo, 'config/visual-references.json');
const visualReferencesRaw = fs.readFileSync(visualReferencesPath);
const visualReferences = JSON.parse(visualReferencesRaw);
const visualReferencesSha256 = createHash('sha256').update(visualReferencesRaw).digest('hex');
const visualValidatorPath = path.join(repo, 'scripts/validate-visual-references.mjs');
const visualValidatorSha256 = createHash('sha256').update(fs.readFileSync(visualValidatorPath)).digest('hex');
const dutyCatalogPath = path.join(repo, 'config/duties/duty-catalog.json');
const dutyEntrancesPath = path.join(repo, 'config/duties/entrances.json');
const dutyLightsPath = path.join(repo, 'config/duties/duty-lights.json');
const runtimeVisualReferences = {
  ...visualReferences,
  views: visualReferences.views.map(({ referenceProvenance, ...view }) => view),
};
const engineRedirects = new Map([
  ['src/world/index.js', 'preview/babylon/WorldIndex.js'],
  ['src/assets/SandboxAssets.js', 'preview/babylon/SandboxAssets.js'],
  ['src/dev/DeveloperRuntime.js', 'preview/babylon/DeveloperRuntime.js'],
]);

function sourceFingerprint() {
  const hash = createHash('sha256');
  const add = file => {
    hash.update(path.relative(repo, file).replaceAll('\\', '/'));
    hash.update(fs.readFileSync(file));
  };
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else add(file);
    }
  };
  walk(path.join(repo, 'src'));
  walk(path.join(repo, 'preview/babylon'));
  add(path.join(repo, 'package.json'));
  add(path.join(repo, 'vite.babylon.config.js'));
  add(visualValidatorPath);
  add(visualReferencesPath);
  return hash.digest('hex');
}

function createBuildInfo() {
  return {
    engine: 'Babylon.js', engineVersion: '9.26.0', appBase,
    mapCount: Object.keys(active.scenes).length, sourceSha256: sourceFingerprint(), threeModules: 0,
    visualReferences: {
      schemaVersion: visualReferences.schemaVersion,
      manifestSha256: visualReferencesSha256,
      validatorSha256: visualValidatorSha256,
      views: visualReferences.views.length,
      validator: 'scripts/validate-visual-references.mjs',
    },
  };
}

const devBuildInfoText = JSON.stringify(createBuildInfo());
const hasDutyCatalog = fs.existsSync(dutyCatalogPath);
const dutyCatalog = hasDutyCatalog ? readJson(dutyCatalogPath) : { schemaVersion: 1, duties: [], unavailable: true };
const hasDutyEntrances = fs.existsSync(dutyEntrancesPath);
const dutyEntrances = hasDutyEntrances ? readJson(dutyEntrancesPath) : { schemaVersion: 1, entrances: [] };
const hasDutyLights = fs.existsSync(dutyLightsPath);
const dutyLights = hasDutyLights ? readJson(dutyLightsPath) : {};
let resolvedViteConfig;

export default defineConfig(({ command }) => {
  const local = (command === 'serve' && Boolean(process.env.BABYLON_ASSET_DIR)) || Boolean(process.env.BABYLON_QA_STATIC);
  const config = {
    appBasePath: appBase,
    defaultMapId,
    // Scene metadata and profiles are build-time data only. Asset URLs stay
    // catalog-relative to the CDN/ticket base and are never joined to appBase.
    maps: active.scenes,
    profiles,
    lightingObjects,
    assetBaseUrl: 'https://img.yuluo.site/ff14-assets/v1/',
    assetVersion: active.runId, catalogEntry, mapManifest,
    sharedAppBaseUrl: '/ff14-web/',
    sandboxManifestUrl: local ? `${sandboxPrefix}manifest.json` : '/ff14-web/sandbox/manifest.json',
    assetPointer: local
      ? { manifest: `${assetPrefix}${catalogEntry}`, base: assetPrefix }
      : { ticket: ticketPath || '/ff14-assets/ticket', base: 'https://img.yuluo.site/ff14-assets/v1/' },
    profile: profiles[defaultMapId],
    // Runtime needs view/camera policy only. The tracked manifest remains the
    // provenance source of truth and may contain private local capture URLs.
    visualReferences: runtimeVisualReferences,
    duties: dutyCatalog,
    dutyEntrances,
  };
  const configText = JSON.stringify(config);
  function configureDataServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url, 'http://preview.invalid');
      if (url.pathname === `${appBase}app-config.json` || url.pathname === '/app-config.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(configText);
        return;
      }
      if (url.pathname === `${appBase}extracted/active.json`) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(publishedActive));
        return;
      }
      if (url.pathname === `${appBase}build-info.json` || url.pathname === '/build-info.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(devBuildInfoText);
        return;
      }
      if (url.pathname === `${appBase}duties/catalog.json` || url.pathname === '/duties/catalog.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(dutyCatalog));
        return;
      }
      if (url.pathname === `${appBase}duties/entrances.json` || url.pathname === '/duties/entrances.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(dutyEntrances));
        return;
      }
      const dutyLightsMatch = /^(?:\/ff14-web\/|\/)extracted\/duty-lights\/([a-z0-9]+)\.json$/.exec(url.pathname);
      const dutyLightsManifestMatch = /^(?:\/ff14-web\/|\/)extracted\/duty-lights\/manifest\.json$/.exec(url.pathname);
      if (dutyLightsManifestMatch) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          schemaVersion: 1,
          client: '2026.09.01.0000.0000',
          catalog: 'config/duties/hidden-catalog.json',
          statusCounts: Object.values(dutyLights).reduce((acc, entry) => { acc[entry.status] = (acc[entry.status] || 0) + 1; return acc; }, {}),
          scenes: Object.fromEntries(Object.entries(dutyLights).map(([id, entry]) => [id, { status: entry.status, lights: entry.lights.length }])),
        }));
        return;
      }
      if (dutyLightsMatch) {
        const sceneId = dutyLightsMatch[1];
        const payload = dutyLights[sceneId];
        if (!payload) { response.writeHead(404).end(); return; }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(payload));
        return;
      }
      if (url.pathname === '/ff14-assets/ticket') {
        // The CDN only returns CORS headers for the production origin, so
        // browser runs outside https://yuluo.site cannot read signed asset
        // URLs. Re-sign through the upstream ticket service, then rewrite the
        // signed hosts to root-relative URLs served by this server's
        // /ff14-assets proxy. Dev/preview servers only; builds keep the
        // production ticket and CDN base untouched.
        const upstream = `https://yuluo.site/ff14-assets/ticket${url.search}`;
        const origin = `http://${request.headers.host || '127.0.0.1:5173'}`;
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', async () => {
          try {
            const upstreamResponse = await fetch(upstream, {
              method: request.method,
              headers: request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {},
              body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
            });
            const text = await upstreamResponse.text();
            response.statusCode = upstreamResponse.status;
            response.setHeader('Content-Type', upstreamResponse.headers.get('content-type') || 'application/json');
            response.end(text.replaceAll('https://img.yuluo.site/', `${origin}/`));
          } catch (error) {
            response.statusCode = 502;
            response.end(`ticket rewrite failed: ${error?.message || error}`);
          }
        });
        return;
      }
      const sandbox = url.pathname.startsWith(sandboxPrefix);
      if (!local || (!sandbox && !url.pathname.startsWith(assetPrefix))) return next();
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const assetRoot = sandbox ? path.join(repo, 'public/sandbox') : world;
      const prefix = sandbox ? sandboxPrefix : assetPrefix;
      const file = path.resolve(assetRoot, decodeURIComponent(url.pathname.slice(prefix.length)));
      const relative = path.relative(assetRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
      let stat;
      try { stat = fs.statSync(file); } catch { response.writeHead(404).end(); return; }
      if (!stat.isFile()) { response.writeHead(404).end(); return; }
      const gzip = file.endsWith('.json.gz');
      response.setHeader('Content-Type', gzip || file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (gzip) response.setHeader('Content-Encoding', 'gzip');
      response.setHeader('Accept-Ranges', 'bytes');
      const range = !gzip && /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { response.writeHead(416).end(); return; }
      response.setHeader('Content-Length', end - start + 1);
      if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      response.writeHead(range ? 206 : 200);
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
    });
  }
  return {
    root: path.join(repo, 'preview/babylon'),
    cacheDir: path.join(repo, 'work/babylon-client/vite-cache'),
    base: appBase,
    publicDir: false,
    server: {
      host: '127.0.0.1',
      fs: { allow: [repo] },
      proxy: {
        // Versioned assets live on the CDN host; the ticket service lives on
        // yuluo.site and is intercepted by the dev middleware above before
        // the proxy sees it.
        '/ff14-assets': { target: 'https://img.yuluo.site', changeOrigin: true, secure: true },
      },
    },
    preview: {
      host: '127.0.0.1',
      proxy: {
        '/ff14-assets': { target: 'https://img.yuluo.site', changeOrigin: true, secure: true },
      },
    },
    build: { outDir: path.resolve(repo, process.env.BABYLON_OUT_DIR || 'site'), emptyOutDir: true, target: 'es2022' },
    plugins: [{
      name: 'isolated-babylon-world-config',
      enforce: 'pre',
      configResolved(value) { resolvedViteConfig = value; },
      resolveId(source, importer) {
        if (!importer || !source.startsWith('.')) return;
        const resolved = path.relative(repo, path.resolve(path.dirname(importer.split('?')[0]), source)).replaceAll('\\', '/');
        const replacement = engineRedirects.get(resolved);
        if (replacement) return path.join(repo, replacement).replaceAll('\\', '/');
      },
      transform(source, id) {
        // This entry always runs in a browser. Omit the shared module's Node
        // test-only localhost fallback without changing the main build.
        if (/\/src\/assets\/(?:AssetRuntime|FetchScheduler)\.js$/.test(id.replaceAll('\\', '/'))) {
          return source.replace(/globalThis\.location\?\.(href|origin)\s*\|\|\s*['"]http:\/\/localhost\/['"]/g, 'location.$1');
        }
        const relative = path.relative(repo, id.split('?')[0]).replaceAll('\\', '/');
        if (relative === 'src/main.js') return source.replace('world.player.position.copy(point)', 'world.player.position.copyFrom(point)');
        if (relative === 'src/core/Settings.js') return source.replace("'aetheryte-settings'", "'aetheryte-babylon-settings'");
        if (relative === 'src/ui/layout/HudLayoutRuntime.js') return source.replace("'aetheryte-hud-layouts-v1'", "'aetheryte-babylon-hud-layouts-v1'");
        if (relative === 'src/ui/SkillIcon.js') return source.replace('import.meta.env.BASE_URL', '"/ff14-web/"');
      },
      generateBundle() {
        const threeImports = [...this.getModuleIds()].filter(id => /\/node_modules\/(?:three|three-mesh-bvh)\//.test(id.replaceAll('\\', '/')));
        if (threeImports.length) this.error(`Babylon preview imports the old engine: ${threeImports[0]}`);
        this.emitFile({ type: 'asset', fileName: 'app-config.json', source: configText });
        this.emitFile({ type: 'asset', fileName: 'extracted/active.json', source: JSON.stringify(publishedActive) });
        this.emitFile({ type: 'asset', fileName: 'duties/catalog.json', source: JSON.stringify(dutyCatalog) });
        this.emitFile({ type: 'asset', fileName: 'duties/entrances.json', source: JSON.stringify(dutyEntrances) });
        this.emitFile({ type: 'asset', fileName: 'extracted/duty-lights/manifest.json', source: JSON.stringify({
          schemaVersion: 1,
          generatedAtUtc: new Date().toISOString(),
          client: '2026.09.01.0000.0000',
          catalog: 'config/duties/hidden-catalog.json',
          statusCounts: Object.values(dutyLights).reduce((acc, entry) => { acc[entry.status] = (acc[entry.status] || 0) + 1; return acc; }, {}),
          scenes: Object.fromEntries(Object.entries(dutyLights).map(([id, entry]) => [id, { status: entry.status, lights: entry.lights.length }])),
        }) });
        for (const [sceneId, entry] of Object.entries(dutyLights)) {
          this.emitFile({ type: 'asset', fileName: `extracted/duty-lights/${sceneId}.json`, source: JSON.stringify(entry) });
        }
        this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ ...createBuildInfo(), threeModules: threeImports.length }) });
      },
      async closeBundle() {
        const outDir = path.resolve(repo, resolvedViteConfig.build.outDir);
        const copy = async (source, relative) => {
          const destination = path.join(outDir, relative);
          await fs.promises.mkdir(path.dirname(destination), { recursive: true });
          await fs.promises.cp(source, destination, { recursive: true });
        };
        for (const name of ['favicon.svg', 'icons', 'vfx']) await copy(path.join(repo, 'public', name), name);
        const sandboxRoot = path.resolve(process.env.SANDBOX_RELEASE_DIR || path.join(repo, 'public/sandbox'));
        const sandboxManifest = process.env.SANDBOX_CDN === '1' ? 'manifest.cdn.json' : 'manifest.json';
        await copy(path.join(sandboxRoot, sandboxManifest), 'sandbox/manifest.json');
        await copy(path.join(sandboxRoot, 'human.cmp'), 'sandbox/human.cmp');
      },
      configureServer: configureDataServer,
      configurePreviewServer: configureDataServer,
    }],
  };
});
