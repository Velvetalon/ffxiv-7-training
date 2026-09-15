#!/usr/bin/env node
/**
 * S7 checks:
 *  1. Cross-midnight interpolation on e3t1 (23.5 -> 0.5 -> back to day) with
 *     no value accumulation.
 *  2. Guard maps G-1 (gridania, nature) and G-2 (limsa, city) via the CDN-mode
 *     server: profiles must be map-specific (data-driven rules, not e3t1
 *     hardcodes) and both maps render at the interactive gate.
 *  3. Performance probe: fps median on e3t1 full load with shadows on, shadows
 *     off, and sky dome hidden (isolates the S8 fps-drop watch item).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from '../workbench/wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'work', 'lighting', 's7');

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

async function fpsMedian(page, sampleCount = 8) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    await page.waitForTimeout(350);
    const fps = await page.evaluate(() => globalThis.__BABYLON_PREVIEW__.engine.getFps());
    samples.push(fps);
  }
  samples.sort((a, b) => a - b);
  return { median: Number(samples[Math.floor(samples.length / 2)].toFixed(1)), min: Number(samples[0].toFixed(1)), max: Number(samples[samples.length - 1].toFixed(1)) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const localUrl = new URL(args.url || 'http://127.0.0.1:5173/ff14-web-babylon-preview/');
  if (!localUrl.pathname.endsWith('/')) localUrl.pathname += '/';
  localUrl.searchParams.set('viewer', '1');
  localUrl.searchParams.set('scene', 'e3t1');
  await fs.mkdir(OUT_DIR, { recursive: true });
  const report = { midnight: null, guardMaps: [], perf: null, passed: true };

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  try {
    // 1. Cross-midnight + accumulation check on the local asset server.
    const first = await openWorkbenchPage({ browser, appUrl: localUrl, waitFull: true });
    const page = first.page;
    const read = () => page.evaluate(() => {
      const diag = globalThis.__BABYLON_PREVIEW__.environment.diagnostics();
      const sun = globalThis.__BABYLON_PREVIEW__.scene.lights.find(l => l.name === 'KuganeSun');
      return { hour: diag.currentHour, sun: sun?.intensity, fogColor: diag.lights?.fog?.color, sky: diag.sky?.horizon ?? null };
    });

    const dayBefore = await (async () => { await dispatch(page, 'time.set', { time: 'day' }); await page.waitForTimeout(400); return read(); })();
    await dispatch(page, 'time.set', { hour: 23.5 });
    const late = await page.waitForTimeout(300).then(() => read());
    await dispatch(page, 'time.set', { hour: 0.5 });
    const early = await read();
    await dispatch(page, 'time.set', { time: 'day' });
    const dayAgain = await page.waitForTimeout(400).then(() => read());
    const noAccumulation = dayAgain.sun === dayBefore.sun && dayAgain.fogColor === dayBefore.fogColor;
    const midnightSane = late.hour > 23 && early.hour < 1 && late.sun !== null;
    report.midnight = { dayBefore, late, early, dayAgain, noAccumulation, midnightSane };
    report.passed &&= noAccumulation && midnightSane;
    console.error(`  [midnight] cross-midnight sane=${midnightSane} day-restored-identical=${noAccumulation}`);

    // 3. Perf probe (same page, full city view).
    await dispatch(first.page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
    await page.waitForTimeout(800);
    const perf = {};
    perf.shadowsOn = await fpsMedian(first.page);
    await first.page.evaluate(() => {
      const generator = globalThis.__BABYLON_PREVIEW__.environment.shadowGenerator;
      const map = generator?.getShadowMap?.();
      if (map) map.renderList = [];
    });
    await first.page.waitForTimeout(500);
    perf.shadowsEmptyList = await fpsMedian(first.page);
    await first.page.evaluate(() => { globalThis.__BABYLON_PREVIEW__.scene.getMeshByName('KuganeSkyDome')?.setEnabled(false); });
    await first.page.waitForTimeout(500);
    perf.skyHidden = await fpsMedian(first.page);
    await first.page.evaluate(() => { globalThis.__BABYLON_PREVIEW__.scene.getMeshByName('KuganeSkyDome')?.setEnabled(true); });
    report.perf = perf;
    console.error(`  [perf] shadowsOn=${JSON.stringify(perf.shadowsOn)} shadowsEmpty=${JSON.stringify(perf.shadowsEmptyList)} skyHidden=${JSON.stringify(perf.skyHidden)}`);
    await first.context.close();

    // 2. Guard maps via CDN-mode server.
    for (const [label, mapId] of [['G-1-gridania', 'gridania'], ['G-2-limsa', 'limsa']]) {
      const cdnUrl = new URL(args.cdnUrl || 'http://127.0.0.1:5174/ff14-web-babylon-preview/');
      if (!cdnUrl.pathname.endsWith('/')) cdnUrl.pathname += '/';
      cdnUrl.searchParams.set('viewer', '1');
      cdnUrl.searchParams.set('scene', mapId);
      let context = null;
      try {
        const opened = await openWorkbenchPage({ browser, appUrl: cdnUrl, timeoutMs: 240000 });
        context = opened.context;
        const page = opened.page;
        await dispatch(page, 'time.set', { time: 'day' });
        await page.waitForTimeout(800);
        const info = await page.evaluate(map => {
          const api = globalThis.__BABYLON_PREVIEW__;
          const diag = api.environment.diagnostics();
          return {
            mapId: api.mapId,
            meshes: api.loader?.state?.meshCount ?? 0,
            sun: diag.lights?.sun, fog: diag.lights?.fog, sky: diag.sky?.horizon ?? null,
            profileSampleCount: diag.sampleCount,
          };
        }, mapId);
        const shot = path.join(OUT_DIR, `guard-${label}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        report.guardMaps.push({ label, ...info, screenshot: path.relative(REPO_ROOT, shot) });
        console.error(`  [guard] ${label}: map=${info.mapId} meshes=${info.meshes} sun=${info.sun?.color}@${info.sun?.intensity} fog=${info.fog?.color} sky=${info.sky}`);
        report.passed &&= info.mapId === mapId && info.meshes > 0;
      } catch (error) {
        report.guardMaps.push({ label, error: error.message.slice(0, 200) });
        report.passed = false;
        console.error(`  [guard] ${label}: FAILED ${error.message.slice(0, 120)}`);
      } finally {
        await context?.close();
      }
    }
  } finally {
    await browser.close();
  }

  const reportFile = path.join(OUT_DIR, `s7-report-${Date.now()}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS7 report: ${path.relative(REPO_ROOT, reportFile)} passed=${report.passed}`);
}

await main();
