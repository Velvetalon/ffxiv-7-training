import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const usage = `Usage: node scripts/assets/select-regression-maps.mjs [options]

Options:
  --changed-files <json>  JSON file containing changed path strings or {status,path,oldPath} entries
  --base <git-ref>        Read git diff --name-status from this ref through the working tree
  --graph <index>         Reference analysis JSON or sharded index
  --config <file>         Regression configuration (default config/map-regression.json)
  --baseline <file>       Explicit performance baseline path for the report consumer
  --mode <daily|runtime|release>
  --out <file>            Write selection JSON instead of stdout
  --self-test             Run deterministic selector fixtures
`;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));
const slash = value => String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
const lowered = value => slash(value).toLowerCase();
const asArray = value => Array.isArray(value) ? value : value ? [value] : [];

function parseNameStatus(bytes) {
  const fields = Buffer.from(bytes).toString('utf8').split('\0');
  const changes = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    if (/^[RC]/.test(status)) changes.push({ status: status[0], oldPath: slash(fields[index++]), path: slash(fields[index++]) });
    else changes.push({ status: status[0], path: slash(fields[index++]) });
  }
  return changes;
}
function normalizeChanges(value) {
  return asArray(value).flatMap(item => {
    if (typeof item === 'string') return [{ status: 'M', path: slash(item) }];
    if (!item || typeof item !== 'object') return [];
    const pathValue = item.path || item.file || item.newPath;
    return pathValue ? [{ status: String(item.status || 'M')[0], path: slash(pathValue), oldPath: item.oldPath ? slash(item.oldPath) : undefined }] : [];
  });
}
async function changesFromArgs() {
  const changedFile = option('changed-files');
  const base = option('base');
  if (changedFile && base) throw new Error('Use only one of --changed-files or --base');
  if (changedFile) return normalizeChanges(await readJson(path.resolve(root, changedFile)));
  if (base) {
    const tracked = parseNameStatus(execFileSync('git', ['diff', '--name-status', '-z', '--find-renames', base], { cwd: root, encoding: 'buffer' }));
    const known = new Set(tracked.flatMap(change => [change.path, change.oldPath].filter(Boolean)));
    const untracked = Buffer.from(execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer' })).toString('utf8').split('\0').filter(Boolean)
      .filter(file => !known.has(slash(file))).map(file => ({ status: 'A', path: slash(file) }));
    return [...tracked, ...untracked];
  }
  throw new Error('Provide --changed-files or --base');
}
async function readGraph(graphPath) {
  const index = await readJson(graphPath);
  if (index.format !== 'asset-reference-shards-v1') return index;
  const directory = path.dirname(graphPath);
  const resources = {};
  for (const shard of index.resourceShards || []) Object.assign(resources, await readJson(path.join(directory, shard)));
  const maps = {};
  for (const [id, shard] of Object.entries(index.maps || {})) maps[id] = await readJson(path.join(directory, shard));
  return { input: index.input, stats: index.stats, resources, maps };
}
function sourceCandidates(resource) {
  return [resource?.source, ...(resource?.sources || [])].filter(Boolean).map(lowered);
}
function buildIndex(graph, active) {
  const mapsByResource = new Map();
  const resourceBySource = new Map();
  const dependentsByResource = new Map();
  for (const [id, resource] of Object.entries(graph.resources || {})) for (const source of sourceCandidates(resource)) {
    const set = resourceBySource.get(source) || new Set(); set.add(id); resourceBySource.set(source, set);
  }
  for (const [id, resource] of Object.entries(graph.resources || {})) for (const dependency of resource.dependencies || []) {
    const dependents = dependentsByResource.get(dependency) || new Set(); dependents.add(id); dependentsByResource.set(dependency, dependents);
  }
  for (const [sceneId, map] of Object.entries(graph.maps || {})) for (const resourceId of map.resources || []) {
    const set = mapsByResource.get(resourceId) || new Set(); set.add(sceneId); mapsByResource.set(resourceId, set);
  }
  const mapPaths = new Map();
  for (const [sceneId, scene] of Object.entries(active.scenes || {})) {
    for (const base of [scene.base, `public/extracted/${scene.base || ''}`, `public/extracted/world/${scene.base || ''}`]) if (base) mapPaths.set(lowered(base), sceneId);
  }
  return { mapsByResource, resourceBySource, dependentsByResource, mapPaths };
}
function pathResources(file, resourceBySource) {
  const target = lowered(file);
  const matches = new Set();
  for (const [source, ids] of resourceBySource) if (source === target || source.endsWith(`/${target}`) || target.endsWith(`/${source}`)) for (const id of ids) matches.add(id);
  return matches;
}
function mapFromPath(file, mapPaths) {
  const target = lowered(file);
  let match = null;
  for (const [prefix, sceneId] of mapPaths) if (target.includes(prefix) && (!match || prefix.length > match.prefix.length)) match = { prefix, sceneId };
  return match?.sceneId || null;
}
function isDocsOnly(file) { return /^(docs\/|readme(?:\.md)?$|.*\.md$)/i.test(slash(file)); }
function isStrictMapMetadata(file) { return /(?:^|\/)(?:scene|manifest)\.json$/i.test(slash(file)); }
function scanCodeFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...scanCodeFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
  }
  return files;
}
function buildCodeImportGraph() {
  const files = scanCodeFiles(path.join(root, 'src'));
  const reverse = new Map();
  const known = new Set(files.map(file => lowered(path.relative(root, file))));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const importer = lowered(path.relative(root, file));
    const specs = [...source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const spec of specs) if (spec.startsWith('.')) {
      let target = lowered(path.relative(root, path.resolve(path.dirname(file), spec)));
      if (!target.endsWith('.js')) target += '.js';
      if (!known.has(target)) continue;
      const dependents = reverse.get(target) || new Set();
      dependents.add(importer); reverse.set(target, dependents);
    }
  }
  const entries = new Set(['src/main.js', 'src/world/world.js']);
  const reachesEntry = changed => {
    const pending = [changed], seen = new Set(), reached = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (entries.has(current)) reached.add(current);
      for (const dependent of reverse.get(current) || []) pending.push(dependent);
    }
    return [...reached].sort();
  };
  return { known, reachesEntry };
}
function runtimeSourceImpact(file, codeGraph) {
  const normalized = lowered(file);
  if (normalized.startsWith('src/')) {
    const reaches = codeGraph.reachesEntry(normalized);
    return { major: true, trace: reaches.length ? reaches : ['unresolved-src-change'] };
  }
  if (/^(vite\.config\.js$|package(?:-lock)?\.json$|scripts\/(serve\.mjs|asset-ticket-server\.mjs)|scripts\/assets\/)/i.test(normalized)) return { major: true, trace: ['runtime-or-pipeline-entry'] };
  return null;
}
function ownerMaps(resourceIds, index) {
  const maps = new Set(), pending = [...resourceIds], seen = new Set();
  while (pending.length) {
    const resourceId = pending.pop();
    if (seen.has(resourceId)) continue;
    seen.add(resourceId);
    for (const sceneId of index.mapsByResource.get(resourceId) || []) maps.add(sceneId);
    for (const dependent of index.dependentsByResource.get(resourceId) || []) pending.push(dependent);
  }
  return maps;
}
function select(changes, graph, active, config, mode, codeGraph = buildCodeImportGraph(), graphUnavailable = null) {
  const catalog = Object.keys(active.scenes || graph.maps || {}).sort();
  const available = new Set(catalog);
  const smokeEntries = config.smokeScenes || [];
  const missingSmoke = smokeEntries.filter(entry => !available.has(entry.id)).map(entry => entry.id);
  if (missingSmoke.length) throw new Error(`Regression smoke config references missing active maps: ${missingSmoke.join(', ')}`);
  const impact = new Set();
  const reasons = [];
  const uncertainties = [];
  let globalRuntime = false, unknown = false;
  const index = buildIndex(graph, active);
  for (const change of changes) for (const file of [change.oldPath, change.path].filter(Boolean)) {
    if (isDocsOnly(file)) { reasons.push({ path: file, kind: 'docs-only', maps: [] }); continue; }
    const runtimeImpact = runtimeSourceImpact(file, codeGraph);
    if (runtimeImpact) { globalRuntime = true; reasons.push({ path: file, kind: 'runtime-source', maps: catalog, importTrace: runtimeImpact.trace }); continue; }
    const directMap = mapFromPath(file, index.mapPaths);
    const resourceIds = pathResources(file, index.resourceBySource);
    const maps = ownerMaps(resourceIds, index);
    if (directMap && !graphUnavailable) maps.add(directMap);
    if (graphUnavailable && !(directMap && isStrictMapMetadata(file))) {
      unknown = true;
      uncertainties.push({ path: file, status: change.status, reason: 'Analysis graph is unavailable; cross-map resource reuse cannot be ruled out.' });
      reasons.push({ path: file, kind: 'graph-unavailable', maps: catalog });
    } else if (!maps.size && directMap && isStrictMapMetadata(file)) {
      maps.add(directMap);
      impact.add(directMap);
      reasons.push({ path: file, kind: 'strict-map-metadata', maps: [directMap] });
    } else if (!maps.size) {
      unknown = true;
      uncertainties.push({ path: file, status: change.status, reason: 'No active map or analyzed source resource matched this path.' });
      reasons.push({ path: file, kind: 'unknown', maps: catalog });
    } else {
      for (const sceneId of maps) impact.add(sceneId);
      reasons.push({ path: file, kind: resourceIds.size ? 'resource-source' : 'map-path', maps: [...maps].sort(), resources: [...resourceIds].sort() });
    }
  }
  if (globalRuntime || unknown) for (const sceneId of catalog) impact.add(sceneId);
  const modeConfig = config.modes?.[mode];
  if (!modeConfig) throw new Error(`Unknown regression mode: ${mode}`);
  const smoke = modeConfig.includeSmoke === false ? [] : smokeEntries.map(entry => entry.id);
  const selected = new Set([...impact, ...smoke]);
  const fullRequired = Boolean(modeConfig.fullRequired || globalRuntime || unknown);
  if (fullRequired) for (const sceneId of catalog) selected.add(sceneId);
  return {
    schemaVersion: 1,
    mode,
    activeSceneCount: catalog.length,
    changedFiles: changes,
    detectedMajor: globalRuntime,
    unknownImpact: unknown,
    graph: graphUnavailable ? { available: false, error: graphUnavailable } : { available: true },
    baseline: option('baseline') ? path.resolve(root, option('baseline')) : config.baseline?.path || null,
    impacted: [...impact].sort(),
    smoke,
    selected: [...selected].sort(),
    fullRequired,
    reasons,
    uncertainties,
    limitations: ['All src/ changes are conservatively treated as major. Import reverse tracing is diagnostic only and is not used to claim map-local source-code impact.'],
  };
}
async function selfTest() {
  const active = { scenes: { a: { base: 'world/run/a/' }, b: { base: 'world/run/b/' } } };
  const graph = { resources: { 'texture:shared': { sources: ['C:/game/shared.webp'] }, 'material:a': { dependencies: ['texture:shared'] }, 'material:b': { dependencies: ['texture:shared'] }, 'glb:a': { sources: ['C:/game/world/run/a/models/one.glb'] } }, maps: { a: { resources: ['material:a', 'glb:a'] }, b: { resources: ['material:b'] } } };
  const config = { smokeScenes: [{ id: 'a', reason: 'fixture' }], modes: { daily: { includeSmoke: true, fullRequired: false }, runtime: { includeSmoke: true, fullRequired: true }, release: { includeSmoke: true, fullRequired: true } } };
  const run = changes => select(changes, graph, active, config, 'daily', { reachesEntry: () => ['fixture-entry'] });
  const assert = (condition, message) => { if (!condition) throw new Error(`self-test: ${message}`); };
  assert(run([{ path: 'C:/game/shared.webp' }]).impacted.join(',') === 'a,b', 'reverse dependencies must propagate a shared resource to both maps');
  assert(run([{ status: 'D', path: 'C:/game/world/run/a/models/one.glb' }]).impacted.join(',') === 'a', 'deletion must map by prior path');
  assert(run([{ path: 'unknown.bin' }]).fullRequired, 'unknown path must require full coverage');
  assert(run([{ path: 'src/world/world.js' }]).fullRequired, 'global runtime source must require full coverage');
  assert(run([{ path: 'docs/guide.md' }]).impacted.length === 0 && run([{ path: 'docs/guide.md' }]).selected.join(',') === 'a', 'docs-only daily run must retain smoke only');
  assert(run([{ status: 'R', oldPath: 'C:/game/world/run/a/models/one.glb', path: 'C:/game/world/run/b/models/two.glb' }]).impacted.join(',') === 'a,b', 'rename must inspect both paths');
  console.log(JSON.stringify({ ok: true, fixtures: 6 }));
}
if (process.argv.includes('--self-test')) await selfTest();
else {
  const config = await readJson(path.resolve(root, option('config') || 'config/map-regression.json'));
  const graphPath = path.resolve(root, option('graph') || 'work/asset-performance/reference-all/shards/index.json');
  const active = await readJson(path.resolve(root, 'public/extracted/active.json'));
  let graph, graphUnavailable = null;
  try { graph = await readGraph(graphPath); }
  catch (error) { graph = { resources: {}, maps: {} }; graphUnavailable = error.message; }
  const result = select(await changesFromArgs(), graph, active, config, option('mode') || 'daily', buildCodeImportGraph(), graphUnavailable);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const out = option('out');
  if (out) { const target = path.resolve(root, out); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, text); }
  else process.stdout.write(text);
}
