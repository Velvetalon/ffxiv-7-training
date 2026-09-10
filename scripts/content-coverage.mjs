#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  asObject,
  audioHeaderStatus,
  exists,
  normaliseSlashes,
  readGzipJson,
  readGlbJson,
  readHeader,
  readJson,
  readJsonIfExists,
  relativePath,
  sortIssues,
  statIfExists,
  writeJson,
} from './lib/content-coverage-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(process.cwd(), 'work/diagnostics');
const ISSUE_LIMIT = 20000;

const HELP = `Usage: node scripts/content-coverage.mjs [options]

Options:
  --dir PATH                 Project or fixture root (default: current directory)
  --out PATH                 Diagnostics directory (default: work/diagnostics)
  --manifest PATH            Sandbox runtime manifest override
  --map-dir PATH             packed-all-final map release override
  --runtime-smoke PATH       Optional proven runtime smoke result
  --position-report PATH     Existing all-map position report override
  --fixture NAME              Built-in smoke fixture: missasset, invalidref, expectedgaps
  --console-examples N       Print up to N anomaly examples (capped at 20)
  --help                     Show this help
`;

function parseArgs(argv) {
  const values = {};
  const flags = new Set(['help']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') throw new Error('Unexpected positional arguments');
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const equal = token.indexOf('=');
    const key = (equal >= 0 ? token.slice(2, equal) : token.slice(2)).trim();
    if (!key) throw new Error('Empty option name');
    if (flags.has(key)) {
      if (equal >= 0) throw new Error(`Option --${key} does not take a value`);
      values[key] = true;
      continue;
    }
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (value == null || String(value).startsWith('--')) throw new Error(`Option --${key} requires a value`);
    values[key] = value;
  }
  const aliases = {
    examples: 'console-examples',
    smoke: 'runtime-smoke',
    position: 'position-report',
  };
  for (const [from, to] of Object.entries(aliases)) if (values[from] != null && values[to] == null) values[to] = values[from];
  return values;
}

