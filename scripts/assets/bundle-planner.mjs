import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAGIC = Buffer.from('AETHPAK1');
const ALIGNMENT = 8;
const DEFAULT_TARGET_BYTES = 8 * 1024 * 1024;
const root = process.cwd();
const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const usage = `Usage: node scripts/assets/bundle-planner.mjs [options]

Options:
  --analysis <file>       Reference analysis JSON
                           (default: work/asset-performance/reference-analysis/reference-analysis.json)
  --out <directory>       Pack release directory (default: work/asset-performance/packed)
  --reuse-from <directory> Reuse byte-identical packs from an existing release via hard links
  --target-bytes <bytes>  Raw pack target, default 8388608 (8 MiB)
  --bootstrap-radius <n>  Runtime-aligned horizontal geometry radius (default: 35)
`;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const align = value => Math.ceil(value / ALIGNMENT) * ALIGNMENT;
const contentType = file => {
  switch (path.extname(file).toLowerCase()) {
    case '.webp': return 'image/webp';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.glb': return 'model/gltf-binary';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
};
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));
async function readAnalysis(file) {
  const index = await readJson(file);
  if (index.format !== 'asset-reference-shards-v1') return index;
  const directory = path.dirname(file);
  const resources = {};
  for (const shard of index.resourceShards) Object.assign(resources, await readJson(path.join(directory, shard)));
  const maps = {};
  for (const [sceneId, shard] of Object.entries(index.maps)) maps[sceneId] = await readJson(path.join(directory, shard));
  return { schemaVersion: index.schemaVersion, input: index.input, stats: index.stats, resources, maps, reuse: { resources: await readJson(path.join(directory, index.reuse)) } };
}
const writeJson = async (file, value) => fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const hashFile = async file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const stream = fs.createReadStream(file);
  stream.on('data', chunk => { hash.update(chunk); size += chunk.length; });
  stream.on('error', reject);
  stream.on('end', () => resolve({ hash: hash.digest('hex'), size }));
});
async function copyToHandle(source, handle, position, expectedHash) {
  let offset = position;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(source)) {
    hash.update(chunk);
    const { bytesWritten } = await handle.write(chunk, 0, chunk.length, offset);
    if (bytesWritten !== chunk.length) throw new Error(`Short write while packing ${source}`);
    offset += bytesWritten;
  }
  if (hash.digest('hex') !== expectedHash) throw new Error(`Source SHA verification failed for ${source}`);
  return offset;
}
async function verifyBundle(file, bundle, entries) {
  const whole = crypto.createHash('sha256');
  const states = entries.sort((a, b) => a.offset - b.offset).map(entry => ({ ...entry, hash: crypto.createHash('sha256'), seen: 0 }));
  let absolute = 0, current = 0;
  for await (const chunk of fs.createReadStream(file)) {
    whole.update(chunk);
    let local = 0;
    while (local < chunk.length) {
      const state = states[current];
      const nextStart = state ? state.offset : Infinity;
      const nextEnd = state ? state.offset + state.length : Infinity;
      const position = absolute + local;
      if (position < nextStart) { local += Math.min(chunk.length - local, nextStart - position); continue; }
      if (position >= nextEnd) { current++; continue; }
      const length = Math.min(chunk.length - local, nextEnd - position);
      state.hash.update(chunk.subarray(local, local + length)); state.seen += length; local += length;
    }
    absolute += chunk.length;
  }
  if (absolute !== bundle.size || whole.digest('hex') !== bundle.hash) throw new Error(`Bundle SHA verification failed for ${bundle.url}`);
  for (const state of states) if (state.seen !== state.length || state.hash.digest('hex') !== state.hashExpected) throw new Error(`Packed SHA verification failed for ${state.resourceId}`);
}

