#!/usr/bin/env node
/**
 * Workbench doctor: one command that reports the real project, versions,
 * entry points, capability inventory and the minimum resource-access results.
 *
 * Distinguishes failure kinds: service-unreachable (connection refused /
 * timeout), resource-failed (HTTP error status), content-invalid (unexpected
 * payload). It never scans the whole asset catalog and never prints
 * credentials or signed query strings.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5173/ff14-web-babylon-preview/';
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench');
const GOLDEN_MAP_ID = 'e3t1';

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

async function gitState() {
  const state = { repoRoot: REPO_ROOT };
  try {
    const [{ stdout: commit }, { stdout: branch }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO_ROOT }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: REPO_ROOT }),
    ]);
    state.commit = commit.trim();
    state.branch = branch.trim();
    state.dirtyEntries = status.split('\n').filter(Boolean).length;
    state.dirty = state.dirtyEntries > 0;
  } catch (error) {
    state.error = error.message.split('\n')[0];
  }
  return state;
}

function readJson(file) {
  return JSON.parse(fsSync.readFileSync(file, 'utf8'));
}

async function probe(url, { accept = null, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: accept ? { Accept: accept } : {} });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (!response.ok) return { kind: 'resource-failed', status: response.status, contentType };
    return { kind: 'ok', status: response.status, contentType, body };
  } catch (error) {
    return { kind: 'service-unreachable', message: error?.name === 'AbortError' ? 'timeout' : String(error?.cause?.code || error?.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeJson(url, options = {}) {
  const result = await probe(url, { ...options, accept: 'application/json' });
  if (result.kind !== 'ok') return result;
  if (!/json/i.test(result.contentType)) return { kind: 'content-invalid', status: result.status, contentType: result.contentType, detail: 'expected JSON payload' };
  try {
    return { ...result, json: JSON.parse(result.body) };
  } catch {
    return { kind: 'content-invalid', status: result.status, contentType: result.contentType, detail: 'payload is not valid JSON' };
  }
}

function capabilityInventory() {
  const has = relative => fsSync.existsSync(path.join(REPO_ROOT, relative));
  const entry = (name, status, location) => ({ name, status, location });
  return [
    entry('babylon-entry', has('preview/babylon/app.js') && has('preview/babylon/index.html'), 'preview/babylon/app.js (globalThis.__BABYLON_PREVIEW__)'),
    entry('asset-runtime', has('src/assets/AssetRuntime.js'), 'src/assets/AssetRuntime.js + preview/babylon/AssetBridge.js'),
    entry('material-adapter', has('preview/babylon/MaterialAdapter.js'), 'preview/babylon/MaterialAdapter.js'),
    entry('environment-adapter', has('preview/babylon/EnvironmentAdapter.js'), 'preview/babylon/EnvironmentAdapter.js'),
    entry('map-loader', has('preview/babylon/SceneLoader.js'), 'preview/babylon/SceneLoader.js (runtimeSnapshot/diagnostics)'),
    entry('developer-panel', has('src/ui/developer/DeveloperPanel.js'), 'src/ui/developer/DeveloperPanel.js + preview/babylon/DeveloperRuntime.js (run(command,args))'),
    entry('programmatic-api', has('preview/babylon/app.js'), 'app.js api: setCameraState/setTime/setViewpoint/diagnostics'),
    entry('snapshot-restore', false, 'MISSING: no capture/restore of scene state (S02 scope)'),
    entry('object-provenance', false, 'MISSING: no resourceId→source provenance panel (S03 scope)'),
    entry('patch-roundtrip', false, 'MISSING: no param override export/apply (S04 scope)'),
    entry('browser-automation', has('scripts/validation/browser.mjs'), 'scripts/validation/browser.mjs (Playwright, PLAYWRIGHT_MODULE_PATH)'),
    entry('bounded-babylon-validation', has('scripts/validate-babylon.mjs'), 'scripts/validate-babylon.mjs (e3t1 fixed views)'),
    entry('visual-reference-harness', has('scripts/validate-visual-references.mjs'), 'config/visual-references.json + scripts/validate-visual-references.mjs'),
    entry('release-pipeline', has('deploy/sandbox-release.py') && has('scripts/verify-babylon-deployment.mjs'), 'deploy/*.sh|py + scripts/verify-babylon-deployment.mjs'),
  ].map(item => ({ ...item, status: item.status === false ? 'missing' : item.status === true ? 'available' : item.status }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = normalizeUrl(args.url || DEFAULT_URL);
  const startedAt = new Date().toISOString();

  const [git, active, visualRefs] = await Promise.all([
    gitState(),
    Promise.resolve().then(() => readJson(path.join(REPO_ROOT, 'public/extracted/active.json'))).catch(error => ({ error: error.message })),
    Promise.resolve().then(() => {
      const raw = fsSync.readFileSync(path.join(REPO_ROOT, 'config/visual-references.json'));
      return { sha256: createHash('sha256').update(raw).digest('hex'), views: JSON.parse(raw).views?.length ?? null };
    }).catch(error => ({ error: error.message })),
  ]);

  const packageJson = readJson(path.join(REPO_ROOT, 'package.json'));
  const nodeVersion = process.version;
  const viteInstalled = fsSync.existsSync(path.join(REPO_ROOT, 'node_modules/vite/package.json'));
  const babylonInstalled = fsSync.existsSync(path.join(REPO_ROOT, 'node_modules/@babylonjs/core/package.json'));
  const goldenScene = active?.scenes?.[GOLDEN_MAP_ID] || null;

  const buildInfo = await probeJson(new URL('build-info.json', appUrl).href);
  const appConfig = await probeJson(new URL('app-config.json', appUrl).href);
  const ticket = await probeJson(new URL('/ff14-assets/ticket?mode=batch', appUrl).href);

  let catalogProbe = { kind: 'skipped', reason: 'ticket unavailable' };
  if (ticket.kind === 'ok' && ticket.json?.entryUrl) {
    catalogProbe = await probeJson(ticket.json.entryUrl);
    if (catalogProbe.kind === 'ok') {
      const maps = Object.keys(catalogProbe.json?.maps || {}).length;
      catalogProbe = { ...catalogProbe, releaseId: catalogProbe.json?.releaseId || null, maps };
      delete catalogProbe.body;
    }
  }

  const server = { appUrl: appUrl.href, buildInfo: strip(buildInfo), appConfig: strip(appConfig), ticket: strip(ticket), catalog: strip(catalogProbe) };
  function strip(result) {
    if (!result || result.kind === 'skipped') return result;
    const { body, ...rest } = result;
    return rest;
  }

  const checks = [];
  const check = (id, ok, detail, kind = null) => checks.push({ id, ok, kind: ok ? null : kind, detail });
  check('git-repo', Boolean(git.commit), git.error || `${git.branch}@${git.commit?.slice(0, 10)} dirty=${git.dirty}`, 'environment');
  check('node', Number(nodeVersion.split('.')[0].slice(1)) >= 18, `node ${nodeVersion} (project recommends 22)`, 'environment');
  check('dependencies', viteInstalled && babylonInstalled, viteInstalled && babylonInstalled ? 'vite + @babylonjs/core installed' : 'node_modules incomplete: run npm install', 'environment');
  check('active-catalog', Boolean(active?.runId), active?.error || `runId ${active?.runId}, ${Object.keys(active?.scenes || {}).length} scenes`, 'project');
  check('golden-map-entry', Boolean(goldenScene), goldenScene ? `e3t1 = ${goldenScene.en} (territory ${goldenScene.territoryId})` : 'e3t1 missing from active.json', 'project');
  check('preview-server', buildInfo.kind === 'ok', serverSummary(buildInfo), buildInfo.kind === 'ok' ? null : buildInfo.kind, );
  check('app-config', appConfig.kind === 'ok', serverSummary(appConfig), appConfig.kind === 'ok' ? null : appConfig.kind);
  check('asset-ticket', ticket.kind === 'ok', serverSummary(ticket), ticket.kind === 'ok' ? null : ticket.kind);
  check('asset-catalog', catalogProbe.kind === 'ok', serverSummary(catalogProbe), catalogProbe.kind === 'ok' ? null : catalogProbe.kind);

  const critical = checks.filter(item => !item.ok);
  const report = {
    schemaVersion: 1,
    generatedAt: startedAt,
    entry: {
      dev: 'npm run dev:babylon',
      preview: 'npm run build:babylon && npm run preview:babylon',
      validate: 'npm run validate:babylon -- --url=' + appUrl.href,
      url: appUrl.href,
    },
    runtime: { node: nodeVersion, viteInstalled, babylonVersion: babylonInstalled ? packageJson.dependencies['@babylonjs/core'] : null },
    git,
    project: {
      activeRunId: active?.runId || null,
      sceneCount: active?.scenes ? Object.keys(active.scenes).length : null,
      goldenMap: goldenScene ? { id: GOLDEN_MAP_ID, name: goldenScene.en, territoryId: goldenScene.territoryId, manifestSha256: goldenScene.manifestSha256 } : null,
      visualReferences: visualRefs,
    },
    server,
    capabilities: capabilityInventory(),
    checks,
    verdict: critical.length === 0 ? 'healthy' : `${critical.length} failing check(s)`,
  };

  await fs.mkdir(DEFAULT_OUT_DIR, { recursive: true });
  const outFile = path.join(DEFAULT_OUT_DIR, `doctor-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const line = (ok, id, detail) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(18)} ${detail}`);
  console.log(`\nWorkbench doctor @ ${startedAt}`);
  for (const item of checks) line(item.ok, item.id, item.detail);
  console.log('\nCapabilities:');
  for (const item of report.capabilities) console.log(`  ${item.status === 'available' ? '[x]' : '[ ]'} ${item.name.padEnd(28)} ${item.status === 'available' ? item.location : item.location}`);
  console.log(`\nVerdict: ${report.verdict}`);
  console.log(`Report:  ${path.relative(REPO_ROOT, outFile)}\n`);
  process.exitCode = critical.length === 0 ? 0 : 1;
}

function serverSummary(result) {
  if (!result || result.kind === 'skipped') return result?.reason || 'skipped';
  if (result.kind === 'ok') {
    if (result.releaseId !== undefined) return `catalog ${result.releaseId}, ${result.maps} maps`;
    if (result.json?.engineVersion) return `engine ${result.json.engineVersion}, ${result.json.mapCount} maps`;
    if (result.json?.assetBase !== undefined) return 'ticket signed, urls available';
    return `HTTP ${result.status}`;
  }
  return `${result.kind}${result.status ? ` HTTP ${result.status}` : ''}${result.message ? ` (${result.message})` : ''}${result.detail ? ` ${result.detail}` : ''}`;
}

await main();