function usageError(message) {
  const error = new Error(message);
  error.code = 'USAGE';
  return error;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function number(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function countBy(items, getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function firstDefined(...values) {
  return values.find(value => value != null);
}

function isExternalUrl(value) {
  return /^[a-z][a-z\d+.-]*:/i.test(String(value || ''));
}

function resolveSafe(root, value) {
  if (!value || isExternalUrl(value)) return null;
  const target = path.resolve(root, String(value));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

function issue(type, values = {}) {
  return {
    severity: values.severity || (type === 'warnings' ? 'warning' : 'error'),
    kind: String(values.kind || 'unknown'),
    resource: values.resource == null ? null : String(values.resource),
    source: values.source == null ? null : String(values.source),
    map: values.map == null ? null : String(values.map),
    recommendation: String(values.recommendation || 'Inspect the referenced manifest and rerun the coverage scanner.'),
    ...(values.detail == null ? {} : { detail: values.detail }),
  };
}

class CoverageContext {
  constructor({ root, out, paths }) {
    this.root = root;
    this.out = out;
    this.paths = paths;
    this.issues = {
      missingAssets: [],
      invalidMappings: [],
      animationGaps: [],
      mountGaps: [],
      audioGaps: [],
      positionOutliers: [],
      warnings: [],
    };
    this.issueKeys = new Set();
    this.bundleCache = new Map();
    this.glbCache = new Map();
    this.audioCache = new Map();
    this.manifestValidation = [];
    this.mapResults = [];
    this.sandboxManifest = null;
    this.sandboxPublish = null;
    this.active = null;
    this.catalog = null;
    this.cnNames = null;
    this.mapCatalog = null;
    this.mapPublish = null;
    this.sourceActions = null;
    this.combatActions = null;
    this.position = null;
    this.runtimeSmoke = null;
  }

  rel(file) {
    return relativePath(this.root, file);
  }

  addIssue(bucket, value) {
    const item = value.severity ? value : issue(bucket === 'warnings' ? 'warnings' : bucket, value);
    const key = [bucket, item.severity, item.kind, item.resource, item.source, item.map, JSON.stringify(item.detail || '')].join('|');
    if (this.issueKeys.has(key)) return item;
    this.issueKeys.add(key);
    if (this.issues[bucket].length < ISSUE_LIMIT) this.issues[bucket].push(item);
    return item;
  }

  addMissing(values) { return this.addIssue('missingAssets', issue('missingAssets', { ...values, severity: 'error' })); }
  addInvalid(values) { return this.addIssue('invalidMappings', issue('invalidMappings', { ...values, severity: 'error' })); }
  addWarning(values) { return this.addIssue('warnings', issue('warnings', { ...values, severity: 'warning' })); }
  addAnimationGap(values) { return this.addIssue('animationGaps', issue('animationGaps', { ...values, severity: 'warning' })); }
  addMountGap(values) { return this.addIssue('mountGaps', issue('mountGaps', { ...values, severity: values.severity || 'error' })); }
  addAudioGap(values) { return this.addIssue('audioGaps', issue('audioGaps', { ...values, severity: values.severity || 'error' })); }
  addPosition(values) { return this.addIssue('positionOutliers', issue('positionOutliers', { ...values, severity: values.severity || 'warning' })); }
}

async function firstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate)) return path.resolve(candidate);
  return null;
}

async function findFileByPrefix(directory, prefix, suffix = '') {
  if (!(await exists(directory))) return null;
  const entries = (await fs.readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith(suffix)).sort();
  return entries.length ? path.join(directory, entries[0]) : null;
}

async function discoverPaths(root, args) {
  const sandboxRoot = await firstExisting([
    args.manifest ? path.dirname(path.resolve(root, args.manifest)) : null,
    path.join(root, 'public/sandbox'),
    path.join(root, 'sandbox'),
    root,
  ]);
  const sandboxManifest = args.manifest
    ? path.resolve(root, args.manifest)
    : await firstExisting([path.join(sandboxRoot || root, 'manifest.json'), path.join(sandboxRoot || root, 'manifest.cdn.json')]);
  const sandboxPublish = await firstExisting([
    path.join(sandboxRoot || root, 'publish-manifest.json'),
    path.join(path.dirname(sandboxManifest || root), 'publish-manifest.json'),
  ]);
  const active = await firstExisting([
    path.join(root, 'public/extracted/active.json'),
    path.join(root, 'extracted/active.json'),
    path.join(root, 'active.json'),
  ]);
  const catalog = await firstExisting([
    path.join(root, 'tools/map-tools/world-catalog.json'),
    path.join(root, 'world-catalog.json'),
    path.join(root, 'world/world-catalog.json'),
  ]);
  const cnNames = await firstExisting([
    path.join(root, 'tools/map-tools/data/world-scene-names-zh.json'),
    path.join(root, 'world-scene-names-zh.json'),
  ]);
  const mapDir = args['map-dir']
    ? path.resolve(root, args['map-dir'])
    : await firstExisting([
      path.join(root, 'work/asset-performance/packed-all-final'),
      path.join(root, 'packed-all-final'),
    ]);
  const mapCatalog = await findFileByPrefix(mapDir, 'catalog_', '.json');
  const mapPublish = await firstExisting([mapDir ? path.join(mapDir, 'publish-manifest.json') : null]);
  const positionReport = args['position-report']
    ? path.resolve(root, args['position-report'])
    : path.join(root, 'work/map-position/check-map-position-all.json');
  const runtimeSmoke = args['runtime-smoke']
    ? path.resolve(root, args['runtime-smoke'])
    : await firstExisting([
      path.join(root, 'work/fast-validation/result.json'),
      path.join(root, 'work/quality-v2-fast-validation/result.json'),
    ]);
  const audioRoot = sandboxRoot ? path.join(sandboxRoot, 'audio') : null;
  return {
    sandboxRoot,
    sandboxManifest,
    sandboxPublish,
    active,
    catalog,
    cnNames,
    mapDir,
    mapCatalog,
    mapPublish,
    positionReport,
    runtimeSmoke,
    actionSource: await firstExisting([
      path.join(audioRoot || root, 'action-source-manifest.json'),
      path.join(root, 'public/sandbox/audio/action-source-manifest.json'),
    ]),
    audioSource: await firstExisting([
      path.join(audioRoot || root, 'audio-source-manifest.json'),
      path.join(root, 'public/sandbox/audio/audio-source-manifest.json'),
    ]),
    sceneBgmCatalog: await firstExisting([
      path.join(audioRoot || root, 'scene-bgm-catalog.json'),
      path.join(root, 'public/sandbox/audio/scene-bgm-catalog.json'),
    ]),
  };
}

async function loadOptional(file, ctx, label, { required = false } = {}) {
  if (!file) {
    if (required) ctx.addMissing({ kind: `missing_${label}`, source: label, recommendation: `Provide the ${label} input before rerunning the scanner.` });
    return null;
  }
  try {
    return await readJson(file);
  } catch (error) {
    ctx.addInvalid({ kind: `invalid_${label}`, source: ctx.rel(file), recommendation: `Repair the ${label} JSON and rerun the scanner.`, detail: error.message });
    return null;
  }
}

async function loadGzipOptional(file, ctx, label, map = null) {
  try {
    return await readGzipJson(file);
  } catch (error) {
    ctx.addInvalid({ kind: `invalid_${label}`, source: ctx.rel(file), map, recommendation: `Regenerate the compressed ${label} manifest.`, detail: error.message });
    return null;
  }
}

function resolveAlias(id, aliases = {}) {
  let current = id;
  const seen = new Set();
  while (typeof current === 'string' && aliases[current] != null && !seen.has(current)) {
    seen.add(current);
    const next = aliases[current];
    // The pack builder emits identity aliases for canonical IDs. They are
    // intentional and must not be mistaken for an alias cycle.
    if (next === current) return { id: current, cycle: false, seen };
    current = next;
  }
  return { id: current, cycle: seen.has(current), seen };
}

function manifestResource(manifest, id) {
  if (!manifest || typeof id !== 'string') return null;
  const aliases = asObject(manifest.aliases);
  const resolved = resolveAlias(id, aliases).id;
  return { id: resolved, resource: asObject(manifest.resources)[resolved] || null };
}

async function getBundleInfo(ctx, manifestRoot, bundleId, bundle, source, map = null) {
  const url = bundle?.url || bundle?.Url;
  const cacheKey = `${manifestRoot}|${bundleId}|${url || ''}`;
  if (ctx.bundleCache.has(cacheKey)) return ctx.bundleCache.get(cacheKey);
  const info = {
    id: bundleId,
    url: url || null,
    file: null,
    exists: false,
    size: null,
    declaredSize: number(bundle?.size ?? bundle?.Size),
    external: isExternalUrl(url),
  };
  if (url && !info.external) {
    info.file = resolveSafe(manifestRoot, url);
    const stat = await statIfExists(info.file);
    info.exists = Boolean(stat);
    info.size = stat?.size ?? null;
    if (!info.exists) {
      ctx.addMissing({
        kind: 'missing_local_pack', resource: bundleId, source, map,
        recommendation: 'Restore the local pack listed by the manifest or regenerate the bounded release.',
      });
    } else if (info.declaredSize != null && info.declaredSize !== info.size) {
      ctx.addInvalid({
        kind: 'bundle_size_mismatch', resource: bundleId, source, map,
        recommendation: 'Regenerate the publish manifest so bundle size matches the local pack.',
        detail: { declared: info.declaredSize, actual: info.size },
      });
    }
  }
  ctx.bundleCache.set(cacheKey, info);
  return info;
}

async function validateResourceManifest(ctx, manifest, manifestRoot, source, map = null, publishManifest = null) {
  if (!manifest || !isPlainObject(manifest)) return { resourceCount: 0, validResourceCount: 0, errors: 0 };
  const resources = asObject(manifest.resources);
  const bundles = asObject(manifest.bundles);
  const aliases = asObject(manifest.aliases);
  const publishFiles = new Map((Array.isArray(publishManifest?.files) ? publishManifest.files : [])
    .filter(item => item && typeof item.path === 'string')
    .map(item => [normaliseSlashes(item.path), item]));
  const bundleInfo = new Map();
  let validResourceCount = 0;
  const resolve = id => resolveAlias(id, aliases);
  for (const [alias, target] of Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof target !== 'string') {
      ctx.addInvalid({ kind: 'invalid_alias_target', resource: alias, source, map, recommendation: 'Point each alias at a concrete resource ID.' });
      continue;
    }
    const resolved = resolve(target);
    if (resolved.cycle || !resources[resolved.id]) {
      ctx.addInvalid({ kind: 'invalid_alias_target', resource: alias, source, map, recommendation: 'Remove the dangling alias or point it at an imported resource ID.', detail: { target } });
    }
  }
  for (const [bundleId, bundle] of Object.entries(bundles).sort(([a], [b]) => a.localeCompare(b))) {
    const info = await getBundleInfo(ctx, manifestRoot, bundleId, bundle, source, map);
    bundleInfo.set(bundleId, info);
    if (info.url && !info.external) {
      const published = publishFiles.get(normaliseSlashes(info.url));
      if (!published) {
        ctx.addWarning({ kind: 'pack_not_listed_in_publish_manifest', resource: bundleId, source, map, recommendation: 'Regenerate publish-manifest.json to include every local pack.' });
      } else if (number(published.size) != null && info.size != null && number(published.size) !== info.size) {
        ctx.addInvalid({ kind: 'published_pack_size_mismatch', resource: bundleId, source, map, recommendation: 'Align publish-manifest file size with the local pack.', detail: { published: number(published.size), actual: info.size } });
      }
    }
  }
  for (const [id, resource] of Object.entries(resources).sort(([a], [b]) => a.localeCompare(b))) {
    const item = asObject(resource);
    const hashMatch = /^([^:]+):sha256:([a-f0-9]{64})$/i.exec(id);
    if (!hashMatch || (item.hash && String(item.hash).toLowerCase() !== hashMatch[2].toLowerCase())) {
      ctx.addInvalid({ kind: 'invalid_resource_id', resource: id, source, map, recommendation: 'Use the canonical type:sha256:<64-hex> resource ID and matching hash.' });
    }
    if (!Array.isArray(item.dependencies)) {
      ctx.addInvalid({ kind: 'invalid_dependencies', resource: id, source, map, recommendation: 'Store dependencies as an array of resource IDs.' });
    } else {
      for (const dependency of item.dependencies) {
        if (typeof dependency !== 'string') {
          ctx.addInvalid({ kind: 'invalid_dependency_id', resource: id, source, map, recommendation: 'Use string resource IDs in dependencies.' });
          continue;
        }
        const resolved = resolve(dependency);
        if (resolved.cycle || !resources[resolved.id]) {
          ctx.addMissing({ kind: 'missing_dependency', resource: dependency, source, map, recommendation: 'Import the dependency or remove the stale dependency reference.', detail: { owner: id } });
        }
      }
    }
    const bundleId = item.bundle;
    if (!bundleId) {
      if (!item.virtual && item.size !== 0) {
        ctx.addInvalid({ kind: 'unbundled_resource', resource: id, source, map, recommendation: 'Assign a local pack bundle to each non-virtual resource.' });
      } else validResourceCount += 1;
      continue;
    }
    const info = bundleInfo.get(bundleId) || await getBundleInfo(ctx, manifestRoot, bundleId, bundles[bundleId], source, map);
    bundleInfo.set(bundleId, info);
    const offset = number(item.offset);
    const length = number(item.length);
    if (!info || !info.exists || offset == null || length == null || offset < 0 || length < 0) {
      if (offset == null || length == null || offset < 0 || length < 0) {
        ctx.addInvalid({ kind: 'invalid_resource_range', resource: id, source, map, recommendation: 'Keep resource offset and length as non-negative integers within the pack.' });
      }
      continue;
    }
    if (offset + length > info.size) {
      ctx.addInvalid({ kind: 'resource_range_out_of_bounds', resource: id, source, map, recommendation: 'Regenerate the pack index so offset plus length stays within the local pack.', detail: { offset, length, packSize: info.size } });
      continue;
    }
    if (number(item.size) != null && number(item.size) !== length) {
      ctx.addInvalid({ kind: 'resource_size_mismatch', resource: id, source, map, recommendation: 'Regenerate the resource index so resource size matches its packed length.', detail: { declared: number(item.size), length } });
      continue;
    }
    validResourceCount += 1;
  }
  return { resourceCount: Object.keys(resources).length, validResourceCount, errors: 0 };
}

