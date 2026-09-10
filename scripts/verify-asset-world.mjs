#!/usr/bin/env node
/**
 * Progressive packed-world verifier.
 *
 * npm install -D playwright
 * node scripts/verify-asset-world.mjs --url=http://127.0.0.1:18080/ff14-web/ --out=work/world-asset-verify.json
 * node scripts/verify-asset-world.mjs --url=http://127.0.0.1:18080/ff14-web/ --out=work/world-smoke.json --smoke
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

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
  throw new Error(`Playwright is required. Install it with \`npm install -D playwright\`, or set PLAYWRIGHT_MODULE_PATH. ${error.message}`);
}

if (!args.url || !args.out) throw new Error('Required: --url=URL --out=FILE');
const appUrl = String(args.url).replace(/([^/])$/, '$1/');
const outPath = path.resolve(args.out);
const progressPath = outPath.replace(/\.json$/i, '.progress.jsonl');
const timeout = Number(args.timeout || 600000);
const browserPath = args['browser-path'] || process.env.BROWSER_PATH;
const expectedSceneCount = args['expected-scenes'] === undefined ? null : Number(args['expected-scenes']);
const expectedEdgeCount = args['expected-edges'] === undefined ? null : Number(args['expected-edges']);
const resumePath = args.resume ? path.resolve(String(args.resume)) : null;
const continueOnFailure = args['continue-on-failure'] === true || args['continue-on-failure'] === 'true';
const transitionsOnly = args['transitions-only'] === true || args['transitions-only'] === 'true';
const requested = args.scenes ? new Set(String(args.scenes).split(',').map(value => value.trim()).filter(Boolean)) : null;
const smoke = args.smoke === true || args.smoke === 'true';
const smokeIds = String(args['smoke-scenes'] || 'x6f2,gridania,limsa').split(',').map(value => value.trim()).filter(Boolean);
const now = () => new Date().toISOString();
const progress = (event, detail = {}) => fs.appendFile(progressPath, `${JSON.stringify({ at: now(), event, detail })}\n`);
const scrubUrl = value => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return value; }
};
const scrubText = value => String(value).replace(/https?:\/\/[^\s)'"`]+/g, scrubUrl);
const fetchJson = async url => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(decoded));
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const activeUrl = new URL('extracted/active.json', appUrl).href;
const active = await fetchJson(activeUrl);
const entryHtml = await (await fetch(appUrl, { cache: 'no-store' })).text();
async function pipelineCatalog(pointer) {
  if (!pointer || (!pointer.manifest && !pointer.ticket)) return null;
  if (!pointer.ticket) {
    const base = new URL(pointer.base || './', activeUrl).href;
    return { catalog: await fetchJson(new URL(pointer.manifest, activeUrl).href), base, resolve: async url => new URL(url, base).href };
  }
  const endpoint = new URL(pointer.ticket, activeUrl).href;
  const batch = new URL(endpoint); batch.searchParams.set('mode', 'batch');
  const ticketResponse = await fetch(batch, { cache: 'no-store' });
  if (!ticketResponse.ok) throw new Error(`Asset ticket HTTP ${ticketResponse.status}`);
  const ticket = await ticketResponse.json();
  const entryUrl = new URL(ticket.entryUrl, activeUrl).href;
  const signed = new Map(Object.entries(ticket.urls || {}).map(([key, url]) => [key.replace(/^\/+/, ''), url]));
  const base = new URL(pointer.base || ticket.assetBase || './', entryUrl).href;
  const resolve = async value => {
    const canonical = new URL(value, base).href;
    const key = new URL(canonical).pathname.replace(/^\/+/, '');
    if (signed.has(key)) return signed.get(key);
    const response = await fetch(endpoint, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: [key] }) });
    if (!response.ok) throw new Error(`Asset authorization HTTP ${response.status}`);
    const result = await response.json();
    if (!result.urls?.[key]) throw new Error(`Asset authorization omitted ${key}`);
    signed.set(key, result.urls[key]);
    return result.urls[key];
  };
  return { catalog: await fetchJson(entryUrl), base, resolve };
}
const pipeline = await pipelineCatalog(active.assetPipeline);
const artifactFingerprint = {
  entryHtmlSha256: sha256(entryHtml),
  catalogSha256: pipeline ? sha256(JSON.stringify(pipeline.catalog)) : null,
  activeRunId: active.runId || null,
};
const allScenes = Object.keys(pipeline?.catalog?.maps || active.scenes || {}).map(id => ({ id, ...(active.scenes?.[id] || {}), pipeline: pipeline?.catalog?.maps?.[id] || null }));
if (!allScenes.length) throw new Error('active catalog has no scenes');
const catalogIds = new Set(allScenes.map(scene => scene.id));
const unknown = requested && [...requested].filter(id => !catalogIds.has(id));
if (unknown?.length) throw new Error(`unknown scene ids: ${unknown.join(', ')}`);
const selectedScenes = transitionsOnly ? [] : requested ? allScenes.filter(scene => requested.has(scene.id)) : smoke ? allScenes.filter(scene => smokeIds.includes(scene.id)) : allScenes;
if (!transitionsOnly && !selectedScenes.length) throw new Error('no scenes selected');

const manifests = new Map();
for (const scene of allScenes) {
  await progress('manifest:start', { id: scene.id });
  const registry = pipeline ? await fetchJson(await pipeline.resolve(scene.pipeline.manifest)) : null;
  const manifest = registry?.maps?.[scene.id]?.legacyManifest || registry?.legacyManifest || (!pipeline && await fetchJson(new URL(`extracted/${scene.base}scene.json`, appUrl).href));
  if (!manifest) throw new Error(`${scene.id}: map registry has no legacyManifest`);
  manifests.set(scene.id, manifest);
  await progress('manifest:ready', { id: scene.id, models: manifest.models?.length || 0, connections: manifest.connections?.length || 0, registryResources: registry?.maps?.[scene.id]?.resources ? Object.keys(registry.maps[scene.id].resources).length : registry?.resources ? Object.keys(registry.resources).length : null });
}

const staticProblems = [];
const staticEdges = [];
for (const scene of allScenes) {
  const manifest = manifests.get(scene.id);
  if (manifest.scene !== scene.id) staticProblems.push(`${scene.id}: manifest scene mismatch`);
  if (!Array.isArray(manifest.models) || !manifest.models.length) staticProblems.push(`${scene.id}: no source models`);
  const seen = new Set();
  for (const connection of manifest.connections || []) {
    if (!connection.id || seen.has(connection.id)) staticProblems.push(`${scene.id}: duplicate or missing connection id`);
    seen.add(connection.id);
    if (!catalogIds.has(connection.targetScene)) staticProblems.push(`${scene.id}:${connection.id}: unpublished target ${connection.targetScene}`);
    if (!Array.isArray(connection.position) || connection.position.length !== 3 || !connection.position.every(Number.isFinite)) staticProblems.push(`${scene.id}:${connection.id}: invalid endpoint position`);
    if (!connection.source) staticProblems.push(`${scene.id}:${connection.id}: missing endpoint source`);
    staticEdges.push({ ...connection, sourceScene: scene.id, provenance: connection.source });
  }
}

const report = {
  generatedAt: now(), appUrl, activeUrl, activeRunId: active.runId || null,
  artifactFingerprint,
  measurementEnvironment: null,
  assetPipeline: pipeline ? { catalogMaps: Object.keys(pipeline.catalog.maps || {}).length, ticketed: Boolean(active.assetPipeline?.ticket) } : null,
  expected: { scenes: expectedSceneCount, directedConnections: expectedEdgeCount },
  static: { catalogCount: allScenes.length, directedConnections: staticEdges.length, problems: staticProblems },
  selection: selectedScenes.map(scene => scene.id), smoke, transitionsOnly,
  zones: [], transitions: [],
};
function compatiblePassingEvidence(zone) {
  const full = zone?.full;
  const pre = zone?.preFull;
  const diagnostics = zone?.diagnostics;
  return Boolean(
    pre?.imported && pre?.inputEnabled && pre?.overlay?.loaded && pre?.overlay?.visibility === 'hidden' && pre?.overlay?.pointerEvents === 'none' && zone.keyboardAccepted
    && full?.imported && !full.loading && !full.loadError && !full.streaming && !full.streamError && full.completed === zone.expectedModels
    && full.manifestModels === zone.expectedModels && full.runtimeModels === zone.expectedModels && full.floor && full.collision?.navigationReady
    && (full.collision.fullCollisionReady ? full.collision.fullCollisionBytes === full.collision.expectedRawBytes : full.collision.expectedChunks === null || full.collision.streamingChunks === full.collision.expectedChunks)
    && full.glError === 0 && full.textureAudit?.previewVariants === 0 && full.textureAudit?.dimensionsInvalid === 0 && full.firstFrameVisible
    && full.runtime?.inflightResources === 0 && full.runtime?.queuedFetches === 0 && full.runtime?.activeFetches === 0
    && diagnostics?.pageErrors?.length === 0 && diagnostics?.consoleErrors?.length === 0 && diagnostics?.failedRequests?.length === 0
  );
}
const persist = async () => {
  report.summary = {
    passed: report.zones.filter(zone => zone.status === 'pass').length,
    failed: report.zones.filter(zone => zone.status === 'fail').length,
    selected: selectedScenes.length,
    staticCoveragePass: (expectedSceneCount === null || allScenes.length === expectedSceneCount) && (expectedEdgeCount === null || staticEdges.length === expectedEdgeCount) && staticProblems.length === 0,
    transitionPassed: report.transitions.every(transition => transition.status === 'pass'),
    releaseReady: !smoke && !requested && report.complete === true && (expectedSceneCount === null || allScenes.length === expectedSceneCount) && (expectedEdgeCount === null || staticEdges.length === expectedEdgeCount) && staticProblems.length === 0 && report.zones.length === allScenes.length && report.transitions.length === 4 && report.transitions.every(transition => transition.status === 'pass'),
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
};

async function attach(page, diagnostics) {
  page.on('pageerror', error => diagnostics.pageErrors.push(scrubText(error.message)));
  page.on('console', message => {
    if (message.type() === 'error') {
      const location = message.location();
      diagnostics.consoleErrors.push({ text: scrubText(message.text()), location: { ...location, url: scrubUrl(location.url || '') } });
    }
  });
  page.on('requestfailed', request => diagnostics.failedRequests.push({ url: scrubUrl(request.url()), error: request.failure()?.errorText || null }));
  await page.addInitScript(() => performance.setResourceTimingBufferSize(30000));
}

async function pageDiagnostic(page, error) {
  const state = await page.evaluate(() => {
    const world = window.__APP__?.world;
    const overlay = document.querySelector('#loading');
    const style = overlay && getComputedStyle(overlay);
    return {
      world: world && { sceneId: world.sceneId, requestedSceneId: world.requestedSceneId, loading: world.loading, imported: world.isImported, loadError: world.loadError, streaming: world.assetScene?.streaming ?? null, streamError: world.assetScene?.streamError?.message || null, completed: world.assetScene?.completed?.size ?? null },
      overlay: overlay && { className: overlay.className, opacity: style?.opacity, visibility: style?.visibility, pointerEvents: style?.pointerEvents },
      runtime: window.__ASSET_RUNTIME__?.stats?.() || null,
    };
  }).catch(snapshotError => ({ snapshotError: snapshotError.message }));
  return { error: scrubText(error.message), diagnostic: state };
}

async function phaseState(page, id, phase) {
  const state = await page.evaluate(() => {
    const world = window.__APP__?.world;
    const profiler = window.__ASSET_PROFILER__?.snapshot?.();
    const events = profiler?.events || [];
    return {
      sceneId: world?.sceneId || null, requestedSceneId: world?.requestedSceneId || null, loading: world?.loading ?? null,
      loadError: world?.loadError || null, streaming: world?.assetScene?.streaming ?? null, streamError: world?.assetScene?.streamError?.message || null,
      completed: world?.assetScene?.completed?.size ?? null, collisionChunks: world?.navigation?.loadedChunks?.size ?? null,
      profilerLastEvent: events.at(-1)?.name || null, runtime: window.__ASSET_RUNTIME__?.stats?.() || null,
    };
  }).catch(error => ({ probeError: scrubText(error.message) }));
  await progress('zone:heartbeat', { id, phase, state });
  return state;
}

async function monitoredWait(page, id, phase, wait, onState = () => {}) {
  let running = false;
  const probe = async () => {
    if (running) return;
    running = true;
    try { onState(await phaseState(page, id, phase)); } finally { running = false; }
  };
  await probe();
  const timer = setInterval(() => { void probe(); }, 10000);
  try {
    await wait();
    const state = await phaseState(page, id, `${phase}:complete`); onState(state);
    if (state.loadError || state.streamError) throw new Error(`runtime error: ${state.loadError || state.streamError}`);
  } finally { clearInterval(timer); }
}

async function waitForVisible(page, id, onState) {
  await monitoredWait(page, id, 'visible', () => page.waitForFunction(sceneId => {
    const world = window.__APP__?.world;
    if (world?.loadError || world?.assetScene?.streamError) return true;
    const overlay = document.querySelector('#loading');
    if (!world || world.loading || world.sceneId !== sceneId || !world.isImported || !world.input?.enabled || !world.renderer?.info?.render?.calls) return false;
    const style = overlay && getComputedStyle(overlay);
    const canvas = document.querySelector('#world');
    const rect = canvas?.getBoundingClientRect();
    const top = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const uiReady = !overlay || (overlay.classList.contains('loaded') && style.visibility === 'hidden' && Number(style.opacity) <= 0.01 && style.pointerEvents === 'none' && top !== overlay && !overlay.contains(top));
    return uiReady && (!window.__ASSET_PROFILER__?.active || Boolean(window.__ASSET_PROFILER__.active.firstRender) && Boolean(window.__ASSET_PROFILER__.active.interactive));
  }, id, { timeout }), onState);
}

async function waitForFull(page, id, expectedModels, onState) {
  await monitoredWait(page, id, 'fully-loaded', () => page.waitForFunction(({ sceneId, models }) => {
    const world = window.__APP__?.world;
    if (world?.loadError || world?.assetScene?.streamError) return true;
    return world && !world.loading && world.sceneId === sceneId && !world.assetScene?.streaming && world.assetScene?.completed?.size === models;
  }, { sceneId: id, models: expectedModels }, { timeout }), onState);
}

async function inspectZone(browser, scene) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  const runtimeSamples = [];
  const noteRuntime = state => { if (state?.runtime) runtimeSamples.push(state.runtime); };
  await attach(page, diagnostics);
  const manifest = manifests.get(scene.id);
  try {
    await progress('zone:start', { id: scene.id, expectedModels: manifest.models.length });
    await page.goto(new URL(`?scene=${scene.id}`, appUrl).href, { waitUntil: 'domcontentloaded', timeout });
    await waitForVisible(page, scene.id, noteRuntime);
    const preFull = await page.evaluate(() => {
      const world = window.__APP__.world;
      const overlay = document.querySelector('#loading');
      const style = getComputedStyle(overlay);
      const profiler = window.__ASSET_PROFILER__?.snapshot?.() || null;
      return {
        at: performance.now(), sceneId: world.sceneId, imported: world.isImported, loading: world.loading, rendererCalls: world.renderer.info.render.calls,
        inputEnabled: world.input.enabled, streaming: Boolean(world.assetScene?.streaming), completed: world.assetScene?.completed?.size ?? null,
        overlay: { loaded: overlay.classList.contains('loaded'), opacity: style.opacity, visibility: style.visibility, pointerEvents: style.pointerEvents },
        profiler, runtime: window.__ASSET_RUNTIME__?.stats?.() || null,
      };
    });
    await page.keyboard.down('w');
    const keyboardAccepted = await page.evaluate(() => window.__APP__.world.input.keys.has('KeyW'));
    await page.keyboard.up('w');
    await waitForFull(page, scene.id, manifest.models.length, noteRuntime);
    const full = await page.evaluate(expectedModels => {
      const world = window.__APP__.world;
      const gl = world.renderer.getContext();
      const textureAudit = { previewVariants: 0, dimensionsKnown: 0, dimensionsInvalid: 0 };
      const textures = new Set();
      world.sceneRoot.traverse(node => {
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) for (const texture of [material?.map, material?.normalMap, material?.specularMap, material?.roughnessMap, material?.metalnessMap, material?.emissiveMap, material?.alphaMap, ...(material?.userData?.ownedTextures || [])]) {
          if (!texture?.isTexture || textures.has(texture.uuid)) continue;
          textures.add(texture.uuid);
          if (texture.userData?.fullVariant) textureAudit.previewVariants++;
          const width = texture.image?.width, height = texture.image?.height;
          if (Number.isFinite(width) && Number.isFinite(height)) { if (width > 0 && height > 0) textureAudit.dimensionsKnown++; else textureAudit.dimensionsInvalid++; }
        }
      });
      const position = world.player.position;
      const floor = world.navigation?.surfaceAt(position.x, position.z, position.y);
      const navigation = world.navigation;
      const map = world.assetScene?.map;
      const fullNavigation = world.assetScene?.fullNavigation || navigation?.fullNavigation || null;
      const firstConnection = world.getConnections()[0] || null;
      const connectionFloor = firstConnection && world.navigation?.surfaceAt(firstConnection.position[0], firstConnection.position[2], firstConnection.position[1]);
      return {
        sceneId: world.sceneId, imported: world.isImported, loading: world.loading, loadError: world.loadError, streaming: Boolean(world.assetScene?.streaming), streamError: world.assetScene?.streamError?.message || null,
        completed: world.assetScene?.completed?.size ?? null, expectedModels, manifestModels: world.importedManifest?.models?.length ?? null, runtimeModels: map?.models?.length ?? null,
        floor: floor ? { height: floor.height } : null, connectionFloor: connectionFloor ? { height: connectionFloor.height } : null,
        collision: {
          navigationReady: Boolean(navigation), streamingChunks: navigation?.loadedChunks?.size ?? null, expectedChunks: map?.collisionChunks?.length ?? null,
          // New large-map completion may promote the streaming proxy to one full BVH.
          // The verifier requires the explicit ready flag and original raw-byte count.
          fullCollisionReady: Boolean(world.assetScene?.fullCollisionReady || navigation?.fullCollisionReady || fullNavigation),
          fullCollisionBytes: world.assetScene?.fullCollisionBytes ?? navigation?.fullCollisionBytes ?? fullNavigation?.rawBytes ?? null,
          expectedRawBytes: map?.legacyManifest?.collisionBytes ?? world.importedManifest?.collisionBytes ?? null,
        },
        glError: gl.getError(), textureAudit, runtime: window.__ASSET_RUNTIME__?.stats?.() || null, profiler: window.__ASSET_PROFILER__?.snapshot?.() || null,
        firstFrameVisible: Boolean(window.__ASSET_PROFILER__?.active?.firstRender && window.__ASSET_PROFILER__?.active?.interactive),
        connections: world.getConnections().map(connection => ({ id: connection.id, targetScene: connection.targetScene })),
      };
    }, manifest.models.length);
    const runtimeSettled = full.runtime && full.runtime.inflightResources === 0 && full.runtime.queuedFetches === 0 && full.runtime.activeFetches === 0;
    const collisionComplete = full.collision.fullCollisionReady
      ? full.collision.fullCollisionBytes === full.collision.expectedRawBytes
      : full.collision.expectedChunks === null || full.collision.streamingChunks === full.collision.expectedChunks;
    const checks = [
      ['visible scene/import', preFull.sceneId === scene.id && preFull.imported],
      ['visible input', preFull.inputEnabled && keyboardAccepted],
      ['visible overlay hidden/non-intercepting', preFull.overlay.loaded && preFull.overlay.visibility === 'hidden' && preFull.overlay.pointerEvents === 'none'],
      ['final scene/import/no load error', full.sceneId === scene.id && full.imported && !full.loading && !full.loadError],
      ['streaming complete/no stream error', !full.streaming && !full.streamError],
      ['completed source model count', full.completed === manifest.models.length && full.manifestModels === manifest.models.length && full.runtimeModels === manifest.models.length],
      ['spawn floor', Boolean(full.floor)],
      ['connection floor when map has connections', full.connections.length === 0 || Boolean(full.connectionFloor)],
      ['collision navigation complete', Boolean(full.collision.navigationReady) && collisionComplete],
      ['WebGL error', full.glError === 0],
      ['final textures', full.textureAudit.previewVariants === 0 && full.textureAudit.dimensionsInvalid === 0],
      ['visible imported frame', full.firstFrameVisible],
      ['runtime fetch queue settled', Boolean(runtimeSettled)],
      ['page diagnostics', diagnostics.pageErrors.length === 0 && diagnostics.consoleErrors.length === 0 && diagnostics.failedRequests.length === 0],
    ];
    const failureReasons = checks.filter(([, pass]) => !pass).map(([name]) => name);
    const phaseMs = name => full.profiler?.events?.find(event => event.name === name)?.elapsedMs ?? null;
    const peak = field => Math.max(0, ...[...runtimeSamples, preFull.runtime, full.runtime].map(sample => sample?.[field] || 0));
    const gpuErrors = Number(full.glError !== 0) + (full.profiler?.resources || []).filter(event => event.kind === 'gpu-execution' && event.status && event.status !== 'measured').length;
    const result = {
      id: scene.id, status: failureReasons.length ? 'fail' : 'pass', failureReasons, expectedModels: manifest.models.length, preFull, keyboardAccepted, full,
      metrics: {
        loadSuccess: !full.loadError && !full.streamError && full.completed === manifest.models.length,
        firstVisibleRenderMs: phaseMs('first-visible-render'), ttiMs: phaseMs('interactive'),
        missingAssets: diagnostics.failedRequests.length, jsErrors: diagnostics.pageErrors.length + diagnostics.consoleErrors.length, gpuErrors,
        memoryPeakSampled: { decodedBytes: peak('decodedBytes'), pinnedBytes: peak('pinnedBytes'), encodedBytes: peak('encodedBytes'), samples: runtimeSamples.length, note: 'Sampled from runtime heartbeat states; this is not total GPU memory.' },
        keyCounts: { expectedModels: manifest.models.length, completedModels: full.completed, finalPreviewVariants: full.textureAudit.previewVariants, invalidTextureDimensions: full.textureAudit.dimensionsInvalid, collisionChunks: full.collision.streamingChunks, expectedCollisionChunks: full.collision.expectedChunks, fullCollisionReady: full.collision.fullCollisionReady },
      },
      runtimeBoundedObservation: { separateContext: true, decodedBytes: full.runtime?.decodedBytes ?? null, decodedBudget: full.runtime?.decodedBudget ?? null, pinnedBytes: full.runtime?.pinnedBytes ?? null, encodedBytes: full.runtime?.encodedBytes ?? null, settled: runtimeSettled }, diagnostics,
    };
    await progress('zone:result', result);
    return result;
  } catch (error) {
    const result = { id: scene.id, status: 'fail', expectedModels: manifest.models.length, ...(await pageDiagnostic(page, error)), diagnostics };
    await progress('zone:result', result);
    return result;
  } finally { await context.close(); }
}

function representativeEdges() {
  const selectedIds = new Set(selectedScenes.map(scene => scene.id));
  if (smoke) return staticEdges.filter(edge => selectedIds.has(edge.sourceScene)).slice(0, 1);
  const kinds = [
    ['city', edge => allScenes.find(scene => scene.id === edge.sourceScene)?.kind === 'city'],
    ['outdoor', edge => allScenes.find(scene => scene.id === edge.sourceScene)?.kind === 'overworld' && Number(allScenes.find(scene => scene.id === edge.sourceScene)?.expansion || 0) === 0],
    ['expansion', edge => Number(allScenes.find(scene => scene.id === edge.sourceScene)?.expansion || 0) > 0],
    ['cross-expansion', edge => Number(allScenes.find(scene => scene.id === edge.sourceScene)?.expansion || 0) !== Number(allScenes.find(scene => scene.id === edge.targetScene)?.expansion || 0)],
  ];
  const used = new Set();
  const representatives = kinds.map(([kind, match]) => {
    const edge = staticEdges.find(candidate => !used.has(`${candidate.sourceScene}:${candidate.id}`) && match(candidate));
    if (edge) used.add(`${edge.sourceScene}:${edge.id}`);
    return edge && { ...edge, representativeKind: kind };
  }).filter(Boolean);
  for (const edge of staticEdges) {
    if (representatives.length >= 4) break;
    const key = `${edge.sourceScene}:${edge.id}`;
    if (used.has(key)) continue;
    used.add(key);
    representatives.push({ ...edge, representativeKind: `fallback-${representatives.length + 1}` });
  }
  return representatives;
}

async function inspectTransition(browser, edge) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] };
  await attach(page, diagnostics);
  const targetManifest = manifests.get(edge.targetScene);
  const targetConnectionId = edge.targetConnection || edge.arrivalConnection || null;
  const targetConnection = targetConnectionId ? targetManifest.connections?.find(connection => connection.id === targetConnectionId) : null;
  const expectedPoint = Array.isArray(edge.arrival) ? edge.arrival : targetConnection?.spawn || targetConnection?.position || null;
  const label = `${edge.sourceScene}:${edge.id}->${edge.targetScene}`;
  try {
    await progress('transition:start', { label, kind: edge.representativeKind || 'smoke' });
    await page.goto(new URL(`?scene=${edge.sourceScene}`, appUrl).href, { waitUntil: 'domcontentloaded', timeout });
    await waitForVisible(page, edge.sourceScene);
    await waitForFull(page, edge.sourceScene, manifests.get(edge.sourceScene).models.length);
    const departure = await page.evaluate(connectionId => {
      const world = window.__APP__.world;
      const moved = world.goToLandmark(`connection:${connectionId}`);
      const near = world.getNearbyConnection()?.id;
      return { moved, near, runtime: window.__ASSET_RUNTIME__?.stats?.() || null };
    }, edge.id);
    if (!departure.moved || departure.near !== edge.id) throw new Error('could not place player at representative connection');
    await page.keyboard.press('f');
    await waitForVisible(page, edge.targetScene);
    await waitForFull(page, edge.targetScene, targetManifest.models.length);
    if (!expectedPoint) throw new Error('transition has no target arrival point');
    const arrival = await page.evaluate(point => {
      const world = window.__APP__.world;
      const position = world.player.position;
      const distance = point ? Math.hypot(position.x - point[0], position.y - point[1], position.z - point[2]) : null;
      const floor = world.navigation?.surfaceAt(position.x, position.z, position.y);
      return { sceneId: world.sceneId, streaming: Boolean(world.assetScene?.streaming), completed: world.assetScene?.completed?.size ?? null, point, distance, floor: floor ? { height: floor.height } : null, runtime: window.__ASSET_RUNTIME__?.stats?.() || null };
    }, expectedPoint);
    const endpointOk = arrival.distance !== null && arrival.distance < 0.2;
    const pass = arrival.sceneId === edge.targetScene && !arrival.streaming && arrival.completed === targetManifest.models.length && endpointOk && arrival.floor && diagnostics.pageErrors.length === 0 && diagnostics.consoleErrors.length === 0 && diagnostics.failedRequests.length === 0;
    const result = { label, representativeKind: edge.representativeKind || 'smoke', status: pass ? 'pass' : 'fail', sourceScene: edge.sourceScene, provenance: edge.provenance, connection: edge.id, target: edge.targetScene, targetConnection: targetConnectionId, expectedPoint, departure, arrival, diagnostics };
    await progress('transition:result', result);
    return result;
  } catch (error) {
    const result = { label, representativeKind: edge.representativeKind || 'smoke', status: 'fail', sourceScene: edge.sourceScene, provenance: edge.provenance, connection: edge.id, target: edge.targetScene, ...(await pageDiagnostic(page, error)), diagnostics };
    await progress('transition:result', result);
    return result;
  } finally { await context.close(); }
}

const browser = await chromium.launch({ executablePath: browserPath || undefined, headless: args.headed ? false : true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
report.measurementEnvironment = {
  browserVersion: await browser.version(), platform: os.platform(), arch: os.arch(),
  deviceId: process.env.REGRESSION_DEVICE_ID || null, viewport: { width: 1440, height: 900 },
  cachePolicy: 'fresh browser context per map', networkProfile: args['network-profile'] || null, concurrency: 1,
};
try {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(progressPath, '');
  if (resumePath) {
    const prior = JSON.parse(await fs.readFile(resumePath, 'utf8'));
    const priorFingerprint = prior.artifactFingerprint;
    if (!priorFingerprint) throw new Error('resume report lacks artifactFingerprint; rerun or explicitly reconcile it before reuse');
    if (prior.appUrl !== appUrl || priorFingerprint.entryHtmlSha256 !== artifactFingerprint.entryHtmlSha256 || priorFingerprint.catalogSha256 !== artifactFingerprint.catalogSha256 || priorFingerprint.activeRunId !== artifactFingerprint.activeRunId) throw new Error('resume report does not match this app HTML/catalog/run fingerprint');
    const wanted = new Set(selectedScenes.map(scene => scene.id));
    for (const zone of prior.zones || []) {
      if (!wanted.has(zone.id) || !compatiblePassingEvidence(zone)) continue;
      report.zones.push({ ...zone, status: 'resumed-pass', failureReasons: [], resumedFrom: resumePath });
    }
  }
  await progress('run:start', { appUrl, activeRunId: active.runId || null, selected: selectedScenes.map(scene => scene.id), resumed: report.zones.map(zone => zone.id), static: report.static });
  for (const scene of selectedScenes.filter(scene => !report.zones.some(zone => zone.id === scene.id))) {
    const result = await inspectZone(browser, scene);
    report.zones.push(result);
    await persist();
    if (result.status === 'fail' && !continueOnFailure) break;
  }
  if (transitionsOnly || (!requested && report.zones.length === selectedScenes.length && report.zones.every(zone => zone.status === 'pass' || zone.status === 'resumed-pass'))) {
    for (const edge of representativeEdges()) {
      const result = await inspectTransition(browser, edge);
      report.transitions.push(result);
      await persist();
      if (result.status === 'fail') break;
    }
  }
  report.complete = (transitionsOnly ? report.transitions.length === 4 : report.zones.length === selectedScenes.length && report.zones.every(zone => zone.status === 'pass' || zone.status === 'resumed-pass')) && report.transitions.every(transition => transition.status === 'pass');
  await persist();
  await progress('run:complete', { complete: report.complete, summary: report.summary });
  console.log(JSON.stringify({ complete: report.complete, summary: report.summary }, null, 2));
  if (!report.complete) process.exitCode = 1;
} finally { await browser.close(); }
