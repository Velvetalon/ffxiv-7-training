#!/usr/bin/env node
/**
 * S07 recipe executor: a structured recipe replays 恢复案例 -> 应用覆盖 ->
 * 等待就绪 -> 截图/读数 -> 恢复基线 for a bounded candidate set (<= 6).
 * Recipes only reference registered workbench commands; the dispatcher
 * whitelist rejects anything else. Metrics describe state differences only;
 * visual conclusions stay pending human review.
 *
 * Usage:
 *   node scripts/workbench/recipe.mjs --recipe=workbench/recipes/ab-roughness.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const MAX_CANDIDATES = 6;

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

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function readMetrics(page) {
  // Give the fps counter a beat to stabilise, then read run state.
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const api = globalThis.__BABYLON_PREVIEW__;
    return {
      stage: api.stats?.stage || null,
      fps: api.stats?.fps ? Number(api.stats.fps.toFixed(1)) : null,
      activeMeshes: api.scene?.getActiveMeshes?.().length ?? null,
      exposure: api.scene?.imageProcessingConfiguration?.exposure ?? null,
      time: api.stats?.time ?? null,
      camera: api.camera ? api.camera.position.asArray().map(value => Number(value.toFixed(3))) : null,
    };
  });
}

export async function runRecipe({ browser, appUrl, recipe, outDir }) {
  if (recipe?.kind !== 'recipe') throw new Error('recipe.kind must be "recipe"');
  if (!Array.isArray(recipe.candidates) || !recipe.candidates.length) throw new Error('recipe.candidates is empty');
  if (recipe.candidates.length > MAX_CANDIDATES) throw new Error(`recipe exceeds the ${MAX_CANDIDATES}-candidate budget`);
  await fs.mkdir(outDir, { recursive: true });

  const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });
  const log = { recipeId: recipe.recipeId, startedAt: new Date().toISOString(), baseline: null, candidates: [], baselineRestored: null, failures: [] };

  try {
    // Explicit baseline: restore a saved case or run setup steps.
    if (recipe.caseId) {
      const restored = await dispatch(page, 'case.restore', { caseId: recipe.caseId });
      if (restored.status !== 'ok') throw new Error(`baseline case restore failed: ${restored.errorCode}`);
    }
    for (const step of recipe.setup || []) {
      const result = await dispatch(page, step.command, step.args || {});
      if (result.status !== 'ok') throw new Error(`setup step ${step.command} failed: ${result.errorCode}`);
    }
    await dispatch(page, 'camera.set', recipe.camera ? { ...recipe.camera, id: recipe.camera.id || 'recipe-baseline' } : {});
    if (recipe.time) await dispatch(page, 'time.set', { time: recipe.time });
    await page.waitForTimeout(400);
    log.baseline = await readMetrics(page);
    const baselineShot = path.join(outDir, 'baseline.png');
    await page.screenshot({ path: baselineShot });
    log.baseline.screenshot = path.relative(REPO_ROOT, baselineShot);

    for (const candidate of recipe.candidates) {
      const entry = { candidateId: candidate.candidateId, applied: [], ok: true };
      try {
        for (const override of candidate.overrides || []) {
          const result = await dispatch(page, 'override.set', override);
          if (result.status !== 'ok') throw new Error(`override ${override.scope}/${override.property} rejected: ${result.errorCode}`);
          entry.applied.push(override);
        }
        await page.waitForTimeout(400);
        entry.metrics = await readMetrics(page);
        const shot = path.join(outDir, `candidate-${entry.candidateId}.png`);
        await page.screenshot({ path: shot });
        entry.screenshot = path.relative(REPO_ROOT, shot);
      } catch (error) {
        entry.ok = false;
        entry.error = error.message;
        log.failures.push({ candidateId: entry.candidateId, error: error.message });
      }
      // Restore baseline no matter what happened.
      const cleared = await dispatch(page, 'override.clear');
      if (cleared.status !== 'ok') entry.cleanupError = 'override.clear failed';
      await page.waitForTimeout(400);
      const restored = await readMetrics(page);
      entry.baselineVerified = restored.camera
        && log.baseline.camera
        && Math.hypot(
          restored.camera[0] - log.baseline.camera[0],
          restored.camera[1] - log.baseline.camera[1],
          restored.camera[2] - log.baseline.camera[2],
        ) < 0.05
        && restored.exposure === log.baseline.exposure;
      log.candidates.push(entry);
    }

    const finalState = await readMetrics(page);
    log.baselineRestored = Boolean(finalState.camera
      && log.baseline.camera
      && Math.hypot(
        finalState.camera[0] - log.baseline.camera[0],
        finalState.camera[1] - log.baseline.camera[1],
        finalState.camera[2] - log.baseline.camera[2],
      ) < 0.05);
    log.finishedAt = new Date().toISOString();
    log.passed = log.candidates.every(candidate => candidate.ok) && log.baselineRestored;
    // Metrics only locate differences; visual judgement is a human step.
    log.visualConclusion = 'PENDING-HUMAN-REVIEW';
  } finally {
    await context.close().catch(() => {});
  }
  return log;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recipe) {
    console.error('Usage: node scripts/workbench/recipe.mjs --recipe=FILE [--url=URL] [--out=DIR]');
    process.exit(2);
  }
  const recipe = JSON.parse(await fs.readFile(path.resolve(args.recipe), 'utf8'));
  const appUrl = normalizeUrl(args.url || DEFAULT_URL);
  const outDir = path.resolve(args.out || path.join(REPO_ROOT, 'work', 'workbench', 'recipes', recipe.recipeId || 'run'));

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  let log;
  try {
    log = await runRecipe({ browser, appUrl, recipe, outDir });
  } finally {
    await browser.close();
  }

  const reportFile = path.join(outDir, 'report.json');
  await fs.writeFile(reportFile, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  console.log(`\nRecipe ${log.recipeId}: ${log.passed ? 'PASS' : 'FAIL'}  baselineRestored=${log.baselineRestored}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(log.passed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