async function resolveResourceRef(ctx, manifest, id, values = {}, { required = true } = {}) {
  const source = values.source || ctx.rel(ctx.paths.sandboxManifest);
  if (id == null || id === '') {
    if (required) ctx.addInvalid({ kind: values.kind || 'missing_resource_reference', resource: values.resource || null, source, map: values.map, recommendation: values.recommendation || 'Add the explicit runtime resource ID to the mapping.' });
    return null;
  }
  if (typeof id !== 'string') {
    ctx.addInvalid({ kind: values.kind || 'invalid_resource_reference', resource: String(id), source, map: values.map, recommendation: values.recommendation || 'Use a string runtime resource ID rather than provenance metadata.' });
    return null;
  }
  const aliases = asObject(manifest?.aliases);
  const resolution = resolveAlias(id, aliases);
  if (resolution.cycle) {
    ctx.addInvalid({ kind: 'alias_cycle', resource: id, source, map: values.map, recommendation: 'Break the alias cycle and point the alias at a concrete resource ID.' });
    return null;
  }
  const resource = asObject(manifest?.resources)[resolution.id];
  if (!resource) {
    ctx.addMissing({ kind: values.kind || 'missing_resource_reference', resource: id, source, map: values.map, recommendation: values.recommendation || 'Import the referenced resource or remove the stale runtime mapping.' });
    return null;
  }
  return { id: resolution.id, resource };
}

async function getGlbStats(ctx, manifest, resourceId, values = {}) {
  const resolved = await resolveResourceRef(ctx, manifest, resourceId, values);
  if (!resolved || resolved.resource.type !== 'glb') return resolved ? { status: 'not-glb', resource: resolved.resource, id: resolved.id } : null;
  const resource = resolved.resource;
  const bundle = asObject(manifest.bundles)[resource.bundle];
  const url = bundle?.url;
  const bundleFile = url && !isExternalUrl(url) ? resolveSafe(ctx.paths.sandboxRoot || ctx.root, url) : null;
  const key = `${ctx.paths.sandboxRoot || ctx.root}|${resource.bundle}|${resource.offset}|${resource.length}`;
  if (ctx.glbCache.has(key)) return { ...ctx.glbCache.get(key), id: resolved.id, resource };
  if (!bundleFile || !(await exists(bundleFile))) {
    const result = { status: 'not-parsed', reason: 'local-pack-unavailable', id: resolved.id, resource };
    ctx.glbCache.set(key, result);
    return result;
  }
  const result = await readGlbJson(bundleFile, number(resource.offset, 0), number(resource.length, 0));
  const normalized = { ...result, id: resolved.id, resource, declared: {
    materials: number(resource.metadata?.glbMaterials ?? resource.metadata?.materials),
    skins: number(resource.metadata?.skeletonBones),
    animations: number(resource.metadata?.animations),
  } };
  ctx.glbCache.set(key, normalized);
  if (result.status === 'invalid') {
    ctx.addInvalid({ kind: 'invalid_glb_json_chunk', resource: resolved.id, source: values.source || ctx.rel(ctx.paths.sandboxManifest), map: values.map, recommendation: 'Regenerate the bounded GLB resource with a valid JSON chunk.', detail: result.reason });
  }
  return normalized;
}

async function getAudioStatus(ctx, manifest, resourceId, values = {}) {
  const resolved = await resolveResourceRef(ctx, manifest, resourceId, values);
  if (!resolved) return null;
  const resource = resolved.resource;
  const bundle = asObject(manifest.bundles)[resource.bundle];
  const bundleFile = bundle?.url && !isExternalUrl(bundle.url) ? resolveSafe(ctx.paths.sandboxRoot || ctx.root, bundle.url) : null;
  const key = `${ctx.paths.sandboxRoot || ctx.root}|${resource.bundle}|${resource.offset}|${resource.length}`;
  if (ctx.audioCache.has(key)) return { ...ctx.audioCache.get(key), id: resolved.id, resource };
  if (!bundleFile || !(await exists(bundleFile))) {
    const result = { status: 'unknown', reason: 'local-pack-unavailable', id: resolved.id, resource };
    ctx.audioCache.set(key, result);
    return result;
  }
  const header = await readHeader(bundleFile, number(resource.offset, 0), 16);
  const result = { ...audioHeaderStatus(header, resource.metadata), id: resolved.id, resource };
  ctx.audioCache.set(key, result);
  return result;
}

function refValues(source, map = null, recommendation = null) {
  return { source, map, ...(recommendation ? { recommendation } : {}) };
}

function collectAnimationRefs(manifest) {
  const refs = [];
  for (const [characterId, character] of Object.entries(asObject(manifest?.characters)).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [state, resourceId] of Object.entries(asObject(character.animations)).sort(([a], [b]) => a.localeCompare(b))) {
      refs.push({ state, resourceId, owner: characterId, kind: 'character', sourceField: `characters.${characterId}.animations.${state}` });
    }
  }
  for (const [mountId, mount] of Object.entries(asObject(manifest?.mounts)).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [state, resourceId] of Object.entries(asObject(mount.animations)).sort(([a], [b]) => a.localeCompare(b))) {
      refs.push({ state, resourceId, owner: mountId, kind: 'mount', sourceField: `mounts.${mountId}.animations.${state}` });
    }
    for (const [state, resourceId] of Object.entries(asObject(mount.riderAnimations)).sort(([a], [b]) => a.localeCompare(b))) {
      refs.push({ state: `rider:${state}`, resourceId, owner: mountId, kind: 'rider', sourceField: `mounts.${mountId}.riderAnimations.${state}` });
    }
  }
  return refs;
}

async function scanCharacters(ctx, manifest) {
  const source = ctx.rel(ctx.paths.sandboxManifest);
  const characters = asObject(manifest.characters);
  const summary = {
    imported: Object.keys(characters).length,
    parsed: 0,
    model: { referenced: 0, resolvable: 0, actualMaterials: 0, actualSkins: 0, declaredSkeletonBones: 0 },
    materials: { declared: 0, actual: 0, mappings: 0 },
    skeleton: { declared: 0, actualSkins: 0, resolvable: 0 },
    appearance: { mapped: 0, bindings: 0, missing: 0 },
    animations: { referenced: 0, resolvable: 0 },
  };
  for (const [id, character] of Object.entries(characters).sort(([a], [b]) => a.localeCompare(b))) {
    const value = asObject(character);
    const modelRef = await resolveResourceRef(ctx, manifest, value.model, { ...refValues(source), kind: 'missing_character_model', resource: `${id}:model`, recommendation: 'Import the character model referenced by the character definition.' });
    summary.model.referenced += value.model ? 1 : 0;
    if (modelRef) {
      summary.model.resolvable += 1;
      const modelStats = await getGlbStats(ctx, manifest, value.model, { ...refValues(source), kind: 'invalid_character_model', resource: value.model });
      if (modelStats?.status === 'parsed') {
        summary.parsed += 1;
        summary.model.actualMaterials += modelStats.counts.materials;
        summary.model.actualSkins += modelStats.counts.skins;
        summary.materials.actual += modelStats.counts.materials;
        summary.skeleton.actualSkins += modelStats.counts.skins;
      }
      const declaredBones = number(modelRef.resource.metadata?.skeletonBones, 0);
      summary.model.declaredSkeletonBones += declaredBones;
      summary.skeleton.declared += declaredBones;
      if ((modelStats?.status === 'parsed' && modelStats.counts.skins > 0) || declaredBones > 0) summary.skeleton.resolvable += 1;
      if (modelRef.resource.metadata?.kind && modelRef.resource.metadata.kind !== 'character-model') {
        ctx.addWarning({ kind: 'character_model_kind_mismatch', resource: value.model, source, recommendation: 'Confirm the character definition points at a character-model resource.', detail: { kind: modelRef.resource.metadata.kind } });
      }
    }
    const binding = asObject(value.appearanceBindings);
    const materialBindings = asObject(binding.materials);
    const roleBindings = asObject(binding.materialRoles);
    summary.materials.declared += Object.keys(materialBindings).length;
    summary.materials.mappings += Object.keys(roleBindings).length;
    summary.appearance.mapped += value.appearance && typeof value.appearance === 'object' ? 1 : 0;
    summary.appearance.bindings += Object.keys(binding).length ? 1 : 0;
    if (!value.appearance || !value.appearanceMatch || !binding.modelFamily) {
      summary.appearance.missing += 1;
      ctx.addWarning({ kind: 'character_appearance_metadata_gap', resource: id, source, recommendation: 'Provide the parsed appearance and binding metadata for this imported character.' });
    }
    const animationEntries = Object.entries(asObject(value.animations));
    summary.animations.referenced += animationEntries.length;
    for (const [state, resourceId] of animationEntries) {
      const ref = await resolveResourceRef(ctx, manifest, resourceId, { ...refValues(source), kind: 'missing_character_animation', resource: resourceId, recommendation: 'Import the character animation resource or remove the stale state mapping.' });
      if (!ref) continue;
      summary.animations.resolvable += 1;
      const stats = await getGlbStats(ctx, manifest, resourceId, { ...refValues(source), kind: 'invalid_character_animation', resource: resourceId });
      if (stats?.status === 'parsed' && stats.counts.animations < 1) {
        ctx.addInvalid({ kind: 'character_animation_without_clip', resource: resourceId, source, recommendation: `Add an animation clip for character state ${state}.` });
      }
    }
    if (modelRef && summary.parsed >= 0) {
      // A character with a valid model and explicit appearance mapping counts as imported/parsed.
      if (modelRef.resource && (value.appearance || value.appearanceMatch)) summary.parsed += 0;
    }
  }
  summary.model.materials = summary.model.actualMaterials;
  summary.skeleton.status = summary.skeleton.resolvable === summary.imported ? 'declared' : 'partial';
  return summary;
}

