#!/usr/bin/env node
/**
 * Matched Golden-port benchmark for the isolated Babylon preview and the
 * unchanged main entry. The benchmark is opt-in and only loads e3t1.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './validation/browser.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PREVIEW_URL = 'http://127.0.0.1:4173/ff14-web-babylon-preview/';
const DEFAULT_LEGACY_URL = 'http://127.0.0.1:4173/ff14-web/';
const DEFAULT_OUT = path.join(REPO_ROOT, 'work', 'babylon-preview', 'benchmark.json');
const MAP_ID = 'e3t1';
const PINNED_ASSET_VERSION = '20260909T124255Z-e3ea44';
const PINNED_LEGACY_RELEASE = '20260909T124255Z-e3ea44';
const TARGET_FOV_RADIANS = 0.82;
const LEGACY_FOV_DEGREES = TARGET_FOV_RADIANS * 180 / Math.PI;
const CAMERA_POSITION = [25.28964, 14, 1.34939];
const CAMERA_TARGET = [47.28964, 14, 35.34939];

function parseArgs(argv) {
  const result = {};
  for (const value of argv) {
    if (!value.startsWith('--')) continue;
    const body = value.slice(2);
    const index = body.indexOf('=');
    if (index < 0) result[body] = true;
    else result[body.slice(0, index)] = body.slice(index + 1);
  }
  return result;
}

function boolOption(value, fallback) {
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function usage() {
  console.log(`Usage: node scripts/benchmark-babylon.mjs --preview-url=URL --legacy-url=URL [options]

Options:
  --preview-url=URL         Babylon preview URL (default: ${DEFAULT_PREVIEW_URL})
  --legacy-url=URL          Unchanged main entry (default: ${DEFAULT_LEGACY_URL})
  --out=FILE                JSON report (default: work/babylon-preview/benchmark.json)
  --timeout=MS              Full-load timeout (default: 600000)
  --settle-ms=MS            Post-load settling time (default: 1500)
  --fps-ms=MS               FPS sampling window (default: 3000)
  --camera-position=x,y,z   Shared fixed camera position
  --camera-target=x,y,z     Shared fixed camera target
  --legacy-map-pattern=REGEX  Extra legacy map-bundle URL filter
  --browser-path=PATH       Chromium executable
  --playwright-module-path  Existing Playwright package.json/module path
  --headed=true             Keep Chromium visible
  --skip-legacy=true        Preview-only benchmark
  --help`);
}

function parseVector(value, fallback) {
  if (value === undefined) return fallback.slice();
  const values = String(value).split(',').map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? values : fallback.slice();
}

function isHttp(url) {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

function stripQuery(url) {
  try {
    const value = new URL(url);
    return `${value.origin}${value.pathname}`;
  } catch {
    return url;
  }
}

function defaultMapBundle(url) {
  return /(?:^|[\\/])(?:e3t1|maps[\\/]e3t1)(?:[\\/]|$)/i.test(url)
    && /\.(?:glb|bin|png|jpe?g|webp|ktx2|aethpak|json)(?:$|\?)/i.test(url);
}

function createNetworkCapture(context) {
  const responses = [];
  const byId = new Map();
  return (async () => {
    const cdp = await context.newCDPSession(await context.pages()[0]);
    await cdp.send('Network.enable');
    cdp.on('Network.responseReceived', event => {
      const record = {
        id: event.requestId,
        url: event.response.url,
        status: event.response.status,
        protocol: event.response.protocol || null,
        fromDiskCache: Boolean(event.response.fromDiskCache),
        fromServiceWorker: Boolean(event.response.fromServiceWorker),
        encodedBytes: 0,
      };
      responses.push(record);
      byId.set(event.requestId, record);
    });
    cdp.on('Network.loadingFinished', event => {
      const record = byId.get(event.requestId);
      if (record) record.encodedBytes = Math.round(event.encodedDataLength || 0);
    });
    return { cdp, responses };
  })();
}

async function newRun(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const network = await createNetworkCapture(context);
  return { context, page, ...network };
}

function profilerSnapshot(state) {
  const profiler = state?.profiler;
  if (!profiler) return { firstRenderMs: null, interactiveMs: null, fullyLoadedMs: null, events: [] };
  const event = name => profiler.events?.find(item => item.name === name);
  return {
    firstRenderMs: profiler.firstRenderMs ?? event('first-render')?.elapsedMs ?? null,
    interactiveMs: profiler.interactiveMs ?? event('interactive')?.elapsedMs ?? event('engine-interactive')?.elapsedMs ?? null,
    fullyLoadedMs: profiler.fullyLoadedMs ?? event('fully-loaded')?.elapsedMs ?? null,
    events: (profiler.events || []).filter(item => ['first-render', 'interactive', 'engine-interactive', 'fully-loaded', 'registry:ready'].includes(item.name)),
  };
}

async function appState(page) {
  return page.evaluate(() => {
    const preview = globalThis.__BABYLON_PREVIEW__;
    if (preview) {
      const diagnostics = typeof preview.diagnostics === 'function' ? preview.diagnostics() : (preview.diagnostics || null);
      const map = preview.assets?.map?.e3t1 || preview.assets?.map;
      const legacy = preview.assets?.legacy?.e3t1 || preview.assets?.legacy || map?.legacyManifest;
      const sourceModels = legacy?.models || [];
      const profiler = preview.assets?.profiler?.snapshot?.() || preview.profiler?.snapshot?.() || null;
      const bundles = preview.assets?.manifest?.bundles || {};
      const mapBundlePaths = Object.values(bundles).map(bundle => bundle.url).filter(Boolean);
      const canvas = preview.engine?.getRenderingCanvas?.();
      const gl = canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl');
      let gpu = null;
      try {
        const debug = gl?.getExtension?.('WEBGL_debug_renderer_info');
        gpu = debug ? {
          vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
        } : null;
      } catch {}
      return {
        kind: 'preview',
        ready: Boolean(preview.isReady),
        fullyLoaded: Boolean(preview.isFullyLoaded),
        assetVersion: preview.assets?.config?.assetVersion ?? diagnostics?.assetVersion ?? null,
        mapBundlePaths,
        contentCounts: {
          modelRecords: map?.models?.length ?? sourceModels.length,
          placements: sourceModels.reduce((sum, model) => sum + (model?.matrices?.length || 0), 0),
          loadedModels: diagnostics?.loadedModels ?? preview.stats?.loader?.loadedModels ?? null,
          instantiatedModels: diagnostics?.instantiatedModels ?? null,
          failures: diagnostics?.failures?.length ?? preview.stats?.loader?.failures?.length ?? null,
          materials: new Set((map?.models || []).flatMap(model => model?.materialResources || [])).size,
          bundles: Object.keys(preview.assets?.manifest?.bundles || {}).length,
          meshes: diagnostics?.meshCount ?? null,
          triangles: diagnostics?.triangleCount ?? null,
        },
        renderer: {
          backend: preview.engine?.webGLVersion >= 2 ? 'WebGL2' : `WebGL${preview.engine?.webGLVersion || 0}`,
          fps: preview.engine?.getFps?.() ?? null,
          drawCalls: preview.engine?._drawCalls?.current ?? preview.engine?._drawCalls?.count ?? preview.engine?.getDrawCalls?.() ?? null,
          fov: preview.camera?.fov ?? null,
          fovUnit: 'radians',
          cameraPosition: preview.camera ? [preview.camera.position.x, preview.camera.position.y, preview.camera.position.z] : null,
          gpu,
          shadowQuality: preview.shadowQuality ?? preview.stats?.shadowQuality ?? null,
          lod: preview.lod?.enabled ?? preview.stats?.lod?.enabled ?? null,
        },
        profiler,
        textureUpgrade: (() => {
          const upgrade = preview.stats?.textureUpgrade || diagnostics?.textureUpgrade || null;
          const material = diagnostics?.materials || {};
          return upgrade ? {
            requested: upgrade.requested ?? null,
            upgraded: upgrade.upgraded ?? upgrade.completed ?? null,
            rejected: upgrade.rejected ?? 0,
            missing: upgrade.missing ?? 0,
            failures: Array.isArray(preview.stats?.textureUpgradeFailures) ? preview.stats.textureUpgradeFailures : (Array.isArray(upgrade.failures) ? upgrade.failures : []),
            createdMaterials: material.createdMaterials ?? null,
            legacyUpgrades: material.upgrades ?? null,
            previewTextures: material.textures?.preview ?? null,
            fullTextures: material.textures?.full ?? null,
            missingTextures: Object.keys(material.missing?.textures || {}).length,
          } : material.createdMaterials !== undefined ? {
            requested: material.createdMaterials ?? null,
            upgraded: material.upgrades ?? null,
            rejected: 0,
            missing: Object.keys(material.missing?.textures || {}).length,
            failures: [],
            createdMaterials: material.createdMaterials ?? null,
            legacyUpgrades: material.upgrades ?? null,
            previewTextures: material.textures?.preview ?? null,
            fullTextures: material.textures?.full ?? null,
            missingTextures: Object.keys(material.missing?.textures || {}).length,
          } : null;
        })(),
        diagnostics,
      };
    }
    const world = globalThis.__APP__?.world;
    const scene = world?.assetScene;
    const manifest = scene?.manifest || world?.importedManifest;
    const map = scene?.map;
    const profiler = globalThis.__ASSET_PROFILER__?.snapshot?.() || null;
    const canvas = world?.renderer?.domElement;
    const gl = world?.renderer?.getContext?.() || canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl');
    let gpu = null;
    try {
      const debug = gl?.getExtension?.('WEBGL_debug_renderer_info');
      gpu = debug ? {
        vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
      } : null;
    } catch {}
    const legacyBundles = globalThis.__ASSET_RUNTIME__?.manifest?.bundles || {};
    return {
      kind: 'legacy',
      ready: Boolean(world && !world.loading && world.isImported && (world.sceneId === 'e3t1' || world.requestedSceneId === 'e3t1')),
      fullyLoaded: Boolean(world && !world.loading && (!scene?.streaming || scene?.streamError)),
      assetVersion: globalThis.__ASSET_RUNTIME__?.manifest?.releaseId ?? null,
      mapBundlePaths: Object.values(legacyBundles).map(bundle => bundle.url).filter(Boolean),
      contentCounts: {
        modelRecords: map?.models?.length ?? manifest?.models?.length ?? null,
        placements: map?.legacyManifest?.models?.reduce((sum, model) => sum + (model?.matrices?.length || 0), 0) ?? null,
        loadedModels: scene?.completed?.size ?? manifest?.models?.length ?? null,
        instantiatedModels: scene?.completed?.size ?? null,
        failures: scene?.streamError ? 1 : 0,
        materials: map?.models ? new Set(map.models.flatMap(model => model?.materialResources || [])).size : null,
        bundles: Object.keys(globalThis.__ASSET_RUNTIME__?.manifest?.bundles || {}).length || null,
        meshes: world?.sceneRoot?.children?.length ?? null,
        triangles: world?.renderer?.info?.render?.triangles ?? null,
        collisionBytes: manifest?.collisionBytes ?? null,
      },
      renderer: {
        backend: 'WebGL',
        fps: world?.renderer?.getFps?.() ?? null,
        drawCalls: world?.renderer?.info?.render?.calls ?? null,
        fov: world?.camera?.fov ?? null,
        fovUnit: 'degrees',
        cameraPosition: world?.camera ? [world.camera.position.x, world.camera.position.y, world.camera.position.z] : null,
        gpu,
        shadowQuality: world?.quality ?? null,
        lod: scene?.lod?.enabled ?? null,
      },
      profiler,
      diagnostics: {
        sceneId: world?.sceneId ?? null,
        loading: world?.loading ?? null,
        streaming: scene?.streaming ?? null,
        streamError: scene?.streamError?.message || null,
      },
    };
  });
}

async function waitForApp(page, kind, timeoutMs) {
  if (kind === 'preview') {
    await page.waitForFunction(() => Boolean(globalThis.__BABYLON_PREVIEW__?.ready), undefined, { timeout: timeoutMs });
    await withTimeout(page.evaluate(() => globalThis.__BABYLON_PREVIEW__.ready), timeoutMs, 'Timed out waiting for preview ready promise');
    await withTimeout(page.evaluate(() => globalThis.__BABYLON_PREVIEW__.fullyLoaded), timeoutMs, 'Timed out waiting for preview fullyLoaded promise');
    return;
  }
  await page.waitForFunction(() => {
    const world = globalThis.__APP__?.world;
    const scene = world?.assetScene;
    return Boolean(world && !world.loading && world.sceneId === 'e3t1' && world.isImported && (!scene?.streaming || scene?.streamError));
  }, undefined, { timeout: timeoutMs });
}

async function prepareFixedConditions(page, kind, { cameraPosition, cameraTarget, lodOff, mapOnly, fovRadians = TARGET_FOV_RADIANS }) {
  return page.evaluate(({ kind: rendererKind, cameraPosition: position, cameraTarget: target, lodOff: disableLod, mapOnly: hideMapActors, fovRadians: targetFovRadians }) => {
    const hidden = [];
    const setVisible = object => {
      if (!object || object.visible === false) return;
      hidden.push(object);
      object.visible = false;
    };
    if (rendererKind === 'preview') {
      const api = globalThis.__BABYLON_PREVIEW__;
      const camera = api.camera;
      if (camera) {
        camera.position.set(...position);
        camera.fov = targetFovRadians;
        camera.updateProjectionMatrix?.();
        const Vector = camera.position?.constructor;
        if (typeof camera.setTarget === 'function' && Vector) camera.setTarget(new Vector(...target));
      }
      let lodApplied = false;
      for (const fn of ['setLodEnabled', 'setLODEnabled', 'setLod']) {
        if (typeof api[fn] === 'function') { api[fn](!disableLod); lodApplied = true; break; }
      }
      if (api.lod && 'enabled' in api.lod) { api.lod.enabled = !disableLod; lodApplied = true; }
      if (api.stats?.lod && 'enabled' in api.stats.lod) api.stats.lod.enabled = !disableLod;
      return { kind: rendererKind, lodOff: disableLod, lodApplied, mapOnly: false, fov: camera?.fov ?? null, fovUnit: 'radians', fovRadians: camera?.fov ?? null, cameraPosition: camera ? [camera.position.x, camera.position.y, camera.position.z] : null };
    }
    const world = globalThis.__APP__?.world;
    const camera = world?.camera;
    if (camera) {
      const originalUpdateCamera = world.updateCamera;
      world.updateCamera = () => {
        camera.position.set(...position);
        camera.lookAt(...target);
      };
      camera.fov = targetFovRadians * 180 / Math.PI;
      camera.updateProjectionMatrix?.();
      world.__babylonBenchmarkRestore = () => { world.updateCamera = originalUpdateCamera; };
    }
    let lodApplied = false;
    if (world?.assetScene?.lod && 'enabled' in world.assetScene.lod) {
      world.assetScene.lod.enabled = !disableLod;
      lodApplied = true;
    }
    if (world?.setQuality) world.setQuality('high');
    if (world?.setInputEnabled) world.setInputEnabled(false);
    if (globalThis.__APP__?.audio?.pause) globalThis.__APP__.audio.pause();
    if (globalThis.__APP__?.audio?.setEnabled) globalThis.__APP__.audio.setEnabled(false);
    if (hideMapActors) {
      setVisible(world?.player);
      for (const character of world?.characters?.values?.() || []) setVisible(character?.root || character);
      for (const node of world?.sceneRoot?.children || []) {
        if (node?.userData?.entityId || node?.userData?.actor || node?.userData?.npc) setVisible(node);
      }
    }
    return { kind: rendererKind, lodOff: disableLod, lodApplied, mapOnly: hideMapActors, fov: camera?.fov ?? null, fovUnit: 'degrees', fovRadians: camera ? camera.fov * Math.PI / 180 : null, cameraPosition: camera ? [camera.position.x, camera.position.y, camera.position.z] : null, hiddenActorCount: hidden.length };
  }, { kind, cameraPosition, cameraTarget, lodOff, mapOnly, fovRadians });
}

async function setFixedTimePaused(page, kind) {
  return page.evaluate(async rendererKind => {
    const nearNoon = value => Number.isFinite(Number(value)) && Math.abs(Number(value) - 12) < 0.01;
    const compactResult = value => {
      if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
      if (typeof value === 'object') return { hour: value.hour ?? value.currentHour ?? null, paused: value.paused ?? null, preset: value.preset ?? null };
      return String(value);
    };
    if (rendererKind === 'preview') {
      const api = globalThis.__BABYLON_PREVIEW__;
      const attempts = [
        () => api.setTime?.(12),
        () => api.setTime?.({ hour: 12, paused: true }),
      ];
      const readState = () => {
        const environment = api.environment?.diagnostics?.() || api.environment?.state || {};
        const hour = [environment.currentHour, environment.hour, api.stats?.timeHour, api.stats?.hour, api.scene?.metadata?.ff14Hour]
          .map(Number).find(Number.isFinite) ?? null;
        const paused = [environment.paused, api.stats?.timePaused, api.stats?.paused]
          .find(value => typeof value === 'boolean') ?? null;
        return { hour, paused, preset: api.stats?.time ?? null };
      };
      const attemptsReport = [];
      for (const [index, attempt] of attempts.entries()) {
        try {
          const before = readState();
          const result = await attempt();
          await new Promise(resolve => setTimeout(resolve, 150));
          const after = readState();
          const stable = before.hour === null || after.hour === null || Math.abs(before.hour - after.hour) < 0.05;
          const exactSetterResult = typeof result === 'number' ? nearNoon(result) : Boolean(result && typeof result === 'object' && nearNoon(result.hour ?? result.currentHour));
          const exactSetter = exactSetterResult || (index === 0 && typeof result !== 'string' && nearNoon(after.hour));
          const paused = after.paused === true || (after.paused === null && stable);
          attemptsReport.push({ method: index === 0 ? 'number' : 'object', result: compactResult(result), before, after, exactSetter, paused });
          if (exactSetter && nearNoon(after.hour) && paused) return { requestedHour: 12, appliedHour: after.hour, paused: true, supported: true, setter: index === 0 ? 'number' : 'object', attempts: attemptsReport };
        } catch (error) {
          attemptsReport.push({ method: index === 0 ? 'number' : 'object', error: error?.message || String(error) });
        }
      }
      const finalState = readState();
      return { requestedHour: 12, appliedHour: finalState.hour, paused: finalState.paused, supported: false, setter: null, attempts: attemptsReport };
    }
    const time = globalThis.__APP__?.world?.worldTime;
    if (time?.setState) {
      const applied = time.setState({ hour: 12, paused: true });
      return { requestedHour: 12, appliedHour: applied?.hour ?? time.hour ?? null, paused: applied?.paused ?? time.paused ?? null, supported: nearNoon(applied?.hour ?? time.hour) && applied?.paused === true, setter: 'worldTime.setState' };
    }
    if (time?.setHour) {
      const applied = time.setHour(12);
      time.paused = true;
      return { requestedHour: 12, appliedHour: applied?.hour ?? time.hour ?? null, paused: applied?.paused ?? time.paused ?? null, supported: nearNoon(applied?.hour ?? time.hour) && time.paused === true, setter: 'worldTime.setHour' };
    }
    return { requestedHour: 12, appliedHour: null, paused: null, supported: false, setter: null };
  }, kind);
}

async function fpsSample(page, durationMs) {
  return page.evaluate(ms => new Promise(resolve => {
    const api = globalThis.__BABYLON_PREVIEW__;
    const renderer = api?.engine || globalThis.__APP__?.world?.renderer;
    let frames = 0;
    const start = performance.now();
    const tick = now => {
      frames++;
      if (now - start >= ms) {
        resolve({ fps: frames * 1000 / Math.max(1, now - start), frames, durationMs: now - start });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    void renderer;
  }), durationMs);
}

function collectBytes(responses, mapHints, legacyPattern) {
  const hints = mapHints.map(value => String(value).replace(/^https?:\/\/[^/]+/i, '').replace(/^\//, '').toLowerCase());
  const pattern = legacyPattern ? new RegExp(legacyPattern, 'i') : null;
  const http = responses.filter(item => isHttp(item.url));
  const isMap = item => {
    const stripped = stripQuery(item.url).toLowerCase();
    const pathName = stripped.replace(/^https?:\/\/[^/]+/i, '').replace(/^\//, '');
    if (hints.some(hint => pathName.endsWith(hint) || pathName.includes(hint))) return true;
    if (pattern?.test(stripped)) return true;
    return defaultMapBundle(stripped);
  };
  const mapResponses = http.filter(isMap);
  return {
    responseCount: http.length,
    encodedBytes: sum(http.map(item => item.encodedBytes)),
    mapBundleResponseCount: mapResponses.length,
    mapBundleEncodedBytes: sum(mapResponses.map(item => item.encodedBytes)),
    cacheHits: http.filter(item => item.fromDiskCache || item.fromServiceWorker || item.encodedBytes === 0).length,
    mapBundleCacheHits: mapResponses.filter(item => item.fromDiskCache || item.fromServiceWorker || item.encodedBytes === 0).length,
    mapBundleHints: hints,
  };
}

function benchmarkMetrics(state, bytes, fps, mode, label) {
  const profiler = profilerSnapshot(state);
  const fovRaw = state?.renderer?.fov ?? null;
  const fovRadians = state?.renderer?.fovUnit === 'degrees' && Number.isFinite(fovRaw)
    ? fovRaw * Math.PI / 180
    : fovRaw;
  return {
    label,
    mode,
    firstActualMapRenderMs: profiler.firstRenderMs,
    interactiveMs: profiler.interactiveMs,
    fullyLoadedMs: profiler.fullyLoadedMs,
    fpsAfterFull: round(fps?.fps, 2),
    fpsFrames: fps?.frames ?? null,
    fpsGate: state?.fpsGate || null,
    bytes,
    contentCounts: state?.contentCounts || null,
    renderer: state?.renderer || null,
    projection: {
      fovRaw,
      fovUnit: state?.renderer?.fovUnit ?? null,
      fovRadians: round(fovRadians, 6),
      targetFovRadians: TARGET_FOV_RADIANS,
      fovDeltaRadians: Number.isFinite(fovRadians) ? round(fovRadians - TARGET_FOV_RADIANS, 6) : null,
      cameraPosition: state?.renderer?.cameraPosition || null,
    },
    profiler: profiler,
    diagnostics: state?.diagnostics || null,
    assetVersion: state?.assetVersion ?? null,
    mapBundlePaths: state?.mapBundlePaths || [],
  };
}

async function waitForCacheWrites(page, timeoutMs) {
  await page.waitForFunction(() => {
    const previewPending = globalThis.__BABYLON_PREVIEW__?.assets?.runtime?.cache?.pendingWrites?.size;
    const mainPending = globalThis.__ASSET_RUNTIME__?.cache?.pendingWrites?.size;
    return (previewPending ?? mainPending ?? 0) === 0;
  }, undefined, { timeout: timeoutMs });
}

async function runPair(browser, { kind, url, timeoutMs, settleMs, fpsMs, cameraPosition, cameraTarget, lodOff, mapOnly, legacyPattern }) {
  const run = await newRun(browser);
  const target = new URL(url);
  if (kind === 'legacy') target.searchParams.set('scene', MAP_ID);
  let coldResult = null;
  const coldStartedAt = Date.now();
  const capture = async (mode, responseStart, fallbackHints, startedAt) => {
    const conditions = await prepareFixedConditions(run.page, kind, { cameraPosition, cameraTarget, lodOff, mapOnly, fovRadians: TARGET_FOV_RADIANS });
    const clock = await setFixedTimePaused(run.page, kind);
    await run.page.waitForTimeout(settleMs);
    const state = await appState(run.page);
    const content = state.contentCounts || {};
    const texture = state.textureUpgrade;
    const missingTextures = Array.isArray(texture?.missing) ? texture.missing.length : Number(texture?.missing || 0);
    const textureReady = kind !== 'preview' || Boolean(texture && texture.requested > 0 && texture.upgraded === texture.requested && texture.rejected === 0 && missingTextures === 0 && texture.missingTextures === 0 && texture.failures.length === 0);
    const contentReady = content.modelRecords === 807 && content.placements === 4461 && content.loadedModels === 807 && content.failures === 0;
    state.fpsGate = { contentReady, textureReady, sampled: contentReady && textureReady };
    const fps = state.fpsGate.sampled ? await fpsSample(run.page, fpsMs) : null;
    const hints = state.mapBundlePaths.length ? state.mapBundlePaths : fallbackHints;
    const bytes = collectBytes(run.responses.slice(responseStart), hints, legacyPattern);
    return {
      ...benchmarkMetrics(state, bytes, fps, mode, `${kind}-${mode === 'warm-reload' ? 'warm' : 'cold'}`),
      status: 'complete',
      elapsedMs: Date.now() - startedAt,
      conditions,
      clock,
      navigationUrl: target.href,
      network: run.responses.slice(responseStart).length,
    };
  };
  try {
    await run.page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForApp(run.page, kind, timeoutMs);
    coldResult = await capture('cold', 0, [], coldStartedAt);
    await waitForCacheWrites(run.page, timeoutMs);
    const responseStart = run.responses.length;
    const warmStartedAt = Date.now();
    await run.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForApp(run.page, kind, timeoutMs);
    const warmResult = await capture('warm-reload', responseStart, coldResult.mapBundlePaths, warmStartedAt);
    warmResult.cachePersistence = { coldAndWarmSameContext: true, pendingWritesZeroBeforeReload: true, preservedHttpCache: true, preservedCacheStorage: true };
    return [coldResult, warmResult];
  } catch (error) {
    const phase = coldResult ? 'warm-reload' : 'cold';
    const failed = {
      label: `${kind}-${phase}`,
      mode: phase,
      status: 'incomplete',
      elapsedMs: Date.now() - (coldResult ? coldStartedAt : coldStartedAt),
      error: error.message,
      diagnostic: await appState(run.page).catch(detailError => ({ error: detailError.message })),
    };
    return coldResult ? [coldResult, failed] : [failed];
  } finally {
    await run.context.close();
  }
}

async function benchmark(args) {
  const previewUrl = normalizeUrl(args['preview-url'] || DEFAULT_PREVIEW_URL);
  previewUrl.searchParams.set('viewer', '1');
  previewUrl.searchParams.set('scene', MAP_ID);
  const legacyUrl = normalizeUrl(args['legacy-url'] || DEFAULT_LEGACY_URL);
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const timeoutMs = numberOption(args.timeout, 600000);
  const settleMs = numberOption(args['settle-ms'], 1500);
  const fpsMs = numberOption(args['fps-ms'], 3000);
  const cameraPosition = parseVector(args['camera-position'], CAMERA_POSITION);
  const cameraTarget = parseVector(args['camera-target'], CAMERA_TARGET);
  const lodOff = !boolOption(args['lod-on'], false);
  const mapOnly = !boolOption(args['include-actors'], false);
  const legacyPattern = args['legacy-map-pattern'] || null;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mapId: MAP_ID,
    environment: {
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      cameraPosition,
      cameraTarget,
      fovRadians: 0.82,
      fovLegacyDegrees: LEGACY_FOV_DEGREES,
      timeHour: 12,
      timePaused: true,
      lodOff,
      mapOnly,
      pinnedPreviewAssetVersion: PINNED_ASSET_VERSION,
      pinnedLegacyRelease: PINNED_LEGACY_RELEASE,
      cdnCacheState: 'unknown',
      cold: 'new isolated browser context',
      warm: 'reload in the same context after pendingWrites reached zero; HTTP and CacheStorage preserved',
      pageBytesAndMapBundleBytesAreReportedSeparately: true,
      note: 'Legacy retains collision/character/runtime startup work unless map-only hooks successfully hide it; byte and FPS deltas are not a pure renderer claim.',
    },
    urls: { preview: previewUrl.href, legacy: legacyUrl.href },
    runs: [],
  };
  let browser;
  try {
    const { chromium } = await loadPlaywright(args['playwright-module-path'] || process.env.PLAYWRIGHT_MODULE_PATH);
    browser = await chromium.launch({ executablePath: args['browser-path'] || process.env.BROWSER_PATH || undefined, headless: !boolOption(args.headed, false), args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
    report.environment.browser = { engine: 'chromium', version: await browser.version() };
    report.runs.push(...await runPair(browser, { kind: 'preview', url: previewUrl.href, timeoutMs, settleMs, fpsMs, cameraPosition, cameraTarget, lodOff, mapOnly, legacyPattern }));
    if (!boolOption(args['skip-legacy'], false)) {
      report.runs.push(...await runPair(browser, { kind: 'legacy', url: legacyUrl.href, timeoutMs, settleMs, fpsMs, cameraPosition, cameraTarget, lodOff, mapOnly, legacyPattern }));
    }
    const previewVersions = report.runs.filter(run => run.label?.startsWith('preview-')).map(run => run.assetVersion).filter(Boolean);
    const legacyVersions = report.runs.filter(run => run.label?.startsWith('legacy-')).map(run => run.assetVersion).filter(Boolean);
    const actualPreviewVersion = previewVersions[0] || null;
    const actualLegacyRelease = legacyVersions[0] || null;
    report.assetVersionCheck = {
      expectedPreview: PINNED_ASSET_VERSION,
      expectedLegacy: PINNED_LEGACY_RELEASE,
      actualPreview: actualPreviewVersion,
      actualLegacy: actualLegacyRelease,
      previewMatches: previewVersions.length > 0 && previewVersions.every(version => version === PINNED_ASSET_VERSION),
      legacyMatches: boolOption(args['skip-legacy'], false) || (legacyVersions.length > 0 && legacyVersions.every(version => version === PINNED_LEGACY_RELEASE)),
      sharedReleaseBase: actualPreviewVersion?.startsWith(PINNED_LEGACY_RELEASE) === true && (boolOption(args['skip-legacy'], false) || actualLegacyRelease === PINNED_LEGACY_RELEASE),
    };
    const completeRuns = report.runs.filter(run => run.status === 'complete');
    const projectionAligned = completeRuns.length > 0 && completeRuns.every(run => Math.abs(run.projection?.fovDeltaRadians ?? Infinity) <= 0.0001);
    const clocksAligned = completeRuns.length > 0 && completeRuns.every(run => run.clock?.supported === true && Math.abs((run.clock?.appliedHour ?? Infinity) - 12) <= 0.01 && run.clock?.paused === true);
    const fpsReady = completeRuns.length > 0 && completeRuns.every(run => run.fpsGate?.sampled === true);
    report.comparisonChecks = {
      allRunsComplete: completeRuns.length === report.runs.length && report.runs.length > 0,
      projectionAligned,
      clocksAligned,
      fpsReady,
      assetVersionsAligned: report.assetVersionCheck?.sharedReleaseBase === true,
      limitedComparison: !(projectionAligned && clocksAligned && fpsReady && report.assetVersionCheck?.sharedReleaseBase === true),
    };
    report.status = report.comparisonChecks.allRunsComplete && !report.comparisonChecks.limitedComparison ? 'complete' : 'review';
  } catch (error) {
    report.status = 'error';
    report.error = error.message;
  } finally {
    await browser?.close();
  }
  await writeJson(outPath, report);
  const summary = {
    status: report.status,
    out: outPath,
    assetVersionCheck: report.assetVersionCheck || null,
    runs: report.runs.map(run => ({ label: run.label, status: run.status, firstActualMapRenderMs: run.firstActualMapRenderMs, interactiveMs: run.interactiveMs, fullyLoadedMs: run.fullyLoadedMs, fpsAfterFull: run.fpsAfterFull, pageEncodedBytes: run.bytes?.encodedBytes ?? null, mapBundleEncodedBytes: run.bytes?.mapBundleEncodedBytes ?? null, contentCounts: run.contentCounts })),
  };
  console.log(JSON.stringify(summary, null, 2));
  return report.status === 'complete' ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();
else {
  try { process.exitCode = await benchmark(args); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
