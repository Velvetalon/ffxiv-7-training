#!/usr/bin/env node
/**
 * Workbench baseline: load the golden map (Kugane / e3t1) at a fixed
 * viewpoint and time, read back the real state, capture a screenshot and save
 * a restorable case file.
 *
 * Products:
 *   workbench/cases/e3t1-baseline.json   committed, restorable case
 *   work/workbench/baseline/<run>/       screenshot + state read-back evidence
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5173/ff14-web-babylon-preview/';
const GOLDEN_MAP_ID = 'e3t1';
const DEFAULT_VIEW = 'kugane-castle';
const DEFAULT_TIME = 'day';
const CASE_FILE = path.join(REPO_ROOT, 'workbench', 'cases', 'e3t1-baseline.json');
const EVIDENCE_ROOT = path.join(REPO_ROOT, 'work', 'workbench', 'baseline');

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

function normalizeUrl(value) {
  const url = new URL(value);
  url.searchParams.set('viewer', '1');
  url.searchParams.set('scene', GOLDEN_MAP_ID);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
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

async function waitForApi(page, timeoutMs) {
  await page.waitForFunction(() => Boolean(globalThis.__BABYLON_PREVIEW__), null, { timeout: timeoutMs, polling: 250 });
  return page.evaluateHandle(() => globalThis.__BABYLON_PREVIEW__);
}

async function waitForReady(page, apiHandle, timeoutMs) {
  await page.evaluate(({ api, limit }) => new Promise((resolve, reject) => {
    const deadline = Date.now() + limit;
    const poll = () => {
      if (api.stats?.stage === 'error') { reject(new Error('preview entered error stage')); return; }
      if (api.isReady) { resolve(true); return; }
      if (Date.now() > deadline) { reject(new Error(`preview not interactive within ${limit}ms (stage ${api.stats?.stage})`)); return; }
      setTimeout(poll, 250);
    };
    poll();
  }), { api: apiHandle, limit: timeoutMs });
}

async function readState(page, apiHandle) {
  return page.evaluate(api => {
    const camera = api.camera;
    const target = camera?.target;
    return {
      mapId: api.mapId,
      stage: api.stats?.stage || null,
      time: api.stats?.time || null,
      camera: {
        position: camera ? [camera.position.x, camera.position.y, camera.position.z].map(value => Number(value.toFixed(4))) : null,
        target: target ? [target.x, target.y, target.z].map(value => Number(value.toFixed(4))) : (api.stats?.referenceView ?? null),
        fov: camera ? Number(camera.fov.toFixed(4)) : null,
      },
      backend: api.engine ? `WebGL${api.engine.webGLVersion}` : null,
      meshes: api.loader?.state?.meshCount ?? null,
      instantiatedModels: api.loader?.state?.instantiatedModels ?? null,
      sourcePlacements: api.loader?.state?.sourcePlacementCount ?? null,
      failures: api.loader?.state?.failures?.length ?? null,
      fps: api.stats?.fps ? Number(api.stats.fps.toFixed(1)) : null,
      asset: {
        assetVersion: api.assets?.config?.assetVersion || null,
        mapManifest: api.assets?.manifestPath || null,
        cacheName: api.assets?.diagnostics?.().cacheName || null,
      },
    };
  }, apiHandle);
}

async function pickSampleObjects(page, apiHandle, count = 2) {
  return page.evaluate(({ api, limit }) => {
    const records = api.loader?.records || [];
    const seen = new Set();
    const objects = [];
    for (const mesh of api.scene.meshes || []) {
      const meta = mesh?.metadata?.ff14;
      if (!meta?.sourceAsset || meta.sourceInstanceIndex === undefined) continue;
      if (seen.has(meta.sourceAsset)) continue;
      const record = records.find(candidate => candidate.asset === meta.sourceAsset);
      if (!record?.resourceId) continue;
      seen.add(meta.sourceAsset);
      objects.push({
        stableAddress: `e3t1:${record.index}:${meta.sourceInstanceIndex}`,
        sourceAsset: meta.sourceAsset,
        modelIndex: record.index,
        sourceInstanceIndex: meta.sourceInstanceIndex,
        resourceId: record.resourceId,
        meshName: mesh.name,
      });
      if (objects.length >= limit) break;
    }
    return objects;
  }, { api: apiHandle, limit: count });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = normalizeUrl(args.url || DEFAULT_URL);
  const timeoutMs = Number(args['timeout-ms']) || 600000;
  const waitFull = Boolean(args.full);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const evidenceDir = path.join(EVIDENCE_ROOT, runId);
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(path.dirname(CASE_FILE), { recursive: true });

  const visualReferences = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'config/visual-references.json'), 'utf8'));
  const view = visualReferences.views.find(candidate => candidate.id === (args.view || DEFAULT_VIEW) && candidate.mapId === GOLDEN_MAP_ID);
  if (!view) throw new Error(`View ${args.view || DEFAULT_VIEW} for ${GOLDEN_MAP_ID} not found in config/visual-references.json`);
  const time = args.time || DEFAULT_TIME;

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const startedAt = Date.now();
  try {
    await page.goto(appUrl.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const apiHandle = await withTimeout(waitForApi(page, 30000), 40000, '__BABYLON_PREVIEW__ never appeared');
    await withTimeout(waitForReady(page, apiHandle, timeoutMs), timeoutMs + 5000, 'preview never became interactive');

    // A baseline is only comparable when the load gate has settled. The
    // default gate is `interactive` (the same bootstrap gate the project's
    // smoke validation uses); repeated full-map streams are CDN-throttled, so
    // waiting for full texture upgrade is opt-in via --full.
    if (args.full) {
      const deadline = Date.now() + timeoutMs;
      let lastStage = null;
      while (Date.now() < deadline) {
        const status = await page.evaluate(api => ({
          fullyLoaded: api.isFullyLoaded,
          stage: api.stats?.stage || null,
          meshes: api.loader?.state?.meshCount ?? null,
          failures: api.loader?.state?.failures?.length ?? null,
        }), apiHandle);
        if (status.stage !== lastStage) {
          lastStage = status.stage;
          console.error(`  [load] stage=${status.stage} meshes=${status.meshes} failures=${status.failures} t=${Math.round((timeoutMs - (deadline - Date.now())) / 1000)}s`);
        }
        if (status.fullyLoaded) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (Date.now() >= deadline) throw new Error(`preview never fully loaded within ${timeoutMs}ms (stage ${lastStage})`);
      }
    }

    // Fixed viewpoint + time via the same programmatic surface the workbench uses.
    const applied = await page.evaluate(({ api, request }) => {
      const result = { camera: false, time: null };
      result.camera = api.setCameraState({ position: request.camera.position, target: request.camera.target, fov: request.camera.fov, id: request.id });
      result.time = api.setTime(request.time);
      return result;
    }, { api: apiHandle, request: { id: view.id, camera: view.camera, time } });
    if (!applied.camera) throw new Error(`setCameraState rejected the ${view.id} view`);
    await page.evaluate(frames => new Promise(resolve => {
      let remaining = frames;
      const step = () => { remaining -= 1; if (remaining <= 0) resolve(); else setTimeout(step, 50); };
      step();
    }), 8);

    const state = await readState(page, apiHandle);
    const objects = await pickSampleObjects(page, apiHandle, 2);
    const screenshotPath = path.join(evidenceDir, `${GOLDEN_MAP_ID}-${view.id}-${time}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const statePath = path.join(evidenceDir, 'state.json');
    await fs.writeFile(statePath, `${JSON.stringify({ generatedAt: new Date().toISOString(), applied, state, objects, pageErrors: pageErrors.slice(0, 10) }, null, 2)}\n`, 'utf8');

    let commit = null;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      commit = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
    } catch { /* leave null */ }

    const buildInfo = await page.evaluate(() => fetch(new URL('build-info.json', location.href).href).then(response => response.json()).catch(() => null));
    const active = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'public/extracted/active.json'), 'utf8'));
    const scene = active.scenes?.[GOLDEN_MAP_ID] || {};

    const testCase = {
      schemaVersion: 1,
      caseId: 'e3t1-baseline',
      kind: 'case',
      createdAt: new Date().toISOString(),
      map: { id: GOLDEN_MAP_ID, name: scene.en || GOLDEN_MAP_ID, territoryId: scene.territoryId ?? null },
      view: { id: view.id, camera: view.camera },
      time: { preset: time },
      objects,
      versions: {
        codeCommit: commit,
        assetRunId: active.runId,
        sourceSha256: buildInfo?.sourceSha256 || null,
        engine: buildInfo ? `${buildInfo.engine} ${buildInfo.engineVersion}` : null,
      },
      capture: {
        stage: state.stage,
        meshes: state.meshes,
        failures: state.failures,
        backend: state.backend,
        screenshot: path.relative(REPO_ROOT, screenshotPath),
        stateReadBack: path.relative(REPO_ROOT, statePath),
      },
    };
    await fs.writeFile(CASE_FILE, `${JSON.stringify(testCase, null, 2)}\n`, 'utf8');

    console.log(`\nBaseline captured for ${GOLDEN_MAP_ID} (${scene.en})`);
    console.log(`  view      : ${view.id} @ ${time}   cameraApplied=${applied.camera}`);
    console.log(`  stage     : ${state.stage}  meshes=${state.meshes}  failures=${state.failures}  fps=${state.fps}`);
    console.log(`  objects   : ${objects.map(object => `${object.resourceId}#${object.sourceInstanceIndex}`).join(', ') || 'none found'}`);
    console.log(`  case file : ${path.relative(REPO_ROOT, CASE_FILE)}`);
    console.log(`  evidence  : ${path.relative(REPO_ROOT, evidenceDir)}/`);
    if (pageErrors.length) console.log(`  pageErrors: ${pageErrors.length} (recorded in state.json)`);
  } finally {
    await browser.close();
  }
}

await main();