const analysisPath = path.resolve(root, option('analysis') || 'work/asset-performance/reference-analysis/reference-analysis.json');
const outRoot = path.resolve(root, option('out') || 'work/asset-performance/packed');
const reuseFromRoot = option('reuse-from') && path.resolve(root, option('reuse-from'));
const targetBytes = Number(option('target-bytes') || DEFAULT_TARGET_BYTES);
const bootstrapRadius = Number(option('bootstrap-radius') || 35);
if (!Number.isInteger(targetBytes) || targetBytes < ALIGNMENT) throw new Error('--target-bytes must be an integer of at least 8');
if (!Number.isFinite(bootstrapRadius) || bootstrapRadius < 0) throw new Error('--bootstrap-radius must be non-negative');
const analysis = await readAnalysis(analysisPath);
const analysisHash = (await hashFile(analysisPath)).hash;
if (analysis.schemaVersion !== 1) throw new Error(`Expected analysis schemaVersion 1, got ${analysis.schemaVersion}`);
await fsp.mkdir(path.join(outRoot, 'packs'), { recursive: true });
async function readPreviousRelease(releaseRoot) {
  try {
    const published = await readJson(path.join(releaseRoot, 'publish-manifest.json'));
    const entry = await readJson(path.join(releaseRoot, published.entry));
    if (entry.resources && entry.bundles) return { root: releaseRoot, entry };
    if (!entry.maps) return null;
    // Catalog releases intentionally keep the common catalog small.  Rebuild only the
    // placement index here, so reuse does not retain the much larger map metadata.
    const compact = { resources: {}, bundles: {} };
    for (const item of Object.values(entry.maps)) {
      const mapManifest = await readJson(path.join(releaseRoot, item.manifest));
      for (const [id, resource] of Object.entries(mapManifest.resources || {})) if (resource.bundle) {
        compact.resources[id] = { bundle: resource.bundle, offset: resource.offset, length: resource.length };
      }
      Object.assign(compact.bundles, mapManifest.bundles || {});
    }
    return { root: releaseRoot, entry: compact };
  } catch {
    return null;
  }
}
const previousReleases = [];
for (const candidate of [...new Set([outRoot, reuseFromRoot].filter(Boolean))]) {
  const release = await readPreviousRelease(candidate);
  if (release) previousReleases.push(release);
}

const sceneIdsByResource = new Map();
for (const [sceneId, map] of Object.entries(analysis.maps)) for (const resourceId of map.resources || []) {
  const scenes = sceneIdsByResource.get(resourceId) || new Set();
  scenes.add(sceneId);
  sceneIdsByResource.set(resourceId, scenes);
}
const mapImageIds = new Set();
const legacyManifests = {};
for (const [sceneId, map] of Object.entries(analysis.maps)) {
  const legacy = await readJson(map.legacyManifest.sourceFile);
  legacyManifests[sceneId] = legacy;
  if (legacy.mapTexture && map.paths?.[legacy.mapTexture]) mapImageIds.add(map.paths[legacy.mapTexture]);
}

const intersectsBootstrap = (bounds, point) => bounds && point &&
  bounds.min[0] <= point[0] + bootstrapRadius && bounds.max[0] >= point[0] - bootstrapRadius &&
  bounds.min[2] <= point[2] + bootstrapRadius && bounds.max[2] >= point[2] - bootstrapRadius &&
  bounds.min[1] <= point[1] + 80 && bounds.max[1] >= point[1] - 80;
for (const map of Object.values(analysis.maps)) {
  const point = map.spawn?.point;
  const modelIndices = point ? map.models.filter(model => model.instanceBounds.some(bounds => intersectsBootstrap(bounds, point))).map(model => model.index) : map.bootstrap.modelIndices;
  const resourceIds = new Set();
  for (const model of map.models.filter(model => modelIndices.includes(model.index))) {
    resourceIds.add(model.glbResourceId);
    for (const materialId of model.materialResources) {
      resourceIds.add(materialId);
      for (const dependency of analysis.resources[materialId]?.dependencies || []) resourceIds.add(dependency);
    }
  }
  map.bootstrap = {
    ...map.bootstrap,
    modelIndices,
    modelOwnerIds: modelIndices.map(index => map.models[index]?.ownerId).filter(Boolean),
    resources: [...resourceIds].sort(),
    resourceBytes: [...resourceIds].reduce((sum, id) => sum + (analysis.resources[id]?.sizeBytes || 0), 0),
  };
}

