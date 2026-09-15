#!/usr/bin/env node
/**
 * After-capture for the S2/S3/S4/S5 changes: K-DAY/DUSK/NIGHT from the same
 * fixed viewpoint as the S0 baselines, plus runtime read-back. Files land in
 * work/lighting/after/ with names matching the S0 baselines for side-by-side
 * review.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from '../workbench/wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'work', 'lighting', 'after');

async function main() {
  const appUrl = new URL('http://127.0.0.1:5173/ff14-web-babylon-preview/');
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  appUrl.searchParams.set('viewer', '1');
  appUrl.searchParams.set('scene', 'e3t1');
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const readBack = {};
    for (const preset of ['day', 'dusk', 'night']) {
      await dispatch(page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
      await dispatch(page, 'time.set', { time: preset });
      await page.waitForTimeout(1100);
      readBack[preset] = await page.evaluate(() => {
        const api = globalThis.__BABYLON_PREVIEW__;
        const diag = api.environment.diagnostics();
        const ambient = api.scene.lights.find(l => l.name === 'KuganeAmbient');
        return {
          sun: diag.lights?.sun, moon: diag.lights?.moon, ambientRig: ambient?.intensity,
          shadows: diag.shadows, sky: diag.sky,
          imageProcessing: api.scene.imageProcessingConfiguration ? {
            toneMappingEnabled: api.scene.imageProcessingConfiguration.toneMappingEnabled,
            exposure: api.scene.imageProcessingConfiguration.exposure,
          } : null,
        };
      });
      const shot = path.join(OUT_DIR, `baseline-${preset}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      console.error(`  [after] ${preset}: ambient=${readBack[preset].ambientRig?.toFixed(3)} toneMap=${readBack[preset].imageProcessing?.toneMappingEnabled} sky=${readBack[preset].sky?.horizon}->${readBack[preset].sky?.zenith} shadows=${readBack[preset].shadows?.activeSource}@${readBack[preset].shadows?.darkness}`);
    }
    await fs.writeFile(path.join(OUT_DIR, 'readback.json'), `${JSON.stringify(readBack, null, 2)}\n`, 'utf8');
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(`\nAfter-captures in ${path.relative(REPO_ROOT, OUT_DIR)}`);
}

await main();
