#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findAssetRelease, prepareLocalSite, serveLocalSite } from './validation/local-site.mjs';
import { runSmoke, runRepresentative } from './validation/browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
  const equal = arg.indexOf('=');
  args[arg.slice(2, equal < 0 ? undefined : equal)] = equal >= 0 ? arg.slice(equal + 1)
    : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
if (args.help) {
  console.log(`Usage: npm run validate-fast -- [options]
  --asset-release PATH  Reuse packed assets (or ASSET_PIPELINE_DIR)
  --force-smoke         Explicitly run all maps again; use only for global fixes
  --skip-build          Reuse this tool's previous local JS build
  --plan-only           Show validation scope without building or opening a browser
  --out PATH            Output directory (default work/fast-validation)
  --browser-path PATH   Browser executable
  --playwright-module-path PATH  Existing Playwright package.json

Build/static checks -> once-per-core-version Smoke -> fixed representative checks.
No deployment, asset conversion, screenshots, full streaming wait or stress test.`);
  process.exit(0);
}
const out = path.resolve(root, String(args.out || 'work/fast-validation'));
if (out === root || !path.relative(root, out).startsWith(`work${path.sep}`)) {
  throw new Error('--out must be a dedicated directory under this project work/');
}
const config = JSON.parse(await fs.readFile(path.join(root, 'config/fast-validation.json'), 'utf8'));
const assetRelease = await findAssetRelease(root, args['asset-release']);
const buildOut = path.join(out, 'site');
const ledgerPath = path.join(out, 'smoke-state.json');
const buildStatePath = path.join(out, 'build-state.json');
const resultPath = path.join(out, 'result.json');
const startedAt = performance.now();

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(file));
    else if (/\.(js|css|json)$/.test(entry.name)) result.push(file);
  }
  return result.sort();
}
const files = await sourceFiles(path.join(root, 'src'));
const buildHash = crypto.createHash('sha256');
for (const file of [...files, path.join(root, 'index.html'), path.join(root, 'package.json')]) {
  buildHash.update(path.relative(root, file)); buildHash.update(await fs.readFile(file));
}
const buildFingerprint = buildHash.digest('hex');
const core = files.filter(file => /[/\\]src[/\\](assets[/\\]|world[/\\]|main\.js$)/.test(file));
const coreHash = crypto.createHash('sha256');
for (const file of [...core, path.join(root, 'package.json'), path.join(root, 'vite.config.js'), path.join(root, 'config/fast-validation.json')]) {
  coreHash.update(path.relative(root, file)); coreHash.update(await fs.readFile(file));
}
const assetIdentity = assetRelease
  ? (JSON.parse(await fs.readFile(path.join(assetRelease, 'publish-manifest.json'), 'utf8'))).entry
  : await fs.readFile(path.join(root, 'public/extracted/active.json'), 'utf8');
coreHash.update(assetIdentity);
const fingerprint = coreHash.digest('hex');
let previous;
try { previous = JSON.parse(await fs.readFile(ledgerPath, 'utf8')); } catch {}
const sameCore = previous?.fingerprint === fingerprint;
const runAll = Boolean(args['force-smoke']) || !sameCore;
const retryIds = sameCore ? (previous.failures || []) : [];
const plan = {
  build: !args['skip-build'],
  smoke: runAll ? 'all maps once' : retryIds.length ? `retry ${retryIds.length} failed/timeout maps only` : 'reuse previous passing all-map smoke',
  representatives: config.representatives.map(item => item.id),
  assetRelease, out,
};
if (args['plan-only']) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
await fs.mkdir(out, { recursive: true });

