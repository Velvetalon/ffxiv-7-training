import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('AETHPAK1');
const DEFAULT_THRESHOLD = 4 * 1024 * 1024;
const DEFAULT_PACK_RAW_BYTES = 1024 * 1024;
const root = process.cwd();
const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const usage = `Usage: node scripts/assets/chunk-collision.mjs --dir <packed release> --out <output directory> [options]

Options:
  --maps <ids>           Comma-separated maps or all, default x6f2
  --cache <directory>    Reuse matching per-map collision artifacts from a prior run
  --cell-size <metres>   Primary XZ centroid cell size, default 64
  --threshold <bytes>    Chunk only source gzip collisions over this size; then split a raw cell over it at 32m, default 4194304
  --tile-size <metres>   Spatial pack tile size, default 256 (four 64m cells per side)
  --pack-raw-bytes <n>   Maximum raw chunk bytes per pack within a tile, default 1048576
  --bootstrap-radius <n> Near-chunk statistic radius, default 128
  --prototype            Write only analysis patches/packs; otherwise write a complete release
`;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = async file => {
  const bytes = await fsp.readFile(file);
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
};
const writeJson = async (file, value) => fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
const gzipJson = value => zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 });
const releaseRoot = path.resolve(root, option('dir') || 'work/asset-performance/packed-all-locality');
const outRoot = path.resolve(root, option('out') || 'work/collision-analysis');
const mapIds = (option('maps') || 'x6f2').split(',').map(value => value.trim()).filter(Boolean);
const cacheRoot = option('cache') && path.resolve(root, option('cache'));
const cellSize = Number(option('cell-size') || 64);
const threshold = Number(option('threshold') || DEFAULT_THRESHOLD);
const bootstrapRadius = Number(option('bootstrap-radius') || 128);
const tileSize = Number(option('tile-size') || 256);
const packRawBytes = Number(option('pack-raw-bytes') || DEFAULT_PACK_RAW_BYTES);
const prototype = process.argv.includes('--prototype');
if (!Number.isFinite(cellSize) || cellSize <= 0 || !Number.isFinite(threshold) || threshold < 36 || !Number.isFinite(bootstrapRadius) || bootstrapRadius < 0 || !Number.isFinite(tileSize) || tileSize < cellSize || !Number.isFinite(packRawBytes) || packRawBytes < 36) throw new Error('Invalid numeric option');
const align = value => Math.ceil(value / 8) * 8;

const updateBounds = (bounds, values, index) => {
  for (const point of [index, index + 3, index + 6]) for (const axis of [0, 1, 2]) {
    const value = values[point + axis];
    if (!Number.isFinite(value)) throw new Error(`Collision contains a non-finite coordinate at float ${point + axis}`);
    bounds.min[axis] = Math.min(bounds.min[axis], value);
    bounds.max[axis] = Math.max(bounds.max[axis], value);
  }
};
const emptyBounds = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const stableCell = (size, x, z) => `${size}m_${x}_${z}`;
const circleIntersectsBounds = (bounds, point, radius) => {
  const dx = Math.max(bounds.min[0] - point[0], 0, point[0] - bounds.max[0]);
  const dz = Math.max(bounds.min[2] - point[2], 0, point[2] - bounds.max[2]);
  return dx * dx + dz * dz <= radius * radius;
};

