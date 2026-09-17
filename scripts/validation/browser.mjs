import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DEFAULT_OUT = 'work/validation/browser-report.json';
const MAX_EXCEPTIONS = 20;

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function asSceneIds(scenes) {
  if (!scenes) return null;
  const values = Array.isArray(scenes) ? scenes : String(scenes).split(',');
  const ids = [...new Set(values.map(value => typeof value === 'string' ? value.trim() : value?.id).filter(Boolean))];
  if (!ids.length) throw new Error('No scene ids were supplied');
  return ids;
}

async function loadPlaywright(modulePath) {
  const configured = modulePath || process.env.PLAYWRIGHT_MODULE_PATH;
  try {
    if (configured) {
      const resolved = path.resolve(configured);
      if (path.basename(resolved).toLowerCase() !== 'package.json') try {
        const module = await import(resolved);
        if (module.chromium) return module;
      } catch {
        // A module directory is more common than a direct entrypoint.
      }
      return createRequire(path.basename(resolved).toLowerCase() === 'package.json' ? resolved : path.join(resolved, 'package.json'))('playwright');
    }
    return require('playwright');
  } catch (error) {
    throw new Error(`Playwright could not be loaded. Install it or set PLAYWRIGHT_MODULE_PATH. ${error.message}`);
  }
}

