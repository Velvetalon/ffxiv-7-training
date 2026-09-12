import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { loadPlaywright } from './browser.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'work', 'color-audit');
const MAP_IDS = ['e3t1', 'limsa', 'gridania', 'd2t1'];
const MODES = ['full', 'neutral', 'albedo', 'albedo-normal', 'pbr-no-environment'];
const E3T1_SAMPLES = [
  {
    id: 'building-290-placement-0', kind: 'building', modelIndex: 290, instanceIndex: 0,
    asset: 'bg/ex2/02_est_e3/twn/e3t1/bgparts/e3t1_b3_hou3a.mdl',
    resourceId: 'glb:sha256:8921a545492ab13574207ac9b8182047eb41a86d7c26e88feb1ff2583196c86b',
  },
  {
    id: 'ground-659-placement-0', kind: 'ground', modelIndex: 659, instanceIndex: 0,
    asset: 'bg/ex2/02_est_e3/twn/e3t1/bgplate/0000.mdl',
    resourceId: 'glb:sha256:a4192b66658583efbeebde8713a99f0f9172c8ed84c380d23839306b296ceb1a',
  },
];

function parseArgs(argv) {
  const args = {};
  for (const value of argv) {
    if (!value.startsWith('--')) continue;
    const [key, ...rest] = value.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
  return args;
}

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function decodePng(bytes) {
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('Expected a PNG screenshot');
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error(`Unsupported screenshot PNG ${width}x${height}, depth=${bitDepth}, type=${colorType}, interlace=${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const source = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset++];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const raw = source[sourceOffset++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= channels ? prior[x - channels] : 0;
      let value = raw;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[x] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

function readPngStats(bytes, roi, maskBytes = null) {
  const image = decodePng(bytes);
  const mask = maskBytes ? decodePng(maskBytes) : null;
  if (mask && (mask.width !== image.width || mask.height !== image.height)) throw new Error('Mask dimensions differ from color screenshot');
  const { width, height, channels, pixels } = image;
  const area = {
    x: Math.max(0, Math.floor(roi?.x ?? 0)), y: Math.max(0, Math.floor(roi?.y ?? 0)),
    width: Math.max(1, Math.min(width, Math.ceil(roi?.width ?? width))), height: Math.max(1, Math.min(height, Math.ceil(roi?.height ?? height))),
  };
  area.width = Math.max(1, Math.min(area.width, width - area.x));
  area.height = Math.max(1, Math.min(area.height, height - area.y));
  const sums = [0, 0, 0];
  let opaque = 0;
  let maskPixels = 0;
  const maskBits = mask ? Buffer.alloc(Math.ceil(width * height / 8)) : null;
  for (let y = area.y; y < area.y + area.height; y += 1) for (let x = area.x; x < area.x + area.width; x += 1) {
    const index = (y * width + x) * channels;
    if (channels === 4 && !pixels[index + 3]) continue;
    if (mask) {
      const maskIndex = (y * width + x) * mask.channels;
      const selected = mask.pixels[maskIndex] >= 250 && mask.pixels[maskIndex + 1] >= 250 && mask.pixels[maskIndex + 2] >= 250
        && (mask.channels === 3 || mask.pixels[maskIndex + 3] > 0);
      if (!selected) continue;
      maskPixels += 1;
      const bit = y * width + x;
      maskBits[bit >> 3] |= 1 << (bit & 7);
    }
    opaque += 1;
    sums[0] += pixels[index]; sums[1] += pixels[index + 1]; sums[2] += pixels[index + 2];
  }
  const mean = sums.map(value => opaque ? value / opaque : 0);
  const total = mean[0] + mean[1] + mean[2];
  const greenExcess = mean[1] - (mean[0] + mean[2]) / 2;
  return {
    screenshot: { width, height }, roi: area, opaquePixels: opaque,
    meanRgb: mean.map(value => Number(value.toFixed(4))),
    greenExcess: Number(greenExcess.toFixed(4)),
    chroma: {
      greenShare: Number((total ? mean[1] / total : 0).toFixed(8)),
      greenExcessNormalized: Number((total ? greenExcess / total : 0).toFixed(8)),
    },
    mask: mask ? { pixelCount: maskPixels, sha256: crypto.createHash('sha256').update(maskBits).digest('hex') } : null,
  };
}

async function waitForRuntime(page, timeoutMs) {
  await page.waitForFunction(() => {
    const preview = globalThis.__BABYLON_PREVIEW__;
    const world = globalThis.__APP__?.world;
    const debug = preview?.renderDebug || world?.renderDebug;
    const scene = preview?.scene || world?.scene;
    const loader = preview?.loader || world?.assetScene?.loader || world?.mapLoader;
    return Boolean(debug && scene?.activeCamera && loader && (loader.state?.instantiatedModels > 0 || loader.records?.some(record => record.instantiated)));
  }, undefined, { timeout: timeoutMs });
}

async function prepareMap(page, { mapId, sample = null, settleMs }) {
  return page.evaluate(async ({ mapId: requestedMap, sample: requestedSample, settle }) => {
    const preview = globalThis.__BABYLON_PREVIEW__ || null;
    const world = globalThis.__APP__?.world || null;
    const scene = preview?.scene || world?.scene;
    const debug = preview?.renderDebug || world?.renderDebug;
    const loader = preview?.loader || world?.assetScene?.loader || world?.mapLoader;
    const materialAdapter = preview?.materials || world?.assetScene?.materials || null;
    if (!scene || !debug || !loader) throw new Error('Color-audit runtime contract is unavailable');

    // Resource and material work must begin from the source Full state. The
    // render loop owns normal apply calls; the capture guard is frame-local.
    globalThis.__COLOR_AUDIT_APPLY_GUARD__?.restore?.();
    debug.setMode('full').setContributions({ vertexColors: null, ao: null, extraColor: null, disableSecondaryPlugin: false }).apply();

    // The main-world time and the preview environment adapter have independent entry points.
    if (world?.worldTime?.setState) world.worldTime.setState({ hour: 12, paused: true });
    if (preview?.setTime) preview.setTime(12);
    else (preview?.environment || world?.environmentAdapter)?.setTime?.(12, { apply: true });
    if (world?.environmentAdapter?.setTime) world.environmentAdapter.setTime(12, { apply: true });
    const camera = preview?.camera || world?.camera || scene.activeCamera;
    if (camera) camera.fov = 0.82;

    const record = requestedSample ? loader.records?.find(item => item.index === requestedSample.modelIndex) : null;
    if (requestedSample && !record) throw new Error(`Missing selected record ${requestedSample.modelIndex} on ${requestedMap}`);
    if (record) {
      const matrix = record.matrices?.[requestedSample.instanceIndex];
      if (!Array.isArray(matrix) || matrix.length !== 16) throw new Error(`Missing selected placement matrix ${requestedSample.modelIndex}:${requestedSample.instanceIndex}`);
      const instanceBounds = record.instanceBounds?.[requestedSample.instanceIndex];
      if (!Array.isArray(instanceBounds?.min) || !Array.isArray(instanceBounds?.max) || instanceBounds.min.length < 3 || instanceBounds.max.length < 3) {
        throw new Error(`Missing selected instance bounds ${requestedSample.modelIndex}:${requestedSample.instanceIndex}`);
      }
      const location = instanceBounds.min.map((value, axis) => (value + instanceBounds.max[axis]) / 2);
      await loader.ensureLocation(location, 0.01);
      const targetMeshes = () => scene.meshes.filter(mesh => mesh?.metadata?.ff14?.modelIndex === requestedSample.modelIndex
        && mesh.metadata.ff14.sourceInstanceIndex === requestedSample.instanceIndex && mesh.getTotalVertices?.() > 0);
      const selected = targetMeshes();
      if (!selected.length) throw new Error(`Selected placement did not instantiate ${requestedSample.modelIndex}:${requestedSample.instanceIndex}`);
      for (const material of [...new Set(selected.map(mesh => mesh.material).filter(Boolean))]) await materialAdapter?.upgradeMaterial?.(material);

      const meshBounds = selected.flatMap(mesh => mesh.getBoundingInfo?.().boundingBox?.vectorsWorld || []);
      if (meshBounds.length && camera?.position && camera?.setTarget) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const point of meshBounds) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], point[['x', 'y', 'z'][axis]]); max[axis] = Math.max(max[axis], point[['x', 'y', 'z'][axis]]); }
        const center = selected[0].getBoundingInfo().boundingBox.centerWorld.clone();
        center.x = (min[0] + max[0]) / 2; center.y = (min[1] + max[1]) / 2; center.z = (min[2] + max[2]) / 2;
        const span = Math.max(4, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
        camera.position.copyFromFloats(center.x + span * 1.15, center.y + span * 0.72, center.z + span * 1.15);
        camera.setTarget(center);
      }
      return {
        mapId: world?.sceneId || preview?.assets?.mapId || requestedMap,
        sample: { ...requestedSample, recordId: record.id, recordAsset: record.asset, resourceId: record.resourceId, matrix: record.matrices[requestedSample.instanceIndex].slice(), instanceBounds, ensureLocationCenter: location, ensureLocationRadius: 0.01, selectedMeshCount: selected.length },
      };
    }
    return { mapId: world?.sceneId || preview?.assets?.mapId || requestedMap, sample: null };
  }, { mapId, sample, settleMs });
}

async function setupIsolation(page, sample) {
  return page.evaluate(selectedSample => {
    const preview = globalThis.__BABYLON_PREVIEW__ || null;
    const world = globalThis.__APP__?.world || null;
    const scene = preview?.scene || world?.scene;
    const key = '__COLOR_AUDIT_ISOLATION__';
    globalThis[key]?.restore?.();
    const original = new Map();
    const wanted = mesh => mesh?.metadata?.ff14?.modelIndex === selectedSample.modelIndex
      && mesh.metadata.ff14.sourceInstanceIndex === selectedSample.instanceIndex && mesh.getTotalVertices?.() > 0;
    const hide = mesh => {
      if (!mesh?.getTotalVertices || !mesh.getTotalVertices() || wanted(mesh)) return;
      if (!original.has(mesh)) original.set(mesh, { isVisible: mesh.isVisible, enabled: mesh.isEnabled?.() });
      mesh.isVisible = false;
      mesh.setEnabled?.(false);
    };
    for (const mesh of scene.meshes || []) hide(mesh);
    const observer = scene.onNewMeshAddedObservable?.add(hide);
    const restore = () => {
      if (observer) scene.onNewMeshAddedObservable.remove(observer);
      for (const [mesh, value] of original) {
        if (mesh.isDisposed?.()) continue;
        mesh.isVisible = value.isVisible;
        mesh.setEnabled?.(value.enabled);
      }
      globalThis[key] = null;
    };
    globalThis[key] = { restore };
    return { isolated: (scene.meshes || []).filter(wanted).length, hidden: original.size };
  }, sample);
}

async function clearIsolation(page) {
  await page.evaluate(() => globalThis.__COLOR_AUDIT_ISOLATION__?.restore?.());
}

async function captureMode(page, { dir, name, mode, sample = null, settleMs, ablateReflectivity = false }) {
  const state = await page.evaluate(async ({ debugMode, selectedSample, ablate }) => {
    const preview = globalThis.__BABYLON_PREVIEW__ || null;
    const world = globalThis.__APP__?.world || null;
    const scene = preview?.scene || world?.scene;
    const debug = preview?.renderDebug || world?.renderDebug;
    const selectedMeshes = selectedSample ? scene.meshes.filter(mesh => mesh?.metadata?.ff14?.modelIndex === selectedSample.modelIndex
      && mesh.metadata.ff14.sourceInstanceIndex === selectedSample.instanceIndex && mesh.getTotalVertices?.() > 0) : [];
    const selectedMaterials = [...new Set(selectedMeshes.map(mesh => mesh.material).filter(Boolean))];
    globalThis.__COLOR_AUDIT_APPLY_GUARD__?.restore?.();
    const apply = debug.apply;
    debug.setMode(debugMode).setContributions({ vertexColors: null, ao: null, extraColor: null, disableSecondaryPlugin: false });
    apply.call(debug);
    // app.js/World.js call apply every frame. Hold the already-applied temporary
    // state steady while Playwright captures this single diagnostic frame.
    debug.apply = () => debug;
    globalThis.__COLOR_AUDIT_APPLY_GUARD__ = { restore() { debug.apply = apply; globalThis.__COLOR_AUDIT_APPLY_GUARD__ = null; } };
    globalThis.__COLOR_AUDIT_UI_GUARD__?.restore?.();
    const ui = [...document.querySelectorAll('.preview-panel, .preview-controls, .render-debug-controls, [data-render-debug]')];
    const uiState = ui.map(element => ({ element, visibility: element.style.visibility }));
    for (const entry of uiState) entry.element.style.visibility = 'hidden';
    globalThis.__COLOR_AUDIT_UI_GUARD__ = { restore() {
      for (const entry of uiState) entry.element.style.visibility = entry.visibility;
      globalThis.__COLOR_AUDIT_UI_GUARD__ = null;
    } };
    const ablation = [];
    if (ablate) {
      for (const material of selectedMaterials) {
        ablation.push({ material, reflectivityTexture: material.reflectivityTexture, useMicroSurfaceFromReflectivityMapAlpha: material.useMicroSurfaceFromReflectivityMapAlpha });
        material.reflectivityTexture = null;
        material.useMicroSurfaceFromReflectivityMapAlpha = false;
      }
    }
    scene.render();
    await new Promise(resolve => setTimeout(resolve, 0));
    const canvas = scene.getEngine().getRenderingCanvas();
    const rect = canvas?.getBoundingClientRect?.();
    const projection = scene.getTransformMatrix?.().m;
    const width = scene.getEngine().getRenderWidth();
    const height = scene.getEngine().getRenderHeight();
    const points = selectedMeshes.flatMap(mesh => mesh.getBoundingInfo?.().boundingBox?.vectorsWorld || []);
    const screen = [];
    for (const point of points) {
      if (!projection) continue;
      const x = point.x, y = point.y, z = point.z;
      const w = x * projection[3] + y * projection[7] + z * projection[11] + projection[15];
      if (Math.abs(w) < 1e-6) continue;
      const nx = (x * projection[0] + y * projection[4] + z * projection[8] + projection[12]) / w;
      const ny = (x * projection[1] + y * projection[5] + z * projection[9] + projection[13]) / w;
      screen.push([(nx * 0.5 + 0.5) * width, (1 - (ny * 0.5 + 0.5)) * height]);
    }
    let roi = null;
    if (screen.length && rect) {
      const xs = screen.map(point => point[0]), ys = screen.map(point => point[1]);
      const minX = Math.max(0, Math.min(...xs)), maxX = Math.min(width, Math.max(...xs));
      const minY = Math.max(0, Math.min(...ys)), maxY = Math.min(height, Math.max(...ys));
      if (maxX - minX >= 8 && maxY - minY >= 8) roi = { x: rect.x + minX, y: rect.y + minY, width: maxX - minX, height: maxY - minY };
    }
    if (!roi && rect) roi = { x: rect.x + rect.width * 0.2, y: rect.y + rect.height * 0.2, width: rect.width * 0.6, height: rect.height * 0.6, fallback: true };
    const dump = debug.dump({ samples: selectedMaterials });
    globalThis.__COLOR_AUDIT_ABLATION__?.restore?.();
    globalThis.__COLOR_AUDIT_ABLATION__ = {
      restore() {
        for (const value of ablation) {
          value.material.reflectivityTexture = value.reflectivityTexture;
          value.material.useMicroSurfaceFromReflectivityMapAlpha = value.useMicroSurfaceFromReflectivityMapAlpha;
        }
        globalThis.__COLOR_AUDIT_ABLATION__ = null;
      },
    };
    return { mode: debugMode, ablation: Boolean(ablate), sample: selectedSample, selectedMeshes: selectedMeshes.map(mesh => ({ name: mesh.name, material: mesh.material?.name || null, matrix: mesh.metadata?.ff14?.sourceMatrix || null })), roi, dump };
  }, { debugMode: mode, selectedSample: sample, ablate: ablateReflectivity });
  const png = path.join(dir, `${name}.png`);
  const maskPng = sample ? path.join(dir, `${name}.mask.png`) : null;
  const json = path.join(dir, `${name}.json`);
  await fs.mkdir(dir, { recursive: true });
  try {
    await page.waitForTimeout(settleMs);
    await page.screenshot({ path: png, fullPage: false });
    if (sample) {
      await page.evaluate(selectedSample => {
        const preview = globalThis.__BABYLON_PREVIEW__ || null;
        const world = globalThis.__APP__?.world || null;
        const scene = preview?.scene || world?.scene;
        const selected = scene.meshes.filter(mesh => mesh?.metadata?.ff14?.modelIndex === selectedSample.modelIndex
          && mesh.metadata.ff14.sourceInstanceIndex === selectedSample.instanceIndex && mesh.getTotalVertices?.() > 0);
        const materials = [...new Set(selected.map(mesh => mesh.material).filter(Boolean))];
        const color = value => value?.clone?.() || value;
        const sceneState = { clearColor: color(scene.clearColor), environmentTexture: scene.environmentTexture, fogEnabled: scene.fogEnabled };
        const image = scene.imageProcessingConfiguration;
        const imageState = image ? { isEnabled: image.isEnabled, applyByPostProcess: image.applyByPostProcess } : null;
        const lights = (scene.lights || []).map(light => ({ light, intensity: light.intensity }));
        const materialState = materials.map(material => ({ material, unlit: material.unlit, albedoTexture: material.albedoTexture, albedoColor: color(material.albedoColor), emissiveTexture: material.emissiveTexture, emissiveColor: color(material.emissiveColor), emissiveIntensity: material.emissiveIntensity, reflectivityTexture: material.reflectivityTexture, environmentIntensity: material.environmentIntensity, directIntensity: material.directIntensity }));
        scene.clearColor = scene.clearColor.clone();
        scene.clearColor.r = 0; scene.clearColor.g = 0; scene.clearColor.b = 0; scene.clearColor.a = 1;
        scene.environmentTexture = null; scene.fogEnabled = false;
        if (image) { image.isEnabled = false; image.applyByPostProcess = false; }
        for (const light of lights) light.light.intensity = 0;
        for (const entry of materialState) {
          const material = entry.material;
          material.unlit = true; material.albedoTexture = null; material.reflectivityTexture = null;
          material.emissiveTexture = null; material.emissiveIntensity = 0; material.environmentIntensity = 0; material.directIntensity = 1;
          material.albedoColor = material.albedoColor.clone(); material.albedoColor.r = 1; material.albedoColor.g = 1; material.albedoColor.b = 1;
          material.emissiveColor = material.emissiveColor.clone(); material.emissiveColor.r = 0; material.emissiveColor.g = 0; material.emissiveColor.b = 0;
        }
        globalThis.__COLOR_AUDIT_MASK__?.restore?.();
        globalThis.__COLOR_AUDIT_MASK__ = { restore() {
          scene.clearColor = sceneState.clearColor; scene.environmentTexture = sceneState.environmentTexture; scene.fogEnabled = sceneState.fogEnabled;
          if (image && imageState) { image.isEnabled = imageState.isEnabled; image.applyByPostProcess = imageState.applyByPostProcess; }
          for (const entry of lights) entry.light.intensity = entry.intensity;
          for (const entry of materialState) {
            const { material, ...saved } = entry;
            Object.assign(material, saved);
          }
          globalThis.__COLOR_AUDIT_MASK__ = null;
        } };
        scene.render();
      }, sample);
      await page.waitForTimeout(Math.max(30, Math.floor(settleMs / 2)));
      await page.screenshot({ path: maskPng, fullPage: false });
      await page.evaluate(() => globalThis.__COLOR_AUDIT_MASK__?.restore?.());
    }
    const stats = readPngStats(await fs.readFile(png), state.roi, maskPng ? await fs.readFile(maskPng) : null);
    await writeJson(json, { ...state, png, maskPng, stats });
    return { ...state, png, maskPng, json, stats };
  } finally {
    await page.evaluate(() => globalThis.__COLOR_AUDIT_MASK__?.restore?.());
    await page.evaluate(() => globalThis.__COLOR_AUDIT_ABLATION__?.restore?.());
    await page.evaluate(() => globalThis.__COLOR_AUDIT_APPLY_GUARD__?.restore?.());
    await page.evaluate(() => globalThis.__COLOR_AUDIT_UI_GUARD__?.restore?.());
    await restoreDebug(page);
  }
}

async function restoreDebug(page) {
  await page.evaluate(() => {
    const preview = globalThis.__BABYLON_PREVIEW__ || null;
    const world = globalThis.__APP__?.world || null;
    const debug = preview?.renderDebug || world?.renderDebug;
    globalThis.__COLOR_AUDIT_APPLY_GUARD__?.restore?.();
    debug?.setMode('full').setContributions({ vertexColors: null, ao: null, extraColor: null, disableSecondaryPlugin: false }).apply();
  });
}

async function auditMap(browser, baseUrl, { mapId, label, outRoot, timeoutMs, settleMs, captureLadder }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(Math.min(timeoutMs, 30000));
  const target = new URL(baseUrl);
  target.searchParams.set('scene', mapId);
  const result = { mapId, url: target.href, status: 'error', frames: [], ladder: [], errors: [] };
  try {
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForRuntime(page, timeoutMs);
    const broad = await prepareMap(page, { mapId, settleMs });
    const mapDir = path.join(outRoot, label, mapId);
    result.runtime = await page.evaluate(() => {
      const preview = globalThis.__BABYLON_PREVIEW__ || null;
      const world = globalThis.__APP__?.world || null;
      const loader = preview?.loader || world?.assetScene?.loader || world?.mapLoader;
      return { mapId: world?.sceneId || preview?.assets?.mapId || null, assetVersion: preview?.assets?.releaseId || world?.assetScene?.assets?.releaseId || null, loader: { records: loader?.records?.length || 0, instantiated: loader?.state?.instantiatedModels || 0 } };
    });
    for (const mode of ['full', 'neutral']) result.frames.push(await captureMode(page, { dir: mapDir, name: `${label}-${mode}`, mode, settleMs }));
    if (captureLadder && mapId === 'e3t1') {
      for (const sample of E3T1_SAMPLES) {
        const prepared = await prepareMap(page, { mapId, sample, settleMs });
        const isolated = await setupIsolation(page, sample);
        const sampleDir = path.join(mapDir, 'samples', sample.id);
        const ladder = { sample: prepared.sample, isolated, modes: [], ablation: null };
        try {
          for (const mode of MODES) ladder.modes.push(await captureMode(page, { dir: sampleDir, name: `${label}-${mode}`, mode, sample, settleMs }));
          ladder.ablation = await captureMode(page, { dir: sampleDir, name: `${label}-full-no-reflectivity`, mode: 'full', sample, settleMs, ablateReflectivity: true });
        } finally {
          await clearIsolation(page);
          await restoreDebug(page);
        }
        result.ladder.push(ladder);
      }
    }
    result.status = 'pass';
  } catch (error) {
    result.errors.push({ message: error.message, stack: error.stack || null });
  } finally {
    await clearIsolation(page).catch(() => {});
    await restoreDebug(page).catch(() => {});
    await context.close();
  }
  return result;
}

export async function runColorAudit({ url, out = DEFAULT_OUT, label = 'before', timeoutMs = 120000, settleMs = 250, browserPath, playwrightModulePath, headed = false, maps = MAP_IDS, captureLadder = true } = {}) {
  if (!url) throw new Error('url is required');
  const baseUrl = normalizeUrl(url);
  const outRoot = path.resolve(out);
  const startedAt = new Date().toISOString();
  const { chromium } = await loadPlaywright(playwrightModulePath);
  const browser = await chromium.launch({ executablePath: browserPath || process.env.BROWSER_PATH || undefined, headless: !headed, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const results = [];
  try {
    for (const mapId of maps) results.push(await auditMap(browser, baseUrl, { mapId, label, outRoot, timeoutMs, settleMs, captureLadder }));
  } finally {
    await browser.close();
  }
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), startedAt, url: baseUrl.href, label,
    fixedCapture: { viewport: [1280, 720], deviceScaleFactor: 1, hour: 12, paused: true, fov: 0.82 },
    maps: results, samples: E3T1_SAMPLES, status: results.every(result => result.status === 'pass') ? 'pass' : 'review',
  };
  const reportPath = path.join(outRoot, label, 'color-audit.json');
  await writeJson(reportPath, report);
  return { ...report, reportPath };
}

export default runColorAudit;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) throw new Error('Usage: node scripts/validation/color-audit.mjs --url=URL [--label=before] [--out=work/color-audit]');
  const result = await runColorAudit({
    url: args.url, out: args.out || DEFAULT_OUT, label: args.label || 'before', timeoutMs: numeric(args.timeout, 120000), settleMs: numeric(args['settle-ms'], 250),
    browserPath: args['browser-path'], playwrightModulePath: args['playwright-module-path'], headed: args.headed === true || args.headed === 'true',
    maps: args.maps ? String(args.maps).split(',').map(value => value.trim()).filter(Boolean) : MAP_IDS,
    captureLadder: args['skip-ladder'] !== true && args['skip-ladder'] !== 'true',
  });
  console.log(JSON.stringify({ status: result.status, reportPath: result.reportPath, maps: result.maps.map(item => ({ mapId: item.mapId, status: item.status })) }, null, 2));
}