class TriangleMultiset {
  constructor(directory) {
    this.directory = directory;
    this.pending = Array.from({ length: 256 }, () => []);
    this.pendingBytes = Array(256).fill(0);
    this.totalPending = 0;
    this.triangles = 0;
  }
  add(triangle) {
    const hash = crypto.createHash('sha256').update(triangle).digest();
    const bucket = hash[0];
    this.pending[bucket].push(hash);
    this.pendingBytes[bucket] += hash.length;
    this.totalPending += hash.length;
    this.triangles++;
  }
  async flush() {
    if (!this.totalPending) return;
    await fsp.mkdir(this.directory, { recursive: true });
    for (let bucket = 0; bucket < 256; bucket++) if (this.pendingBytes[bucket]) {
      await fsp.appendFile(path.join(this.directory, `${bucket.toString(16).padStart(2, '0')}.bin`), Buffer.concat(this.pending[bucket]));
      this.pending[bucket] = [];
      this.pendingBytes[bucket] = 0;
    }
    this.totalPending = 0;
  }
  async compare(other) {
    await this.flush();
    await other.flush();
    if (this.triangles !== other.triangles) throw new Error(`Triangle count differs: ${this.triangles} != ${other.triangles}`);
    const aggregate = crypto.createHash('sha256');
    for (let bucket = 0; bucket < 256; bucket++) {
      const name = `${bucket.toString(16).padStart(2, '0')}.bin`;
      const left = fs.existsSync(path.join(this.directory, name)) ? await fsp.readFile(path.join(this.directory, name)) : Buffer.alloc(0);
      const right = fs.existsSync(path.join(other.directory, name)) ? await fsp.readFile(path.join(other.directory, name)) : Buffer.alloc(0);
      if (left.length !== right.length || left.length % 32 || right.length % 32) throw new Error(`Invalid multiset bucket ${name}`);
      const split = bytes => Array.from({ length: bytes.length / 32 }, (_, index) => bytes.subarray(index * 32, index * 32 + 32)).sort(Buffer.compare);
      const sortedLeft = split(left), sortedRight = split(right);
      for (let index = 0; index < sortedLeft.length; index++) if (!sortedLeft[index].equals(sortedRight[index])) throw new Error(`Triangle multiset mismatch in bucket ${name}`);
      aggregate.update(name);
      aggregate.update(Buffer.concat(sortedLeft));
    }
    return { triangles: this.triangles, sortedTriangleHash: aggregate.digest('hex') };
  }
}

