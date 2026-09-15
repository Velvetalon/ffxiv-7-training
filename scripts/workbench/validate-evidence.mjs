#!/usr/bin/env node
/**
 * S08 closed-loop validation: a controlled local failure produces aggregated
 * anomalies and a portable evidence pack; a new page reproduces the case with
 * the injection removed.
 *
 * 1. Inject a page-level fetch fault for a specific texture path (local only).
 * 2. Trigger a hot texture update that needs that path -> candidate-error.
 * 3. anomalies.list aggregates the failure; evidence.export builds the pack.
 * 4. New page: import the case from the pack -> restores cleanly (no fault).
 * 5. faults.clear removes the interception on the first page.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's08');
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
  const evidenceId = `s08-fault-${Date.now()}`;
  const evidenceDir = path.join(OUT_DIR, evidenceId);

  try {
    // Page 1: the faulted run.
    const first = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const { page } = first;

    await dispatch(page, 'camera.set', { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' });
    await dispatch(page, 'time.set', { time: 'day' });
    const captured = await dispatch(page, 'case.capture', { caseId: `s08-${evidenceId}`, objectLimit: 2 });
    const saved = await dispatch(page, 'case.save', { case: captured.data?.case });
    step('case saved', captured.status === 'ok' && saved.status === 'ok', saved.data);

    // Find a texture path that is NOT loaded yet (the cached ones never hit
    // the network, so the fault would not fire), then fault exactly it.
    const inspected = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    const slots = inspected.data?.materials?.[0]?.textures || [];
    const albedoPath = slots.find(slot => slot.semantic === 'albedo')?.runtimePath || null;
    const loadedPaths = new Set(slots.map(slot => slot.runtimePath).filter(Boolean));
    const faultPath = await page.evaluate(loaded => {
      const paths = globalThis.__BABYLON_PREVIEW__.assets?.map?.paths || {};
      return Object.keys(paths).find(key => !loaded.includes(key)) || null;
    }, [...loadedPaths]);
    step('uncached fault target found', Boolean(faultPath) && faultPath !== albedoPath, { faultPath });
    const injected = await dispatch(page, 'faults.inject', { match: faultPath });
    step('fault injected (page-local)', injected.status === 'ok', injected.data);

    const hotUpdate = await dispatch(page, 'hot.updateMaterial', {
      stableAddress: TARGET, change: { kind: 'texture', slot: 'albedo', runtimePath: faultPath },
    });
    const materialStill = (await dispatch(page, 'objects.inspect', { stableAddress: TARGET })).data?.materials?.[0]?.finalParams?.className;
    step('faulted hot update fails safely', hotUpdate.status === 'failed'
      && hotUpdate.errorCode === 'candidate-error'
      && materialStill === 'PBRMaterial', { status: hotUpdate.status, errorCode: hotUpdate.errorCode });

    const anomalies = await dispatch(page, 'anomalies.list');
    const aggregated = (anomalies.data?.anomalies || []).find(entry => entry.key?.includes(faultPath) || entry.kind === 'hot-candidate-error');
    step('anomalies aggregated', anomalies.status === 'ok'
      && Boolean(aggregated)
      && anomalies.data?.injectedFault?.active, { aggregated, injectedFault: anomalies.data?.injectedFault });

    const exported = await dispatch(page, 'evidence.export', { evidenceId, caseId: `s08-${evidenceId}` });
    step('evidence.export', exported.status === 'ok' && exported.data?.evidence?.case?.map?.id === 'e3t1', exported.data?.evidence?.anomalies);

    // Write the pack (no signed URLs may leak).
    await fs.mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, 'faulted-state.png'), fullPage: false });
    const evidenceText = JSON.stringify(exported.data.evidence, null, 2);
    await fs.writeFile(path.join(evidenceDir, 'evidence.json'), `${evidenceText}\n`, 'utf8');
    const leaked = /sign=[0-9a-fA-F]{8,}/.test(evidenceText);
    step('evidence sanitized (no signed URLs)', !leaked, { leaked, file: path.relative(REPO_ROOT, path.join(evidenceDir, 'evidence.json')) });

    // Page 2: a clean page reproduces the case without the fault.
    const second = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const evidence = JSON.parse(await fs.readFile(path.join(evidenceDir, 'evidence.json'), 'utf8'));
    const restored = await dispatch(second.page, 'case.restore', { case: evidence.case });
    const readBack = await dispatch(second.page, 'state.read');
    const reproduced = restored.status === 'ok'
      && restored.data?.completeness === 'complete'
      && readBack.data?.camera?.position
      && Math.abs(readBack.data.camera.position[0] - 90.5219) < 0.05;
    step('case reproduces in a clean page', reproduced, { restored: restored.data?.completeness, camera: readBack.data?.camera?.position });
    await second.page.screenshot({ path: path.join(evidenceDir, 'reproduced.png'), fullPage: false });
    await second.context.close();

    // Remove the injection; the flow recovers.
    const cleared = await dispatch(page, 'faults.clear');
    const hotAfterClear = await dispatch(page, 'hot.updateMaterial', {
      stableAddress: TARGET, change: { kind: 'texture', slot: 'albedo', runtimePath: faultPath },
    });
    step('normal flow recovers after faults.clear', cleared.status === 'ok'
      && hotAfterClear.status === 'ok', { cleared: cleared.data, hotAfterClear: hotAfterClear.data?.material });
    await dispatch(page, 'hot.rollback', { stableAddress: TARGET });
    await first.context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s08-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS08 evidence validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