async function scanMounts(ctx, manifest) {
  const source = ctx.rel(ctx.paths.sandboxManifest);
  const mounts = asObject(manifest.mounts);
  const summary = {
    imported: Object.keys(mounts).length,
    total: Object.keys(mounts).length,
    metadataResolvable: 0,
    modelResolvable: 0,
    skeletonResolvable: 0,
    modelActualMaterials: 0,
    modelActualSkins: 0,
    modelDeclaredSkeletonBones: 0,
    animationResolvable: 0,
    riderAnimationResolvable: 0,
    missing: 0,
    details: [],
  };
  for (const [id, mount] of Object.entries(mounts).sort(([a], [b]) => a.localeCompare(b))) {
    const value = asObject(mount);
    if (value.id && value.mountRowId != null && value.modelCharaId != null && value.model) summary.metadataResolvable += 1;
    const modelRef = await resolveResourceRef(ctx, manifest, value.model, { ...refValues(source), kind: 'missing_mount_model', resource: `${id}:model`, recommendation: 'Import the mount model referenced by the mount definition.' });
    const detail = { id, model: value.model || null, modelResolvable: Boolean(modelRef), skeletonResolvable: false, animations: 0, riderAnimations: 0, missing: [] };
    if (modelRef) {
      const modelStats = await getGlbStats(ctx, manifest, value.model, { ...refValues(source), kind: 'invalid_mount_model', resource: value.model });
      summary.modelDeclaredSkeletonBones += number(modelRef.resource.metadata?.skeletonBones, 0);
      if (modelStats?.status === 'parsed') {
        summary.modelActualMaterials += modelStats.counts.materials;
        summary.modelActualSkins += modelStats.counts.skins;
      }
      detail.skeletonResolvable = Boolean(modelStats?.status === 'parsed' ? modelStats.counts.skins > 0 : number(modelRef.resource.metadata?.skeletonBones, 0) > 0);
      if (detail.skeletonResolvable) summary.skeletonResolvable += 1;
      else {
        summary.missing += 1;
        detail.missing.push('skeleton');
        ctx.addMountGap({ kind: 'mount_model_without_skeleton', resource: value.model, source, map: id, recommendation: 'Export a skinned mount model with a readable skeleton.' });
      }
      if (detail.modelResolvable) summary.modelResolvable += 1;
    } else {
      summary.missing += 1;
      detail.missing.push('model');
      ctx.addMountGap({ kind: 'missing_mount_model', resource: value.model || `${id}:model`, source, map: id, recommendation: 'Import the mount model referenced by the mount definition.' });
    }
    const animationEntries = Object.entries(asObject(value.animations));
    for (const [state, resourceId] of animationEntries) {
      const ref = await resolveResourceRef(ctx, manifest, resourceId, { ...refValues(source), kind: 'missing_mount_animation', resource: resourceId, recommendation: 'Import the mount animation resource or remove the stale state mapping.' });
      if (!ref) {
        detail.missing.push(`animation:${state}`);
        continue;
      }
      const stats = await getGlbStats(ctx, manifest, resourceId, { ...refValues(source), kind: 'invalid_mount_animation', resource: resourceId });
      if (stats?.status === 'parsed' && stats.counts.animations < 1) {
        detail.missing.push(`animation:${state}`);
        ctx.addMountGap({ kind: 'mount_animation_without_clip', resource: resourceId, source, map: id, recommendation: `Add a readable animation clip for mount state ${state}.` });
      } else {
        detail.animations += 1;
        summary.animationResolvable += 1;
      }
    }
    for (const [state, resourceId] of Object.entries(asObject(value.riderAnimations))) {
      const ref = await resolveResourceRef(ctx, manifest, resourceId, { ...refValues(source), kind: 'missing_rider_animation', resource: resourceId, recommendation: 'Import the rider animation resource or remove the stale rider state mapping.' });
      if (!ref) {
        detail.missing.push(`riderAnimation:${state}`);
        continue;
      }
      const stats = await getGlbStats(ctx, manifest, resourceId, { ...refValues(source), kind: 'invalid_rider_animation', resource: resourceId });
      if (stats?.status === 'parsed' && stats.counts.animations < 1) {
        detail.missing.push(`riderAnimation:${state}`);
        ctx.addMountGap({ kind: 'rider_animation_without_clip', resource: resourceId, source, map: id, recommendation: `Add a readable rider animation clip for ${state}.` });
      } else {
        detail.riderAnimations += 1;
        summary.riderAnimationResolvable += 1;
      }
    }
    if (detail.missing.length) summary.missing += detail.missing.length;
    summary.animationResolvable = Math.min(summary.animationResolvable, animationEntries.length * summary.total || summary.animationResolvable);
    summary.details.push(detail);
  }
  return summary;
}

async function loadCombatActions(ctx) {
  const sourceFile = path.join(ctx.root, 'src/combat/data.js');
  const definitionsFile = path.join(ctx.root, 'src/character/SkillDefinitions.js');
  try {
    const [{ ACTIONS }, { SkillDefinitions }] = await Promise.all([
      import(`${pathToFileURL(sourceFile).href}?coverage=${Date.now()}`),
      import(`${pathToFileURL(definitionsFile).href}?coverage=${Date.now()}`),
    ]);
    const actions = Object.values(asObject(ACTIONS)).flat().filter(Boolean);
    const definitions = new SkillDefinitions(actions);
    return { actions, definitions: [...definitions.definitions.values()], source: ctx.rel(sourceFile) };
  } catch (error) {
    ctx.addWarning({ kind: 'combat_action_source_unavailable', source: ctx.rel(sourceFile), recommendation: 'Keep src/combat/data.js and SkillDefinitions.js available for runtime action coverage counts.', detail: error.message });
    return { actions: [], definitions: [], source: ctx.rel(sourceFile), error: error.message };
  }
}

function actionManifestRows(source) {
  return Array.isArray(source?.Actions) ? source.Actions : Array.isArray(source?.actions) ? source.actions : [];
}

function presentationHasAnimation(value) {
  return Boolean(value && (value.animationResourceId || value.animationAssetId || value.animationState || value.animationId != null || value.animation));
}

