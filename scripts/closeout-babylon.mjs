import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const runId = `maps-${stamp}`;
const out = path.join(root, 'work', `babylon-closeout-${runId}`);
const url = 'https://yuluo.site/ff14-web-babylon-preview/';
const npmCli = [
  path.join(path.dirname(process.execPath), '../node_modules/npm/bin/npm-cli.js'),
  'F:/node16142/node_modules/npm/bin/npm-cli.js',
].find(file => fsSync.existsSync(file));
if (!npmCli) throw new Error('npm CLI is unavailable');
const python = 'G:/UGit/rawWeb/.venv/Scripts/python.exe';
const playwright = 'C:/Users/v_whcnwwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json';
const browser = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dat = 'C:/Users/v_whcnwwang/OneDrive/codex/FFXIV_CHARA_40.dat';
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  PLAYWRIGHT_MODULE_PATH: playwright, BROWSER_PATH: browser };
delete env.BABYLON_ASSET_DIR;
await fs.mkdir(out, { recursive: true });
const state = { runId, pid: process.pid, startedAt: new Date().toISOString(), status: 'running', out, results: [] };
const persist = () => fs.writeFile(path.join(out, 'state.json'), JSON.stringify(state, null, 2));
await persist();

async function execute(name, executable, argv, required = false) {
  state.stage = name;
  await persist();
  const started = Date.now();
  const stdout = fsSync.createWriteStream(path.join(out, `${name}.stdout.log`));
  const stderr = fsSync.createWriteStream(path.join(out, `${name}.stderr.log`));
  const result = await new Promise(resolve => {
    const child = spawn(executable, argv, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once('error', error => resolve({ exitCode: -1, error: error.message }));
    child.once('close', code => resolve({ exitCode: code }));
  });
  stdout.end();
  stderr.end();
  state.results.push({ name, ...result, durationMs: Date.now() - started });
  await persist();
  console.log(JSON.stringify({ stage: name, ...result, durationMs: Date.now() - started, out }));
  if (required && result.exitCode !== 0) throw new Error(`Required stage failed: ${name}`);
}

try {
  const target = path.resolve(root, 'site-babylon-preview');
  const archive = path.join(root, 'work', 'archive', `site-babylon-preview-before-${runId}`);
  if (target !== path.join(root, 'site-babylon-preview') || !archive.startsWith(path.join(root, 'work', 'archive') + path.sep)) {
    throw new Error('Unsafe build archive paths');
  }
  if (fsSync.existsSync(target)) {
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.rename(target, archive);
    state.previousLocalBuild = archive;
    await persist();
  }
  await execute('build', process.execPath, [npmCli, 'run', 'build:babylon'], true);
  state.build = JSON.parse(await fs.readFile(path.join(target, 'build-info.json'), 'utf8'));
  await persist();
  await execute('prepare', python, ['deploy/babylon-preview-release.py', 'prepare', '--release-id', runId, '--apply'], true);
  await execute('deploy', python, ['deploy/babylon-preview-release.py', 'deploy',
    '--prepared-dir', `work/deployment/babylon-preview-release-${runId}`, '--origin', 'https://yuluo.site', '--apply'], true);
  await execute('deployment-proof', process.execPath, ['scripts/verify-babylon-deployment.mjs', `--out=${path.join(out, 'deployment-proof.json')}`], true);
  const common = [`--url=${url}`, `--browser-path=${browser}`, `--playwright-module-path=${playwright}`];
  const npmRun = (name, script, args) => execute(name, process.execPath, [npmCli, 'run', script, '--', ...args]);
  await npmRun('validate-fast', 'validate-fast', ['--engine=babylon', ...common, `--out=${path.join(out, 'fast')}`]);
  await npmRun('validate-smoke', 'validate-smoke', [...common, '--scenes=e3t1', '--concurrency=1', `--out=${path.join(out, 'smoke-subset.json')}`]);
  await npmRun('validate-map', 'validate-map', ['e3t1', ...common, `--out=${path.join(out, 'map-e3t1.json')}`]);
  await npmRun('validate-sandbox', 'validate-sandbox', [...common, `--dat=${dat}`, `--out=${path.join(out, 'sandbox')}`, '--timeout=60000']);
  await npmRun('validate-developer', 'validate-developer', [...common, `--dat=${dat}`, `--out=${path.join(out, 'developer')}`, '--no-retry-probe', '--timeout=60000']);
  await npmRun('validate-babylon', 'validate-babylon', [...common, `--out=${path.join(out, 'kugane.json')}`, '--skip-screenshots=true', '--timeout=180000']);
  await execute('coverage', process.execPath, ['scripts/summarize-babylon-coverage.mjs',
    `--reports=${path.join(out, 'fast/smoke.json')}`, '--out=docs/BABYLON-MAP-COVERAGE.md']);
  state.status = state.results.every(result => result.exitCode === 0) ? 'passed' : 'finished-with-failures';
} catch (error) {
  state.status = 'stopped-on-required-failure';
  state.error = error.message;
} finally {
  state.finishedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify(state, null, 2));
  process.exitCode = state.status === 'passed' ? 0 : 1;
}