async function staticCheck(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const retain = chunk => { output = (output + chunk).slice(-6000); };
    child.stdout.on('data', retain); child.stderr.on('data', retain);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} failed: ${output}`)));
  });
}

let server;
const result = { schemaVersion: 1, startedAt: new Date().toISOString(), plan, fingerprint, status: 'RUNNING' };
try {
  if (args['skip-build']) {
    const priorBuild = JSON.parse(await fs.readFile(buildStatePath, 'utf8').catch(() => '{}'));
    if (priorBuild.fingerprint !== buildFingerprint) throw new Error('Current source differs from the cached build; omit --skip-build.');
  }
  await prepareLocalSite({ root, out: buildOut, assetRelease, skipBuild: Boolean(args['skip-build']) });
  await fs.writeFile(buildStatePath, JSON.stringify({ fingerprint: buildFingerprint }));
  await staticCheck('scripts/verify.mjs');
  await staticCheck('scripts/verify-camera.mjs');
  server = await serveLocalSite({ root, out: buildOut, assetRelease });
  const common = {
    url: server.url, timeoutMs: config.smoke.timeoutMs,
    browserPath: args['browser-path'], playwrightModulePath: args['playwright-module-path'],
  };
  let smoke;
  if (runAll || retryIds.length) {
    smoke = await runSmoke({
      ...common, concurrency: config.smoke.concurrency,
      ...(runAll ? {} : { scenes: retryIds }),
      out: path.join(out, runAll ? 'smoke.json' : 'smoke-retry.json'),
    });
    const failures = smoke.failedMapIds || smoke.exceptions.filter(item => ['FAIL', 'TIMEOUT'].includes(item.status)).map(item => item.id);
    if (smoke.globalError || smoke.counts.maps === 0) throw new Error(smoke.globalError || 'Smoke executed no maps');
    await fs.writeFile(ledgerPath, JSON.stringify({
      schemaVersion: 1, fingerprint, testedAt: new Date().toISOString(),
      allMapCount: runAll ? smoke.counts.maps : previous.allMapCount,
      failures, report: smoke.reportPath, fullSmokeReused: !runAll,
    }, null, 2));
  } else {
    smoke = { reused: true, reportPath: previous.report, counts: { maps: previous.allMapCount, pass: previous.allMapCount, fail: 0, timeout: 0 }, exceptions: [], totalMs: 0 };
  }
  result.smoke = smoke;
  const validIds = new Set(Object.keys(JSON.parse(await fs.readFile(path.join(buildOut, 'extracted/active.json'), 'utf8')).scenes));
  const missingRepresentatives = config.representatives.filter(item => !validIds.has(item.id));
  if (missingRepresentatives.length) throw new Error(`Representative maps are not in this catalog: ${missingRepresentatives.map(item => item.id).join(', ')}`);
  result.representatives = await runRepresentative({
    ...common, timeoutMs: config.representative.timeoutMs, observeMs: config.representative.observeMs,
    scenes: config.representatives.map(item => item.id), out: path.join(out, 'representatives.json'),
  });
  const issues = [...smoke.exceptions, ...result.representatives.exceptions];
  result.exceptions = issues;
  result.agentExceptionCount = new Set([...(smoke.failedMapIds || []), ...(result.representatives.failedMapIds || []), ...issues.map(item => item.id)]).size;
  result.status = smoke.counts.fail || smoke.counts.timeout || result.representatives.counts.fail ||
    result.representatives.counts.timeout || result.representatives.globalError ? 'FAIL' : 'PASS';
  result.manualReview = {
    status: 'CHECKLIST_READY',
    note: 'Automated movement/camera checks are not visual or task-specific human/agent observation.',
    maps: config.representatives,
    command: 'npm run validate-map -- <mapId> --url=<running app URL> --headed',
  };
} catch (error) {
  result.status = 'ERROR';
  result.error = error.message;
} finally {
  await server?.close();
  result.totalMs = Math.round(performance.now() - startedAt);
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify({
  result: result.status, totalMs: result.totalMs, smoke: result.smoke?.counts,
  reusedSmoke: result.smoke?.reused || result.smoke?.scope === 'subset' || false,
  representatives: result.representatives?.counts,
  agentExceptionCount: result.agentExceptionCount, exceptions: result.exceptions?.slice(0, 20),
  manualReview: 'Fixed 4-map visual/task-specific checklist; automated checks do not replace observation.',
  error: result.error, report: resultPath,
}, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