async function scanAnimationsAndSkills(ctx, manifest, characterSummary, mountSummary) {
  const source = ctx.rel(ctx.paths.sandboxManifest);
  const animationRefs = collectAnimationRefs(manifest);
  const boundIds = new Set();
  const boundStates = new Set();
  for (const ref of animationRefs) {
    const resolved = await resolveResourceRef(ctx, manifest, ref.resourceId, { ...refValues(source), kind: 'missing_animation_binding', resource: ref.resourceId, recommendation: `Import the animation resource for state ${ref.state}.` });
    if (resolved) {
      boundIds.add(resolved.id);
      boundStates.add(ref.state);
    }
  }
  const allAnimationResources = Object.entries(asObject(manifest.resources))
    .filter(([, resource]) => resource?.type === 'glb' && /animation/i.test(String(resource.metadata?.kind || '')))
    .sort(([a], [b]) => a.localeCompare(b));
  const actual = { parsed: 0, declaredOnly: 0, invalid: 0, clips: 0 };
  for (const [resourceId, resource] of allAnimationResources) {
    const stats = await getGlbStats(ctx, manifest, resourceId, { ...refValues(source), kind: 'invalid_animation_resource', resource: resourceId });
    if (stats?.status === 'parsed') {
      actual.parsed += 1;
      actual.clips += stats.counts.animations;
    } else if (stats?.status === 'invalid') actual.invalid += 1;
    else actual.declaredOnly += 1;
  }
  const sourceRows = actionManifestRows(ctx.sourceActions);
  const presentations = Object.entries(asObject(manifest.skills)).filter(([, value]) => presentationHasAnimation(value));
  const presentedIds = new Set(presentations.map(([, value]) => number(value?.skillId)).filter(value => value != null));
  const sourceById = new Map(sourceRows.map(row => [number(firstDefined(row.SkillId, row.skillId)), row]).filter(([id]) => id != null));
  const sourcePresentedIds = new Set(presentedIds);
  const combat = ctx.combatActions || { actions: [], definitions: [], source: null };
  const knownRuntime = [];
  const runtimeMissing = [];
  const sourceNames = new Set(presentations.map(([, value]) => sourceById.get(number(value?.skillId))?.Name || sourceById.get(number(value?.skillId))?.name).filter(Boolean));
  const combatEntries = combat.actions.length ? combat.actions : combat.definitions;
  for (const definition of combatEntries) {
    const key = number(definition.skillId) ?? definition.id;
    const byId = key != null && sourcePresentedIds.has(Number(key));
    const byName = sourceNames.has(definition.name);
    if (byId || byName) knownRuntime.push(definition);
    else runtimeMissing.push(definition);
  }
  // If the source-derived combat table is unavailable, use the extracted action rows
  // for a truthful imported-only count rather than inventing a game-wide total.
  const combatTotal = combatEntries.length || sourceRows.length;
  const knownPresentationCount = presentations.length;
  for (const definition of runtimeMissing) {
    ctx.addAnimationGap({
      kind: 'expected_combat_action_coverage_gap',
      resource: definition.id,
      source: combat.source || ctx.rel(ctx.paths.actionSource),
      map: null,
      recommendation: 'Add a verified presentation mapping when this action is intentionally brought into the developer panel; this warning does not indicate a runtime crash.',
      detail: { name: definition.name, expected: true },
    });
  }
  const summary = {
    importedAnimationResources: allAnimationResources.length,
    parsedAnimationResources: actual.parsed,
    declaredOnlyAnimationResources: actual.declaredOnly,
    invalidAnimationResources: actual.invalid,
    actualAnimationClips: actual.clips,
    boundStates: boundStates.size,
    boundResourceRefs: boundIds.size,
    unboundResources: allAnimationResources.filter(([id]) => !boundIds.has(resolveAlias(id, asObject(manifest.aliases)).id)).map(([id]) => id),
    characterAnimationRefs: characterSummary.animations.referenced,
    mountAnimationRefs: mountSummary.animationResolvable,
    skill: {
      runtimeCombatActionDefinitions: combatTotal,
      uniqueSkillDefinitions: combat.definitions.length,
      extractedSourceActionDefinitions: sourceRows.length,
      knownPresentations: knownPresentationCount,
      runtimeDefinitionsWithPresentation: knownRuntime.length,
      expectedCoverageGaps: runtimeMissing.length,
      expectedGapPolicy: 'warning-only; unimplemented combat actions are not broken runtime references',
    },
    source: {
      combatActions: combat.source,
      skillDefinitions: combat.source ? ctx.rel(path.join(ctx.root, 'src/character/SkillDefinitions.js')) : null,
      actionManifest: ctx.paths.actionSource ? ctx.rel(ctx.paths.actionSource) : null,
    },
  };
  return summary;
}

async function scanAudio(ctx, manifest) {
  const source = ctx.rel(ctx.paths.sandboxManifest);
  const sceneBgm = asObject(manifest.sceneBgm);
  const entries = Object.entries(sceneBgm).sort(([a], [b]) => a.localeCompare(b));
  const explicitNull = entries.filter(([, value]) => value == null).map(([id]) => id);
  const mapped = entries.filter(([, value]) => value != null);
  const bgmIds = new Set();
  let codecChecked = 0;
  let codecOk = 0;
  let codecInvalid = 0;
  let codecUnknown = 0;
  for (const [scene, value] of mapped) {
    const resourceId = typeof value === 'string' ? value : value?.id;
    const ref = await resolveResourceRef(ctx, manifest, resourceId, { ...refValues(source, scene), kind: 'missing_scene_bgm', resource: resourceId, recommendation: 'Import the scene BGM resource or leave the scene explicitly null for source absence.' });
    if (!ref) continue;
    bgmIds.add(ref.id);
    const status = await getAudioStatus(ctx, manifest, resourceId, { ...refValues(source, scene), resource: resourceId });
    codecChecked += 1;
    if (status?.status === 'ok') codecOk += 1;
    else if (status?.status === 'invalid') {
      codecInvalid += 1;
      ctx.addAudioGap({ kind: 'invalid_bgm_codec', resource: resourceId, source, map: scene, recommendation: 'Regenerate the audio pack with the declared codec and a valid local header.', detail: status.reason });
    } else codecUnknown += 1;
  }
  const skillIds = new Set();
  let skillSoundRefs = 0;
  for (const [skillKey, value] of Object.entries(asObject(manifest.skills)).sort(([a], [b]) => a.localeCompare(b))) {
    const soundIds = [];
    if (value?.soundId != null) soundIds.push(value.soundId);
    for (const cue of Array.isArray(value?.soundEvents) ? value.soundEvents : []) if (cue?.resourceId != null) soundIds.push(cue.resourceId);
    for (const resourceId of soundIds) {
      skillSoundRefs += 1;
      const ref = await resolveResourceRef(ctx, manifest, resourceId, { ...refValues(source), kind: 'missing_skill_sfx', resource: resourceId, recommendation: `Import the SFX resource referenced by skill ${skillKey}.` });
      if (!ref) continue;
      skillIds.add(ref.id);
      const status = await getAudioStatus(ctx, manifest, resourceId, { ...refValues(source), resource: resourceId });
      codecChecked += 1;
      if (status?.status === 'ok') codecOk += 1;
      else if (status?.status === 'invalid') {
        codecInvalid += 1;
        ctx.addAudioGap({ kind: 'invalid_sfx_codec', resource: resourceId, source, map: null, recommendation: `Regenerate the SFX pack with a valid local header for skill ${skillKey}.`, detail: status.reason });
      } else codecUnknown += 1;
    }
  }
  let audioSourceManifest = null;
  if (ctx.paths.audioSource) audioSourceManifest = await loadOptional(ctx.paths.audioSource, ctx, 'audio_source_manifest');
  const sourceResources = asObject(audioSourceManifest?.Resources);
  return {
    bgm: {
      sceneEntries: entries.length,
      mappedScenes: mapped.length,
      resolvableScenes: bgmIds.size ? mapped.filter(([, value]) => value != null).length - entries.filter(([, value]) => value != null && !bgmIds.has(typeof value === 'string' ? value : value?.id)).length : 0,
      uniqueResources: bgmIds.size,
      explicitNullSourceAbsence: explicitNull.length,
      nullScenes: explicitNull,
      nullPolicy: 'explicit source absence; not a missing reference',
    },
    sfx: {
      skillEntries: Object.keys(asObject(manifest.skills)).length,
      resourceReferences: skillSoundRefs,
      uniqueResources: skillIds.size,
      mappedSkills: Object.values(asObject(manifest.skills)).filter(value => value?.soundId || value?.soundEvents?.length).length,
    },
    source: {
      audioManifest: ctx.paths.audioSource ? ctx.rel(ctx.paths.audioSource) : null,
      sceneCatalog: ctx.paths.sceneBgmCatalog ? ctx.rel(ctx.paths.sceneBgmCatalog) : null,
      sourceResourceCount: Object.keys(sourceResources).length,
    },
    codec: { checked: codecChecked, ok: codecOk, invalid: codecInvalid, unknown: codecUnknown, policy: 'bounded header check only; no full audio decode' },
  };
}

function mapCriticalMissing(mapDoc, mapEntry) {
  const map = asObject(mapDoc?.maps?.[mapEntry.id]);
  const legacy = asObject(map.legacyManifest);
  const missing = [];
  const hasSceneId = map.sceneId != null || legacy.scene != null;
  const hasCollision = map.collisionBounds != null || (legacy.collisionBytes != null && map.paths?.['collision.bin.gz'] != null);
  const required = [
    ['sceneId', hasSceneId],
    ['paths', map.paths],
    ['models', map.models],
    ['spawn', map.spawn],
    ['collisionBounds', hasCollision],
    ['legacyManifest.scene', legacy.scene],
    ['legacyManifest.territoryId', legacy.territoryId],
    ['legacyManifest.models', legacy.models],
    ['legacyManifest.materials', legacy.materials],
  ];
  for (const [field, value] of required) {
    if (value == null || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0)) missing.push(field);
  }
  return { map, legacy, missing };
}

