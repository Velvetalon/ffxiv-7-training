#!/usr/bin/env node
/**
 * S07 closed-loop validation: recipes replay deterministically, failures do
 * not pollute the next case, and every experiment ends with a verified
 * baseline restore.
 *
 * 1. Run the committed A/B recipe (3 candidates <= budget 6) -> PASS.
 * 2. Run a recipe with an illegal override -> candidate fails, baseline still
 *    restored, and a following valid case is not polluted.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { runRecipe } from './recipe.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's07');

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

  const recipe = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'workbench/recipes/ab-roughness-exposure.json'), 'utf8'));

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  let log;
  try {
    // 1. The committed A/B recipe.
    log = await runRecipe({ browser, appUrl, recipe, outDir: OUT_DIR });
    step('A/B recipe executes', log.passed, {
      candidates: log.candidates.map(candidate => ({ id: candidate.candidateId, ok: candidate.ok, baselineVerified: candidate.baselineVerified })),
      baselineRestored: log.baselineRestored,
      visualConclusion: log.visualConclusion,
    });
    step('per-candidate metrics recorded', log.candidates.length === 3
      && log.candidates.every(candidate => candidate.metrics?.fps !== null && Number.isFinite(candidate.metrics.exposure)),
    log.candidates.map(candidate => ({ id: candidate.candidateId, exposure: candidate.metrics?.exposure })));
    step('baseline verified after each candidate', log.candidates.every(candidate => candidate.baselineVerified), null);

    // 2. Illegal candidate fails cleanly and does not pollute the next case.
    const badRecipe = {
      kind: 'recipe', recipeId: 'ab-illegal',
      camera: { position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle' },
      time: 'day',
      candidates: [
        { candidateId: 'bad-param', overrides: [{ scope: 'instance', stableAddress: 'e3t1:118:0', property: 'notAProperty', value: 1 }] },
        { candidateId: 'good-after-bad', overrides: [{ scope: 'environment', property: 'exposure', value: 1.25 }] },
      ],
    };
    const badLog = await runRecipe({ browser, appUrl, recipe: badRecipe, outDir: path.join(OUT_DIR, 'illegal') });
    step('illegal candidate fails cleanly', badLog.candidates.find(candidate => candidate.candidateId === 'bad-param')?.ok === false, badLog.failures);
    step('next candidate unaffected', badLog.candidates.find(candidate => candidate.candidateId === 'good-after-bad')?.ok === true, null);
    step('baseline restored after failure run', badLog.baselineRestored === true, { baselineRestored: badLog.baselineRestored });
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s07-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS07 recipe validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