// A resource can be shared by multiple maps, but it is only locality-compatible
// with resources requested by precisely the same set of maps.  Bootstrap use is
// kept as a second signature: two assets with the same owners still should not be
// co-packed when only one is needed during first render.  This deliberately leaves
// small packs small instead of filling them with unrelated hashes.
const bootstrapSceneIdsByResource = new Map();
for (const [sceneId, map] of Object.entries(analysis.maps)) for (const resourceId of map.bootstrap?.resources || []) {
  const scenes = bootstrapSceneIdsByResource.get(resourceId) || new Set();
  scenes.add(sceneId);
  bootstrapSceneIdsByResource.set(resourceId, scenes);
}
const sceneSignature = scenes => {
  const ids = [...scenes].sort();
  return ids.length ? `${ids.length}-${sha256(ids.join(',' )).slice(0, 16)}` : '0-none';
};

const resourceModels = new Map();
for (const [sceneId, map] of Object.entries(analysis.maps)) for (const model of map.models || []) {
  for (const resourceId of [model.glbResourceId, ...(model.materialResources || [])]) {
    const models = resourceModels.get(resourceId) || [];
    models.push({ sceneId, model });
    resourceModels.set(resourceId, models);
  }
}
for (const resource of Object.values(analysis.resources)) if (resource.type === 'material') {
  for (const dependency of resource.dependencies || []) {
    const models = resourceModels.get(resource.id) || [];
    const targets = resourceModels.get(dependency) || [];
    targets.push(...models);
    resourceModels.set(dependency, targets);
  }
}

function centroid(bounds) {
  if (!bounds?.min || !bounds?.max) return null;
  return bounds.min.map((value, index) => (value + bounds.max[index]) / 2);
}
function groupFor(resourceId, resource) {
  const scenes = sceneIdsByResource.get(resourceId) || new Set();
  const storageType = mapImageIds.has(resourceId) ? 'map-image' : resource.type;
  if (scenes.size >= 2) {
    const bootstrapScenes = bootstrapSceneIdsByResource.get(resourceId) || new Set();
    return `shared:${storageType}:owners-${sceneSignature(scenes)}:bootstrap-${sceneSignature(bootstrapScenes)}`;
  }
  const sceneId = [...scenes][0];
  // Orphans have no map request set to establish locality.  Isolate each rather
  // than reintroducing arbitrary cross-world mixing through a catch-all group.
  if (!sceneId) return `orphan:${storageType}:${sha256(resourceId).slice(0, 16)}`;
  const map = analysis.maps[sceneId];
  if (resource.type === 'collision') return `map:${sceneId}:collision`;
  if (map.bootstrap?.resources?.includes(resourceId)) {
    const phase = resource.type === 'glb' ? 'bootstrap-geometry' : 'bootstrap-textures';
    return `map:${sceneId}:${phase}`;
  }
  const instances = resourceModels.get(resourceId) || [];
  const model = instances.find(entry => entry.sceneId === sceneId)?.model;
  const center = centroid(model?.bounds);
  const spawn = map.spawn?.point;
  if (center && spawn) {
    const horizontal = Math.abs(center[0] - spawn[0]) >= Math.abs(center[2] - spawn[2]);
    const direction = horizontal ? (center[0] >= spawn[0] ? 'east' : 'west') : (center[2] >= spawn[2] ? 'south' : 'north');
    return `map:${sceneId}:outside-${direction}:${storageType}`;
  }
  return `map:${sceneId}:core:${storageType}`;
}

const binaryResources = Object.values(analysis.resources)
  .filter(resource => resource.type !== 'material')
  .sort((left, right) => left.id.localeCompare(right.id));
const sourceFor = resource => {
  const source = resource.sources?.[0];
  if (!source || !fs.existsSync(source)) throw new Error(`${resource.id} has no readable analysis source`);
  return source;
};
for (const resource of binaryResources) {
  const source = sourceFor(resource);
  const stat = await fsp.stat(source);
  if (stat.size !== resource.sizeBytes) throw new Error(`${resource.id} source length changed`);
}