function mapReferencedIds(map) {
  const refs = [];
  const paths = asObject(map.paths);
  for (const [virtualPath, resourceId] of Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) refs.push({ resourceId, field: `paths.${virtualPath}` });
  for (const [index, model] of (Array.isArray(map.models) ? map.models : []).entries()) {
    refs.push({ resourceId: model?.resourceId, field: `models[${index}].resourceId` });
    for (const [materialIndex, resourceId] of (Array.isArray(model?.materialResources) ? model.materialResources : []).entries()) refs.push({ resourceId, field: `models[${index}].materialResources[${materialIndex}]` });
  }
  for (const [index, chunk] of (Array.isArray(map.collisionChunks) ? map.collisionChunks : []).entries()) refs.push({ resourceId: chunk?.resourceId, field: `collisionChunks[${index}].resourceId` });
  for (const [index, resourceId] of (Array.isArray(map.bootstrap?.resources) ? map.bootstrap.resources : []).entries()) refs.push({ resourceId, field: `bootstrap.resources[${index}]` });
  return refs;
}

async function scanMaps(ctx) {
  const catalog = asObject(ctx.catalog);
  const scenes = Array.isArray(catalog.scenes) ? [...catalog.scenes].sort((a, b) => String(a?.id || '').localeCompare(String(b?.id || ''))) : [];
  const activeScenes = asObject(ctx.active?.scenes);
  const territories = asObject(ctx.cnNames?.territories);
  const mapCatalog = asObject(ctx.mapCatalog?.maps);
  const mapPublish = ctx.mapPublish;
  const mapDir = ctx.paths.mapDir;
  const summary = {
    importedCatalogScenes: scenes.length,
    activeImportedScenes: Object.keys(activeScenes).length,
    chineseNames: 0,
    staticManifestReferences: Object.keys(mapCatalog).length,
    staticResolvable: 0,
    criticalMetadataMissing: 0,
    parsedManifestCount: 0,
    mapResourceCounts: { resources: 0, models: 0, materials: 0, textures: 0, collisionChunks: 0 },
    mapsWithErrors: 0,
    positionStatus: null,
  };
  if (!ctx.paths.catalog) ctx.addWarning({ kind: 'world_catalog_unavailable', source: 'world-catalog.json', recommendation: 'Provide the imported world catalog to measure map coverage.' });
  if (!ctx.paths.mapCatalog) ctx.addWarning({ kind: 'packed_map_catalog_unavailable', source: 'packed-all-final', recommendation: 'Provide the existing packed-all-final catalog to measure static map references.' });
  const mapPublishEntries = new Set((Array.isArray(mapPublish?.files) ? mapPublish.files : []).map(item => normaliseSlashes(item?.path)).filter(Boolean));
  for (const scene of scenes) {
    const id = String(scene?.id || '');
    if (!id) continue;
    const territory = territories[String(scene.territoryId)] || territories[scene.territoryId];
    if (territory?.name) summary.chineseNames += 1;
    const ref = mapCatalog[id];
    const result = {
      id,
      name: scene.name || null,
      manifest: ref?.manifest || null,
      parsed: false,
      staticResolvable: false,
      criticalMetadataMissing: [],
      references: 0,
      resourceCount: 0,
    };
    if (!ref?.manifest || !mapDir) {
      ctx.addMissing({ kind: 'missing_map_manifest', resource: ref?.manifest || id, source: ctx.rel(ctx.paths.mapCatalog) || 'packed-all-final/catalog', map: id, recommendation: 'Publish the map manifest listed by the packed map catalog.' });
      ctx.mapResults.push(result);
      summary.mapsWithErrors += 1;
      continue;
    }
    const manifestFile = resolveSafe(mapDir, ref.manifest);
    if (!manifestFile || !(await exists(manifestFile))) {
      ctx.addMissing({ kind: 'missing_map_manifest', resource: ref.manifest, source: ctx.rel(ctx.paths.mapCatalog), map: id, recommendation: 'Restore the gzip map manifest listed by the packed map catalog.' });
      ctx.mapResults.push(result);
      summary.mapsWithErrors += 1;
      continue;
    }
    if (mapPublishEntries.size && !mapPublishEntries.has(normaliseSlashes(ref.manifest))) {
      ctx.addWarning({ kind: 'map_manifest_not_listed_in_publish_manifest', resource: ref.manifest, source: ctx.rel(ctx.paths.mapPublish), map: id, recommendation: 'Regenerate publish-manifest.json so every map manifest is delivered.' });
    }
    const mapDoc = await loadGzipOptional(manifestFile, ctx, 'map_manifest', id);
    if (!mapDoc) {
      ctx.mapResults.push(result);
      summary.mapsWithErrors += 1;
      continue;
    }
    const mapData = asObject(mapDoc.maps?.[id]);
    result.parsed = Boolean(mapDoc.maps?.[id]);
    if (!result.parsed) {
      ctx.addInvalid({ kind: 'map_manifest_scene_mismatch', resource: ref.manifest, source: ctx.rel(manifestFile), map: id, recommendation: 'Regenerate the map manifest with the catalog scene ID as its map key.' });
      ctx.mapResults.push(result);
      summary.mapsWithErrors += 1;
      continue;
    }
    summary.parsedManifestCount += 1;
    const critical = mapCriticalMissing(mapDoc, { id });
    result.criticalMetadataMissing = critical.missing;
    if (critical.missing.length) {
      summary.criticalMetadataMissing += 1;
      ctx.addWarning({ kind: 'map_critical_metadata_missing', resource: id, source: ctx.rel(manifestFile), map: id, recommendation: 'Keep critical scene metadata present in the imported map manifest.', detail: { fields: critical.missing } });
    }
    const refs = mapReferencedIds(mapData);
    result.references = refs.length;
    const beforeErrors = ctx.issues.missingAssets.length + ctx.issues.invalidMappings.length;
    for (const refItem of refs) {
      const resolved = await resolveResourceRef(ctx, mapDoc, refItem.resourceId, {
        source: ctx.rel(manifestFile), map: id, kind: 'missing_map_resource_reference', resource: refItem.resourceId,
        recommendation: `Import the map resource referenced by ${refItem.field}.`,
      });
      if (!resolved) continue;
      result.resourceCount += 1;
      if (refItem.field.startsWith('models[')) summary.mapResourceCounts.models += 1;
      else if (refItem.field.startsWith('collisionChunks[')) summary.mapResourceCounts.collisionChunks += 1;
    }
    const validation = await validateResourceManifest(ctx, mapDoc, mapDir, ctx.rel(manifestFile), id, mapPublish);
    result.resourceCount = Math.max(result.resourceCount, validation.resourceCount);
    summary.mapResourceCounts.resources += validation.resourceCount;
    const types = countBy(Object.values(asObject(mapDoc.resources)), value => String(value?.type || 'unknown'));
    summary.mapResourceCounts.materials += types.material || 0;
    summary.mapResourceCounts.textures += types.texture || 0;
    const afterErrors = ctx.issues.missingAssets.length + ctx.issues.invalidMappings.length;
    result.staticResolvable = Boolean(!critical.missing.length && afterErrors === beforeErrors);
    if (result.staticResolvable) summary.staticResolvable += 1;
    else summary.mapsWithErrors += 1;
    ctx.mapResults.push(result);
  }
  // Imported active scenes not present in the catalog are a provenance mismatch,
  // not a reason to pretend the client game has been exhaustively scanned.
  for (const id of Object.keys(activeScenes).sort()) if (!scenes.some(scene => String(scene.id) === id)) {
    ctx.addWarning({ kind: 'active_scene_not_in_catalog', resource: id, source: ctx.rel(ctx.paths.active), map: id, recommendation: 'Reconcile active.json with the imported world catalog before claiming catalog coverage.' });
  }
  summary.positionStatus = await scanPositionReport(ctx, summary);
  return summary;
}

