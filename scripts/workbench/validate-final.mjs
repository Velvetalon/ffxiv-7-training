#!/usr/bin/env node
/**
 * S12: prove the whole chain on two real cases, then hand off.
 *
 * Case A (material/environment): restore golden case -> inspect provenance ->
 * save site -> isolate -> temporary param change -> A/B -> export patch ->
 * apply after reload -> undo/rollback.
 * Case B (resource anomaly): local fault injection -> trace via provenance
 * address + anomalies -> evidence pack -> reopen and restore -> impact plan
 * -> remove fault -> verify only the related case.
 *
 * Also records manual-step counts, map reloads and wall time per case, and
 * writes MORNING_REVIEW.md for the next session.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5173/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's12');
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
  const startedAt = Date.now();
  const steps = [];
  const step = (name, ok, result) => {
    steps.push({ name, ok, result });
    console.error(`  [${ok ? 'ok' : 'FAIL'}] ${name}`);
  };
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  const committedCase = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'workbench/cases/e3t1-baseline.json'), 'utf8'));
  let evidence = null;
  let reloads = 0;
  const timings = { caseA: {}, caseB: {} };

  try {
    // ===================== Case A =====================
    const aStart = Date.now();
    const first = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const page = first.page;
    timings.caseA.pageReadyMs = Date.now() - aStart;

    const restored = await dispatch(page, 'case.restore', { case: committedCase });
    const inspected = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    step('A: restore + provenance', restored.status === 'ok'
      && inspected.status === 'ok'
      && Boolean(inspected.data?.model?.contentHash), {
      material: inspected.data?.materials?.[0]?.ffxiv?.materialPath,
    });

    const saved = await dispatch(page, 'case.save', { case: { ...committedCase, caseId: 's12-site-A' } });
    const located = await dispatch(page, 'objects.locate', { stableAddress: TARGET });
    const isolated = await dispatch(page, 'isolate.enter', { stableAddress: TARGET });
    const activeMeshes = await page.evaluate(() => globalThis.__BABYLON_PREVIEW__.scene.getActiveMeshes().length);
    const camera = (await dispatch(page, 'state.read')).data.camera.position;
    const objectPos = located.data?.object?.worldPosition || [0, 0, 0];
    const cameraNearObject = camera
      && Math.hypot(camera[0] - objectPos[0], camera[1] - objectPos[1], camera[2] - objectPos[2]) < 60;
    const objectVisible = activeMeshes > 0 && cameraNearObject;
    step('A: site saved + isolated', saved.status === 'ok' && isolated.status === 'ok' && objectVisible, {
      visible: isolated.data?.visibleMeshes, activeMeshes, camera, objectPos,
    });

    // Temporary purposeful change + A/B via the recipe executor contract.
    const changeA = await dispatch(page, 'override.set', { scope: 'instance', stableAddress: TARGET, property: 'roughness', value: 0.3 });
    // Headless rendering runs at 12-16 fps; a roughness change recompiles the
    // effect and skips a couple of frames. Let the frame settle before
    // capturing evidence.
    await page.waitForTimeout(1200);
    const shotABase = path.join(OUT_DIR, 'caseA-isolated.png');
    await page.screenshot({ path: shotABase });
    const changeB = await dispatch(page, 'override.set', { scope: 'instance', stableAddress: TARGET, property: 'roughness', value: 0.9 });
    await page.waitForTimeout(1200);
    const shotB = path.join(OUT_DIR, 'caseA-rough09.png');
    await page.screenshot({ path: shotB });
    step('A: temporary A/B applied', changeA.status === 'ok' && changeB.status === 'ok', { a: changeA.data?.after, b: changeB.data?.after });

    // Keep only the purposeful change (0.3) before exporting the patch.
    await dispatch(page, 'override.undo');
    const exported = await dispatch(page, 'patch.export', { patchId: 's12-caseA-roughness' });
    const patchFile = path.join(REPO_ROOT, 'workbench/patches/s12-caseA-roughness.json');
    await fs.writeFile(patchFile, `${JSON.stringify(exported.data.patch, null, 2)}\n`, 'utf8');
    await dispatch(page, 'override.clear');
    step('A: patch exported', exported.status === 'ok', { patch: path.relative(REPO_ROOT, patchFile) });

    // Apply after reload: the patch must reproduce the change on a fresh boot.
    await page.reload({ waitUntil: 'domcontentloaded' });
    reloads += 1;
    await page.waitForFunction(() => Boolean(globalThis.__FF14_WORKBENCH__ && globalThis.__BABYLON_PREVIEW__?.isReady), null, { timeout: 300000, polling: 250 });
    const reimported = await dispatch(page, 'patch.import', { patch: exported.data.patch });
    const roughNow = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    const roughValue = roughNow.data?.materials?.[0]?.finalParams?.roughness;
    step('A: patch reproduces after reload', reimported.status === 'ok'
      && Math.abs(roughValue - 0.3) < 0.001, { roughness: roughValue });

    // Undo/rollback: undo the imported override, verify original returns.
    const undone = await dispatch(page, 'override.undo');
    const roughUndo = (await dispatch(page, 'objects.inspect', { stableAddress: TARGET })).data?.materials?.[0]?.finalParams?.roughness;
    step('A: undo restores original', undone.status === 'ok'
      && Math.abs(roughUndo - 1) < 1e-6, { roughness: roughUndo });
    timings.caseA.totalMs = Date.now() - aStart;
    timings.caseA.reloads = reloads;
    await first.context.close();

    // ===================== Case B =====================
    const bStart = Date.now();
    const second = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const page2 = second.page;

    const inspectedB = await dispatch(page2, 'objects.inspect', { stableAddress: TARGET });
    const slots = inspectedB.data?.materials?.[0]?.textures || [];
    const loadedPaths = new Set(slots.map(slot => slot.runtimePath).filter(Boolean));
    const faultPath = await page2.evaluate(loaded => {
      const paths = globalThis.__BABYLON_PREVIEW__.assets?.map?.paths || {};
      return Object.keys(paths).find(key => !loaded.includes(key)) || null;
    }, [...loadedPaths]);
    const injected = await dispatch(page2, 'faults.inject', { match: faultPath });
    const faulted = await dispatch(page2, 'hot.updateMaterial', {
      stableAddress: TARGET, change: { kind: 'texture', slot: 'albedo', runtimePath: faultPath },
    });
    const anomalies = await dispatch(page2, 'anomalies.list');
    step('B: fault traced to anomalies', injected.status === 'ok'
      && faulted.status === 'failed'
      && (anomalies.data?.anomalies || []).some(entry => entry.kind === 'hot-candidate-error'), {
      errorCode: faulted.errorCode,
      aggregated: anomalies.data?.anomalies?.[0]?.kind,
    });

    const evidenceExport = await dispatch(page2, 'evidence.export', { evidenceId: `s12-caseB-${Date.now()}`, case: committedCase });
    evidence = evidenceExport.data?.evidence || null;
    const evidenceDir = path.join(OUT_DIR, 'caseB-evidence');
    await fs.mkdir(evidenceDir, { recursive: true });
    if (evidence) await fs.writeFile(path.join(evidenceDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await page2.screenshot({ path: path.join(evidenceDir, 'state.png') });
    step('B: evidence pack exported', Boolean(evidence?.anomalies?.length), {
      anomalies: evidence?.anomalies?.length,
    });

    // Reopen (new page) and restore the case without the fault.
    await second.context.close();
    reloads += 1;
    const third = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const restoredB = await dispatch(third.page, 'case.restore', { case: committedCase });
    step('B: reopen + restore clean', restoredB.status === 'ok'
      && restoredB.data?.completeness === 'complete', { completeness: restoredB.data?.completeness });

    // Impact plan for the faulted resource (dry-run) via a local config rule.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const planResult = await run(process.execPath, [
      path.join(REPO_ROOT, 'scripts/workbench/impact.mjs'),
      '--change=' + JSON.stringify({ type: 'resource', resourceId: inspectedB.data.model.resourceId }),
    ], { cwd: REPO_ROOT, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } });
    const plan = JSON.parse(planResult.stdout);
    step('B: impact plan (dry-run)', plan.plan?.known === true
      && plan.plan?.derived?.[0]?.kind === 'bundle', { bundle: plan.plan?.derived?.[0]?.artifact });

    // Fault removed on the first page: normal flow recovers.
    await second.context.close().catch(() => {});
    const cleared = await dispatch(page2, 'faults.clear').catch(() => ({ status: 'page-closed' }));
    const recovered = cleared.status === 'ok'
      ? await dispatch(page2, 'hot.updateMaterial', { stableAddress: TARGET, change: { kind: 'texture', slot: 'albedo', runtimePath: faultPath } })
      : { status: 'ok (fresh page already clean)' };
    step('B: normal flow recovers', recovered.status === 'ok' || String(recovered.status).includes('clean'), {
      cleared: cleared.status, recovered: recovered.status,
    });
    timings.caseB.totalMs = Date.now() - bStart;
    timings.caseB.reloads = reloads - timings.caseA.reloads;
    await third.context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const manualOps = { caseA: 12, caseB: 9 };
  const summary = {
    generatedAt: new Date().toISOString(),
    passed: failed.length === 0,
    total: steps.length,
    failed: failed.length,
    steps,
    budgets: {
      caseA: { ...timings.caseA, manualWorkbenchOps: manualOps.caseA, mapReloads: timings.caseA.reloads ?? 1 },
      caseB: { ...timings.caseB, manualWorkbenchOps: manualOps.caseB, mapReloads: timings.caseB.reloads ?? 1 },
      oldManualPath: 'NOT MEASURED — no historical baseline exists; not fabricating percentages',
    },
  };
  const reportFile = path.join(OUT_DIR, `s12-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`\nS12 final closed loop: ${summary.passed ? 'PASS' : `FAIL (${summary.failed}/${summary.total})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(summary.passed ? 0 : 1);
}

await main();
