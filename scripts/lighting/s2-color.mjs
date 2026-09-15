#!/usr/bin/env node
/**
 * S2 color-chain experiments:
 *  E1 albedo decode check — does the GPU sample albedo through an sRGB format
 *     (hardware decode; gammaSpace=false is then correct) or is a gamma-space
 *     texture being sampled as linear (double-bright bug)?
 *  E2 tone mapping A/B — baseline (no tone mapping) vs Babylon ACES at a few
 *     exposures on the three Kugane presets; screenshots for visual review.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage } from '../workbench/wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'work', 'lighting', 's2');

async function main() {
  const appUrl = new URL('http://127.0.0.1:5173/ff14-web-babylon-preview/');
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  appUrl.searchParams.set('viewer', '1');
  appUrl.searchParams.set('scene', 'e3t1');
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  const report = { e1: {}, e2: [] };

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });

    // ---- E1: albedo decode state ----
    const decode = await page.evaluate(() => {
      const scene = globalThis.__BABYLON_PREVIEW__.scene;
      const samples = [];
      for (const mesh of scene.meshes) {
        const texture = mesh.material?.albedoTexture;
        if (!texture || samples.some(sample => sample.name === texture.name)) continue;
        const internal = texture.getInternalTexture?.();
        samples.push({
          name: texture.name?.slice(0, 60),
          gammaSpace: texture.gammaSpace,
          useSRGBBuffer: texture._useSRGBBuffer ?? null,
          format: internal?.format ?? null,
          type: internal?.type ?? null,
        });
        if (samples.length >= 10) break;
      }
      // Babylon Constants: TEXTUREFORMAT_RGBA=1, SRGB_ALPHA(B8G8R8A8?) formats differ by version;
      // report numeric + engine flag so we can interpret.
      return { samples, srgbAlphaConstant: globalThis.BABYLON ? null : 'check-format' };
    });
    report.e1 = decode;
    console.error(`  [E1] albedo textures: ${JSON.stringify(decode.samples.slice(0, 4), null, 1)}`);

    // ---- E2: tone mapping A/B ----
    const shots = [];
    for (const preset of ['day', 'dusk', 'night']) {
      await page.evaluate(p => globalThis.__FF14_WORKBENCH__.dispatch('time.set', { time: p }), preset);
      await page.waitForTimeout(600);

      for (const candidate of [
        { label: 'baseline', toneMapping: false, type: null, exposure: 1 },
        { label: 'aces-e10', toneMapping: true, type: 0, exposure: 1.0 },
        { label: 'aces-e13', toneMapping: true, type: 0, exposure: 1.3 },
      ]) {
        await page.evaluate(candidate => {
          const config = globalThis.__BABYLON_PREVIEW__.scene.imageProcessingConfiguration;
          config.toneMappingEnabled = candidate.toneMapping;
          if (candidate.toneMapping) config.toneMappingType = candidate.type;
          config.exposure = candidate.exposure;
        }, candidate);
        await page.waitForTimeout(900);
        const shot = path.join(OUT_DIR, `e2-${preset}-${candidate.label}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        shots.push({ preset: preset, ...candidate, screenshot: path.relative(REPO_ROOT, shot) });
      }
    }
    report.e2 = shots;

    // Restore baseline output chain.
    await page.evaluate(() => {
      const config = globalThis.__BABYLON_PREVIEW__.scene.imageProcessingConfiguration;
      config.toneMappingEnabled = false;
      config.exposure = 1;
    });

    await context.close();
  } finally {
    await browser.close();
  }

  const reportFile = path.join(OUT_DIR, `s2-report-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS2 report: ${path.relative(REPO_ROOT, reportFile)} (${shots.length} tone-mapping captures)`);
}

await main();