async function scanPositionReport(ctx, mapSummary) {
  const file = ctx.paths.positionReport;
  if (!file || !(await exists(file))) {
    return { status: 'not_run', report: null, anomalyCount: null, reason: 'report-not-found' };
  }
  let report;
  try { report = await readJson(file); } catch (error) {
    return { status: 'unverified', report: { path: ctx.rel(file) }, anomalyCount: null, reason: `invalid-report:${error.message}` };
  }
  const stat = await statIfExists(file);
  const inputFiles = [ctx.paths.catalog, ctx.paths.active, ctx.paths.mapPublish].filter(Boolean);
  const inputTimes = await Promise.all(inputFiles.map(async item => (await statIfExists(item))?.mtimeMs || 0));
  const stale = Boolean(stat && Math.max(...inputTimes, 0) > stat.mtimeMs + 1000);
  const provenance = {
    sourceRoot: report.sourceRoot || null,
    runtimeRoot: report.runtimeRoot || null,
    independentReference: report.independentReference === true,
    checkedMaps: number(report.checkedMaps, 0),
    totalMaps: number(report.totalMaps, 0),
    mtime: stat?.mtime?.toISOString?.() || null,
  };
  const structurallyValid = report.schemaVersion === 1 && report.requested === 'all' && provenance.independentReference && provenance.checkedMaps > 0;
  const status = structurallyValid && !stale ? (String(report.status).toLowerCase() === 'pass' ? 'verified' : 'verified_with_anomalies') : (stale ? 'unverified' : 'unverified');
  const reportMaps = Array.isArray(report.maps) ? report.maps : [];
  for (const item of reportMaps) {
    if (!item || String(item.status).toLowerCase() === 'pass') continue;
    const id = item.scene || item.id || item.map || null;
    ctx.addPosition({ kind: 'map_position_outlier', resource: id, source: ctx.rel(file), map: id, recommendation: 'Review the existing map-position checker result; do not infer a zero-anomaly result when the report is stale or unverified.', detail: { status: item.status || 'unknown', reasons: item.reasons || item.errors || null } });
  }
  return {
    status,
    report: { path: ctx.rel(file), sourceRoot: provenance.sourceRoot, runtimeRoot: provenance.runtimeRoot, independentReference: provenance.independentReference, checkedMaps: provenance.checkedMaps, totalMaps: provenance.totalMaps, reportStatus: report.status || null, mtime: provenance.mtime, stale },
    anomalyCount: number(report.anomalyCount, reportMaps.filter(item => String(item?.status).toLowerCase() !== 'pass').length),
    reason: stale ? 'report-older-than-input' : structurallyValid ? null : 'missing-provenance',
  };
}

async function loadRuntimeEvidence(ctx) {
  const file = ctx.paths.runtimeSmoke;
  if (!file || !(await exists(file))) return { status: 'not_run', path: file ? ctx.rel(file) : null, reason: 'smoke-report-not-found' };
  let report;
  try { report = await readJson(file); } catch (error) {
    return { status: 'unverified', path: ctx.rel(file), reason: `invalid-report:${error.message}` };
  }
  const status = String(report.status || report.result?.status || '').toLowerCase();
  const testedAt = firstDefined(report.testedAt, report.generatedAt, report.startedAt, report.completedAt);
  const smokeStatus = status === 'pass' || status === 'passed' ? 'pass' : status === 'fail' || status === 'failed' ? 'fail' : 'reported';
  return {
    status: smokeStatus,
    path: ctx.rel(file),
    testedAt: testedAt || null,
    fingerprint: report.fingerprint || report.artifactFingerprint || null,
    scope: report.scope || report.plan?.scope || null,
    freshness: testedAt ? 'reported; fingerprint freshness is not inferred' : 'unknown',
    note: 'This is optional evidence for a proven runtime smoke; static manifest references remain a separate count.',
  };
}

function anomalyPayload(category, items, extra = {}) {
  const sorted = sortIssues(items);
  const errors = sorted.filter(item => item.severity === 'error').length;
  const warnings = sorted.filter(item => item.severity === 'warning').length;
  return {
    schemaVersion: 1,
    category,
    status: errors ? 'error' : warnings ? 'warning' : 'ok',
    count: sorted.length,
    errors,
    warnings,
    items: sorted,
    ...extra,
  };
}

function compactScope(ctx, paths, durationMs, startedAt, fixtureName = null) {
  return {
    root: relativePath(process.cwd(), ctx.root),
    generatedAt: startedAt,
    durationMs,
    fixture: fixtureName,
    sources: Object.fromEntries(Object.entries(paths).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, ctx.rel(value)])),
    policy: {
      importedAndParsedOnly: true,
      fullClientGameTotalNotClaimed: true,
      glbImagesDecoded: false,
      audioFullyDecoded: false,
      browserSmokeExecuted: false,
    },
  };
}

async function writeDiagnostics(ctx, summary, startedAt, durationMs) {
  const files = {
    summary: 'summary.json',
    missingAssets: 'missing_assets.json',
    invalidMappings: 'invalid_mappings.json',
    positionOutliers: 'position_outliers.json',
    animationGaps: 'animation_gaps.json',
    mountGaps: 'mount_gaps.json',
    audioGaps: 'audio_gaps.json',
  };
  const diagnostics = {
    missingAssets: anomalyPayload('missing_assets', ctx.issues.missingAssets),
    invalidMappings: anomalyPayload('invalid_mappings', ctx.issues.invalidMappings),
    positionOutliers: anomalyPayload('position_outliers', ctx.issues.positionOutliers, { positionStatus: summary.maps?.positionStatus || null }),
    animationGaps: anomalyPayload('animation_gaps', ctx.issues.animationGaps),
    mountGaps: anomalyPayload('mount_gaps', ctx.issues.mountGaps),
    audioGaps: anomalyPayload('audio_gaps', ctx.issues.audioGaps),
  };
  summary.diagnostics = {
    directory: ctx.rel(ctx.out),
    files,
    errors: Object.values(diagnostics).reduce((total, value) => total + value.errors, 0),
    warnings: Object.values(diagnostics).reduce((total, value) => total + value.warnings, 0) + ctx.issues.warnings.length,
    issueCounts: Object.fromEntries(Object.entries(diagnostics).map(([key, value]) => [key, value.count])),
  };
  summary.warnings = sortIssues(ctx.issues.warnings);
  summary.status = summary.diagnostics.errors ? 'fail' : 'pass';
  summary.generatedAt = startedAt;
  summary.durationMs = durationMs;
  await writeJson(path.join(ctx.out, files.missingAssets), diagnostics.missingAssets);
  await writeJson(path.join(ctx.out, files.invalidMappings), diagnostics.invalidMappings);
  await writeJson(path.join(ctx.out, files.positionOutliers), diagnostics.positionOutliers);
  await writeJson(path.join(ctx.out, files.animationGaps), diagnostics.animationGaps);
  await writeJson(path.join(ctx.out, files.mountGaps), diagnostics.mountGaps);
  await writeJson(path.join(ctx.out, files.audioGaps), diagnostics.audioGaps);
  await writeJson(path.join(ctx.out, files.summary), summary);
  return diagnostics;
}

function consoleSummary(summary, ctx, examples = 0) {
  const lines = [
    `Content coverage: ${String(summary.status).toUpperCase()}`,
    `Scope: ${summary.scope?.root || '.'} | duration ${summary.durationMs}ms | imported/parsed only`,
    `Maps: catalog=${summary.maps?.importedCatalogScenes ?? 0} CN=${summary.maps?.chineseNames ?? 0} staticRefs=${summary.maps?.staticManifestReferences ?? 0} staticResolvable=${summary.maps?.staticResolvable ?? 0} criticalMetadataMissing=${summary.maps?.criticalMetadataMissing ?? 0}`,
    `Character: imported=${summary.characters?.imported ?? 0} parsed=${summary.characters?.parsed ?? 0} model=${summary.characters?.model?.resolvable ?? 0} appearance=${summary.characters?.appearance?.mapped ?? 0}`,
    `Animation: resources=${summary.animations?.importedAnimationResources ?? 0} parsed=${summary.animations?.parsedAnimationResources ?? 0} boundStates=${summary.animations?.boundStates ?? 0} unbound=${summary.animations?.unboundResources?.length ?? 0}`,
    `Skill: combatDefs=${summary.animations?.skill?.runtimeCombatActionDefinitions ?? 0} sourceDefs=${summary.animations?.skill?.extractedSourceActionDefinitions ?? 0} presentations=${summary.animations?.skill?.knownPresentations ?? 0} expectedGaps=${summary.animations?.skill?.expectedCoverageGaps ?? 0}`,
    `Mount: total=${summary.mounts?.total ?? 0} metadata=${summary.mounts?.metadataResolvable ?? 0} modelOK=${summary.mounts?.modelResolvable ?? 0} skeletonOK=${summary.mounts?.skeletonResolvable ?? 0} animationRefsOK=${summary.mounts?.animationResolvable ?? 0}`,
    `Audio: BGM=${summary.audio?.bgm?.sceneEntries ?? 0} mapped=${summary.audio?.bgm?.mappedScenes ?? 0} explicitNull=${summary.audio?.bgm?.explicitNullSourceAbsence ?? 0} SFX=${summary.audio?.sfx?.uniqueResources ?? 0} codec=${summary.audio?.codec?.ok ?? 0}/${summary.audio?.codec?.checked ?? 0}`,
    `Runtime evidence: smoke=${summary.runtime?.provenRuntimeSmoke?.status || 'not_run'} | position=${summary.maps?.positionStatus?.status || 'not_run'}`,
    `Diagnostics: ${ctx.rel(ctx.out)} | errors=${summary.diagnostics?.errors ?? 0} warnings=${summary.diagnostics?.warnings ?? 0}`,
  ];
  const cap = Math.min(20, Math.max(0, number(examples, 0)));
  if (cap > 0) {
    const all = sortIssues([
      ...ctx.issues.missingAssets,
      ...ctx.issues.invalidMappings,
      ...ctx.issues.mountGaps,
      ...ctx.issues.audioGaps,
      ...ctx.issues.positionOutliers,
      ...ctx.issues.animationGaps,
    ]).slice(0, cap);
    lines.push(`Anomaly examples (${all.length}/${ctx.issues.missingAssets.length + ctx.issues.invalidMappings.length + ctx.issues.mountGaps.length + ctx.issues.audioGaps.length + ctx.issues.positionOutliers.length + ctx.issues.animationGaps.length}):`);
    for (const item of all) lines.push(`- [${item.severity}] ${item.kind} resource=${item.resource || '-'} map=${item.map || '-'} source=${item.source || '-'}`);
  }
  console.log(lines.join('\n'));
}

