#!/usr/bin/env node
/**
 * Fixed Babylon visual-reference harness.
 *
 * This is a diagnostic ranking tool, not a pixel-parity gate. It deliberately
 * compares only the tracked manifest views and never rewrites source images.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './validation/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = path.join(ROOT, 'config', 'visual-references.json');
const DEFAULT_URL = 'http://127.0.0.1:4173/ff14-web-babylon-preview/';
const DEFAULT_OUT = path.join(ROOT, 'work', 'visual-references', 'summary.json');
const DEFAULT_CAPTURE_DIR = path.join(ROOT, 'work', 'visual-references', 'captures');
const CANONICAL_FULL_LOAD = true;

function args(argv) {
  const result = {};
  for (const value of argv) {
    if (!value.startsWith('--')) continue;
    const body = value.slice(2);
    const at = body.indexOf('=');
    result[at < 0 ? body : body.slice(0, at)] = at < 0 ? true : body.slice(at + 1);
  }
  return result;
}

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function absolute(file) { return path.isAbsolute(file) ? file : path.resolve(ROOT, file); }

function mime(file) {
  return /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
}

async function dataUrl(file) {
  return `data:${mime(file)};base64,${(await fs.readFile(file)).toString('base64')}`;
}

async function sha256File(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizedUrl(value, scene) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.searchParams.set('scene', scene);
  url.searchParams.set('viewer', '1');
  url.searchParams.set('visualReference', '1');
  return url.href;
}

async function waitReady(page, timeout) {
  await page.waitForFunction(() => Boolean(globalThis.__BABYLON_PREVIEW__?.ready), null, { timeout });
  await page.evaluate(() => globalThis.__BABYLON_PREVIEW__.ready.then(() => true));
  await page.evaluate(({ timeoutMs }) => Promise.race([
    globalThis.__BABYLON_PREVIEW__.fullyLoaded.then(() => true),
    new Promise((_, reject) => setTimeout(() => reject(new Error('full-load timeout')), timeoutMs)),
  ]), { timeoutMs: timeout });
}

async function settle(page, ms) {
  await sleep(Math.max(0, ms));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function applyView(page, view, disableLod) {
  const result = await page.evaluate(async ({ view: selected, disableLod: noLod }) => {
    const api = globalThis.__BABYLON_PREVIEW__;
    if (!api?.setCameraState) return { ok: false, reason: 'preview camera contract missing' };
    const readState = () => {
      const lodEnabled = Boolean(api.loader?.state?.lod?.enabled);
      const camera = api.camera;
      const target = camera?.getTarget?.();
      return {
        camera: camera ? {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: target ? [target.x, target.y, target.z] : null,
          fov: camera.fov,
        } : null,
        time: Number.isFinite(Number(api.stats?.time)) ? Number(api.stats.time) : null,
        lodEnabled,
      };
    };
    const before = readState();
    const cameraApplied = api.setCameraState({ id: selected.id, ...selected.camera });
    const appliedTime = await api.setTime?.(selected.worldTime);
    if (noLod) api.setLodEnabled?.(false);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const final = readState();
    return {
      ok: cameraApplied === true,
      before,
      requested: { camera: selected.camera, time: selected.worldTime, lodEnabled: false },
      final,
    };
  }, { view, disableLod });
  if (!result.ok) throw new Error(result.reason || 'Could not apply visual reference view');
  return result;
}

function assertClose(actual, expected, tolerance, label) {
  if (!Number.isFinite(Number(actual)) || Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertVectorClose(actual, expected, tolerance, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) throw new Error(`${label} missing`);
  for (let index = 0; index < expected.length; index += 1) {
    assertClose(actual[index], expected[index], tolerance, `${label}[${index}]`);
  }
}

function validateViewEvidence(view, evidence) {
  const camera = evidence.camera;
  if (!camera) throw new Error('Final camera evidence missing');
  assertVectorClose(camera.position, view.camera.position, 1e-3, 'camera.position');
  assertVectorClose(camera.target, view.camera.target, 1e-3, 'camera.target');
  assertClose(camera.fov, view.camera.fov, 1e-6, 'camera.fov');
  assertClose(evidence.time, view.worldTime, 1e-3, 'worldTime');
  const lod = evidence.loader?.lod;
  if (!lod) throw new Error('Final LOD evidence missing');
  if (Boolean(lod.enabled)) {
    throw new Error('LOD state mismatch: canonical captures require enabled=false');
  }
}

async function captureBuildInfo(page) {
  return page.evaluate(async () => {
    try {
      const response = await fetch(new URL('build-info.json', location.href), { cache: 'no-store' });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  });
}

async function captureEvidence(page) {
  return page.evaluate(() => {
    const api = globalThis.__BABYLON_PREVIEW__;
    const loader = api?.loader;
    const state = loader?.state;
    const camera = api?.camera;
    const target = camera?.getTarget?.();
    return {
      ready: Boolean(api?.isReady),
      fullyLoaded: Boolean(api?.isFullyLoaded),
      stage: api?.stats?.stage || null,
      time: api?.stats?.time ?? null,
      camera: camera ? {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: target ? [target.x, target.y, target.z] : null,
        fov: camera.fov,
      } : null,
      loader: state ? {
        loadedModels: state.loadedModels,
        instantiatedModels: state.instantiatedModels,
        sourcePlacementCount: state.sourcePlacementCount,
        instanceCount: state.instanceCount,
        meshCount: state.meshCount,
        triangleCount: state.triangleCount,
        failures: state.failures?.length || 0,
        lod: state.lod ? {
          enabled: Boolean(state.lod.enabled),
          pending: state.lod.pending,
          completed: state.lod.completed,
          skipped: state.lod.skipped,
          failures: state.lod.failures?.length || 0,
        } : null,
      } : null,
    };
  });
}

async function compareInPage(page, referenceUrl, captureUrl, resampling) {
  return page.evaluate(async ({ referenceUrl: reference, captureUrl: capture, resampling }) => {
    const load = url => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Could not decode image ${url.slice(0, 48)}`));
      image.src = url;
    });
    const [referenceImage, captureImage] = await Promise.all([load(reference), load(capture)]);
    const width = captureImage.naturalWidth || captureImage.width;
    const height = captureImage.naturalHeight || captureImage.height;
    const referenceWidth = referenceImage.naturalWidth || referenceImage.width;
    const referenceHeight = referenceImage.naturalHeight || referenceImage.height;
    const captureAspect = width / height;
    const referenceAspect = referenceWidth / referenceHeight;
    const aspectRatioDelta = Math.abs(referenceAspect - captureAspect) / captureAspect;
    if (aspectRatioDelta > Number(resampling?.aspectRatioTolerance ?? 0.005)) {
      throw new Error(`Reference aspect ratio differs beyond tolerance: ${referenceAspect.toFixed(6)} vs ${captureAspect.toFixed(6)}`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = resampling?.imageSmoothingQuality || 'high';
    context.drawImage(referenceImage, 0, 0, width, height);
    const referencePixels = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, width, height);
    context.drawImage(captureImage, 0, 0, width, height);
    const capturePixels = context.getImageData(0, 0, width, height).data;
    const count = width * height;
    const refHist = [new Uint32Array(16), new Uint32Array(16), new Uint32Array(16), new Uint32Array(16)];
    const capHist = [new Uint32Array(16), new Uint32Array(16), new Uint32Array(16), new Uint32Array(16)];
    const refLuma = new Float64Array(count);
    const capLuma = new Float64Array(count);
    const refMean = [0, 0, 0], capMean = [0, 0, 0], bias = [0, 0, 0];
    let mae = 0, mse = 0, lumaMae = 0, lumaMse = 0, edgeDiff = 0;
    let refNonBlank = 0, capNonBlank = 0;
    const refColors = new Set(), capColors = new Set();
    const luma = (pixels, index) => 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      const r = [referencePixels[i], referencePixels[i + 1], referencePixels[i + 2]];
      const c = [capturePixels[i], capturePixels[i + 1], capturePixels[i + 2]];
      for (let channel = 0; channel < 3; channel++) {
        refMean[channel] += r[channel]; capMean[channel] += c[channel];
        const delta = c[channel] - r[channel]; bias[channel] += delta;
        mae += Math.abs(delta); mse += delta * delta;
        refHist[channel][Math.min(15, r[channel] >> 4)]++;
        capHist[channel][Math.min(15, c[channel] >> 4)]++;
      }
      refHist[3][Math.min(15, Math.round(luma(referencePixels, i) / 16))]++;
      capHist[3][Math.min(15, Math.round(luma(capturePixels, i) / 16))]++;
      refLuma[p] = luma(referencePixels, i); capLuma[p] = luma(capturePixels, i);
      const ld = capLuma[p] - refLuma[p]; lumaMae += Math.abs(ld); lumaMse += ld * ld;
      if (refLuma[p] > 3) refNonBlank++; if (capLuma[p] > 3) capNonBlank++;
      if (refColors.size < 20000) refColors.add(`${r[0]},${r[1]},${r[2]}`);
      if (capColors.size < 20000) capColors.add(`${c[0]},${c[1]},${c[2]}`);
    }
    const sobel = (values, x, y) => {
      const at = (xx, yy) => values[Math.max(0, Math.min(height - 1, yy)) * width + Math.max(0, Math.min(width - 1, xx))];
      const gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      return Math.min(255, Math.hypot(gx, gy));
    };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * width + x;
      edgeDiff += Math.abs(sobel(refLuma, x, y) - sobel(capLuma, x, y));
    }
    const variance = values => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return { mean, value: values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length };
    };
    const refStats = variance(refLuma), capStats = variance(capLuma);
    let covariance = 0;
    for (let p = 0; p < count; p++) covariance += (refLuma[p] - refStats.mean) * (capLuma[p] - capStats.mean);
    covariance /= count;
    const c1 = 6.5025, c2 = 58.5225;
    const ssim = ((2 * refStats.mean * capStats.mean + c1) * (2 * covariance + c2))
      / ((refStats.mean ** 2 + capStats.mean ** 2 + c1) * (refStats.value + capStats.value + c2));
    const chiSquare = refHist.map((hist, channel) => hist.reduce((sum, expected, index) => {
      const actual = capHist[channel][index];
      return sum + ((actual - expected) ** 2) / Math.max(1, expected + actual);
    }, 0));
    const rgbMae = mae / (count * 3), rgbRmse = Math.sqrt(mse / (count * 3));
    const luminanceMae = lumaMae / count, luminanceRmse = Math.sqrt(lumaMse / count);
    const channelMean = values => values.map(value => value / count);
    const rgbBias = channelMean(bias);
    const edgeDifference = edgeDiff / (count * 255);
    const absoluteBias = rgbBias.reduce((sum, value) => sum + Math.abs(value), 0) / 3;
    const score = 100 * (0.35 * rgbMae / 255 + 0.2 * luminanceMae / 255 + 0.15 * Math.min(1, absoluteBias / 255) + 0.15 * Math.max(0, 1 - ssim) + 0.15 * Math.min(1, edgeDifference));
    return {
      dimensions: { width, height, reference: { width: referenceWidth, height: referenceHeight }, resampling: { policy: resampling?.policy || 'stretch-to-capture', aspectRatioDelta, aspectRatioTolerance: Number(resampling?.aspectRatioTolerance ?? 0.005), imageSmoothingQuality: context.imageSmoothingQuality } },
      meanRgb: { reference: channelMean(refMean), capture: channelMean(capMean), bias: rgbBias },
      absoluteMeanBias: absoluteBias,
      luminance: { referenceMean: refStats.mean, captureMean: capStats.mean, meanAbsoluteError: luminanceMae, rmse: luminanceRmse },
      rgb: { mae: rgbMae, rmse: rgbRmse },
      histograms: { reference: refHist.map(hist => [...hist]), capture: capHist.map(hist => [...hist]), chiSquare },
      luminanceSsim: ssim,
      sobelEdgeDifference: edgeDifference,
      sanity: { referenceNonBlankRatio: refNonBlank / count, captureNonBlankRatio: capNonBlank / count, referenceUniqueColors: refColors.size, captureUniqueColors: capColors.size },
      diagnosticScore: score,
    };
  }, { referenceUrl, captureUrl, resampling });
}

function usage() {
  console.log('Usage: node scripts/validate-visual-references.mjs --url=URL [--manifest=FILE] [--out=FILE] [--captures=DIR] [--update-baseline] [--disable-lod]');
}

async function validateReferences(manifest, manifestPath, updateBaseline, views = manifest.views || []) {
  const errors = [];
  for (const view of views) {
    const file = absolute(view.referenceImage);
    if (updateBaseline && view.referenceKind === 'source-screenshot') {
      errors.push(`${view.id}: --update-baseline is only valid for babylon-baseline references`);
      continue;
    }
    if (!fsSync.existsSync(file)) {
      errors.push(`${view.id}: missing reference ${path.relative(ROOT, file)}`);
      continue;
    }
    if (!view.referenceSha256) {
      errors.push(`${view.id}: manifest is missing referenceSha256`);
      continue;
    }
    const actual = await sha256File(file);
    if (actual !== view.referenceSha256 && !(updateBaseline && view.referenceKind === 'babylon-baseline')) {
      errors.push(`${view.id}: reference SHA-256 mismatch (manifest ${view.referenceSha256}, actual ${actual})`);
    }
  }
  if (errors.length) throw new Error(`Visual reference manifest validation failed:\n${errors.join('\n')}`);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) { usage(); return; }
  const manifestPath = absolute(options.manifest || DEFAULT_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const outPath = absolute(options.out || DEFAULT_OUT);
  const captureDir = absolute(options.captures || DEFAULT_CAPTURE_DIR);
  const timeout = number(options.timeout, 600000);
  const settleMs = number(options['settle-ms'], 1200);
  const updateBaseline = bool(options['update-baseline']);
  if (options['wait-full-load'] !== undefined && !bool(options['wait-full-load'])) {
    throw new Error('Visual reference validation always requires full load; remove --wait-full-load=false');
  }
  if (options['disable-lod'] !== undefined && !bool(options['disable-lod'])) {
    throw new Error('Canonical visual reference validation always disables LOD; remove --disable-lod=false');
  }
  const fullLoad = CANONICAL_FULL_LOAD;
  const disableLod = true;
  const requestedViews = options.views && String(options.views).split(',').map(value => value.trim()).filter(Boolean);
  let views = manifest.views.filter(view => !requestedViews || requestedViews.includes(view.id) || requestedViews.includes(view.mapId));
  if (updateBaseline && !requestedViews) views = views.filter(view => view.referenceKind === 'babylon-baseline');
  if (!views.length) throw new Error('Manifest selection produced no views');
  await validateReferences(manifest, manifestPath, updateBaseline, views);
  await fs.mkdir(captureDir, { recursive: true });
  const { chromium } = await loadPlaywright(options['playwright-module-path']);
  const browser = await chromium.launch({ executablePath: options['browser-path'] || process.env.BROWSER_PATH || undefined, headless: !bool(options.headed), args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
  const results = [];
  try {
    for (const view of views) {
      const startedAt = Date.now();
      const capture = path.join(captureDir, `${view.mapId}-${view.id}.png`);
      const reference = absolute(view.referenceImage);
      const context = await browser.newContext({ viewport: manifest.resolution, deviceScaleFactor: manifest.resolution.deviceScaleFactor || 1 });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      try {
        await page.goto(normalizedUrl(options.url || DEFAULT_URL, view.mapId), { waitUntil: 'domcontentloaded', timeout });
        await waitReady(page, timeout);
        const applied = await applyView(page, view, disableLod);
        const buildInfo = await captureBuildInfo(page);
        await settle(page, settleMs);
        const evidence = await captureEvidence(page);
        if (!evidence.ready || !evidence.fullyLoaded) throw new Error('Preview did not expose ready and fullyLoaded evidence');
        validateViewEvidence(view, evidence);
        await page.locator('#babylon-canvas').screenshot({ path: capture });
        let referencePath = reference;
        let status = 'compared';
        if (updateBaseline) {
          const temporary = `${reference}.tmp-${process.pid}`;
          await fs.copyFile(capture, temporary);
          await fs.rename(temporary, reference);
          view.referenceSha256 = await sha256File(reference);
          view.referenceProvenance = {
            kind: 'babylon-capture',
            source: 'current-build baseline refreshed by scripts/validate-visual-references.mjs',
            updatedAt: new Date().toISOString(),
            capture: {
              url: page.url(),
              resolution: manifest.resolution,
              fullLoad,
              lodEnabled: false,
            },
            producer: buildInfo ? {
              sourceSha256: buildInfo.sourceSha256 ?? null,
              engine: buildInfo.engine ?? null,
              engineVersion: buildInfo.engineVersion ?? null,
              mapCount: buildInfo.mapCount ?? null,
              manifestSha256: buildInfo.visualReferences?.manifestSha256 ?? null,
              validatorSha256: buildInfo.visualReferences?.validatorSha256 ?? null,
              buildInfo,
            } : { status: 'unavailable' },
          };
          status = 'baseline-updated';
        }
        const metrics = await compareInPage(page, await dataUrl(referencePath), await dataUrl(capture), manifest.resampling);
        results.push({ mapId: view.mapId, id: view.id, status, referenceKind: view.referenceKind, reference: referencePath, capture, applied, evidence, metrics, durationMs: Date.now() - startedAt });
      } catch (error) {
        results.push({ mapId: view.mapId, id: view.id, status: 'error', message: error.message, capture, reference, durationMs: Date.now() - startedAt });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (updateBaseline) await writeJson(manifestPath, manifest);
  const ranked = results.filter(result => result.metrics).sort((a, b) => b.metrics.diagnosticScore - a.metrics.diagnosticScore);
  const summary = {
    generatedAt: new Date().toISOString(),
    manifest: path.relative(ROOT, manifestPath).replaceAll('\\', '/'),
    url: options.url || DEFAULT_URL,
    policy: { diagnosticOnly: true, scoreHigherMeansMoreDifferent: true, scoreWeights: { rgbMae: 0.35, luminanceMae: 0.2, absoluteMeanBias: 0.15, ssim: 0.15, sobelEdge: 0.15 }, fullLoad, disableLod, resolution: manifest.resolution, resampling: manifest.resampling },
    counts: { views: results.length, compared: results.filter(result => result.metrics).length, missingReference: results.filter(result => result.status === 'missing-reference').length, errors: results.filter(result => result.status === 'error').length },
    topDifferences: ranked.slice(0, 3).map(result => ({ mapId: result.mapId, id: result.id, diagnosticScore: result.metrics.diagnosticScore })),
    results,
  };
  await writeJson(outPath, summary);
  console.log(JSON.stringify({ out: outPath, counts: summary.counts, topDifferences: summary.topDifferences }, null, 2));
  if (summary.counts.errors || summary.counts.missingReference || summary.counts.compared !== summary.counts.views) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
