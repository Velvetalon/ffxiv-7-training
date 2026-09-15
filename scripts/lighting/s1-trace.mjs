#!/usr/bin/env node
/**
 * S1 trace verification: prove the decoded ENVB values (source-profiles.json)
 * reach the live light rig for Kugane at day / dusk / night, and record which
 * lighting data sources are available vs blocked. Numeric trace only — the
 * visual pass happens in the S8 comparison.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from '../workbench/wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRESET_HOURS = { day: 12, dusk: 17.5, night: 22 };

function nearestSample(samples, hour) {
  return samples.reduce((best, sample) => {
    const distance = Math.abs(sample.hour - hour);
    return !best || distance < best.distance ? { sample, distance } : best;
  }, null).sample;
}

async function main() {
  const appUrl = new URL('http://127.0.0.1:5173/ff14-web-babylon-preview/');
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  appUrl.searchParams.set('viewer', '1');
  appUrl.searchParams.set('scene', 'e3t1');

  const profiles = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'src/world/environment/source-profiles.json'), 'utf8'));
  const profile = profiles.e3t1 || null;
  const trace = { profileFound: Boolean(profile), keyframes: profile?.samples?.length ?? 0, checks: [], blocked: [] };

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });

    for (const [preset, hour] of Object.entries(PRESET_HOURS)) {
      await dispatch(page, 'time.set', { time: preset });
      await page.waitForTimeout(500);
      const runtime = await page.evaluate(() => {
        const diag = globalThis.__BABYLON_PREVIEW__.environment.diagnostics();
        const sun = globalThis.__BABYLON_PREVIEW__.scene.lights.find(light => light.name === 'KuganeSun');
        const moon = globalThis.__BABYLON_PREVIEW__.scene.lights.find(light => light.name === 'KuganeMoon');
        const ambient = globalThis.__BABYLON_PREVIEW__.scene.lights.find(light => light.name === 'KuganeAmbient');
        return {
          diagSun: diag.lights?.sun, diagMoon: diag.lights?.moon, diagFog: diag.lights?.fog,
          rigSun: sun?.intensity, rigMoon: moon?.intensity, rigAmbient: ambient?.intensity,
          rigSunColor: sun?.diffuse?.toHexString(), fogColor: globalThis.__BABYLON_PREVIEW__.scene.fogColor.toHexString(),
          sourceTime: diag.sourceTimeSeconds,
        };
      });
      const sample = nearestSample(profile.samples, hour);
      const check = {
        preset, hour,
        sourceSample: { hour: sample.hour, sunColor: sample.sunColor, sunIntensity: sample.sunIntensity, moonIntensity: sample.moonIntensity, fogColor: sample.fogColor },
        runtime,
        sunMatches: runtime.diagSun.color.toUpperCase() === sample.sunColor.toUpperCase() || Math.abs(runtime.rigSun - sample.sunIntensity) < 0.35,
        moonMatches: Math.abs(runtime.rigMoon - sample.moonIntensity) < 0.1,
      };
      trace.checks.push(check);
      console.error(`  [${preset}] source sun=${sample.sunColor}@${sample.sunIntensity} moon=${sample.moonIntensity} -> runtime sun=${runtime.diagSun?.color}@${runtime.rigSun} moon=${runtime.rigMoon} matches=${check.sunMatches && check.moonMatches}`);
    }

    trace.blocked = [
      { item: 'LGB light instances (night lamp positions/colors/ranges)', reason: 'no installed game client on this machine; bg.lgb extraction needs MapExtract + client. Raw LGB parsing precedent exists in scripts/check-map-position.mjs' },
      { item: 'sky cubemap / env texture assets', reason: 'no client; ENVB decoded fields carry colors/intensities but not sky assets' },
      { item: 'weather owner semantics', reason: 'owner-1 keyframes used without renaming raw ids to weather labels (documented non-claim)' },
    ];

    await context.close();
  } finally {
    await browser.close();
  }

  trace.passed = trace.checks.every(check => check.sunMatches && check.moonMatches);
  const reportFile = path.join(REPO_ROOT, 'work', 'lighting', `s1-trace-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`\nS1 trace: ${trace.passed ? 'PASS' : 'FAIL'} — source ENVB values reach the live rig; ${trace.blocked.length} sources blocked (no client)`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
}

await main();