async function createSmokeFixture(baseRoot, name) {
  const fixtureName = String(name || '').toLowerCase();
  if (!['missasset', 'invalidref', 'expectedgaps'].includes(fixtureName)) throw usageError(`Unknown fixture: ${name}`);
  const fixtureRoot = path.join(baseRoot, 'work/diagnostics/content-coverage-fixtures', fixtureName);
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(fixtureRoot, 'audio'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    resources: {},
    aliases: {},
    bundles: {},
    characters: {},
    mounts: {},
    sceneBgm: {},
    skills: {},
  };
  if (fixtureName === 'missasset') {
    manifest.characters['fixture-character'] = {
      id: 'fixture-character',
      model: 'glb:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      animations: {},
      appearance: { modelFamily: 'fixture' },
    };
  } else if (fixtureName === 'invalidref') {
    manifest.resources['glb:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] = {
      type: 'glb', hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', size: 16,
      dependencies: ['glb:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'],
      bundle: 'pack:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', offset: 32, length: 8,
    };
    manifest.aliases['fixture-alias'] = 'glb:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  }
  await fs.writeFile(path.join(fixtureRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(fixtureRoot, 'publish-manifest.json'), `${JSON.stringify({ schemaVersion: 1, releaseId: `fixture-${fixtureName}`, entry: 'manifest.json', files: [{ path: 'manifest.json', size: 0, hash: 'fixture' }] }, null, 2)}\n`, 'utf8');
  if (fixtureName === 'expectedgaps') {
    await fs.writeFile(path.join(fixtureRoot, 'audio/action-source-manifest.json'), `${JSON.stringify({ SchemaVersion: 1, Actions: [{ SkillId: 1, Name: 'fixture-one' }, { SkillId: 2, Name: 'fixture-two' }] }, null, 2)}\n`, 'utf8');
  }
  return fixtureRoot;
}

async function runScan({ root, out, args, fixtureName = null }) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const paths = await discoverPaths(root, args);
  const ctx = new CoverageContext({ root, out, paths });
  ctx.sandboxManifest = await loadOptional(paths.sandboxManifest, ctx, 'sandbox_manifest', { required: true });
  ctx.sandboxPublish = await loadOptional(paths.sandboxPublish, ctx, 'sandbox_publish_manifest');
  ctx.active = await loadOptional(paths.active, ctx, 'active_scene_manifest');
  ctx.catalog = await loadOptional(paths.catalog, ctx, 'world_catalog');
  ctx.cnNames = await loadOptional(paths.cnNames, ctx, 'chinese_scene_names');
  ctx.mapCatalog = await loadOptional(paths.mapCatalog, ctx, 'packed_map_catalog');
  ctx.mapPublish = await loadOptional(paths.mapPublish, ctx, 'packed_map_publish_manifest');
  ctx.sourceActions = await loadOptional(paths.actionSource, ctx, 'action_source_manifest');
  ctx.combatActions = await loadCombatActions(ctx);

  const manifest = ctx.sandboxManifest || { resources: {}, aliases: {}, bundles: {}, characters: {}, mounts: {}, sceneBgm: {}, skills: {} };
  const sandboxValidation = await validateResourceManifest(ctx, manifest, paths.sandboxRoot || root, ctx.rel(paths.sandboxManifest) || 'sandbox/manifest.json', null, ctx.sandboxPublish);
  const characters = await scanCharacters(ctx, manifest);
  const mounts = await scanMounts(ctx, manifest);
  const animations = await scanAnimationsAndSkills(ctx, manifest, characters, mounts);
  const audio = await scanAudio(ctx, manifest);
  const maps = await scanMaps(ctx);
  ctx.runtimeSmoke = await loadRuntimeEvidence(ctx);
  if (fixtureName === 'expectedgaps') {
    ctx.addAnimationGap({ kind: 'fixture_expected_coverage_gap', resource: 'fixture-action-2', source: ctx.rel(paths.actionSource) || 'fixture/action-source-manifest.json', map: null, recommendation: 'Expected fixture warning; do not treat an unmapped source action as a broken runtime reference.' });
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  const summary = {
    schemaVersion: 1,
    scope: compactScope(ctx, paths, durationMs, startedAt, fixtureName),
    sources: {
      sandboxManifest: paths.sandboxManifest ? ctx.rel(paths.sandboxManifest) : null,
      sandboxPublishManifest: paths.sandboxPublish ? ctx.rel(paths.sandboxPublish) : null,
      worldCatalog: paths.catalog ? ctx.rel(paths.catalog) : null,
      chineseSceneNames: paths.cnNames ? ctx.rel(paths.cnNames) : null,
      activeScenes: paths.active ? ctx.rel(paths.active) : null,
      packedMapCatalog: paths.mapCatalog ? ctx.rel(paths.mapCatalog) : null,
      packedMapPublishManifest: paths.mapPublish ? ctx.rel(paths.mapPublish) : null,
      actionSourceManifest: paths.actionSource ? ctx.rel(paths.actionSource) : null,
    },
    sandbox: {
      resources: Object.keys(asObject(manifest.resources)).length,
      resourceTypes: countBy(Object.values(asObject(manifest.resources)), value => String(value?.type || 'unknown')),
      bundles: Object.keys(asObject(manifest.bundles)).length,
      aliases: Object.keys(asObject(manifest.aliases)).length,
      staticResourceValidation: sandboxValidation,
    },
    maps,
    characters,
    animations,
    mounts,
    audio,
    runtime: {
      staticManifestReferences: {
        sandboxResources: Object.keys(asObject(manifest.resources)).length,
        packedMapManifests: maps.staticManifestReferences,
        parsedMapManifests: maps.parsedManifestCount,
        staticResolvableMaps: maps.staticResolvable,
      },
      provenRuntimeSmoke: ctx.runtimeSmoke,
      policy: 'Static references do not claim runtime load success; only an optional dated smoke report can provide that evidence.',
    },
  };
  await writeDiagnostics(ctx, summary, startedAt, durationMs);
  return { ctx, summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const baseRoot = path.resolve(args.dir || process.cwd());
  const fixtureName = args.fixture || args['smoke-fixture'] || null;
  const scanRoot = fixtureName ? await createSmokeFixture(baseRoot, fixtureName) : baseRoot;
  const out = path.resolve(args.out || (fixtureName ? path.join(baseRoot, 'work/diagnostics/content-coverage', fixtureName) : DEFAULT_OUT));
  const { ctx, summary } = await runScan({ root: scanRoot, out, args, fixtureName });
  consoleSummary(summary, ctx, args['console-examples'] || 0);
  return summary.status === 'fail' ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error.code === 'USAGE') {
    console.error(`Error: ${error.message}\n\n${HELP}`);
  } else {
    console.error(`Content coverage scanner failed: ${error.stack || error.message}`);
  }
  process.exitCode = 2;
}
