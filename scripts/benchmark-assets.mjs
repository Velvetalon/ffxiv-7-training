#!/usr/bin/env node
/**
 * Asset-load benchmark for the deployed or local FF14 web build.
 *
 * Examples:
 *   npm install -D playwright
 *   node scripts/benchmark-assets.mjs --url=https://example.test/ff14-web/ --out=work/result.json --scenes=gridania,limsa
 *   PLAYWRIGHT_MODULE_PATH=/path/to/playwright/package.json node scripts/benchmark-assets.mjs --url=http://127.0.0.1:18080/ff14-web/ --out=work/result.json --scenes=gridania --cold-only
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
const require = createRequire(import.meta.url);
const modulePath = args['playwright-module-path'] || process.env.PLAYWRIGHT_MODULE_PATH;
let chromium;
try {
  ({ chromium } = modulePath ? createRequire(path.resolve(modulePath))('playwright') : require('playwright'));
} catch (error) {
  throw new Error(`Playwright is required. Install it with \`npm install -D playwright\`, or set PLAYWRIGHT_MODULE_PATH to its package.json. ${error.message}`);
}

if (!args.url || !args.out || !args.scenes) throw new Error('Required: --url=URL --out=FILE --scenes=gridania,limsa');
const appUrl = String(args.url).replace(/([^/])$/, '$1/');
const outPath = path.resolve(args.out);
const progressPath = outPath.replace(/\.json$/i, '.progress.jsonl');
const scenes = String(args.scenes).split(',').map(value => value.trim()).filter(Boolean);
const timeout = Number(args.timeout || 600000);
const coldOnly = args['cold-only'] === true || args['cold-only'] === 'true';
const browserPath = args['browser-path'] || process.env.BROWSER_PATH;
const round = value => Number.isFinite(value) ? Number(value.toFixed(1)) : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const progress = async (event, detail = {}) => fs.appendFile(progressPath, `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`);
const urlWithoutQuery = url => { const value = new URL(url); return `${value.origin}${value.pathname}`; };
const httpResource = url => { try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; } };
const classify = url => {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('/scene.json')) return 'manifest';
  if (pathname.endsWith('/collision.bin')) return 'collision';
  if (/\/models\//.test(pathname) || pathname.endsWith('.glb')) return 'model';
  if (/\/textures\//.test(pathname) || /\.(png|jpe?g|webp|ktx2)$/i.test(pathname)) return 'texture';
  if (/\.(js|mjs)$/i.test(pathname)) return 'script';
  if (/\.css$/i.test(pathname)) return 'style';
  return 'other';
};
const aggregate = resources => Object.fromEntries(Object.entries(resources.reduce((groups, resource) => {
  const group = groups[resource.kind] ||= { count: 0, transferBytes: 0, encodedBytes: 0, cached: 0 };
  group.count++; group.transferBytes += resource.transferBytes || 0; group.encodedBytes += resource.encodedBytes || 0;
  if (resource.cached) group.cached++;
  return groups;
}, {})).map(([kind, group]) => [kind, { ...group, transferBytes: Math.round(group.transferBytes), encodedBytes: Math.round(group.encodedBytes) }]));

async function preparePage(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(30000);
    window.__benchmarkLongTasks = [];
    try { new PerformanceObserver(list => window.__benchmarkLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true }); } catch {}
  });
  const cdp = await context.newCDPSession(page);
  const responses = []; const byId = new Map();
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', event => {
    const record = { id: event.requestId, url: event.response.url, status: event.response.status, protocol: event.response.protocol || null, cached: Boolean(event.response.fromDiskCache || event.response.fromServiceWorker), encodedBytes: 0 };
    responses.push(record); byId.set(event.requestId, record);
  });
  cdp.on('Network.loadingFinished', event => { const record = byId.get(event.requestId); if (record) record.encodedBytes = Math.round(event.encodedDataLength || 0); });
  return { context, page, responses };
}

function heartbeat(label, responses, start) {
  const emit = () => {
    const current = responses.slice(start).filter(response => httpResource(response.url));
    void progress('heartbeat', { label, completedResponses: current.length, cdpEncodedBytes: current.reduce((sum, response) => sum + (response.encodedBytes || 0), 0) });
  };
  emit();
  const timer = setInterval(emit, 30000);
  return () => clearInterval(timer);
}

async function diagnostic(page, error) {
  const state = await page.evaluate(() => {
    const world = window.__APP__?.world; const overlay = document.querySelector('#loading'); const style = overlay && getComputedStyle(overlay);
    return { world: world && { loading: world.loading, sceneId: world.sceneId, requestedSceneId: world.requestedSceneId, imported: world.isImported, streaming: world.assetScene?.streaming ?? null, streamError: world.assetScene?.streamError?.message || null, completed: world.assetScene?.completed?.size ?? null }, overlay: overlay && { className: overlay.className, opacity: style?.opacity, visibility: style?.visibility, pointerEvents: style?.pointerEvents } };
  }).catch(snapshotError => ({ snapshotError: snapshotError.message }));
  return { status: 'incomplete', error: error.message, diagnostic: state };
}

async function waitForRenderer(page, scene) {
  await page.waitForFunction(id => { const world = window.__APP__?.world; return world && !world.loading && world.sceneId === id && world.isImported && !world.loadError && world.renderer?.info?.render?.calls > 0; }, scene, { timeout });
  return page.evaluate(() => performance.now());
}

async function waitForVisibleInteractive(page, scene) {
  await page.waitForFunction(id => {
    const world = window.__APP__?.world; const overlay = document.querySelector('#loading');
    if (!world || world.loading || world.sceneId !== id || !world.isImported || !world.input?.enabled) return false;
    if (overlay) {
      const style = getComputedStyle(overlay); const canvas = document.querySelector('#world'); const rect = canvas?.getBoundingClientRect();
      const top = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!overlay.classList.contains('loaded') || style.visibility !== 'hidden' || Number(style.opacity) > 0.01 || style.pointerEvents !== 'none' || top === overlay || overlay.contains(top)) return false;
    }
    // Modern imported builds set this only after the overlay is really gone. Legacy builds have no profiler.
    return !window.__ASSET_PROFILER__?.active || Boolean(window.__ASSET_PROFILER__.active.interactive);
  }, scene, { timeout });
  return page.evaluate(() => performance.now());
}

async function waitForFull(page, scene) {
  await page.waitForFunction(id => { const world = window.__APP__?.world; return world && !world.loading && world.sceneId === id && (!world.assetScene?.streaming || world.assetScene?.streamError); }, scene, { timeout });
  return page.evaluate(() => ({ at: performance.now(), streaming: Boolean(window.__APP__.world.assetScene?.streaming), error: window.__APP__.world.assetScene?.streamError?.message || null, completed: window.__APP__.world.assetScene?.completed?.size ?? null }));
}

async function sample(page, responses, action) {
  await delay(150);
  const browser = await page.evaluate(started => {
    const world = window.__APP__?.world; const overlay = document.querySelector('#loading'); const style = overlay && getComputedStyle(overlay); const canvas = document.querySelector('#world'); const rect = canvas?.getBoundingClientRect(); const top = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const materialAudit = { previewVariants: 0, dimensionsKnown: 0, dimensionsInvalid: 0 };
    const textures = new Set();
    if (world?.sceneRoot && !world.assetScene?.streaming) world.sceneRoot.traverse(node => {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) for (const texture of [material?.map, material?.normalMap, material?.specularMap, material?.roughnessMap, material?.metalnessMap, material?.emissiveMap, material?.alphaMap]) {
        if (!texture?.isTexture || textures.has(texture.uuid)) continue; textures.add(texture.uuid);
        if (texture.userData?.fullVariant) materialAudit.previewVariants++;
        const width = texture.image?.width, height = texture.image?.height;
        if (Number.isFinite(width) && Number.isFinite(height)) { if (width > 0 && height > 0) materialAudit.dimensionsKnown++; else materialAudit.dimensionsInvalid++; }
      }
    });
    return {
      resources: performance.getEntriesByType('resource').filter(entry => entry.startTime >= started - 1 && /^https?:/.test(entry.name)).map(entry => ({ url: entry.name, transferBytes: Math.round(entry.transferSize || 0), encodedBytes: Math.round(entry.encodedBodySize || 0), startMs: entry.startTime, responseEndMs: entry.responseEnd, durationMs: entry.duration })),
      profiler: window.__ASSET_PROFILER__?.snapshot?.() || null, longTasks: window.__benchmarkLongTasks || [],
      world: { loading: Boolean(world?.loading), streaming: Boolean(world?.assetScene?.streaming), streamError: world?.assetScene?.streamError?.message || null },
      full: { completed: world?.assetScene?.completed?.size ?? null }, materialAudit,
      ui: { loaded: overlay?.classList.contains('loaded') ?? null, opacity: style?.opacity ?? null, visibility: style?.visibility ?? null, pointerEvents: style?.pointerEvents ?? null, blocksCanvasCenter: Boolean(overlay && (top === overlay || overlay.contains(top))), inputEnabled: Boolean(world?.input?.enabled) },
    };
  }, action.started);
  const resources = browser.resources.map(resource => ({ ...resource, kind: classify(resource.url), url: urlWithoutQuery(resource.url), startMs: round(resource.startMs), responseEndMs: round(resource.responseEndMs), durationMs: round(resource.durationMs), cached: resource.transferBytes === 0 && resource.encodedBytes > 0 }));
  const network = responses.slice(action.responseStart).filter(response => httpResource(response.url)).map(response => ({ ...response, kind: classify(response.url), url: urlWithoutQuery(response.url) }));
  const phase = name => browser.profiler?.events?.find(event => event.name === name)?.at ?? null;
  const rendererFirstRenderMs = phase('first-render') === null ? round(action.rendererAt - action.started) : round(phase('first-render') - action.started);
  const visibleFirstRenderMs = phase('first-visible-render') === null ? null : round(phase('first-visible-render') - action.started);
  const interactiveMs = phase('interactive') === null ? null : round(phase('interactive') - action.started);
  const fullLoadedMs = phase('fully-loaded') === null ? round(action.full.at - action.started) : round(phase('fully-loaded') - action.started);
  return { label: action.label, target: action.target, firstRenderMs: visibleFirstRenderMs ?? rendererFirstRenderMs, rendererFirstRenderMs, visibleFirstRenderMs, interactiveMs, fullLoadedMs, fullNetworkMs: round(Math.max(0, ...resources.map(resource => resource.responseEndMs || 0)) - action.started), fullLoaded: action.full, world: browser.world, uiReadiness: browser.ui, materialAudit: browser.materialAudit, profiler: browser.profiler, resources, resourceSummary: aggregate(resources), cdpNetwork: { responseCount: network.length, summary: aggregate(network) }, longTasks: browser.longTasks.map(task => ({ start: round(task.start), duration: round(task.duration) })) };
}

async function cold(browser, scene) {
  const run = await preparePage(browser);
  const label = `cold-initial-${scene}`;
  const responseStart = run.responses.length;
  const stopHeartbeat = heartbeat(label, run.responses, responseStart);
  try {
    await progress('case:goto', { label, scene, appUrl });
    await run.page.goto(new URL(`?scene=${scene}`, appUrl).href, { waitUntil: 'domcontentloaded', timeout });
    const started = await run.page.evaluate(() => performance.getEntriesByType('navigation').at(-1)?.startTime || 0);
    const rendererAt = await waitForRenderer(run.page, scene); await progress('case:renderer-first-render', { label });
    await waitForVisibleInteractive(run.page, scene); await progress('case:user-interactive', { label });
    const full = await waitForFull(run.page, scene); await progress('case:fully-loaded', { label, full });
    return await sample(run.page, run.responses, { label, target: scene, started, rendererAt, full, responseStart });
  } catch (error) { return { label, target: scene, ...(await diagnostic(run.page, error)) }; }
  finally { stopHeartbeat(); await run.context.close(); }
}

const browser = await chromium.launch({ executablePath: browserPath || undefined, headless: args.headed ? false : true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
const report = { generatedAt: new Date().toISOString(), appUrl, scenes, method: { firstRender: 'first-visible-render after overlay-hidden/input-ready; rendererFirstRenderMs is retained separately', networkScope: 'all HTTP(S) resources in the isolated benchmark context; signed URL queries are stripped in output' }, runs: [] };
const summarize = () => Object.fromEntries(report.runs.map(run => [run.label, { status: run.status || 'complete', firstRenderMs: run.firstRenderMs ?? null, interactiveMs: run.interactiveMs ?? null, fullLoadedMs: run.fullLoadedMs ?? null, fullNetworkMs: run.fullNetworkMs ?? null, transferBytes: Object.values(run.resourceSummary || {}).reduce((sum, group) => sum + group.transferBytes, 0) }]));
const persist = async () => { report.summary = summarize(); await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`); };
const record = async run => { report.runs.push(run); await persist(); await progress(run.status === 'incomplete' ? 'case:incomplete' : 'case:captured', { label: run.label, error: run.error }); };
try {
  await fs.mkdir(path.dirname(outPath), { recursive: true }); await fs.writeFile(progressPath, ''); await progress('run:start', { appUrl, scenes, coldOnly });
  for (const scene of scenes) await record(await cold(browser, scene));
  if (!coldOnly) {
    for (const scene of scenes) {
      const run = await preparePage(browser);
      const label = `warm-reload-${scene}`;
      const stopHeartbeat = heartbeat(label, run.responses, 0);
      try {
        await progress('case:goto', { label, scene, appUrl, mode: 'warm-prime' });
        await run.page.goto(new URL(`?scene=${scene}`, appUrl).href, { waitUntil: 'domcontentloaded', timeout });
        await waitForFull(run.page, scene); const responseStart = run.responses.length;
        await progress('case:goto', { label, scene, appUrl, mode: 'warm-reload' });
        await run.page.reload({ waitUntil: 'domcontentloaded', timeout }); const started = await run.page.evaluate(() => performance.getEntriesByType('navigation').at(-1)?.startTime || 0);
        const rendererAt = await waitForRenderer(run.page, scene); await progress('case:renderer-first-render', { label });
        await waitForVisibleInteractive(run.page, scene); await progress('case:user-interactive', { label });
        const full = await waitForFull(run.page, scene); await progress('case:fully-loaded', { label, full });
        await record(await sample(run.page, run.responses, { label, target: scene, started, rendererAt, full, responseStart }));
      } catch (error) {
        await record({ label, target: scene, ...(await diagnostic(run.page, error)) });
      } finally { stopHeartbeat(); await run.context.close(); }
    }
    if (scenes.includes('gridania') && scenes.includes('limsa')) {
      const run = await preparePage(browser);
      try {
        await run.page.goto(new URL('?scene=gridania', appUrl).href, { waitUntil: 'domcontentloaded', timeout });
        await waitForFull(run.page, 'gridania');
        const select = async (scene, label) => {
          const responseStart = run.responses.length;
          const stopHeartbeat = heartbeat(label, run.responses, responseStart);
          try {
            await progress('case:goto', { label, scene, mode: 'map-select' });
            const started = await run.page.evaluate(id => { const at = performance.now(); window.__APP__.teleport(id, true); return at; }, scene);
            const rendererAt = await waitForRenderer(run.page, scene); await progress('case:renderer-first-render', { label });
            await waitForVisibleInteractive(run.page, scene); await progress('case:user-interactive', { label });
            const full = await waitForFull(run.page, scene); await progress('case:fully-loaded', { label, full });
            await record(await sample(run.page, run.responses, { label, target: scene, started, rendererAt, full, responseStart }));
          } catch (error) {
            await record({ label, target: scene, ...(await diagnostic(run.page, error)) });
          } finally { stopHeartbeat(); }
        };
        await select('limsa', 'aba-gridania-to-limsa');
        await select('gridania', 'aba-limsa-to-gridania-revisit');
      } catch (error) {
        await record({ label: 'aba-setup-gridania', target: 'gridania', ...(await diagnostic(run.page, error)) });
      } finally { await run.context.close(); }
    }
  }
  await persist(); await progress('run:complete', { samples: report.runs.length }); console.log(JSON.stringify(report.summary, null, 2));
} finally { await browser.close(); }
