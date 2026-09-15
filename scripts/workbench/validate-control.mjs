#!/usr/bin/env node
/**
 * S01 closed-loop validation for the Workbench control surface.
 *
 * Normal path: load the golden map, set camera+time through dispatch, wait
 * for observable state, read back, capture a screenshot.
 * Failure paths: an invalid map id is rejected explicitly and the next legal
 * command still works; map.switch to a second map is followed across the
 * navigation and the new boot reports a new sceneEpoch.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's01');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = new URL(args.url || DEFAULT_URL);
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  const startedAt = new Date().toISOString();
  const steps = [];

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  const step = (name, result) => {
    steps.push({ name, ...result });
    console.error(`  [${result.ok ? 'ok' : 'FAIL'}] ${name}`);
  };

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl });

    // 1. Normal path: fixed camera + time, observed, read back.
    const cameraSet = await dispatch(page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
    step('camera.set', { ok: cameraSet.status === 'ok', result: cameraSet });
    const timeSet = await dispatch(page, 'time.set', { time: 'day' });
    step('time.set', { ok: timeSet.status === 'ok' && timeSet.data?.time === 'day', result: timeSet });
    const read = await dispatch(page, 'state.read');
    const camera = read.data?.camera;
    step('state.read', {
      ok: read.status === 'ok'
        && camera?.position?.[0] !== null
        && read.data?.mapId === 'e3t1'
        && Math.abs(camera.position[0] - 90.5219) < 0.01,
      result: read,
    });
    const screenshot = path.join(OUT_DIR, 's01-control.png');
    await fs.mkdir(OUT_DIR, { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: false });
    step('screenshot', { ok: fsSyncExists(screenshot), result: { screenshot } });

    // 2. Failure path: invalid map id is rejected, then a legal command works.
    const invalid = await dispatch(page, 'map.switch', { mapId: 'not-a-map' });
    step('map.switch invalid rejected', { ok: invalid.status === 'rejected' && invalid.errorCode === 'invalid-args', result: invalid });
    const after = await dispatch(page, 'camera.get');
    step('legal command after failure', { ok: after.status === 'ok', result: after });

    // 3. Stale-op guard: commands can carry the epoch they were built for.
    const stale = await dispatch(page, 'camera.set', { expectedEpoch: read.sceneEpoch + 100, position: [1, 1, 1], target: [2, 2, 2] });
    step('stale epoch rejected', { ok: stale.status === 'stale', result: stale });

    // 4. Map switch followed across navigation: new boot, new epoch, same API.
    const switchResult = await dispatch(page, 'map.switch', { mapId: args['switch-map'] || 'e3t1' });
    step('map.switch', { ok: switchResult.status === 'ok' || switchResult.status === 'accepted', result: switchResult });
    if (args['switch-map'] && switchResult.status === 'accepted') {
      await page.goto(switchResult.data.navigateTo, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => Boolean(globalThis.__FF14_WORKBENCH__ && globalThis.__BABYLON_PREVIEW__?.isReady), null, { timeout: 300000, polling: 250 });
      const newState = await dispatch(page, 'state.read');
      step('map.switch followed', {
        ok: newState.status === 'ok'
          && newState.data?.mapId === (args['switch-map'] || 'e3t1')
          && newState.sceneEpoch !== read.sceneEpoch,
        result: newState,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = {
    generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0,
    total: steps.length, failed: failed.length, steps,
  };
  await fs.mkdir(OUT_DIR, { recursive: true });
  const reportFile = path.join(OUT_DIR, `s01-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS01 control validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function fsSyncExists(file) {
  try {
    return fsSync.existsSync(file);
  } catch {
    return false;
  }
}

await main();
