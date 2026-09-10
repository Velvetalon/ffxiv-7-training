#!/usr/bin/env node
/**
 * Regression-mode dispatcher. Detailed map artifacts remain on disk; stdout is summary only.
 *
 * node scripts/regress-maps.mjs --mode=daily --config=config/map-regression.json --url=http://127.0.0.1:18080/ff14-web/ --out=work/regression/daily.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.length ? rest.join('=') : true];
}));
if (!args.mode || !args.config || !args.url || !args.out) throw new Error('Required: --mode=daily|runtime|release --config=FILE --url=URL --out=FILE');
if (!['daily', 'runtime', 'release'].includes(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
const configPath = path.resolve(args.config);
const outPath = path.resolve(args.out);
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
if (config.schemaVersion !== 1) throw new Error('Unsupported regression config schemaVersion');
const smoke = (config.smokeScenes || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
if (!smoke.length) throw new Error('Regression config has no smokeScenes');
const duplicates = smoke.filter((id, index) => smoke.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Regression config has duplicate smoke IDs: ${[...new Set(duplicates)].join(', ')}`);
const modeConfig = config.modes?.[args.mode];
if (!modeConfig) throw new Error(`Regression config has no modes.${args.mode}`);
const node = process.execPath;
const verify = path.resolve('scripts/verify-asset-world.mjs');
const summarize = path.resolve('scripts/assets/summarize-regression.mjs');
const selector = path.resolve('scripts/assets/select-regression-maps.mjs');
const browserArgs = args['browser-path'] ? [`--browser-path=${args['browser-path']}`] : [];
const playwrightArgs = args['playwright-module-path'] ? [`--playwright-module-path=${args['playwright-module-path']}`] : [];
const common = [`--url=${args.url}`, `--timeout=${args.timeout || 600000}`, ...browserArgs, ...playwrightArgs];
const artifacts = [];

function run(command, commandArgs) {
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
    child.on('error', error => resolve({ code: 1, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? 1, stderr: stderr.trim() }));
  });
}

async function verifyPhase(name, scenes, continueOnFailure = false) {
  const artifact = outPath.replace(/\.json$/i, `.${name}.json`);
  if (args['plan-only']) return { name, artifact, code: 0, planned: true, scenes, continueOnFailure };
  const commandArgs = [verify, ...common, `--out=${artifact}`, `--scenes=${scenes.join(',')}`, ...(continueOnFailure ? ['--continue-on-failure'] : [])];
  const result = await run(node, commandArgs);
  artifacts.push(artifact);
  return { name, artifact, ...result };
}

async function fullPhase(name) {
  const artifact = outPath.replace(/\.json$/i, `.${name}.json`);
  if (args['plan-only']) return { name, artifact, code: 0, planned: true, scenes: 'full', continueOnFailure: true };
  const result = await run(node, [verify, ...common, `--out=${artifact}`, '--continue-on-failure']);
  artifacts.push(artifact);
  return { name, artifact, ...result };
}

const phases = [];
let selection = null;
if (args.mode !== 'release') {
  const selectionPath = outPath.replace(/\.json$/i, '.selection.json');
  const selectArgs = [selector, `--config=${configPath}`, `--mode=${args.mode}`, `--out=${selectionPath}`];
  if (args.graph) selectArgs.push(`--graph=${args.graph}`);
  if (args['changed-files']) selectArgs.push(`--changed-files=${args['changed-files']}`);
  else selectArgs.push(`--base=${args.base || 'HEAD'}`);
  const selected = await run(node, selectArgs);
  if (selected.code !== 0) throw new Error(`selection failed: ${selected.stderr || 'unknown selector error'}`);
  selection = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
  if (!Array.isArray(selection.smoke) || !selection.smoke.length) throw new Error('selector produced no smoke maps');
}
if (args.mode === 'daily') {
  if (selection.fullRequired) {
    const smokeResult = await verifyPhase('smoke', selection.smoke, false);
    phases.push(smokeResult);
    if (smokeResult.code === 0) phases.push(await fullPhase('full'));
  } else phases.push(await verifyPhase('daily', selection.selected, true));
}
else if (args.mode === 'runtime') {
  const smokeResult = await verifyPhase('smoke', selection.smoke, false);
  phases.push(smokeResult);
  if (smokeResult.code === 0 && (selection.fullRequired || modeConfig.fullRequired)) phases.push(await fullPhase('full'));
} else phases.push(await fullPhase('release'));

if (args['plan-only']) {
  const plan = {
    mode: args.mode, selection: selection ? outPath.replace(/\.json$/i, '.selection.json') : null,
    phases: phases.map(phase => ({ name: phase.name, artifact: phase.artifact, code: phase.code })),
  };
  console.log(JSON.stringify(plan));
  process.exit(0);
}

const summaryPath = outPath.replace(/\.json$/i, '.summary.json');
const summarizeArgs = [summarize, `--config=${configPath}`, `--reports=${artifacts.join(',')}`, `--out=${summaryPath}`];
if (selection) summarizeArgs.push(`--selection=${outPath.replace(/\.json$/i, '.selection.json')}`);
if (args.baseline) summarizeArgs.push(`--baseline=${args.baseline}`);
const summarizeResult = await run(node, summarizeArgs);
let compact = null;
try { compact = JSON.parse(await fs.readFile(summaryPath, 'utf8')); } catch {}
const result = {
  mode: args.mode, phases: phases.map(phase => ({ name: phase.name, code: phase.code, artifact: phase.artifact, stderr: phase.stderr || null })),
  selection: selection ? outPath.replace(/\.json$/i, '.selection.json') : null, artifacts, summary: summaryPath, counts: compact?.counts || null,
};
console.log(JSON.stringify(result));
if (phases.some(phase => phase.code !== 0) || summarizeResult.code !== 0) process.exitCode = 1;
