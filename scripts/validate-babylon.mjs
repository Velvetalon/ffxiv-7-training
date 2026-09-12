#!/usr/bin/env node
/**
 * Bounded Babylon Kugane validation.
 *
 * This script intentionally knows only the isolated preview contract. It does
 * not enumerate the main catalog and never invokes the all-map validators.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './validation/browser.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:4173/ff14-web-babylon-preview/';
const DEFAULT_OUT = path.join(REPO_ROOT, 'work', 'babylon-preview', 'validation.json');
const DEFAULT_SCREENSHOT_DIR = path.join(REPO_ROOT, 'work', 'babylon-preview', 'views');
const EXPECTED = {
  title: 'FFXIV · Babylon World Preview',
  mapId: 'e3t1',
  territoryId: 628,
  assetVersion: '20260909T124255Z-e3ea44',
  modelRecords: 807,
  placements: 4461,
  materialResources: 324,
  bundles: 112,
};
const DEFAULT_VIEWS = ['overlook', 'street', 'material', 'water'];
const DEFAULT_TIMES = ['day', 'dusk', 'night'];

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

function listOption(value, fallback) {
  if (value === undefined || value === true) return fallback.slice();
  const values = String(value).split(',').map(item => item.trim()).filter(Boolean);
  return values.length ? [...new Set(values)] : fallback.slice();
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.searchParams.set('viewer', '1');
  url.searchParams.set('scene', 'e3t1');
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

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function vector(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.slice(0, 3).map(item => round(Number(item), 4));
  return ['x', 'y', 'z'].map(key => round(Number(value[key]), 4));
}

function distance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(...a.map((value, index) => value - b[index]));
}

function usage() {
  console.log(`Usage: node scripts/validate-babylon.mjs --url=URL [options]

Options:
  --url=URL                 Babylon preview URL (default: ${DEFAULT_URL})
  --out=FILE                JSON report (default: work/babylon-preview/validation.json)
  --screenshots=DIR         PNG directory (default: work/babylon-preview/views)
  --views=a,b,c             Fixed views (default: ${DEFAULT_VIEWS.join(',')})
  --times=a,b,c             Time presets (default: ${DEFAULT_TIMES.join(',')})
  --timeout=MS              Readiness/full-load timeout (default: 600000)
  --settle-ms=MS            Wait after viewpoint/time changes (default: 700)
  --browser-path=PATH       Chromium executable
  --playwright-module-path  Existing Playwright package.json/module path
  --source-root=PATH        Independent source export root for map checker
  --skip-screenshots=true   Keep QA report but do not capture PNGs
  --skip-map-check=true     Do not invoke check-map-position.mjs
  --help`);
}

async function pageApiState(page) {
  return page.evaluate(async () => {
    const pageRound = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
    const preview = globalThis.__BABYLON_PREVIEW__;
    if (!preview) return { present: false };
    const engine = preview.engine;
    const scene = preview.scene;
    const camera = preview.camera;
    const canvas = engine?.getRenderingCanvas?.() || document.querySelector('#babylon-canvas');
    let webgl2Context = null;
    try { webgl2Context = canvas?.getContext('webgl2'); } catch {}
    const materials = scene?.materials || [];
    const meshes = scene?.meshes || [];
    const cells = meshes.filter(mesh => String(mesh.name || '').startsWith('KuganeCell:'));
    const signs = new Map();
    for (const cell of cells) {
      const sign = cell.metadata?.ff14?.determinantSign || 'unknown';
      const key = String(cell.metadata?.ff14?.key || cell.name);
      if (!signs.has(key)) signs.set(key, new Set());
      signs.get(key).add(sign);
    }
    const materialKinds = {};
    let texturedMaterials = 0;
    let doubleSidedMaterials = 0;
    let unlitMaterials = 0;
    let materialErrors = 0;
    const textureKeys = new Set();
    const geometryAudit = { meshes: 0, empty: 0, missingPosition: 0, missingNormal: 0, missingUv: 0, invalidBounds: 0 };
    for (const mesh of meshes) {
      geometryAudit.meshes++;
      try {
        const vertices = mesh.getTotalVertices?.() ?? 0;
        if (!vertices) geometryAudit.empty++;
        if (!mesh.isVerticesDataPresent?.('position')) geometryAudit.missingPosition++;
        if (!mesh.isVerticesDataPresent?.('normal')) geometryAudit.missingNormal++;
        if (!mesh.isVerticesDataPresent?.('uv')) geometryAudit.missingUv++;
        const bounds = mesh.getBoundingInfo?.()?.boundingBox;
        const vectors = [bounds?.minimum, bounds?.maximum];
        if (vectors.some(vector => vector && ![vector.x, vector.y, vector.z].every(Number.isFinite))) geometryAudit.invalidBounds++;
      } catch {
        geometryAudit.empty++;
      }
    }
    for (const material of materials) {
      const kind = material?.getClassName?.() || material?.constructor?.name || 'unknown';
      materialKinds[kind] = (materialKinds[kind] || 0) + 1;
      const textures = [
        material?.albedoTexture, material?.baseTexture, material?.ambientTexture,
        material?.bumpTexture, material?.metallicTexture, material?.reflectivityTexture,
        material?.emissiveTexture, material?.opacityTexture, material?.lightmapTexture,
      ].filter(Boolean);
      if (textures.length) texturedMaterials++;
      for (const texture of textures) textureKeys.add(texture.uniqueId || texture.name || String(texture));
      if (material.backFaceCulling === false || material.side === 2) doubleSidedMaterials++;
      if (material.disableLighting === true || material.unlit === true) unlitMaterials++;
      if (material.isReady) {
        try { if (!material.isReady(scene)) materialErrors++; } catch { materialErrors++; }
      }
    }
    const legacy = preview.assets?.legacy?.e3t1 || preview.assets?.legacy || preview.assets?.map?.legacyManifest;
    const map = preview.assets?.map?.e3t1 || preview.assets?.map;
    const manifest = preview.assets?.manifest;
    const sourceModels = legacy?.models || [];
    const sourcePlacements = sourceModels.reduce((sum, model) => sum + (model?.matrices?.length || 0), 0);
    const sourceMaterialResources = new Set((map?.models || []).flatMap(model => model?.materialResources || [])).size;
    const resources = manifest?.resources || {};
    const resourceKinds = {};
    for (const resource of Object.values(resources)) {
      const kind = resource?.type || resource?.kind || resource?.metadata?.kind || 'unknown';
      resourceKinds[kind] = (resourceKinds[kind] || 0) + 1;
    }
    const runtimeSnapshotFactory = preview.requestedRuntimeSnapshot || preview.getRuntimeSnapshot || preview.runtimeSnapshot;
    let runtimeSnapshot = null;
    if (typeof runtimeSnapshotFactory === 'function') runtimeSnapshot = await runtimeSnapshotFactory();
    else if (runtimeSnapshotFactory?.then) runtimeSnapshot = await runtimeSnapshotFactory;
    else if (runtimeSnapshotFactory) runtimeSnapshot = runtimeSnapshotFactory;
    const profiler = preview.assets?.profiler?.snapshot?.() || preview.profiler?.snapshot?.() || null;
    const event = name => profiler?.events?.find(item => item.name === name) || null;
    const diagnostics = typeof preview.diagnostics === 'function' ? await preview.diagnostics() : (preview.diagnostics || null);
    const runtimeWorldMatrices = diagnostics?.runtimeWorldMatrices || [];
    const transformKeys = new Set();
    const transformAudit = { count: runtimeWorldMatrices.length, uniquePlacements: 0, repeatedPrimitiveRecords: 0, invalid: 0, outliers: [] };
    for (const entry of runtimeWorldMatrices) {
      const matrix = entry?.matrix;
      if (!Array.isArray(matrix) || matrix.length !== 16 || !matrix.every(Number.isFinite)) transformAudit.invalid++;
      const key = `${entry?.modelIndex}:${entry?.instanceIndex}`;
      if (transformKeys.has(key)) transformAudit.repeatedPrimitiveRecords++;
      else transformKeys.add(key);
      const position = Array.isArray(matrix) ? matrix.slice(12, 15) : null;
      if (position?.length === 3 && position.some(value => Math.abs(value) > 5000)) {
        if (transformAudit.outliers.length < 20) transformAudit.outliers.push({ key, position });
      }
    }
    transformAudit.uniquePlacements = transformKeys.size;
    return {
      present: true,
      isReady: Boolean(preview.isReady),
      isFullyLoaded: Boolean(preview.isFullyLoaded),
      keys: Object.keys(preview).sort(),
      engine: {
        webGLVersion: engine?.webGLVersion ?? null,
        webgl2Context: Boolean(webgl2Context),
        renderWidth: engine?.getRenderWidth?.() ?? null,
        renderHeight: engine?.getRenderHeight?.() ?? null,
        fps: pageRound(engine?.getFps?.(), 1),
        drawCalls: engine?._drawCalls?.current ?? engine?._drawCalls?.count ?? engine?.getDrawCalls?.() ?? null,
      },
      scene: {
        meshCount: meshes.length,
        enabledMeshCount: meshes.filter(mesh => mesh.isEnabled?.() !== false && mesh.isVisible !== false).length,
        activeMeshCount: scene?.getActiveMeshes?.()?.length ?? null,
        materialCount: materials.length,
        texturedMaterials: texturedMaterials,
        textureCount: textureKeys.size,
        materialKinds,
        doubleSidedMaterials,
        unlitMaterials,
        materialErrors,
        geometryAudit,
        transformAudit,
        globalDoubleSided: materials.length > 0 && doubleSidedMaterials === materials.length,
        globalUnlit: materials.length > 0 && unlitMaterials === materials.length,
        environmentTexture: Boolean(scene?.environmentTexture),
        environmentReady: Boolean(scene?.environmentTexture?.isReady?.()),
        clearColor: scene?.clearColor ? {
          r: Number(scene.clearColor.r?.toFixed?.(4) ?? scene.clearColor.r),
          g: Number(scene.clearColor.g?.toFixed?.(4) ?? scene.clearColor.g),
          b: Number(scene.clearColor.b?.toFixed?.(4) ?? scene.clearColor.b),
          a: Number(scene.clearColor.a?.toFixed?.(4) ?? scene.clearColor.a ?? 1),
        } : null,
        fogMode: scene?.fogMode ?? null,
        fogDensity: scene?.fogDensity ?? null,
        lightCount: scene?.lights?.length ?? 0,
        cellCount: cells.length,
        mixedDeterminantCells: [...signs].filter(([, values]) => values.size > 1).map(([key, values]) => ({ key, signs: [...values] })).slice(0, 20),
      },
      source: {
        modelRecords: sourceModels.length,
        placements: sourcePlacements,
        materialResources: sourceMaterialResources,
        manifestResourceCount: Object.keys(resources).length,
        resourceKinds,
        bundleCount: Object.keys(manifest?.bundles || {}).length,
        mapId: map?.legacyManifest?.scene || legacy?.scene || diagnostics?.mapId || null,
        territoryId: map?.legacyManifest?.territoryId || legacy?.territoryId || null,
        assetVersion: preview.assets?.config?.assetVersion || diagnostics?.assetVersion || null,
      },
      camera: {
        position: camera?.position ? [camera.position.x, camera.position.y, camera.position.z].map(value => pageRound(value, 4)) : null,
        rotation: camera?.rotation ? [camera.rotation.x, camera.rotation.y, camera.rotation.z].map(value => pageRound(value, 4)) : null,
        rotationQuaternion: camera?.rotationQuaternion ? [camera.rotationQuaternion.x, camera.rotationQuaternion.y, camera.rotationQuaternion.z].map(value => pageRound(value, 4)) : null,
        fov: pageRound(camera?.fov, 6),
        speed: pageRound(camera?.speed, 4),
        minZ: pageRound(camera?.minZ, 4),
        maxZ: pageRound(camera?.maxZ, 4),
      },
      stats: preview.stats || {},
      diagnostics,
      profiler: profiler ? {
        firstRenderMs: pageRound(profiler.firstRenderMs, 1),
        interactiveMs: pageRound(profiler.interactiveMs, 1),
        fullyLoadedMs: pageRound(profiler.fullyLoadedMs, 1),
        events: profiler.events?.filter(item => ['first-render', 'interactive', 'fully-loaded', 'registry:ready'].includes(item.name)),
      } : null,
      runtimeSnapshot,
    };
  });
}

async function pageIdentity(page) {
  return page.evaluate(() => {
    const preview = globalThis.__BABYLON_PREVIEW__;
    return {
      title: document.title,
      moduleScripts: [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src),
      babylonRuntime: Boolean(preview?.engine && preview?.scene && preview?.camera),
      backend: preview?.engine?.webGLVersion >= 2 ? 'WebGL2' : (preview?.engine ? `WebGL${preview.engine.webGLVersion || 0}` : null),
    };
  });
}

async function waitForApi(page, timeoutMs) {
  await page.waitForFunction(() => Boolean(globalThis.__BABYLON_PREVIEW__?.ready), undefined, { timeout: timeoutMs });
  await withTimeout(
    page.evaluate(() => globalThis.__BABYLON_PREVIEW__.ready.then(() => true)),
    timeoutMs,
    'Timed out waiting for Babylon preview ready promise',
  );
}

async function waitForFullyLoaded(page, timeoutMs) {
  return withTimeout(
    page.evaluate(() => globalThis.__BABYLON_PREVIEW__.fullyLoaded.then(() => true)),
    timeoutMs,
    'Timed out waiting for Babylon preview fullyLoaded promise',
  );
}

async function setTime(page, time) {
  return page.evaluate(async value => {
    const api = globalThis.__BABYLON_PREVIEW__;
    if (typeof api?.setTime !== 'function') return null;
    const result = await api.setTime(value);
    return result ?? api.stats?.time ?? value;
  }, time);
}

async function setViewpoint(page, name) {
  return page.evaluate(async value => {
    const api = globalThis.__BABYLON_PREVIEW__;
    if (typeof api?.setViewpoint !== 'function') return false;
    return Boolean(await api.setViewpoint(value));
  }, name);
}

async function inspectControls(page, settleMs) {
  const before = await pageApiState(page);
  await page.locator('#babylon-canvas').click({ position: { x: 640, y: 360 } });
  const start = before.camera?.position;
  await page.keyboard.down('KeyW');
  await sleep(400);
  await page.keyboard.up('KeyW');
  const forward = await pageApiState(page);
  await page.keyboard.down('Space');
  await sleep(300);
  await page.keyboard.up('Space');
  const up = await pageApiState(page);
  await page.keyboard.down('ShiftLeft');
  await sleep(300);
  await page.keyboard.up('ShiftLeft');
  const down = await pageApiState(page);
  const canvas = page.locator('#babylon-canvas');
  await canvas.click({ position: { x: 640, y: 360 } });
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(706, 324, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const turned = await pageApiState(page);
  const speed = await page.evaluate(() => {
    const api = globalThis.__BABYLON_PREVIEW__;
    if (typeof api.controls?.setSpeed === 'function') return api.controls.setSpeed(2.5);
    const input = document.querySelector('[data-speed]');
    if (input) { input.value = '2.5'; input.dispatchEvent(new Event('input', { bubbles: true })); }
    return api.camera?.speed ?? null;
  });
  const sped = await pageApiState(page);
  const reset = await page.evaluate(() => {
    const api = globalThis.__BABYLON_PREVIEW__;
    if (typeof api.controls?.reset === 'function') return Boolean(api.controls.reset());
    return Boolean(api.setViewpoint?.('spawn'));
  });
  await page.waitForTimeout(settleMs);
  const afterReset = await pageApiState(page);
  const distances = {
    forward: distance(start, forward.camera?.position),
    up: distance(forward.camera?.position, up.camera?.position),
    down: distance(up.camera?.position, down.camera?.position),
    reset: distance(before.camera?.position, afterReset.camera?.position),
  };
  const pitchDelta = before.camera?.rotation && turned.camera?.rotation
    ? Math.abs((before.camera.rotation[0] || 0) - (turned.camera.rotation[0] || 0))
    : null;
  return {
    movement: { ...distances, forwardObserved: (distances.forward || 0) > 0.01, verticalUpObserved: (distances.up || 0) > 0.01, verticalDownObserved: (distances.down || 0) > 0.01 },
    camera: { pitchDelta: round(pitchDelta, 5), dragObserved: (pitchDelta || 0) > 0.001 },
    speed: { requested: 2.5, actual: speed ?? sped.camera?.speed ?? null, changed: Number(speed || sped.camera?.speed || 0) >= 2.4 },
    reset: { invoked: reset, positionDelta: distances.reset, returnedNearStart: (distances.reset || 0) < 0.1 },
  };
}

async function captureViews(page, { views, times, settleMs, screenshotDir, skipScreenshots }) {
  const captured = [];
  for (const view of views) {
    const selected = await setViewpoint(page, view);
    if (!selected) {
      captured.push({ view, status: 'missing-viewpoint' });
      continue;
    }
    await setTime(page, 'day');
    await page.waitForTimeout(settleMs);
    const state = await pageApiState(page);
    const record = { view, time: 'day', status: 'captured', camera: state.camera, diagnostics: state.diagnostics, screenshot: null };
    if (!skipScreenshots) {
      const file = path.resolve(screenshotDir, `${view}-day.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: false });
      record.screenshot = file;
    }
    captured.push(record);
  }
  const timeSamples = [];
  if (views.includes('street')) {
    await setViewpoint(page, 'street');
    for (const time of times) {
      const applied = await setTime(page, time);
      await page.waitForTimeout(settleMs);
      const state = await pageApiState(page);
      const record = { view: 'street', time, applied, camera: state.camera, clearColor: state.scene?.clearColor || null, stats: state.stats, screenshot: null };
      if (!skipScreenshots) {
        const file = path.resolve(screenshotDir, `street-${time}.png`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: false });
        record.screenshot = file;
      }
      timeSamples.push(record);
    }
  }
  await setTime(page, 'day');
  return { captured, timeSamples };
}

async function runMapPositionCheck({ snapshot, args, outPath }) {
  if (!snapshot) return { status: 'not-provided', reason: 'preview did not expose requestedRuntimeSnapshot' };
  const snapshotPath = path.resolve(path.dirname(outPath), 'runtime-snapshot.json');
  await writeJson(snapshotPath, snapshot);
  const detailPath = path.resolve(path.dirname(outPath), 'map-position.json');
  const checker = path.resolve(REPO_ROOT, 'scripts', 'check-map-position.mjs');
  const runtimeRoot = path.resolve(args['runtime-root'] || path.join(REPO_ROOT, 'public', 'extracted'));
  const sourceRoot = path.resolve(args['source-root'] || 'G:/FFXIV-MapTools/exports');
  if (!fsSync.existsSync(checker)) return { status: 'not-run', reason: `missing checker: ${checker}`, snapshotPath };
  try {
    const result = await execFileAsync(process.execPath, [
      checker,
      'e3t1',
      `--runtime=${runtimeRoot}`,
      `--source=${sourceRoot}`,
      `--runtime-state=${snapshotPath}`,
      `--out=${detailPath}`,
      '--focus=abnormal-only',
    ], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
    let summary = null;
    try { summary = JSON.parse(result.stdout); } catch {}
    return { status: summary?.status || 'pass', summary, detailPath, snapshotPath, stderr: result.stderr?.trim() || null };
  } catch (error) {
    let summary = null;
    try { summary = JSON.parse(error.stdout); } catch {}
    return { status: summary?.status || 'error', summary, detailPath, snapshotPath, error: error.message };
  }
}

async function validate(args) {
  const appUrl = normalizeUrl(args.url || DEFAULT_URL);
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const screenshotDir = path.resolve(args.screenshots || DEFAULT_SCREENSHOT_DIR);
  const timeoutMs = numberOption(args.timeout, 600000);
  const settleMs = numberOption(args['settle-ms'], 700);
  const views = listOption(args.views, DEFAULT_VIEWS);
  const times = listOption(args.times, DEFAULT_TIMES);
  const skipScreenshots = boolOption(args['skip-screenshots'], false);
  const skipMapCheck = boolOption(args['skip-map-check'], false);
  const browserPath = args['browser-path'] || process.env.BROWSER_PATH;
  const playwrightModulePath = args['playwright-module-path'] || process.env.PLAYWRIGHT_MODULE_PATH;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    url: appUrl.href,
    expected: EXPECTED,
    options: { timeoutMs, settleMs, views, times, skipScreenshots, skipMapCheck },
    status: 'error',
    errors: [],
    warnings: [],
  };
  const fatal = { error: null };
  let browser;
  let context;
  let page;
  try {
    const { chromium } = await loadPlaywright(playwrightModulePath);
    browser = await chromium.launch({ executablePath: browserPath || undefined, headless: !boolOption(args.headed, false), args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on('pageerror', error => { if (!fatal.error) fatal.error = error.message; });
    page.on('console', message => {
      if (message.type() === 'error') report.errors.push({ type: 'console', text: message.text() });
    });
    page.on('response', response => {
      if (response.status() >= 400) report.errors.push({ type: 'http', status: response.status(), url: response.url() });
    });
    page.on('requestfailed', request => report.errors.push({ type: 'request-failed', url: request.url(), error: request.failure()?.errorText || null }));
    const startedAt = Date.now();
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    report.navigationMs = Date.now() - startedAt;
    await waitForApi(page, timeoutMs);
    report.readyAtMs = Date.now() - startedAt;
    report.readyState = await pageApiState(page);
    report.open = await pageIdentity(page);
    try {
      await waitForFullyLoaded(page, timeoutMs);
      report.fullyLoadedAtMs = Date.now() - startedAt;
    } catch (error) {
      report.errors.push({ type: 'fully-loaded', text: error.message });
    }
    const refreshStartedAt = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForApi(page, timeoutMs);
    try {
      await waitForFullyLoaded(page, timeoutMs);
      report.refresh = { completed: true, durationMs: Date.now() - refreshStartedAt, identity: await pageIdentity(page) };
    } catch (error) {
      report.refresh = { completed: false, durationMs: Date.now() - refreshStartedAt, error: error.message, identity: await pageIdentity(page) };
      report.errors.push({ type: 'refresh-fully-loaded', text: error.message });
    }
    const controls = await inspectControls(page, settleMs);
    const viewsResult = await captureViews(page, { views, times, settleMs, screenshotDir, skipScreenshots });
    const finalState = await pageApiState(page);
    report.controls = controls;
    report.views = viewsResult.captured;
    report.timeSamples = viewsResult.timeSamples;
    report.finalState = finalState;
    report.errors = report.errors.slice(0, 40);
    report.runtimeSnapshot = finalState.runtimeSnapshot ? { available: true, path: null } : { available: false };
    if (!skipMapCheck) report.mapPosition = await runMapPositionCheck({ snapshot: finalState.runtimeSnapshot, args, outPath });
    const source = finalState.source || {};
    const scene = finalState.scene || {};
    const engine = finalState.engine || {};
    const checks = {
      ready: finalState.isReady === true,
      fullyLoaded: finalState.isFullyLoaded === true,
      openIdentity: report.open?.title?.endsWith(' · Babylon World Preview') && report.open?.babylonRuntime === true,
      refreshIdentity: report.refresh?.completed === true && report.refresh?.identity?.title?.endsWith(' · Babylon World Preview') && report.refresh?.identity?.babylonRuntime === true,
      webgl2: engine.webGLVersion >= 2 && engine.webgl2Context === true,
      mapId: source.mapId === EXPECTED.mapId,
      territoryId: source.territoryId === EXPECTED.territoryId,
      assetVersion: source.assetVersion === EXPECTED.assetVersion,
      modelRecords: source.modelRecords === EXPECTED.modelRecords,
      placements: source.placements === EXPECTED.placements,
      materialResources: source.materialResources === EXPECTED.materialResources,
      bundles: source.bundleCount === EXPECTED.bundles,
      noLoaderFailures: !(finalState.diagnostics?.failures?.length || finalState.stats?.loader?.failures?.length),
      spatialSignSeparation: (scene.mixedDeterminantCells || []).length === 0,
      geometryAttributes: (scene.geometryAudit?.empty || 0) === 0 && (scene.geometryAudit?.missingPosition || 0) === 0 && (scene.geometryAudit?.invalidBounds || 0) === 0,
      runtimeTransforms: (scene.transformAudit?.count || 0) === 0 || ((scene.transformAudit?.invalid || 0) === 0 && (scene.transformAudit?.outliers || []).length === 0),
      environmentPresent: scene.environmentTexture === true || scene.lightCount > 0,
      materialMapping: scene.materialCount > 0 && scene.texturedMaterials > 0 && !scene.globalUnlit && !scene.globalDoubleSided,
      controlsMovement: controls.movement.forwardObserved,
      controlsVertical: controls.movement.verticalUpObserved && controls.movement.verticalDownObserved,
      controlsPitch: controls.camera.dragObserved,
      controlsSpeed: controls.speed.changed,
      controlsReset: controls.reset.invoked,
      fixedViews: viewsResult.captured.filter(item => item.status === 'captured').length === views.length,
      timePresets: viewsResult.timeSamples.length === times.length,
      mapPosition: skipMapCheck || report.mapPosition?.status === 'pass',
    };
    report.checks = checks;
    report.status = Object.values(checks).every(Boolean) ? 'pass' : 'review';
    if (fatal.error) report.errors.push({ type: 'pageerror', text: fatal.error });
    const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedChecks.length) report.warnings.push({ type: 'failed-checks', checks: failedChecks });
  } catch (error) {
    report.errors.push({ type: 'fatal', text: error.message });
    report.status = /timeout/i.test(error.message) ? 'timeout' : 'error';
  } finally {
    await context?.close();
    await browser?.close();
  }
  await writeJson(outPath, report);
  const summary = {
    status: report.status,
    out: outPath,
    url: appUrl.href,
    readyMs: report.readyAtMs ?? null,
    fullyLoadedMs: report.fullyLoadedAtMs ?? null,
    failedChecks: report.warnings.filter(item => item.type === 'failed-checks').flatMap(item => item.checks),
    screenshots: (report.views || []).map(item => item.screenshot).filter(Boolean),
    mapPosition: report.mapPosition?.status || null,
  };
  console.log(JSON.stringify(summary, null, 2));
  return report.status === 'pass' ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
} else {
  try {
    process.exitCode = await validate(args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
