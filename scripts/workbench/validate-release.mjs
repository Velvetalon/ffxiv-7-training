#!/usr/bin/env node
/**
 * S11 closed-loop validation (local rehearsal; online publish stays BLOCKED):
 * 1. Start the local stand-in origin serving site/ + site-babylon-preview/.
 * 2. Run the existing deployment verifier against it (release rehearsal).
 * 3. Record a release fingerprint.
 * 4. Rollback drill: build a "new" release, roll back to the saved previous
 *    build, verify fingerprints swap and restore.
 * Online rollback is explicitly NOT rehearsed (no credentials).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's11');
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

function buildSha() {
  return JSON.parse(fsSync.readFileSync(BUILD_INFO, 'utf8')).visualReferences.manifestSha256;
}

async function runNode(script, argv) {
  const { stdout } = await execFileAsync(process.execPath, [path.join(REPO_ROOT, script), ...argv], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
  });
  return stdout;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const steps = [];
  const step = (name, ok, result) => {
    steps.push({ name, ok, result });
    console.error(`  [${ok ? 'ok' : 'FAIL'}] ${name}`);
  };
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.copyFile(CONFIG, BACKUP);

  // Local stand-in origin.
  const origin = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/workbench/local-origin.mjs')], {
    env: { ...process.env, PORT: '8791' },
  });
  await new Promise((resolve, reject) => {
    origin.stdout.once('data', resolve);
    origin.once('error', reject);
    setTimeout(resolve, 2000);
  });

  try {
    // 0. Ensure the build artifact exists and matches the current config.
    if (!fsSync.existsSync(BUILD_INFO)) {
      await runNode('scripts/workbench/impact.mjs', ['--apply', '--change={"type":"config","file":"config/visual-references.json"}']);
    }

    // 1. Save the current build as the "previous release" copy.
    const previousDir = path.join(OUT_DIR, 'previous-build');
    await fs.rm(previousDir, { recursive: true, force: true });
    await fs.cp(path.join(REPO_ROOT, 'site-babylon-preview'), previousDir, { recursive: true });
    const previousLabel = `s11-previous-${Date.now()}`;
    await runNode('scripts/workbench/release.mjs', ['record', `--label=${previousLabel}`]);
    step('previous release recorded', true, { label: previousLabel });

    // 2. Release verification rehearsal against the local origin.
    const verify = await runNode('scripts/workbench/release.mjs', ['verify']);
    const verifyPass = /"status":\s*"PASS"/.test(verify);
    step('deployment verifier passes on local origin', verifyPass, {
      status: (/\"status\":\s*\"(\w+)\"/.exec(verify) || [])[1] || null,
    });

    // 3. A "new" release: temporary config view -> targeted rebuild.
    const config = JSON.parse(await fs.readFile(CONFIG, 'utf8'));
    config.views.push({ mapId: 'e3t1', id: `s11-temp-${Date.now()}`, camera: { position: [90, 67, 92], target: [164, 22, 0], fov: 0.82 } });
    await fs.writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await runNode('scripts/workbench/impact.mjs', ['--apply', '--change={"type":"config","file":"config/visual-references.json"}']);
    const newSha = buildSha();
    const newLabel = `s11-new-${Date.now()}`;
    await runNode('scripts/workbench/release.mjs', ['record', `--label=${newLabel}`]);
    step('new release fingerprint differs', newSha !== buildSha && fsSync.existsSync(BUILD_INFO), { newSha: newSha.slice(0, 16) });

    // 4. Rollback drill to the previous release, then restore the new build.
    const drill = await runNode('scripts/workbench/release.mjs', [
      'rollback-drill', `--previous=${previousLabel}`, `--savedBuild=${previousDir}`,
    ]);
    const drillResult = JSON.parse(drill);
    step('local rollback drill restores fingerprint', drillResult.restoredMatches === true, drillResult);
    step('online rollback honestly not rehearsed', drillResult.onlineRollbackRehearsed === false, null);

    // Restore the newer build as the current artifact (config back too).
    await fs.copyFile(BACKUP, CONFIG);
    await runNode('scripts/workbench/impact.mjs', ['--apply', '--change={"type":"config","file":"config/visual-references.json"}']);
    step('current artifact restored', fsSync.existsSync(BUILD_INFO), { sha: buildSha().slice(0, 16) });
  } finally {
    origin.kill();
    await fs.copyFile(BACKUP, CONFIG).catch(() => {});
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, passed: failed.length === 0, total: steps.length, failed: failed.length, steps, onlinePublish: 'BLOCKED: no COS/CDN credentials in the local environment' };
  const reportFile = path.join(OUT_DIR, `s11-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS11 release rehearsal: ${failed.length === 0 ? 'PASS (local; publish BLOCKED)' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
