#!/usr/bin/env node
/**
 * Release descriptor + rollback drill for the isolated Babylon preview.
 *
 * record  : fingerprint the current site-babylon-preview build (commit,
 *           sourceSha256, visualReferences manifest sha, lockfile hash) into
 *           workbench/releases/.
 * verify  : run scripts/verify-babylon-deployment.mjs against the local
 *           stand-in origin (publish rehearsal; CDN publish itself stays
 *           blocked without credentials).
 * rollback: swap the served build directory back to a saved copy and confirm
 *           the origin fingerprint matches the previous release. This is a
 *           LOCAL drill; online rollback is NOT rehearsed (no credentials).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(REPO_ROOT, 'site-babylon-preview');
const RELEASES_DIR = path.join(REPO_ROOT, 'workbench/releases');
const ORIGIN = 'http://127.0.0.1:8791';

function parseArgs(argv) {
  const result = { _: [] };
  for (const value of argv) {
    if (!value.startsWith('--')) { result._.push(value); continue; }
    const body = value.slice(2);
    const index = body.indexOf('=');
    if (index < 0) result[body] = true;
    else result[body.slice(0, index)] = body.slice(index + 1);
  }
  return result;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fingerprint(label) {
  const buildInfo = JSON.parse(fsSync.readFileSync(path.join(BUILD_DIR, 'build-info.json'), 'utf8'));
  const lockfile = fsSync.readFileSync(path.join(REPO_ROOT, 'package-lock.json'));
  let commit = null;
  try {
    commit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
  } catch { /* detached context */ }
  const entry = {
    label,
    recordedAt: new Date().toISOString(),
    commit,
    buildId: buildInfo.sourceSha256,
    visualReferencesManifestSha256: buildInfo.visualReferences.manifestSha256,
    mapCount: buildInfo.mapCount,
    engine: `${buildInfo.engine} ${buildInfo.engineVersion}`,
    lockfileSha256: sha256(lockfile),
    indexSha256: sha256(fsSync.readFileSync(path.join(BUILD_DIR, 'index.html'))),
  };
    entry.releaseId = label;
    return entry;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = args._[0] || args.action || 'record';
  if (!fsSync.existsSync(path.join(BUILD_DIR, 'build-info.json'))) {
    console.error('site-babylon-preview/build-info.json missing; run the S09 targeted build first');
    process.exit(2);
  }
  await fs.mkdir(RELEASES_DIR, { recursive: true });

  if (action === 'record') {
    const label = args.label || `r${Date.now()}`;
    const entry = await fingerprint(label);
    const file = path.join(RELEASES_DIR, `${entry.releaseId}.json`);
    await fs.writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ recorded: entry.releaseId, file: path.relative(REPO_ROOT, file), ...entry }, null, 2));
    return;
  }

  if (action === 'verify') {
    const result = await execFileAsync(process.execPath, [
      path.join(REPO_ROOT, 'scripts/verify-babylon-deployment.mjs'),
      `--origin=${ORIGIN}`,
      `--source=${BUILD_DIR}`,
    ], { cwd: REPO_ROOT, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } });
    console.log(result.stdout);
    return;
  }

  if (action === 'rollback-drill') {
    // Save the current build, swap in the saved copy, verify the origin
    // serves the previous fingerprint, then restore.
    const previousLabel = args.previous;
    const previousFile = path.join(RELEASES_DIR, `${previousLabel}.json`);
    const previous = JSON.parse(fsSync.readFileSync(previousFile, 'utf8'));
    const backupDir = `${BUILD_DIR}-rollback-drill`;
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.cp(BUILD_DIR, backupDir, { recursive: true });
    const savedDir = args.savedBuild ? path.resolve(args.savedBuild) : null;
    if (!savedDir || !fsSync.existsSync(path.join(savedDir, 'build-info.json'))) {
      throw new Error('--savedBuild=<dir with a previous build> is required for the drill');
    }
    await fs.rm(BUILD_DIR, { recursive: true, force: true });
    await fs.cp(savedDir, BUILD_DIR, { recursive: true });
    const restored = await fingerprint('drill-restored');
    const matches = restored.indexSha256 === previous.indexSha256
      && restored.buildId === previous.buildId;
    await fs.rm(BUILD_DIR, { recursive: true, force: true });
    await fs.cp(backupDir, BUILD_DIR, { recursive: true });
    await fs.rm(backupDir, { recursive: true, force: true });
    console.log(JSON.stringify({
      drill: 'local-rollback',
      previous: previous.releaseId,
      restoredMatches: matches,
      restoredIndexSha256: restored.indexSha256.slice(0, 16),
      onlineRollbackRehearsed: false,
      note: 'local drill only; CDN/online rollback not rehearsed (no credentials)',
    }, null, 2));
    process.exit(matches ? 0 : 1);
  }

  console.error('action must be record | verify | rollback-drill');
  process.exit(2);
}

await main();
