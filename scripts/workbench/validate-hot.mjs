#!/usr/bin/env node
/**
 * S05 closed-loop validation: local updates without full map reloads.
 *
 * Layer 1 (environment numeric): override.set exposure, no reload.
 * Layer 2 (texture reference): hot.updateMaterial rebinds the albedo texture
 * to another existing runtime path, then hot.rollback restores it.
 * Layer 3 (material implementation): a deliberately broken shader candidate
 * is rejected and keeps the previous look; a valid flat candidate replaces,
 * then rolls back.
 * Resource accounting: mesh/material counts stay bounded across all rounds.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's05');
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

async function sceneCounts(page) {
  return page.evaluate(() => ({
    materials: globalThis.__BABYLON_PREVIEW__.scene.materials.length,
    textures: globalThis.__BABYLON_PREVIEW__.scene.textures.length,
    meshes: globalThis.__BABYLON_PREVIEW__.scene.meshes.length,
  }));
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

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const epochBefore = (await dispatch(page, 'state.read')).sceneEpoch;
    const countsBefore = await sceneCounts(page);

    // Discover a texture runtime path from the target's own provenance.
    const inspected = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    const slots = inspected.data?.materials?.[0]?.textures || [];
    const normalPath = slots.find(slot => slot.semantic === 'normal')?.runtimePath || null;
    const albedoPath = slots.find(slot => slot.semantic === 'albedo')?.runtimePath || null;

    // Layer 1: environment numeric update without any reload.
    const exposure = await dispatch(page, 'override.set', { scope: 'environment', property: 'exposure', value: 1.25 });
    const countsAfterEnv = await sceneCounts(page);
    step('layer1 environment without reload', exposure.status === 'ok'
      && countsAfterEnv.meshes === countsBefore.meshes
      && (await dispatch(page, 'state.read')).sceneEpoch === epochBefore, exposure.data);

    // Layer 2: texture reference update on one object only.
    if (!normalPath || !albedoPath) {
      step('layer2 texture update', false, { reason: 'no normal/albedo texture paths on target' });
    } else {
      const textureUpdate = await dispatch(page, 'hot.updateMaterial', {
        stableAddress: TARGET, change: { kind: 'texture', slot: 'albedo', runtimePath: normalPath },
      });
      const bound = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
      const boundAlbedo = bound.data?.materials?.[0]?.textures?.find(slot => slot.semantic === 'albedo');
      step('layer2 texture rebound', textureUpdate.status === 'ok'
        && boundAlbedo?.runtimePath === normalPath
        && bound.data?.materials?.[0]?.finalParams?.className === 'PBRMaterial', {
        textureUpdate: textureUpdate.data, boundAlbedo,
      });

      const rolledBack = await dispatch(page, 'hot.rollback', { stableAddress: TARGET });
      const afterRollback = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
      const rollbackAlbedo = afterRollback.data?.materials?.[0]?.textures?.find(slot => slot.semantic === 'albedo');
      step('layer2 rollback restores binding', rolledBack.status === 'ok'
        && rollbackAlbedo?.runtimePath === albedoPath, { rolledBack: rolledBack.data, rollbackAlbedo });
    }

    // Layer 3a: broken shader candidate is rejected, previous look kept.
    const beforeBroken = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    const materialBeforeBroken = beforeBroken.data?.materials?.[0]?.finalParams?.className;
    const broken = await dispatch(page, 'hot.updateMaterial', {
      stableAddress: TARGET, change: { kind: 'shader', preset: 'broken' }, timeoutMs: 3500,
    });
    const afterBroken = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    const materialAfterBroken = afterBroken.data?.materials?.[0]?.finalParams?.className;
    step('broken shader rejected, old binding kept', broken.status === 'failed'
      && broken.errorCode === 'candidate-rejected'
      && materialAfterBroken === materialBeforeBroken, {
      broken: { status: broken.status, errorCode: broken.errorCode },
      materialBeforeBroken, materialAfterBroken,
    });

    // Layer 3b: a valid candidate replaces, then rolls back.
    const flat = await dispatch(page, 'hot.updateMaterial', {
      stableAddress: TARGET, change: { kind: 'shader', preset: 'flat', color: [0.9, 0.3, 0.2] },
    });
    const afterFlat = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    step('valid shader candidate replaces', flat.status === 'ok'
      && afterFlat.data?.materials?.[0]?.finalParams?.className === 'ShaderMaterial', {
      material: flat.data?.material, className: afterFlat.data?.materials?.[0]?.finalParams?.className,
    });
    const shaderRollback = await dispatch(page, 'hot.rollback', { stableAddress: TARGET });
    const afterShaderRollback = await dispatch(page, 'objects.inspect', { stableAddress: TARGET });
    step('shader rollback restores material', shaderRollback.status === 'ok'
      && afterShaderRollback.data?.materials?.[0]?.finalParams?.className !== 'ShaderMaterial', shaderRollback.data);

    // Resource accounting across every round. Growth must stay bounded (a
    // handful of candidates), never scale with the number of updates.
    const countsAfter = await sceneCounts(page);
    const growthBounded = countsAfter.materials - countsBefore.materials <= 4
      && countsAfter.textures - countsBefore.textures <= 8
      && countsAfter.meshes - countsBefore.meshes <= 2;
    step('resource growth bounded', growthBounded, { before: countsBefore, after: countsAfter });
    const status = await dispatch(page, 'hot.status');
    step('hot.status reports history', status.status === 'ok' && status.data?.generation >= 3, status.data);

    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s05-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS05 hot-update validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
