#!/usr/bin/env node
/**
 * S04 closed-loop validation: parameter editing with undo and a patch
 * round-trip that survives a page reload.
 *
 * Normal loop: instance-scoped material edit (clone protects the 32 sibling
 * users) -> observed -> undo restores original material -> redo -> export
 * patch -> clear session -> reload page -> import patch -> values match.
 * Failure paths: shared-material mutation without acknowledgement is
 * rejected; a stale assetRunId patch is refused by import.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's04');
const PATCH_FILE = path.join(REPO_ROOT, 'workbench', 'patches', 's04-roughness-experiment.json');

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

async function materialOf(page, stableAddress) {
  return page.evaluate(address => {
    const api = globalThis.__BABYLON_PREVIEW__;
    const [mapId, modelIndex, instance] = address.split(':');
    const suffix = `:${modelIndex}:${instance}:`;
    const instanceMesh = api.scene.meshes.find(candidate => candidate.metadata?.ff14 && candidate.name.includes(suffix));
    const replacement = api.scene.meshes.find(candidate => candidate.metadata?.ff14?.workbenchReplacementOf === address && candidate.isEnabled());
    const mesh = replacement || instanceMesh;
    if (!mesh) return null;
    const material = mesh.material;
    return {
      name: material?.name || null,
      roughness: material?.roughness ?? null,
      clone: Boolean(material?.metadata?.ffxiv?.workbenchClone),
      replaced: Boolean(replacement),
      instanceEnabled: instanceMesh?.isEnabled?.() ?? null,
    };
  }, stableAddress);
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
  await fs.mkdir(path.dirname(PATCH_FILE), { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  const patchExport = { roughTarget: 'e3t1:118:0', sibling: 'e3t1:118:1', originalRoughness: null, patchedRoughness: 0.35, patch: null };

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });

    const beforeTarget = await materialOf(page, patchExport.roughTarget);
    const beforeSibling = await materialOf(page, patchExport.sibling);
    patchExport.originalRoughness = beforeTarget.roughness;

    // 1. Shared-material mutation must be explicit.
    const rejected = await dispatch(page, 'override.set', {
      scope: 'shared', stableAddress: patchExport.roughTarget, property: 'roughness', value: patchExport.patchedRoughness,
    });
    step('shared mutation rejected without ack', rejected.status === 'rejected'
      && rejected.errorCode === 'shared-material'
      && rejected.data?.affectedInstances > 1, rejected);

    // 2. Instance scope clones the material and observes the new value.
    const applied = await dispatch(page, 'override.set', {
      scope: 'instance', stableAddress: patchExport.roughTarget, property: 'roughness', value: patchExport.patchedRoughness,
    });
    const afterTarget = await materialOf(page, patchExport.roughTarget);
    const afterSibling = await materialOf(page, patchExport.sibling);
    step('instance override applied via clone', applied.status === 'ok'
      && afterTarget.clone
      && Math.abs(afterTarget.roughness - patchExport.patchedRoughness) < 0.001
      && afterSibling.name === beforeSibling.name
      && Math.abs(afterSibling.roughness - beforeSibling.roughness) < 1e-6, {
      applied, target: afterTarget, siblingUnchanged: afterSibling.roughness === beforeSibling.roughness,
    });

    // 3. Undo restores the original shared material; redo reapplies.
    const undone = await dispatch(page, 'override.undo');
    const undoneTarget = await materialOf(page, patchExport.roughTarget);
    step('undo restores original material', undone.status === 'ok'
      && !undoneTarget.clone
      && Math.abs(undoneTarget.roughness - patchExport.originalRoughness) < 1e-6, { undone, target: undoneTarget });
    const redone = await dispatch(page, 'override.redo');
    const redoneTarget = await materialOf(page, patchExport.roughTarget);
    step('redo reapplies override', redone.status === 'ok'
      && redoneTarget.clone
      && Math.abs(redoneTarget.roughness - patchExport.patchedRoughness) < 0.001, { redone });

    // 4. Environment override with observation, then undo.
    const exposure = await dispatch(page, 'override.set', { scope: 'environment', property: 'exposure', value: 1.3 });
    step('environment override observed', exposure.status === 'ok'
      && Math.abs(exposure.data.after - 1.3) < 0.01
      && Math.abs(exposure.data.before - 1) < 0.2, exposure);
    const exposureUndo = await dispatch(page, 'override.undo');
    step('environment undo', exposureUndo.status === 'ok'
      && Math.abs(exposureUndo.data?.undone?.restoredTo - exposure.data.before) < 1e-6, exposureUndo);

    // 5. Export patch, clear session, reload, re-import.
    const exported = await dispatch(page, 'patch.export', { patchId: 's04-roughness-experiment' });
    patchExport.patch = exported.data?.patch || null;
    step('patch.export', exported.status === 'ok' && patchExport.patch?.overrides?.length === 1, exported);
    await fs.writeFile(PATCH_FILE, `${JSON.stringify(patchExport.patch, null, 2)}\n`, 'utf8');

    const cleared = await dispatch(page, 'override.clear');
    const clearedTarget = await materialOf(page, patchExport.roughTarget);
    step('override.clear restores original', cleared.status === 'ok'
      && !clearedTarget.clone
      && Math.abs(clearedTarget.roughness - patchExport.originalRoughness) < 1e-6, cleared);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.__FF14_WORKBENCH__ && globalThis.__BABYLON_PREVIEW__?.isReady), null, { timeout: 300000, polling: 250 });
    const freshTarget = await materialOf(page, patchExport.roughTarget);
    step('fresh page has no overrides', !freshTarget.clone
      && Math.abs(freshTarget.roughness - patchExport.originalRoughness) < 1e-6, freshTarget);

    const imported = await dispatch(page, 'patch.import', { patch: patchExport.patch });
    const importedTarget = await materialOf(page, patchExport.roughTarget);
    step('patch.import applies after reload', imported.status === 'ok'
      && imported.data?.applied?.length === 1
      && Math.abs(importedTarget.roughness - patchExport.patchedRoughness) < 0.001, { imported, target: importedTarget });

    // 6. Stale patch is refused.
    const stalePatch = { ...patchExport.patch, targetVersions: { ...patchExport.patch.targetVersions, assetRunId: '20000101T000000Z-expired' } };
    const stale = await dispatch(page, 'patch.import', { patch: stalePatch });
    step('stale patch rejected', stale.status === 'failed' && stale.errorCode === 'version-mismatch', stale);

    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s04-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS04 patch validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  console.log(`Patch:  ${path.relative(REPO_ROOT, PATCH_FILE)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