async function catalogSceneIds(appUrl) {
  const activeUrl = new URL('extracted/active.json', appUrl);
  const response = await fetch(activeUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Active scene directory returned HTTP ${response.status}`);
  const active = await response.json();
  const scenes = Array.isArray(active.scenes)
    ? active.scenes.map(scene => typeof scene === 'string' ? scene : scene?.id)
    : Object.keys(active.scenes || {});
  const ids = [...new Set(scenes.filter(Boolean))];
  if (!ids.length) throw new Error('Active scene directory has no scenes');
  return ids;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutError() {
  const error = new Error('Timed out waiting for the bootstrap render gate');
  error.kind = 'timeout';
  return error;
}

async function within(promise, ms) {
  if (ms <= 0) throw timeoutError();
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function classifyError(error) {
  if (error?.kind) return error.kind;
  if (/timed out|timeout/i.test(error?.message || '')) return 'timeout';
  return 'runtime-error';
}

async function probe(page, id) {
  return page.evaluate(sceneId => {
    const world = window.__APP__?.world;
    const overlay = document.querySelector('#loading');
    const style = overlay ? getComputedStyle(overlay) : null;
    const calls = world?.engine?._drawCalls?.current ?? world?.renderer?.info?.render?.calls ?? 0;
    const groupChildren = world?.sceneRoot?.getChildMeshes?.().length ?? world?.sceneRoot?.children?.length ?? 0;
    const overlayHidden = !overlay || (style.visibility === 'hidden' && Number(style.opacity) <= 0.01);
    const native = Boolean(world?.engine && world?.scene?.getEngine?.() === world.engine);
    const loader = world?.mapLoader;
    const assets = world?.assetScene?.assets;
    const sample = loader?.records?.find(record => record.instantiated && record.resourceId);
    const nativeMapReady = !native || (assets?.mapId === sceneId && loader?.state?.instantiatedModels > 0 && loader?.state?.meshCount > 0);
    return {
      appReady: Boolean(world),
      targetScene: sceneId,
      sceneId: world?.sceneId ?? null,
      requestedSceneId: world?.requestedSceneId ?? null,
      loading: world?.loading ?? null,
      imported: Boolean(world?.isImported),
      loadError: world?.loadError ?? null,
      navigation: Boolean(world?.navigation),
      groupChildren,
      renderCalls: calls,
      overlayHidden,
      inputEnabled: world?.input?.enabled ?? null,
      evidence: native ? {
        title: document.title,
        displayName: document.querySelector('#scene-name')?.textContent || sceneId,
        entryScript: document.querySelector('script[type="module"][src]')?.getAttribute('src') || null,
        engine: 'Babylon.js',
        engineVersion: world.engine.constructor.Version || null,
        backend: `WebGL${world.engine.webGLVersion}`,
        mapId: assets?.mapId || null,
        manifest: assets?.manifestPath || null,
        sampleResourceId: sample?.resourceId || null,
        sampleVertices: sample?.template?.meshes?.[0]?.mesh?.getTotalVertices?.() || 0,
        instantiatedModels: loader?.state?.instantiatedModels || 0,
        meshes: loader?.state?.meshCount || 0,
        sourcePlacements: loader?.state?.sourcePlacementCount || 0,
      } : null,
      ready: Boolean(world && world.sceneId === sceneId && !world.loading && world.isImported && world.navigation && groupChildren > 0 && calls > 0 && overlayHidden && nativeMapReady),
    };
  }, id);
}

async function waitForBootstrap(page, id, deadline, fatal) {
  let lastState = null;
  while (Date.now() < deadline) {
    if (fatal.error) {
      const error = new Error(fatal.error);
      error.kind = 'js-fatal';
      throw error;
    }
    lastState = await within(probe(page, id), deadline - Date.now());
    if (lastState.loadError) {
      const error = new Error(lastState.loadError);
      error.kind = 'world-load-error';
      throw error;
    }
    if (lastState.ready) return lastState;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  if (fatal.error) {
    const error = new Error(fatal.error);
    error.kind = 'js-fatal';
    throw error;
  }
  const error = timeoutError();
  error.lastState = lastState;
  throw error;
}

async function inspectAppearance(page) {
  return page.evaluate(() => {
    const world = window.__APP__?.world;
    let meshes = 0;
    let positionedMeshes = 0;
    let materials = 0;
    let texturedMaterials = 0;
    let loadedTextures = 0;
    const inspectNode = node => {
      if (typeof node.getTotalVertices === 'function') {
        if (!node.getTotalVertices()) return;
        meshes++;
        positionedMeshes++;
        const list = node.material?.subMaterials || [node.material];
        for (const material of list) {
          if (!material) continue;
          materials++;
          const texture = material.albedoTexture || material.diffuseTexture;
          if (texture) {
            texturedMaterials++;
            if (texture.isReady()) loadedTextures++;
          }
        }
        return;
      }
      if (!node.isMesh) return;
      meshes++;
      if ((node.geometry?.attributes?.position?.count || 0) > 0) positionedMeshes++;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!material) continue;
        materials++;
        if (material.map) {
          texturedMaterials++;
          if (material.map.image?.width > 0 && material.map.image?.height > 0) loadedTextures++;
        }
      }
    };
    if (world?.sceneRoot?.getChildMeshes) world.sceneRoot.getChildMeshes().forEach(inspectNode);
    else world?.sceneRoot?.traverse?.(inspectNode);
    return {
      sceneVisible: world?.scene?.visible !== false && world?.sceneRoot?.visible !== false && (world?.renderer?.info?.render?.calls || 0) > 0,
      meshes,
      positionedMeshes,
      materials,
      texturedMaterials,
      loadedTextures,
      geometryEmpty: meshes === 0 || positionedMeshes === 0,
      texturesAbsent: materials > 0 && texturedMaterials === 0,
    };
  });
}

async function observeRepresentative(page, observeMs, deadline) {
  const observationStartedAt = Date.now();
  const before = await page.evaluate(() => {
    const world = window.__APP__.world;
    return { position: [world.player.position.x, world.player.position.y, world.player.position.z],
      azimuth: world.azimuth, camera: [world.camera.rotation.x, world.camera.rotation.y, world.camera.rotation.z] };
  });
  await page.keyboard.down('KeyW');
  await within(sleep(Math.min(350, Math.max(100, observeMs))), deadline - Date.now());
  await page.keyboard.up('KeyW');
  const moved = await page.evaluate(beforePosition => {
    const position = window.__APP__.world.player.position;
    return Math.hypot(position.x - beforePosition[0], position.y - beforePosition[1], position.z - beforePosition[2]);
  }, before.position);
  let reverseDistance = null;
  if (moved <= 0.01) {
    const reverseStart = await page.evaluate(() => {
      const p = window.__APP__.world.player.position;
      return [p.x, p.y, p.z];
    });
    await page.keyboard.down('KeyS');
    await within(sleep(Math.min(350, Math.max(100, observeMs))), deadline - Date.now());
    await page.keyboard.up('KeyS');
    reverseDistance = await page.evaluate(beforePosition => {
      const position = window.__APP__.world.player.position;
      return Math.hypot(position.x - beforePosition[0], position.y - beforePosition[1], position.z - beforePosition[2]);
    }, reverseStart);
  }

  const canvas = page.locator('#world');
  const box = await canvas.boundingBox();
  let cameraDelta = 0;
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 20, { steps: 3 });
    await page.mouse.up({ button: 'right' });
    cameraDelta = await page.evaluate(beforeAzimuth => Math.abs(window.__APP__.world.azimuth - beforeAzimuth), before.azimuth);
  }
  const elapsed = Date.now() - observationStartedAt;
  await within(sleep(Math.max(0, observeMs - elapsed)), deadline - Date.now());
  const appearance = await within(inspectAppearance(page), deadline - Date.now());
  return {
    keyWDistance: Number(moved.toFixed(3)),
    keySDistance: reverseDistance === null ? null : Number(reverseDistance.toFixed(3)),
    cameraDelta: Number(cameraDelta.toFixed(3)),
    keyWMoved: moved > 0.01,
    movementObserved: moved > 0.01 || (reverseDistance !== null && reverseDistance > 0.01),
    cameraDragged: cameraDelta > 0.001,
    appearance,
  };
}

async function diagnostic(page) {
  try {
    return await within(page.evaluate(() => {
      const world = window.__APP__?.world;
      return {
        sceneId: world?.sceneId ?? null,
        requestedSceneId: world?.requestedSceneId ?? null,
        loading: world?.loading ?? null,
        imported: world?.isImported ?? null,
        loadError: world?.loadError ?? null,
        navigation: Boolean(world?.navigation),
        groupChildren: world?.sceneRoot?.children?.length ?? null,
        renderCalls: world?.renderer?.info?.render?.calls ?? null,
      };
    }), 1000);
  } catch (error) {
    return { probeError: error.message };
  }
}

async function inspectScene(browser, { appUrl, id, timeoutMs, representative, observeMs }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(Math.max(1, timeoutMs));
  const warnings = [];
  const fatal = { error: null };
  let closing = false;
  page.on('pageerror', error => { if (!closing && !fatal.error) fatal.error = error.message; });
  page.on('console', message => {
    if (closing || message.type() !== 'error') return;
    const text = message.text();
    if (/Client map import|Uncaught (?:ReferenceError|TypeError|SyntaxError)|Failed to load module script/i.test(text)) fatal.error ||= text;
  });
  page.on('requestfailed', request => {
    if (!closing) warnings.push({ type: 'request-failed', url: request.url(), error: request.failure()?.errorText || null });
  });

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let bootstrap = null;
  let observation = null;
  try {
    const target = new URL(appUrl);
    target.searchParams.set('scene', id);
    const navigationBudget = deadline - Date.now();
    if (navigationBudget <= 0) throw timeoutError();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: navigationBudget });
    bootstrap = await waitForBootstrap(page, id, deadline, fatal);
    if (representative) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      observation = await observeRepresentative(page, Math.min(observeMs, remaining), deadline);
      if (fatal.error) {
        const error = new Error(fatal.error);
        error.kind = 'js-fatal';
        throw error;
      }
      const postObservation = await within(probe(page, id), deadline - Date.now());
      if (postObservation.loadError) {
        const error = new Error(postObservation.loadError);
        error.kind = 'world-load-error';
        throw error;
      }
      if (!observation.appearance.sceneVisible || observation.appearance.geometryEmpty) {
        const error = new Error('Representative runtime interaction or geometry check failed');
        error.kind = 'representative-observation';
        error.observation = observation;
        throw error;
      }
      if (!observation.movementObserved) warnings.push({ type: 'review-movement-unconfirmed', text: 'Movement was blocked or unconfirmed; inspect this representative manually.' });
      if (!observation.cameraDragged) warnings.push({ type: 'review-camera-unconfirmed', text: 'Camera drag was unconfirmed; inspect this representative manually.' });
      if (observation.appearance.texturesAbsent) warnings.push({ type: 'review-textures-absent', text: 'No material map was found; inspect this representative manually.' });
    }
    return { id, status: 'pass', durationMs: Date.now() - startedAt, warnings, bootstrap, observation };
  } catch (error) {
    const kind = classifyError(error);
    return {
      id,
      status: kind === 'timeout' ? 'timeout' : 'fail',
      durationMs: Date.now() - startedAt,
      reason: kind,
      message: error.message,
      warnings,
      bootstrap,
      observation: error.observation || observation,
      diagnostic: await diagnostic(page),
    };
  } finally {
    closing = true;
    await context.close();
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function runValidation({ url, scenes, timeoutMs = 30000, concurrency = 2, out = DEFAULT_OUT, browserPath, playwrightModulePath, representative = false, observeMs = 1500, headed = false }) {
  if (!url) throw new Error('url is required');
  const appUrl = normalizeUrl(url);
  const outPath = path.resolve(out);
  const requested = asSceneIds(scenes);
  const scope = requested ? 'subset' : 'all';
  let sceneIds;
  try {
    sceneIds = requested || await catalogSceneIds(appUrl);
  } catch (error) {
    const summary = {
      counts: { maps: 0, pass: 0, fail: 0, timeout: 0 }, totalMs: 0, averageMapMs: 0,
      exceptions: [{ id: 'global', status: 'FAIL', reason: 'scene-directory', detailPath: null }], reportPath: outPath, scope,
      wallTimeMs: 0, agentExceptionCount: 1, failedMapIds: [], globalError: error.message,
    };
    await writeJson(outPath, { generatedAt: new Date().toISOString(), mode: representative ? 'representative' : 'smoke', url: appUrl.href, ...summary });
    return summary;
  }

  const runStartedAt = Date.now();
  const results = [];
  let globalError = null;
  let browser = null;
  try {
    const { chromium } = await loadPlaywright(playwrightModulePath);
    browser = await chromium.launch({ executablePath: browserPath || process.env.BROWSER_PATH || undefined, headless: !headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl', '--enable-unsafe-swiftshader'] });
    const limit = Math.max(1, Math.min(Number(concurrency) || 2, sceneIds.length));
    let next = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
      while (next < sceneIds.length) {
        const id = sceneIds[next++];
        results.push(await inspectScene(browser, { appUrl, id, timeoutMs: Number(timeoutMs) || 30000, representative, observeMs: Number(observeMs) || 1500 }));
      }
    }));
  } catch (error) {
    globalError = error.message;
  } finally {
    await browser?.close();
  }

  const failures = results.filter(result => result.status !== 'pass');
  const exceptions = [];
  for (const result of failures) {
    const detailPath = path.join(path.dirname(outPath), `${path.basename(outPath, path.extname(outPath))}.failures`, `${encodeURIComponent(result.id)}.json`);
    try {
      await writeJson(detailPath, { generatedAt: new Date().toISOString(), mode: representative ? 'representative' : 'smoke', url: appUrl.href, ...result });
    } catch (error) {
      result.warning = `Could not write failure detail: ${error.message}`;
    }
    if (exceptions.length < MAX_EXCEPTIONS) exceptions.push({ id: result.id, status: result.status === 'timeout' ? 'TIMEOUT' : 'FAIL', reason: result.reason, detailPath });
  }
  for (const result of results.filter(result => result.status === 'pass' && result.warnings?.length)) {
    if (exceptions.length >= MAX_EXCEPTIONS) break;
    exceptions.push({ id: result.id, status: 'WARN', reason: result.warnings[0].type, detailPath: null });
  }
  if (globalError && exceptions.length < MAX_EXCEPTIONS) exceptions.push({ id: 'global', status: 'FAIL', reason: 'browser-startup', detailPath: null });

  const totalMs = results.reduce((total, result) => total + result.durationMs, 0);
  const counts = {
    maps: sceneIds.length,
    pass: results.filter(result => result.status === 'pass').length,
    fail: failures.filter(result => result.status === 'fail').length + (globalError ? Math.max(0, sceneIds.length - results.length) : 0),
    timeout: failures.filter(result => result.status === 'timeout').length,
  };
  const summary = {
    counts,
    totalMs,
    averageMapMs: results.length ? Math.round(totalMs / results.length) : 0,
    exceptions,
    reportPath: outPath,
    scope,
    wallTimeMs: Date.now() - runStartedAt,
    agentExceptionCount: failures.length + (globalError ? 1 : 0),
    failedMapIds: failures.map(result => result.id),
    ...(globalError ? { globalError } : {}),
  };
  const manualReview = representative ? {
    automaticChecksAreNotVisualSignoff: true,
    taskSpecific: 'Confirm the scene is visually populated and terrain/textures are plausible for the validation task.',
    urls: sceneIds.map(id => {
      const target = new URL(appUrl);
      target.searchParams.set('scene', id);
      return target.href;
    }),
    checklist: ['Confirm visible scene population.', 'Confirm terrain and texture plausibility.', 'Confirm movement and camera response.'],
  } : null;
  await writeJson(outPath, {
    generatedAt: new Date().toISOString(),
    mode: representative ? 'representative' : 'smoke',
    url: appUrl.href,
    timeoutMs: Number(timeoutMs) || 30000,
    concurrency: representative ? 1 : Math.max(1, Number(concurrency) || 2),
    observeMs: representative ? Number(observeMs) || 1500 : null,
    manualReview,
    results: results.map(result => ({
      id: result.id, status: result.status, durationMs: result.durationMs,
      reason: result.reason || null, message: result.message || null,
      sceneId: result.bootstrap?.sceneId || null,
      evidence: result.bootstrap?.evidence || null,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    ...summary,
  });
  return representative ? { ...summary, manualReview } : summary;
}

export async function runSmoke(options) {
  return runValidation({ ...options, representative: false });
}

export async function runRepresentative(options) {
  return runValidation({ ...options, representative: true, concurrency: 1 });
}

// Shared by bounded feature validators that need the same Playwright module
// resolution as the fast smoke/representative checks.
export { loadPlaywright };
