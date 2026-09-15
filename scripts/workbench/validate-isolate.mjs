#!/usr/bin/env node
/**
 * S06 closed-loop validation: inspect one object without the whole city.
 *
 * Loop: fix a site -> isolate.enter a real building object (only the target
 * visible, neutral rig) -> env original/neutral toggle -> orbit -> wireframe
 * -> independent instance override + undo -> isolate.exit returns the exact
 * site. Also records the honest UNSUPPORTED gap for opening a resource with
 * no map context.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's06');
const TARGET = 'e3t1:118:0';

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
  const step = (name, ok, result) => {
    steps.push({ name, ok, result });
    console.error(`  [${ok ? 'ok' : 'FAIL'}] ${name}`);
  };
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  let context = null;
  let page = null;

  try {
    ({ context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true }));

    // Fix the site we intend to return to.
    await dispatch(page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
    await dispatch(page, 'time.set', { time: 'day' });

    const enabledMeshesBefore = await page.evaluate(() => globalThis.__BABYLON_PREVIEW__.scene.meshes.filter(mesh => mesh.isEnabled()).length);

    // Enter isolation.
    const entered = await dispatch(page, 'isolate.enter', { stableAddress: TARGET });
    const isolatedOk = entered.status === 'ok'
      && entered.data?.visibleMeshes <= 12
      && Boolean(entered.data?.dependenciesChanged?.fog);
    step('isolate.enter', isolatedOk, entered.data);

    // Neutral vs original environment toggle inside isolation.
    const original = await dispatch(page, 'isolate.env', { mode: 'original' });
    const neutral = await dispatch(page, 'isolate.env', { mode: 'neutral' });
    step('env toggle', original.status === 'ok' && neutral.status === 'ok', { original: original.status, neutral: neutral.status });

    // Orbit and wireframe.
    const orbitBefore = (await dispatch(page, 'state.read')).data.camera.position;
    const orbit = await dispatch(page, 'isolate.orbit', { angle: 2.2 });
    const orbitAfter = (await dispatch(page, 'state.read')).data.camera.position;
    const moved = orbitAfter && orbitBefore && (Math.abs(orbitAfter[0] - orbitBefore[0]) > 0.5 || Math.abs(orbitAfter[2] - orbitBefore[2]) > 0.5);
    step('orbit moves camera', orbit.status === 'ok' && moved, { angle: orbit.data?.angle, moved });
    const wireframe = await dispatch(page, 'isolate.wireframe', { on: true });
    step('wireframe toggles', wireframe.status === 'ok' && wireframe.data?.wireframe === true, wireframe.data);

    // Independent edit state inside isolation: apply then undo.
    const edit = await dispatch(page, 'override.set', { scope: 'instance', stableAddress: TARGET, property: 'roughness', value: 0.5 });
    const editUndo = await dispatch(page, 'override.undo');
    step('independent edit + undo', edit.status === 'ok' && editUndo.status === 'ok'
      && Math.abs(editUndo.data?.undone?.restoredTo - edit.data?.before) < 1e-6, { edit: edit.data, undo: editUndo.data });

    // Exit isolation: scene and site restored.
    const exited = await dispatch(page, 'isolate.exit');
    const siteAfter = await dispatch(page, 'state.read');
    const enabledMeshesAfter = await page.evaluate(() => globalThis.__BABYLON_PREVIEW__.scene.meshes.filter(mesh => mesh.isEnabled()).length);
    const cameraRestored = siteAfter.data?.camera?.position
      && Math.abs(siteAfter.data.camera.position[0] - 90.5219) < 0.05
      && Math.abs(siteAfter.data.camera.position[1] - 67) < 0.05;
    const sceneRestored = Math.abs(enabledMeshesAfter - enabledMeshesBefore) <= 2;
    step('exit restores scene and site', exited.status === 'ok'
      && sceneRestored && cameraRestored && siteAfter.data?.time === 'day', {
      exited: exited.data, enabledMeshesBefore, enabledMeshesAfter, cameraRestored, time: siteAfter.data?.time,
    });
    const screenshot = path.join(OUT_DIR, 's06-restored-site.png');
    await page.screenshot({ path: screenshot, fullPage: false });

    // Status + honest capability gap.
    const status = await dispatch(page, 'isolate.status');
    step('status reports resource-sample gap', status.status === 'ok'
      && status.data?.active === false
      && String(status.data?.resourceSampleOpen).startsWith('UNSUPPORTED'), status.data);

    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s06-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS06 isolation validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