const groups = new Map();
for (const resource of binaryResources) {
  const group = groupFor(resource.id, resource);
  const entries = groups.get(group) || [];
  entries.push(resource);
  groups.set(group, entries);
}

const plannedPacks = [];
for (const [group, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  let current = [];
  let currentBytes = MAGIC.length;
  const flush = () => {
    if (current.length) plannedPacks.push({ group, entries: current });
    current = []; currentBytes = MAGIC.length;
  };
  for (const resource of entries.sort((a, b) => a.id.localeCompare(b.id))) {
    const nextBytes = align(currentBytes) + resource.sizeBytes;
    if (current.length && nextBytes > targetBytes) flush();
    current.push(resource);
    currentBytes = align(currentBytes) + resource.sizeBytes;
    if (resource.sizeBytes + MAGIC.length > targetBytes) {
      flush();
    }
  }
  flush();
}

const locations = new Map();
const bundles = {};
let oversizedPacks = 0;
let reusedPacks = 0;
const reusableFor = (entries, expectedOffsets, expectedSize) => {
  for (const release of previousReleases) {
    let bundleId = null;
    let bundle = null;
    let matches = true;
    for (let index = 0; index < entries.length; index++) {
      const previousResource = release.entry.resources?.[entries[index].id];
      const candidate = previousResource && release.entry.bundles?.[previousResource.bundle];
      if (!candidate || candidate.size !== expectedSize || previousResource.length !== entries[index].sizeBytes || previousResource.offset !== expectedOffsets[index]) {
        matches = false;
        break;
      }
      if (bundleId && bundleId !== previousResource.bundle) { matches = false; break; }
      bundleId = previousResource.bundle;
      bundle = candidate;
    }
    if (matches && bundle && fs.existsSync(path.join(release.root, bundle.url))) return { release, bundleId, bundle };
  }
  return null;
};
for (let packIndex = 0; packIndex < plannedPacks.length; packIndex++) {
  const plan = plannedPacks[packIndex];
  let expectedPosition = MAGIC.length;
  const expectedOffsets = [];
  for (const resource of plan.entries) {
    expectedPosition = align(expectedPosition);
    expectedOffsets.push(expectedPosition);
    expectedPosition += resource.sizeBytes;
  }
  const reusable = reusableFor(plan.entries, expectedOffsets, expectedPosition);
  if (reusable) {
    const { release, bundleId, bundle } = reusable;
    const finalPath = path.join(outRoot, bundle.url);
    const sourcePath = path.join(release.root, bundle.url);
    if (path.resolve(finalPath) !== path.resolve(sourcePath) && !fs.existsSync(finalPath)) await fsp.link(sourcePath, finalPath);
    bundles[bundleId] = { ...bundle, group: plan.group, resourceCount: plan.entries.length, oversize: bundle.size > targetBytes };
    for (let index = 0; index < plan.entries.length; index++) {
      const resource = plan.entries[index];
      locations.set(resource.id, { bundle: bundleId, offset: expectedOffsets[index], length: resource.sizeBytes, group: plan.group });
    }
    if (bundle.oversize) oversizedPacks++;
    reusedPacks++;
    continue;
  }
  const temporary = path.join(outRoot, 'packs', `writing-${String(packIndex).padStart(4, '0')}.aethpak`);
  const handle = await fsp.open(temporary, 'w');
  let position = 0;
  try {
    await handle.write(MAGIC, 0, MAGIC.length, position);
    position += MAGIC.length;
    for (const resource of plan.entries) {
      const padded = align(position);
      if (padded > position) await handle.write(Buffer.alloc(padded - position), 0, padded - position, position);
      position = padded;
      const offset = position;
      position = await copyToHandle(sourceFor(resource), handle, position, resource.sha256);
      locations.set(resource.id, { temporary, offset, length: resource.sizeBytes, group: plan.group });
    }
  } finally { await handle.close(); }
  const detail = await hashFile(temporary);
  const id = `pack:sha256:${detail.hash}`;
  const name = `${detail.hash}.aethpak`;
  const finalPath = path.join(outRoot, 'packs', name);
  await fsp.rm(finalPath, { force: true });
  await fsp.rename(temporary, finalPath);
  bundles[id] = { url: `packs/${name}`, size: detail.size, hash: detail.hash, group: plan.group, resourceCount: plan.entries.length, oversize: detail.size > targetBytes };
  if (detail.size > targetBytes) oversizedPacks++;
  for (const resource of plan.entries) locations.get(resource.id).bundle = id;
}

const resources = {};
for (const [id, source] of Object.entries(analysis.resources).sort(([a], [b]) => a.localeCompare(b))) {
  const isVirtual = source.type === 'material';
  const type = mapImageIds.has(id) ? 'map-image' : source.type;
  const metadata = { ...(source.metadata || {}) };
  if (!isVirtual) metadata.mime = contentType(sourceFor(source));
  const resource = {
    type,
    hash: source.sha256,
    size: source.sizeBytes,
    dependencies: source.dependencies || [],
    virtual: isVirtual,
    metadata,
  };
  if (!isVirtual) {
    const location = locations.get(id);
    if (!location) throw new Error(`Missing pack location for ${id}`);
    resource.bundle = location.bundle;
    resource.offset = location.offset;
    resource.length = location.length;
  }
  resources[id] = resource;
}

const maps = {};
for (const [sceneId, source] of Object.entries(analysis.maps).sort(([a], [b]) => a.localeCompare(b))) {
  maps[sceneId] = {
    legacyManifest: legacyManifests[sceneId],
    paths: source.paths,
    models: source.models.map(model => ({
      index: model.index,
      id: model.ownerId,
      resourceId: model.glbResourceId,
      instanceBounds: model.instanceBounds,
      materialResources: model.materialResources,
    })),
    bootstrap: {
      modelIndices: source.bootstrap.modelIndices,
      resources: source.bootstrap.resources,
      geometryResources: source.bootstrap.resources.filter(resourceId => resources[resourceId]?.type === 'glb'),
      textureResources: source.bootstrap.resources.filter(resourceId => resources[resourceId]?.type === 'texture' || resources[resourceId]?.type === 'map-image'),
      collisionResources: source.bootstrap.resources.filter(resourceId => resources[resourceId]?.type === 'collision'),
      resourceBytes: source.bootstrap.resourceBytes,
    },
    connections: source.connections,
    spawn: source.spawn,
  };
}

const releaseId = analysis.input.runId || `graph-${sha256(JSON.stringify(analysis.input)).slice(0, 16)}`;
const commonManifest = {
  schemaVersion: 1,
  releaseId,
  sourceGraph: { schemaVersion: analysis.schemaVersion, hash: analysisHash },
  packing: { magic: 'AETHPAK1', alignment: ALIGNMENT, targetBytes, bootstrapRadius, compression: 'none', heuristic: 'Shared resources are partitioned by storage type, exact sorted owner-scene signature, and exact sorted bootstrap-use-scene signature. Small signature groups remain separate packs. Map-local bootstrap candidates are split into geometry/textures; remaining local resources are partitioned by bounds centroid relative to spawn; resource IDs are sorted stably.' },
};

const bundleEntries = new Map();
for (const [resourceId, resource] of Object.entries(resources)) if (!resource.virtual) {
  const entries = bundleEntries.get(resource.bundle) || [];
  entries.push({ resourceId, offset: resource.offset, length: resource.length, hashExpected: resource.hash });
  bundleEntries.set(resource.bundle, entries);
}
for (const [bundleId, entries] of bundleEntries) await verifyBundle(path.join(outRoot, bundles[bundleId].url), bundles[bundleId], entries);
for (const [resourceId, resource] of Object.entries(resources)) if (!resource.virtual && !resource.bundle) throw new Error(`${resourceId} is unpacked`);
if (new Set([...locations.keys()]).size !== binaryResources.length) throw new Error('A binary resource was placed more than once or omitted');

const resourceClosure = sceneId => {
  const selected = new Set(analysis.maps[sceneId].resources || []);
  const visit = id => {
    if (selected.has(id)) {
      for (const dependency of resources[id]?.dependencies || []) visit(dependency);
      return;
    }
    selected.add(id);
    for (const dependency of resources[id]?.dependencies || []) visit(dependency);
  };
  for (const model of maps[sceneId].models) {
    visit(model.resourceId);
    for (const material of model.materialResources) visit(material);
  }
  for (const resourceId of Object.values(maps[sceneId].paths)) visit(resourceId);
  return selected;
};
const mapFiles = [];
const catalogMaps = {};
const mapManifestSizes = {};
const expectedSceneIds = [...(analysis.input?.sceneIds || Object.keys(maps))].sort();
const actualSceneIds = Object.keys(maps).sort();
if (expectedSceneIds.join(',') !== actualSceneIds.join(',')) throw new Error('Map catalog scene IDs differ from the analysis input');
const connectionCount = Object.values(maps).reduce((sum, map) => sum + (map.connections || []).length, 0);
if (connectionCount !== 145) throw new Error(`Expected 145 directed map connections, got ${connectionCount}`);
for (const sceneId of Object.keys(maps).sort()) {
  const selected = resourceClosure(sceneId);
  const mapResources = Object.fromEntries([...selected].sort().map(id => [id, resources[id]]));
  const mapBundleIds = new Set(Object.values(mapResources).map(resource => resource.bundle).filter(Boolean));
  const mapBundles = Object.fromEntries([...mapBundleIds].sort().map(id => [id, bundles[id]]));
  const mapManifest = { ...commonManifest, resources: mapResources, bundles: mapBundles, maps: { [sceneId]: maps[sceneId] } };
  const text = JSON.stringify(mapManifest);
  const hash = sha256(text);
  const relativePath = `maps/${sceneId}/manifest_${hash}.json`;
  await fsp.mkdir(path.dirname(path.join(outRoot, relativePath)), { recursive: true });
  await fsp.writeFile(path.join(outRoot, relativePath), text);
  mapFiles.push({ path: relativePath, size: Buffer.byteLength(text), hash, contentType: 'application/json; charset=utf-8' });
  catalogMaps[sceneId] = { manifest: relativePath };
  mapManifestSizes[sceneId] = Buffer.byteLength(text);
}
const catalog = { schemaVersion: 1, releaseId, maps: catalogMaps };
const catalogText = JSON.stringify(catalog);
const catalogHash = sha256(catalogText);
const catalogName = `catalog_${catalogHash}.json`;
await fsp.writeFile(path.join(outRoot, catalogName), catalogText);
if (Object.keys(catalog.maps).length !== 65) throw new Error(`Expected 65 catalog maps, got ${Object.keys(catalog.maps).length}`);
const publishManifest = {
  schemaVersion: 1,
  releaseId,
  entry: catalogName,
  files: [
    ...Object.values(bundles).map(bundle => ({ path: bundle.url, size: bundle.size, hash: bundle.hash, contentType: 'application/octet-stream' })),
    ...mapFiles,
    { path: catalogName, size: Buffer.byteLength(catalogText), hash: catalogHash, contentType: 'application/json; charset=utf-8' },
  ].sort((a, b) => a.path.localeCompare(b.path)),
};
await writeJson(path.join(outRoot, 'publish-manifest.json'), publishManifest);

const bootstrapTotals = Object.fromEntries(Object.entries(maps).map(([sceneId, map]) => {
  const uniqueBytes = map.bootstrap.resources.reduce((sum, resourceId) => sum + (resources[resourceId]?.size || 0), 0);
  const fetchedBundles = new Set(map.bootstrap.resources.map(resourceId => resources[resourceId]?.bundle).filter(Boolean));
  const fetchedBytes = [...fetchedBundles].reduce((sum, bundleId) => sum + bundles[bundleId].size, 0);
  const smallBundleIds = [...fetchedBundles].filter(bundleId => bundles[bundleId].size < targetBytes);
  const firstGlbResourceId = map.bootstrap.geometryResources[0] || null;
  const glbBundleIds = new Set(map.bootstrap.geometryResources.map(resourceId => resources[resourceId]?.bundle).filter(Boolean));
  return [sceneId, {
    resourceBytes: uniqueBytes,
    fetchedPackBytes: fetchedBytes,
    overfetchBytes: fetchedBytes - uniqueBytes,
    bundleCount: fetchedBundles.size,
    smallPackRequestCount: smallBundleIds.length,
    smallPackRequestBytes: smallBundleIds.reduce((sum, bundleId) => sum + bundles[bundleId].size, 0),
    bootstrapGlbPackCount: glbBundleIds.size,
    firstGlb: firstGlbResourceId ? {
      resourceId: firstGlbResourceId,
      bundle: resources[firstGlbResourceId].bundle,
      packBytes: bundles[resources[firstGlbResourceId].bundle].size,
      group: bundles[resources[firstGlbResourceId].bundle].group,
    } : null,
  }];
}));
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = percentile => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
  return { min: sorted[0], p50: at(.5), p90: at(.9), max: sorted[sorted.length - 1] };
};
const bootstrapRows = Object.values(bootstrapTotals);
const smallPacks = Object.values(bundles).filter(bundle => bundle.size < targetBytes);
const diagnostic = {
  schemaVersion: 1,
  releaseId,
  input: path.relative(root, analysisPath).split(path.sep).join('/'),
  coverage: { catalogMaps: Object.keys(catalog.maps).length, directedConnections: connectionCount, verifiedResourceSlices: binaryResources.length },
  packing: {
    targetBytes,
    bootstrapRadius,
    packCount: Object.keys(bundles).length,
    packBytes: Object.values(bundles).reduce((sum, bundle) => sum + bundle.size, 0),
    reusedPacks,
    smallPackCount: smallPacks.length,
    smallPackBytes: smallPacks.reduce((sum, bundle) => sum + bundle.size, 0),
    groupCount: new Set(Object.values(bundles).map(bundle => bundle.group)).size,
    heuristic: commonManifest.packing.heuristic,
  },
  bootstrap: {
    actualBytes: distribution(bootstrapRows.map(row => row.resourceBytes)),
    fetchedBytes: distribution(bootstrapRows.map(row => row.fetchedPackBytes)),
    overfetchBytes: distribution(bootstrapRows.map(row => row.overfetchBytes)),
    requests: distribution(bootstrapRows.map(row => row.bundleCount)),
    smallPackRequests: distribution(bootstrapRows.map(row => row.smallPackRequestCount)),
    smallPackRequestBytes: distribution(bootstrapRows.map(row => row.smallPackRequestBytes)),
    allMaps: bootstrapTotals,
    representatives: Object.fromEntries(['gridania', 'd2t1', 'limsa', 'n4t2', 'm5t1'].filter(sceneId => bootstrapTotals[sceneId]).map(sceneId => [sceneId, bootstrapTotals[sceneId]])),
  },
};
await writeJson(path.join(outRoot, 'packing-diagnostic.json'), diagnostic);
console.log(JSON.stringify({
  out: path.relative(root, outRoot).split(path.sep).join('/'),
  entry: catalogName,
  packCount: Object.keys(bundles).length,
  packBytes: Object.values(bundles).reduce((sum, bundle) => sum + bundle.size, 0),
  oversizedPacks,
  reusedPacks,
  resourceCount: Object.keys(resources).length,
  verifiedResourceSlices: binaryResources.length,
  catalogBytes: Buffer.byteLength(catalogText),
  mapManifestBytes: mapManifestSizes,
  bootstrap: bootstrapTotals,
  diagnostic: {
    coverage: diagnostic.coverage,
    packing: diagnostic.packing,
    actualBytes: diagnostic.bootstrap.actualBytes,
    fetchedBytes: diagnostic.bootstrap.fetchedBytes,
    overfetchBytes: diagnostic.bootstrap.overfetchBytes,
    requests: diagnostic.bootstrap.requests,
    smallPackRequests: diagnostic.bootstrap.smallPackRequests,
    representatives: diagnostic.bootstrap.representatives,
  },
}, null, 2));