async function readSlice(file, offset, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error(`Short pack slice read: ${bytesRead}/${length}`);
    return buffer;
  } finally { await handle.close(); }
}
async function appendGroups(groups) {
  for (const group of groups.values()) if (group.pendingBytes) {
    await fsp.mkdir(path.dirname(group.file), { recursive: true });
    await fsp.appendFile(group.file, Buffer.concat(group.pending));
    group.pending = []; group.pendingBytes = 0;
  }
}
function addTriangle(groups, tempRoot, size, values, triangle, floatIndex) {
  const cx = (values[floatIndex] + values[floatIndex + 3] + values[floatIndex + 6]) / 3;
  const cz = (values[floatIndex + 2] + values[floatIndex + 5] + values[floatIndex + 8]) / 3;
  const x = Math.floor(cx / size), z = Math.floor(cz / size);
  const key = stableCell(size, x, z);
  let group = groups.get(key);
  if (!group) {
    group = { key, cellSize: size, cell: [x, z], file: path.join(tempRoot, `${key}.raw`), rawBytes: 0, triangles: 0, bounds: emptyBounds(), pending: [], pendingBytes: 0 };
    groups.set(key, group);
  }
  group.pending.push(triangle); group.pendingBytes += triangle.length; group.rawBytes += triangle.length; group.triangles++;
  updateBounds(group.bounds, values, floatIndex);
}
async function chunkCollision({ sceneId, map, resourceId, resource, bundles, manifestPath }) {
  if (resource.size <= threshold) return {
    skipped: true,
    source: { release: path.relative(root, releaseRoot).split(path.sep).join('/'), manifest: path.relative(releaseRoot, manifestPath).split(path.sep).join('/'), sceneId, legacyCollisionResourceId: resourceId, legacyCompressedBytes: resource.size },
    reason: `legacy compressed collision is at or below ${threshold} bytes`,
  };
  if (resource.metadata?.encoding && resource.metadata.encoding !== 'gzip') throw new Error(`${sceneId} collision encoding is not gzip`);
  const sourcePath = path.join(releaseRoot, bundles[resource.bundle].url);
  const compressed = await readSlice(sourcePath, resource.offset, resource.length);
  if (sha256(compressed) !== resource.hash) throw new Error(`${sceneId} collision slice SHA mismatch before chunking`);
  const raw = zlib.gunzipSync(compressed);
  if (raw.length % 36) throw new Error(`${sceneId} collision raw length ${raw.length} is not a triangle stream`);
  const values = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const triangles = raw.length / 36;
  const workRoot = path.join(outRoot, sceneId);
  const tempRoot = path.join(workRoot, 'tmp');
  await fsp.mkdir(tempRoot, { recursive: true });
  const sourceHashes = new TriangleMultiset(path.join(tempRoot, 'source-hashes'));
  const groups = new Map();
  const collisionBounds = emptyBounds();
  for (let triangleIndex = 0; triangleIndex < triangles; triangleIndex++) {
    const floatIndex = triangleIndex * 9;
    const triangle = raw.subarray(triangleIndex * 36, triangleIndex * 36 + 36);
    sourceHashes.add(triangle);
    addTriangle(groups, tempRoot, cellSize, values, triangle, floatIndex);
    updateBounds(collisionBounds, values, floatIndex);
    if (sourceHashes.totalPending >= 32 * 1024 * 1024) {
      await sourceHashes.flush();
      await appendGroups(groups);
    }
  }
  await sourceHashes.flush();
  await appendGroups(groups);

  const finalGroups = new Map();
  const oversizePrimary = [...groups.values()].filter(group => group.rawBytes > threshold);
  for (const group of groups.values()) {
    if (group.rawBytes <= threshold) { finalGroups.set(group.key, group); continue; }
    const bytes = await fsp.readFile(group.file);
    const groupValues = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    for (let offset = 0; offset < bytes.length; offset += 36) addTriangle(finalGroups, tempRoot, 32, groupValues, bytes.subarray(offset, offset + 36), offset / 4);
    await fsp.rm(group.file, { force: true });
  }
  await appendGroups(finalGroups);
  const oversizeSecondary = [...finalGroups.values()].filter(group => group.rawBytes > threshold);

  const outputHashes = new TriangleMultiset(path.join(tempRoot, 'chunk-hashes'));
  const packs = {}, resources = {}, collisionChunks = [];
  await fsp.mkdir(path.join(workRoot, 'packs'), { recursive: true });
  const chunkEntries = [];
  for (const group of [...finalGroups.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const groupRaw = await fsp.readFile(group.file);
    for (let offset = 0; offset < groupRaw.length; offset += 36) outputHashes.add(groupRaw.subarray(offset, offset + 36));
    if (outputHashes.totalPending >= 32 * 1024 * 1024) await outputHashes.flush();
    const gz = zlib.gzipSync(groupRaw, { level: 9 });
    const resourceHash = sha256(gz);
    const chunkId = `collision:sha256:${resourceHash}`;
    const tile = [Math.floor((group.cell[0] * group.cellSize) / tileSize), Math.floor((group.cell[1] * group.cellSize) / tileSize)];
    chunkEntries.push({ group, groupRaw, gz, resourceHash, chunkId, tile });
  }
  // Keep every chunk independently addressable, while packing only spatially-adjacent
  // cells and capping the raw work represented by a request.  This avoids both the
  // one-object-per-cell COS explosion and unrelated-cell overfetch.
  const tileEntries = new Map();
  for (const entry of chunkEntries) {
    const key = `${entry.tile[0]},${entry.tile[1]}`;
    const list = tileEntries.get(key) || [];
    list.push(entry); tileEntries.set(key, list);
  }
  for (const [tileKey, entries] of [...tileEntries].sort(([left], [right]) => left.localeCompare(right))) {
    let batch = [], batchRawBytes = 0, batchIndex = 0;
    const flushPack = async () => {
      if (!batch.length) return;
      let position = MAGIC.length;
      const slices = [];
      for (const entry of batch) {
        position = align(position);
        slices.push({ entry, offset: position });
        position += entry.gz.length;
      }
      const pack = Buffer.alloc(position);
      MAGIC.copy(pack, 0);
      for (const { entry, offset } of slices) entry.gz.copy(pack, offset);
      const packHash = sha256(pack);
      const packId = `pack:sha256:${packHash}`;
      const relativePack = `packs/${packHash}.aethpak`;
      const packPath = path.join(workRoot, relativePack);
      if (!fs.existsSync(packPath)) await fsp.writeFile(packPath, pack);
      const [tileX, tileZ] = tileKey.split(',');
      packs[packId] = { url: relativePack, size: pack.length, hash: packHash, group: `collision:${sceneId}:tile-${tileSize}m:${tileX}:${tileZ}:batch-${batchIndex++}`, resourceCount: batch.length, oversize: false, rawBytes: batchRawBytes };
      for (const { entry, offset } of slices) {
        const { group, resourceHash, chunkId } = entry;
        resources[chunkId] = { type: 'collision', hash: resourceHash, size: entry.gz.length, dependencies: [], virtual: false, metadata: { encoding: 'gzip', rawBytes: entry.groupRaw.length, sourceCollisionId: resourceId, cell: group.cell, cellSize: group.cellSize, tile: entry.tile, triangleCount: group.triangles }, bundle: packId, offset, length: entry.gz.length };
        collisionChunks.push({ resourceId: chunkId, bounds: group.bounds, triangles: group.triangles });
      }
      batch = []; batchRawBytes = 0;
    };
    for (const entry of entries.sort((left, right) => left.group.key.localeCompare(right.group.key))) {
      if (batch.length && batchRawBytes + entry.groupRaw.length > packRawBytes) await flushPack();
      batch.push(entry); batchRawBytes += entry.groupRaw.length;
    }
    await flushPack();
  }
  const multiset = await sourceHashes.compare(outputHashes);
  const point = map.spawn?.point || null;
  const statsAt = radius => {
    const selected = point ? collisionChunks.filter(chunk => circleIntersectsBounds(chunk.bounds, point, radius)) : collisionChunks;
    const selectedResources = selected.map(chunk => resources[chunk.resourceId]);
    const bundleIds = new Set(selectedResources.map(item => item.bundle));
    return { radius, chunks: selected.length, requests: bundleIds.size, compressedBytes: selectedResources.reduce((sum, item) => sum + item.size, 0), packBytes: [...bundleIds].reduce((sum, id) => sum + packs[id].size, 0), rawBytes: selectedResources.reduce((sum, item) => sum + item.metadata.rawBytes, 0) };
  };
  const patch = {
    schemaVersion: 1,
    prototype: true,
    source: { release: path.relative(root, releaseRoot).split(path.sep).join('/'), manifest: path.relative(releaseRoot, manifestPath).split(path.sep).join('/'), sceneId, legacyCollisionResourceId: resourceId, legacyCompressedBytes: resource.size, legacyRawBytes: raw.length },
    mapPatch: { sceneId, collisionBounds, collisionChunks },
    resources,
    bundles: packs,
    verification: { sourceResourceHash: resource.hash, decodedRawBytes: raw.length, collisionBounds, primaryCellSize: cellSize, primaryOverThreshold: oversizePrimary.length, secondaryCellSize: 32, secondaryOverThreshold: oversizeSecondary.map(group => ({ cell: group.cell, rawBytes: group.rawBytes, triangles: group.triangles })), tileSize, packRawBytes, ...multiset },
    bootstrap: { point, radius96: statsAt(96), radius128: statsAt(128) },
    chunks: { count: collisionChunks.length, packCount: Object.keys(packs).length, rawBytes: collisionChunks.reduce((sum, chunk) => sum + resources[chunk.resourceId].metadata.rawBytes, 0), compressedBytes: collisionChunks.reduce((sum, chunk) => sum + resources[chunk.resourceId].size, 0), packBytes: Object.values(packs).reduce((sum, pack) => sum + pack.size, 0) },
  };
  await writeJson(path.join(workRoot, 'collision-chunks.json'), patch);
  return patch;
}

const published = await readJson(path.join(releaseRoot, 'publish-manifest.json'));
const catalog = await readJson(path.join(releaseRoot, published.entry));
const results = [];
await fsp.mkdir(outRoot, { recursive: true });
const selectedSceneIds = mapIds.includes('all') ? Object.keys(catalog.maps).sort() : mapIds;
const progressPath = path.join(outRoot, 'collision-progress.json');
const progress = { schemaVersion: 1, startedAt: new Date().toISOString(), source: path.relative(root, releaseRoot).split(path.sep).join('/'), cellSize, threshold, tileSize, packRawBytes, maps: {} };
await writeJson(progressPath, progress);
async function cachedResult(sceneId, resource) {
  for (const candidateRoot of [...new Set([outRoot, cacheRoot].filter(Boolean))]) {
    const file = path.join(candidateRoot, sceneId, 'collision-chunks.json');
    if (!fs.existsSync(file)) continue;
    const cached = await readJson(file);
    if (cached.source?.legacyCollisionResourceId !== resource.id || cached.source?.legacyCompressedBytes !== resource.size || cached.verification?.sourceResourceHash !== resource.hash || cached.verification?.primaryCellSize !== cellSize || cached.verification?.tileSize !== tileSize || cached.verification?.packRawBytes !== packRawBytes || cached.verification?.primaryOverThreshold === undefined) continue;
    for (const bundle of Object.values(cached.bundles || {})) await linkFile(path.join(candidateRoot, sceneId, bundle.url), path.join(outRoot, sceneId, bundle.url));
    return { ...cached, cacheHit: true };
  }
  return null;
}
for (const sceneId of selectedSceneIds) {
  const catalogMap = catalog.maps?.[sceneId];
  if (!catalogMap) throw new Error(`Map ${sceneId} is not in the release catalog`);
  const manifestPath = path.join(releaseRoot, catalogMap.manifest);
  const manifest = await readJson(manifestPath);
  const map = manifest.maps?.[sceneId];
  const collisionIds = Object.values(map.paths || {}).filter(id => manifest.resources[id]?.type === 'collision');
  if (collisionIds.length > 1) throw new Error(`${sceneId} expected at most one collision path, got ${collisionIds.length}`);
  if (!collisionIds.length) {
    results.push({ skipped: true, source: { sceneId, manifest: path.relative(releaseRoot, manifestPath).split(path.sep).join('/') }, reason: 'map has no collision path' });
  } else {
    const resource = manifest.resources[collisionIds[0]];
    const cached = await cachedResult(sceneId, { ...resource, id: collisionIds[0] });
    if (cached) {
      cached.source = { ...cached.source, release: path.relative(root, releaseRoot).split(path.sep).join('/'), manifest: path.relative(releaseRoot, manifestPath).split(path.sep).join('/') };
      await fsp.mkdir(path.join(outRoot, sceneId), { recursive: true });
      await writeJson(path.join(outRoot, sceneId, 'collision-chunks.json'), cached);
    }
    results.push(cached || await chunkCollision({ sceneId, map, resourceId: collisionIds[0], resource, bundles: manifest.bundles, manifestPath }));
  }
  const result = results.at(-1);
  progress.maps[sceneId] = result.skipped ? { status: 'skipped', reason: result.reason, legacyCompressedBytes: result.source.legacyCompressedBytes } : { status: 'complete', cacheHit: !!result.cacheHit, chunks: result.chunks.count, packs: result.chunks.packCount, legacyCompressedBytes: result.source.legacyCompressedBytes };
  progress.completed = Object.keys(progress.maps).length;
  progress.total = selectedSceneIds.length;
  await writeJson(progressPath, progress);
}
const completedResults = results.filter(result => !result.skipped);
const summary = { schemaVersion: 1, prototype, maps: results.map(result => result.skipped ? ({ sceneId: result.source.sceneId, source: result.source, skipped: true, reason: result.reason }) : ({ sceneId: result.source.sceneId, source: result.source, cacheHit: !!result.cacheHit, verification: result.verification, bootstrap: result.bootstrap, chunks: result.chunks })) };
await writeJson(path.join(outRoot, 'collision-resource-index.json'), {
  schemaVersion: 1,
  resources: Object.assign({}, ...completedResults.map(result => result.resources)),
  bundles: Object.assign({}, ...completedResults.map(result => result.bundles)),
});
await writeJson(path.join(outRoot, 'collision-chunk-summary.json'), summary);
async function linkFile(source, destination) {
  if (path.resolve(source) === path.resolve(destination) || fs.existsSync(destination)) return;
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.link(source, destination);
}
async function materializeRelease() {
  const changedScenes = new Set(completedResults.map(result => result.source.sceneId));
  const sourceManifests = new Map();
  for (const result of completedResults) sourceManifests.set(result.source.sceneId, await readJson(path.join(releaseRoot, result.source.manifest)));
  // Reuse all immutable release files by hard link.  Replaced map manifests and the
  // catalog are intentionally omitted; their content addresses change below.
  const replacedPaths = new Set([published.entry, ...completedResults.map(result => result.source.manifest)]);
  for (const file of published.files) if (!replacedPaths.has(file.path)) await linkFile(path.join(releaseRoot, file.path), path.join(outRoot, file.path));
  const outputMaps = { ...catalog.maps };
  const mapFiles = [];
  const chunkFiles = [];
  for (const result of completedResults) {
    const sceneId = result.source.sceneId;
    const sourceManifest = sourceManifests.get(sceneId);
    const mapManifest = {
      ...sourceManifest,
      resources: { ...sourceManifest.resources, ...result.resources },
      bundles: { ...sourceManifest.bundles, ...result.bundles },
      maps: { ...sourceManifest.maps, [sceneId]: { ...sourceManifest.maps[sceneId], ...result.mapPatch } },
    };
    const compressed = gzipJson(mapManifest);
    const hash = sha256(compressed);
    const relative = `maps/${sceneId}/manifest_${hash}.json.gz`;
    await fsp.mkdir(path.dirname(path.join(outRoot, relative)), { recursive: true });
    await fsp.writeFile(path.join(outRoot, relative), compressed);
    outputMaps[sceneId] = { manifest: relative };
    mapFiles.push({ path: relative, size: compressed.length, hash, contentType: 'application/json; charset=utf-8', contentEncoding: 'gzip' });
    for (const bundle of Object.values(result.bundles)) {
      const source = path.join(outRoot, sceneId, bundle.url);
      const destination = path.join(outRoot, bundle.url);
      await linkFile(source, destination);
      chunkFiles.push({ path: bundle.url, size: bundle.size, hash: bundle.hash, contentType: 'application/octet-stream' });
    }
  }
  const nextCatalog = { ...catalog, maps: outputMaps };
  const catalogText = JSON.stringify(nextCatalog);
  const catalogHash = sha256(catalogText);
  const catalogName = `catalog_${catalogHash}.json`;
  await fsp.writeFile(path.join(outRoot, catalogName), catalogText);
  const retainedFiles = published.files.filter(file => !replacedPaths.has(file.path));
  const filesByPath = new Map([...retainedFiles, ...chunkFiles, ...mapFiles, { path: catalogName, size: Buffer.byteLength(catalogText), hash: catalogHash, contentType: 'application/json; charset=utf-8' }].map(file => [file.path, file]));
  const nextPublish = { ...published, entry: catalogName, files: [...filesByPath.values()].sort((left, right) => left.path.localeCompare(right.path)) };
  await writeJson(path.join(outRoot, 'publish-manifest.json'), nextPublish);
  return { entry: catalogName, files: nextPublish.files.length, changedScenes: [...changedScenes].sort(), addedCollisionPacks: chunkFiles.length };
}
if (!prototype) summary.release = await materializeRelease();
await writeJson(path.join(outRoot, 'collision-chunk-summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
