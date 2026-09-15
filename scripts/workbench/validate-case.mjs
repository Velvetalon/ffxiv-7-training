#!/usr/bin/env node
/**
 * S02 closed-loop validation: a case restores the problem site, not just a
 * screenshot.
 *
 * Normal loop: fixed camera/time -> case.capture -> save -> scramble state ->
 * case.restore -> compare read-back + screenshot.
 * Failure paths: strict semantics reject a stale asset version; a case whose
 * object no longer resolves restores partial with an explicit missing list.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's02');

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

function close(a, b, epsilon = 0.05) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= epsilon;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = new URL(args.url || DEFAULT_URL);
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  const startedAt = new Date().toISOString();
  const steps = [];
  const step = (name, ok, result) => {
    steps.push({ name, ok, result });
    console.error(`  [${ok ? 'ok' : 'FAIL'}] ${name}`);
  };

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  await fs.mkdir(OUT_DIR, { recursive: true });

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });

    // 1. Establish the site and capture a case.
    await dispatch(page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
    await dispatch(page, 'time.set', { time: 'day' });
    const captured = await dispatch(page, 'case.capture', { caseId: 's02-kugane-problem-site', objectLimit: 2 });
    const snapshot = captured.data?.case;
    step('case.capture', captured.status === 'ok' && snapshot?.objects?.length === 2, captured);
    const saved = await dispatch(page, 'case.save', { case: snapshot });
    step('case.save', saved.status === 'ok', saved);
    await fs.writeFile(path.join(OUT_DIR, 'case.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    // 2. Scramble: move away, switch to night, pause animations.
    await dispatch(page, 'camera.set', { position: [10, 5, 10], target: [50, 10, 50] });
    await dispatch(page, 'time.set', { time: 'night' });
    const paused = await dispatch(page, 'animation.pause');
    step('scramble', paused.status === 'ok', { camera: 'moved', time: 'night', paused: paused.status });
    const scrambledShot = path.join(OUT_DIR, 'scrambled.png');
    await page.screenshot({ path: scrambledShot, fullPage: false });

    // 3. Restore from storage (compatible semantics) and verify observably.
    const restored = await dispatch(page, 'case.restore', { caseId: 's02-kugane-problem-site' });
    const readBack = await dispatch(page, 'state.read');
    const camera = readBack.data?.camera;
    const cameraRestored = camera && close(camera.position, snapshot.camera.position);
    const timeRestored = readBack.data?.time === snapshot.time;
    step('case.restore', restored.status === 'ok' && restored.data?.completeness === 'complete', restored);
    step('state matches case', cameraRestored && timeRestored, { cameraRestored, timeRestored, time: readBack.data?.time });
    const restoredShot = path.join(OUT_DIR, 'restored.png');
    await page.screenshot({ path: restoredShot, fullPage: false });

    // 4. Failure path A: strict semantics reject an outdated version.
    const staleCase = { ...snapshot, versions: { ...snapshot.versions, assetRunId: '20000101T000000Z-expired' } };
    const strictResult = await dispatch(page, 'case.restore', { case: staleCase, semantics: 'strict' });
    step('strict version mismatch rejected', strictResult.status === 'failed' && strictResult.errorCode === 'version-mismatch', strictResult);

    // 5. Failure path B: object no longer resolvable -> partial restore with
    // an explicit missing list, never a silent fake success.
    const missingObjectCase = {
      ...snapshot,
      objects: [{ ...snapshot.objects[0], stableAddress: `${snapshot.map.id}:99999:0` }],
    };
    const partialResult = await dispatch(page, 'case.restore', { case: missingObjectCase });
    step('missing object reported partial', partialResult.status === 'ok'
      && partialResult.data?.completeness === 'partial'
      && partialResult.data?.missing?.length === 1, partialResult);

    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s02-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS02 case validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
