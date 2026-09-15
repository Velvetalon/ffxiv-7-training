#!/usr/bin/env node
/**
 * S09 impact planning and targeted rebuild.
 *
 * plan    : a change descriptor -> affected derived artifacts/bundles,
 *           representative samples, estimated bytes, whether extraction is
 *           triggered. Resource changes are DRY-RUN only (repacking needs the
 *           extraction pipeline and is out of the workbench boundary).
 * apply   : executes only the planned local artifact (the isolated Babylon
 *           preview build) when its inputs actually changed; identical input
 *           skips. Unrelated hashes must stay byte-identical.
 *
 * Change types:
 *   {type:"config", file:"config/visual-references.json"}
 *   {type:"resource", resourceId:"glb:sha256:..."}          (plan only)
 *   {type:"code", file:"src/assets/AssetRuntime.js"}        (plan only)
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_GZ = path.join(REPO_ROOT, 'work/babylon-golden-map/maps/e3t1/manifest_ab686a714791aad26083e35fe8348e409998a6b3c1d970342f9286f9bd0d33b4.json.gz');
const PACK_ROOT = path.join(REPO_ROOT, 'work/babylon-golden-map');
const STATE_FILE = path.join(REPO_ROOT, 'work/workbench/s09/build-state.json');
const REPRESENTATIVE_MAPS = ['e3t1', 'gridania', 'limsa', 's1t1'];

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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function loadManifest() {
  return JSON.parse(zlib.gunzipSync(fsSync.readFileSync(MANIFEST_GZ)));
}

function fileHash(file) {
  return sha256(fsSync.readFileSync(file));
}

async function planChange(change) {
  if (change.type === 'resource') {
    const manifest = loadManifest();
    const resourceId = change.resourceId;
    // Model resources are stored as glb:sha256:..., manifest as glb:? try both.
    const resource = manifest.resources[resourceId]
      || manifest.resources[resourceId.replace(/^glb:/, '')]
      || null;
    if (!resource) {
      return { change, known: false, note: 'resource not present in the e3t1 manifest; nothing to rebuild locally' };
    }
    const bundleKey = resource.bundle;
    const bundle = manifest.bundles[bundleKey] || null;
    const bundleFile = bundle ? path.join(PACK_ROOT, bundle.url) : null;
    const sampleStableAddresses = [];
    const models = manifest.maps?.e3t1?.models || [];
    for (const model of models) {
      if (model.resourceId === resourceId) {
        sampleStableAddresses.push(`e3t1:${model.index}:0`);
        if (sampleStableAddresses.length >= 3) break;
      }
    }
    return {
      change,
      known: true,
      mode: 'dry-run',
      derived: [{
        artifact: bundle ? bundle.url : bundleKey,
        kind: 'bundle',
        bytes: bundle?.size ?? null,
        bytesOnDisk: bundleFile && fsSync.existsSync(bundleFile) ? fsSync.statSync(bundleFile).size : null,
        reason: `resource ${resourceId.slice(0, 40)}… packs into this bundle; one changed resource rebuilds the whole bundle at the current granularity`,
      }],
      representativeSamples: sampleStableAddresses,
      extractionTriggered: false,
      note: 'repack execution is out of scope locally (needs the extraction pipeline); plan is dry-run',
    };
  }

  if (change.type === 'config') {
    const file = path.resolve(REPO_ROOT, change.file);
    if (!fsSync.existsSync(file)) throw new Error(`config file missing: ${change.file}`);
    return {
      change,
      known: true,
      derived: [{
        artifact: 'site-babylon-preview (build-info.json visualReferences.manifestSha256)',
        kind: 'build',
        inputHash: sha256(fsSync.readFileSync(file)),
        reason: 'the config is embedded into the preview build config and build info',
      }],
      representativeSamples: ['workbench/cases/e3t1-baseline.json'],
      extractionTriggered: false,
      note: 'no model/texture re-extraction: config is build-time data only',
    };
  }

  if (change.type === 'code') {
    const file = path.resolve(REPO_ROOT, change.file);
    const shared = /src\/(assets|world\/imported)|preview\/babylon\/(SceneLoader|MaterialAdapter|WorkbenchApi)/.test(change.file);
    return {
      change,
      known: true,
      mode: 'plan-only',
      derived: [{
        artifact: 'site-babylon-preview (sourceSha256 changes with any src/preview edit)',
        kind: 'build',
      }],
      representativeSamples: shared ? REPRESENTATIVE_MAPS.map(id => `map:${id}`) : ['map:e3t1'],
      confidence: shared ? 'medium: shared code impact is not provable from the resource graph; escalate to the fixed representative maps' : 'high: scoped to the golden map sample',
      extractionTriggered: false,
    };
  }

  throw new Error(`unknown change type: ${change.type}`);
}

async function readBuildState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const change = args.change ? JSON.parse(args.change) : { type: 'config', file: args.file || 'config/visual-references.json' };
  const apply = Boolean(args.apply);
  const rollbackFile = args.rollback;

  const plan = await planChange(change);
  const out = { plan, applied: false, skipped: null };

  if (apply && plan.derived?.[0]?.kind === 'build') {
    const state = await readBuildState();
    // Rollback restores the file FIRST so the input hash reflects the
    // restored content, not the pre-rollback state.
    if (rollbackFile) {
      await fs.copyFile(path.resolve(rollbackFile), path.resolve(REPO_ROOT, change.file));
      plan.derived[0].inputHash = fileHash(path.resolve(REPO_ROOT, change.file));
    }
    const inputHash = plan.derived[0].inputHash;
    if (state.configInputHash === inputHash) {
      out.skipped = 'input hash unchanged since the last applied build; nothing to do';
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const before = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).then(r => r.stdout.trim()).catch(() => null);
    await execFileAsync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.babylon.config.js'], {
      cwd: REPO_ROOT, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
    });
    const buildInfo = JSON.parse(fsSync.readFileSync(path.join(REPO_ROOT, 'site-babylon-preview/build-info.json'), 'utf8'));
    // Unrelated hashes must be untouched by a config-only change.
    const state2 = {
      configInputHash: inputHash,
      builtAt: new Date().toISOString(),
      commit: before,
      buildInfo: {
        visualReferencesManifestSha256: buildInfo.visualReferences.manifestSha256,
        assetRelease: '20260909T124255Z-e3ea44',
        mapCount: buildInfo.mapCount,
        sourceSha256: buildInfo.sourceSha256,
      },
    };
    await fs.writeFile(STATE_FILE, `${JSON.stringify(state2, null, 2)}\n`, 'utf8');
    out.applied = true;
    out.buildInfo = state2.buildInfo;
  }

  console.log(JSON.stringify(out, null, 2));
}

await main();
