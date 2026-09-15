#!/usr/bin/env node
/**
 * S09 closed-loop validation: a local config change produces an impact plan,
 * only the affected artifact is rebuilt, unrelated hashes stay identical,
 * identical input skips the rebuild, and rollback restores the original.
 * Resource and code changes demonstrate the dry-run planning rules.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's09');
const CONFIG = path.join(REPO_ROOT, 'config/visual-references.json');
const BACKUP = path.join(OUT_DIR, 'config-backup.json');
const BUILD_INFO = path.join(REPO_ROOT, 'site-babylon-preview/build-info.json');

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

async function runImpact(args) {
  const script = path.join(REPO_ROOT, 'scripts/workbench/impact.mjs');
  const argv = [script, ...args];
  const { stdout } = await execFileAsync(process.execPath, argv, { cwd: REPO_ROOT, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } });
  return JSON.parse(stdout);
}

function buildInfoSha() {
  return JSON.parse(fsSync.readFileSync(BUILD_INFO, 'utf8')).visualReferences.manifestSha256;
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
  await fs.copyFile(CONFIG, BACKUP);

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  try {
    // 0. Baseline build with the untouched config.
    const baseline = await runImpact(['--apply', '--change={"type":"config","file":"config/visual-references.json"}']);
    const baselineSha = buildInfoSha();
    step('baseline targeted build', baseline.applied === true && Boolean(baselineSha), { sha: baselineSha.slice(0, 16) });

    // 1. Real local config change: append a temporary view.
    const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
    const originalViews = config.views.length;
    config.views.push({
      mapId: 'e3t1', id: 's09-temp-view', camera: { position: [90, 67, 92], target: [164, 22, 0], fov: 0.82 }, worldTime: { hour: 12 },
    });
    await fs.writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    // 2. Plan (dry) reports build impact and no extraction.
    const plan = await runImpact(['--change={"type":"config","file":"config/visual-references.json"}']);
    step('impact plan', plan.plan?.known === true
      && plan.plan?.derived?.[0]?.kind === 'build'
      && plan.plan?.extractionTriggered === false, plan.plan);

    // 3. Apply: only the affected artifact rebuilds; unrelated hashes stay.
    const applied = await runImpact(['--apply', '--change={"type":"config","file":"config/visual-references.json"}']);
    const newSha = buildInfoSha();
    const newInfo = JSON.parse(fsSync.readFileSync(BUILD_INFO, 'utf8'));
    step('targeted rebuild applied', applied.applied === true
      && newSha !== baselineSha
      && newInfo.visualReferences.views === originalViews + 1
      && newInfo.mapCount === 65, { newSha: newSha.slice(0, 16), views: newInfo.visualReferences.views });

    // 4. Same input skips the rebuild.
    const repeat = await runImpact(['--apply', '--change={"type":"config","file":"config/visual-references.json"}']);
    step('no-change input skips', Boolean(repeat.skipped), repeat.skipped);

    // 5. Rollback restores the original config and its hash.
    const rolledBack = await runImpact(['--apply', '--change={"type":"config","file":"config/visual-references.json"}', `--rollback=${BACKUP}`]);
    const restoredSha = buildInfoSha();
    step('rollback restores original result', rolledBack.applied === true && restoredSha === baselineSha, { restoredSha: restoredSha.slice(0, 16) });

    // 6. Resource change: dry-run plan shows the bundle and bytes.
    const provenance = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'work/workbench/s03/provenance.json'), 'utf8'));
    const resourceId = provenance.inspection.model.resourceId;
    const resourcePlan = await runImpact(['--change=' + JSON.stringify({ type: 'resource', resourceId })]);
    step('resource dry-run plan', resourcePlan.plan?.known === true
      && resourcePlan.plan?.mode === 'dry-run'
      && resourcePlan.plan?.derived?.[0]?.bytes > 0
      && resourcePlan.plan?.representativeSamples?.length >= 1, resourcePlan.plan);

    // 7. Shared code change: escalates to representative maps with confidence.
    const codePlan = await runImpact(['--change={"type":"code","file":"src/assets/AssetRuntime.js"}']);
    step('code impact escalates honestly', codePlan.plan?.representativeSamples?.length === 4
      && String(codePlan.plan?.confidence).startsWith('medium'), codePlan.plan?.confidence);

    // 8. The current case still loads against the rebuilt artifact (local
    // dev server serves source; assert the golden case restores).
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const committedCase = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'workbench/cases/e3t1-baseline.json'), 'utf8'));
    const caseRestored = await dispatch(page, 'case.restore', { case: committedCase });
    const caseState = await dispatch(page, 'state.read');
    step('golden case loads after rebuild', caseRestored.status === 'ok'
      && caseState.data?.mapId === 'e3t1', { status: caseRestored.status, completeness: caseRestored.data?.completeness, mapId: caseState.data?.mapId });
    await context.close();
  } finally {
    await browser.close();
    await fs.copyFile(BACKUP, CONFIG).catch(() => {});
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s09-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS09 impact validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
