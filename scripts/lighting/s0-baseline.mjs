#!/usr/bin/env node
/**
 * S0 lighting baseline: read the REAL runtime values (not config files),
 * capture fixed-viewpoint baselines for K-DAY / K-DUSK / K-NIGHT, and run
 * one-contribution-at-a-time ablations (fog / IBL / direct / ambient) with
 * full restore.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from '../workbench/wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'work', 'lighting', 's0');

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

async function runtimeLighting(page) {
  return page.evaluate(() => {
    const api = globalThis.__BABYLON_PREVIEW__;
    const scene = api.scene;
    const diag = api.environment.diagnostics();
    const lights = scene.lights.map(light => ({
      name: light.name, type: light.getClassName(), intensity: Number(light.intensity.toFixed(4)),
      diffuse: light.diffuse?.toHexString?.() || null, ground: light.groundColor?.toHexString?.() || null,
      direction: light.direction ? light.direction.asArray().map(v => Number(v.toFixed(3))) : null,
      shadowEnabled: light.shadowEnabled,
    }));
    const albedoTextures = new Set();
    let gammaSamples = {};
    for (const mesh of scene.meshes) {
      const material = mesh.material;
      const texture = material?.albedoTexture;
      if (texture && !albedoTextures.has(texture.name)) {
        albedoTextures.add(texture.name);
        const key = `gammaSpace=${texture.gammaSpace}`;
        gammaSamples[key] = (gammaSamples[key] || 0) + 1;
      }
      if (albedoTextures.size >= 12) break;
    }
    return {
      lights,
      fog: { enabled: scene.fogEnabled, mode: scene.fogMode, color: scene.fogColor.toHexString(), start: scene.fogStart, end: scene.fogEnd },
      clearColor: scene.clearColor.toHexString(),
      imageProcessing: {
        exposure: scene.imageProcessingConfiguration.exposure,
        toneMappingEnabled: scene.imageProcessingConfiguration.toneMappingEnabled,
        toneMappingType: scene.imageProcessingConfiguration.toneMappingType,
        contrast: scene.imageProcessingConfiguration.contrast,
        vignetteEnabled: scene.imageProcessingConfiguration.vignetteEnabled,
      },
      environmentTexture: scene.environmentTexture ? {
        name: scene.environmentTexture.name,
        size: scene.environmentTexture.getSize?.().width ?? null,
        gammaSpace: scene.environmentTexture.gammaSpace,
        sphericalPolynomial: Boolean(scene.environmentTexture.sphericalPolynomial),
      } : null,
      envDiag: {
        profileSource: diag.profileSource, sampleCount: diag.sampleCount, currentHour: diag.currentHour,
        sun: diag.lights?.sun, moon: diag.lights?.moon, ambient: diag.lights?.ambient, fog: diag.lights?.fog,
        ibl: diag.ibl, shadows: { activeSource: diag.shadows.activeSource, casterCount: diag.shadows.casterCount, darkness: diag.shadows.darkness },
        imageProcessing: diag.imageProcessing,
      },
      albedoGammaSamples: gammaSamples,
      stats: { fps: Number(api.engine.getFps().toFixed(1)), meshes: api.loader?.state?.meshCount },
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = new URL(args.url || 'http://127.0.0.1:5173/ff14-web-babylon-preview/');
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  appUrl.searchParams.set('viewer', '1');
  appUrl.searchParams.set('scene', 'e3t1');
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  const report = { generatedAt: new Date().toISOString(), url: appUrl.href, presets: {} };

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });

    for (const preset of ['day', 'dusk', 'night']) {
      await dispatch(page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
      await dispatch(page, 'time.set', { time: preset });
      await page.waitForTimeout(900);
      const state = await runtimeLighting(page);
      const shot = path.join(OUT_DIR, `baseline-${preset}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      report.presets[preset] = { state, screenshot: path.relative(REPO_ROOT, shot) };
      console.error(`  [baseline] ${preset}: sun=${state.envDiag.sun.color}@${state.envDiag.sun.intensity} moon=${state.envDiag.moon.color}@${state.envDiag.moon.intensity} fog=${state.fog.color} shadows=${state.envDiag.shadows.activeSource}`);
    }

    // Ablations on K-DAY: toggle one contribution, read back, restore.
    const ablations = [];
    const ablate = async (name, evaluate) => {
      await page.evaluate(evaluate);
      await page.waitForTimeout(700);
      const shot = path.join(OUT_DIR, `ablate-${name}.png`);
      await page.screenshot({ path: shot });
      const stats = await page.evaluate(() => {
        const scene = globalThis.__BABYLON_PREVIEW__.scene;
        return {
          fogEnabled: scene.fogEnabled,
          envTexture: Boolean(scene.environmentTexture),
          sun: scene.lights.find(l => l.name === 'KuganeSun')?.intensity ?? null,
          ambient: scene.lights.find(l => l.name === 'KuganeAmbient')?.intensity ?? null,
        };
      });
      ablations.push({ name, stats, screenshot: path.relative(REPO_ROOT, shot) });
      console.error(`  [ablate] ${name}: ${JSON.stringify(stats)}`);
    };

    await ablate('no-fog', () => { globalThis.__BABYLON_PREVIEW__.scene.fogEnabled = false; });
    await dispatch(page, 'time.set', { time: 'day' });
    await ablate('no-ibl', () => { globalThis.__BABYLON_PREVIEW__.scene.environmentTexture = null; });
    await dispatch(page, 'time.set', { time: 'day' });
    await ablate('no-direct', () => { const s = globalThis.__BABYLON_PREVIEW__.scene.lights.find(l => l.name === 'KuganeSun'); s.intensity = 0; });
    await dispatch(page, 'time.set', { time: 'day' });
    await ablate('no-ambient', () => { const s = globalThis.__BABYLON_PREVIEW__.scene.lights.find(l => l.name === 'KuganeAmbient'); s.intensity = 0; });
    await dispatch(page, 'time.set', { time: 'day' });

    // Restore and verify identical to baseline day.
    await page.waitForTimeout(700);
    const restored = await runtimeLighting(page);
    const restoreOk = restored.lights.find(l => l.name === 'KuganeSun')?.intensity === report.presets.day.state.lights.find(l => l.name === 'KuganeSun')?.intensity
      && restored.fog.enabled === true
      && Boolean(restored.environmentTexture);
    report.ablations = ablations;
    report.restoreVerified = restoreOk;
    console.error(`  [restore] verified=${restoreOk}`);

    await context.close();
  } finally {
    await browser.close();
  }

  const reportFile = path.join(OUT_DIR, `s0-report-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS0 report: ${path.relative(REPO_ROOT, reportFile)}  restoreVerified=${report.restoreVerified}`);
}

await main();
