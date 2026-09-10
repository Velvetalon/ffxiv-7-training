import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const usage = `Usage: node scripts/assets/reference-analyzer.mjs [options]

Options:
  --active <path>          Active catalog (default: public/extracted/active.json)
  --scenes <id,id,...>     Scene IDs (default: every active scene)
  --out <path>             Output directory or .json file
                            (default: work/asset-performance/reference-analysis)
  --spawn-radius <number>  Horizontal bootstrap envelope radius (default: 64)
  --spawn-height <number>  Vertical bootstrap envelope half-height (default: 80)
`;

const option = name => {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find(argument => argument.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage);
  process.exit(0);
}

const root = process.cwd();
const activePath = path.resolve(root, option('active') || 'public/extracted/active.json');
const requestedScenes = option('scenes')?.split(',').map(value => value.trim()).filter(Boolean);
const spawnRadius = Number(option('spawn-radius') || 64);
const spawnHeight = Number(option('spawn-height') || 80);
if (!Number.isFinite(spawnRadius) || spawnRadius < 0 || !Number.isFinite(spawnHeight) || spawnHeight < 0) {
  throw new Error('--spawn-radius and --spawn-height must be non-negative numbers');
}

const sha256 = input => crypto.createHash('sha256').update(input).digest('hex');
const stable = value => JSON.stringify(normalize(value));
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  return value;
};
const relative = file => path.relative(root, file).split(path.sep).join('/');
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));
const writeChunk = async (stream, value) => { if (!stream.write(value)) await once(stream, 'drain'); };
async function writeJsonEntries(stream, entries) {
  let first = true;
  await writeChunk(stream, '{');
  for (const [key, value] of entries) {
    await writeChunk(stream, `${first ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`);
    first = false;
  }
  await writeChunk(stream, '}');
}
async function writeJsonValues(stream, values) {
  let first = true;
  await writeChunk(stream, '[');
  for (const value of values) {
    await writeChunk(stream, `${first ? '' : ','}${JSON.stringify(value)}`);
    first = false;
  }
  await writeChunk(stream, ']');
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => { hash.update(chunk); sizeBytes += chunk.length; });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function readGlbJson(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, header.length, 0);
    if (header.readUInt32LE(0) !== 0x46546c67) throw new Error(`${relative(file)} is not a GLB`);
    if (header.readUInt32LE(4) !== 2) throw new Error(`${relative(file)} is not GLB v2`);
    const jsonLength = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`${relative(file)} has no JSON chunk`);
    const json = Buffer.alloc(jsonLength);
    await handle.read(json, 0, jsonLength, 20);
    return JSON.parse(json.toString('utf8'));
  } finally {
    await handle.close();
  }
}

const emptyBounds = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const hasBounds = bounds => bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite);
function mergeBounds(target, bounds) {
  if (!bounds || !hasBounds(bounds)) return target;
  for (let axis = 0; axis < 3; axis++) {
    target.min[axis] = Math.min(target.min[axis], bounds.min[axis]);
    target.max[axis] = Math.max(target.max[axis], bounds.max[axis]);
  }
  return target;
}
function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const divisor = w || 1;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor,
  ];
}
function transformBounds(bounds, matrix) {
  if (!hasBounds(bounds)) return null;
  const target = emptyBounds();
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    const point = transformPoint(matrix, [x, y, z]);
    mergeBounds(target, { min: point, max: point });
  }
  return target;
}
function multiply(left, right) {
  const result = Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    result[column * 4 + row] = left[row] * right[column * 4]
      + left[4 + row] * right[column * 4 + 1]
      + left[8 + row] * right[column * 4 + 2]
      + left[12 + row] * right[column * 4 + 3];
  }
  return result;
}
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [x, y, z] = node.translation || [0, 0, 0];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx, 0,
    (2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy, 0,
    (2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    x, y, z, 1,
  ];
}
function intersects(left, right) {
  return hasBounds(left) && hasBounds(right) && [0, 1, 2].every(axis => left.min[axis] <= right.max[axis] && left.max[axis] >= right.min[axis]);
}
function finiteAabb(bounds) {
  return hasBounds(bounds) ? { min: bounds.min.map(round), max: bounds.max.map(round) } : null;
}
const round = value => Math.round(value * 1e6) / 1e6;

function glbNodes(document) {
  const nodes = document.nodes || [];
  const parents = new Set(nodes.flatMap(node => node.children || []));
  const roots = document.scenes?.[document.scene || 0]?.nodes || nodes.map((_, index) => index).filter(index => !parents.has(index));
  const output = [];
  const visit = (index, parent) => {
    const node = nodes[index];
    if (!node) return;
    const world = multiply(parent, nodeMatrix(node));
    if (Number.isInteger(node.mesh)) output.push({ index, node, world });
    for (const child of node.children || []) visit(child, world);
  };
  for (const index of roots) visit(index, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return output;
}

function geometryFromGlb(document) {
  const primitiveUses = [];
  const localBounds = emptyBounds();
  for (const { index: nodeIndex, node, world } of glbNodes(document)) {
    const mesh = document.meshes?.[node.mesh];
    for (const [primitiveIndex, primitive] of (mesh?.primitives || []).entries()) {
      const accessor = document.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      const local = { min: accessor.min, max: accessor.max };
      const transformed = transformBounds(local, world);
      mergeBounds(localBounds, transformed);
      primitiveUses.push({
        nodeIndex,
        meshIndex: node.mesh,
        primitiveIndex,
        materialPath: node.extras?.materialPath || null,
        bounds: finiteAabb(transformed),
      });
    }
  }
  return { localBounds, primitiveUses };
}

function spawnEnvelope(manifest) {
  const trainingSpawn = manifest.training?.spawn;
  const spawn = trainingSpawn && [trainingSpawn.x, trainingSpawn.y, trainingSpawn.z].every(Number.isFinite)
    ? { point: [trainingSpawn.x, trainingSpawn.y, trainingSpawn.z], source: 'training.spawn' }
    : Array.isArray(manifest.spawn) && manifest.spawn.length === 3
      ? { point: manifest.spawn, source: 'spawn' }
      : null;
  if (!spawn) return null;
  const [x, y, z] = spawn.point;
  return {
    ...spawn,
    bounds: { min: [x - spawnRadius, y - spawnHeight, z - spawnRadius], max: [x + spawnRadius, y + spawnHeight, z + spawnRadius] },
  };
}

const resources = new Map();
const aliases = {};
async function blobResource(type, file) {
  const details = await hashFile(file);
  const id = `${type}:sha256:${details.sha256}`;
  const sourcePath = relative(file);
  if (!resources.has(id)) resources.set(id, { id, type, sha256: details.sha256, sizeBytes: details.sizeBytes, sourcePaths: [sourcePath], sources: [file] });
  else {
    const resource = resources.get(id);
    if (!resource.sourcePaths.includes(sourcePath)) resource.sourcePaths.push(sourcePath);
    if (!resource.sources.includes(file)) resource.sources.push(file);
  }
  return id;
}

function makeMaterialRecord(sceneId, materialPath, descriptor, dependencies, warnings) {
  const sourceDescriptor = {
    materialPath,
    shader: descriptor?.shader || null,
    flags: descriptor?.flags ?? null,
    samplers: (descriptor?.samplers || []).map(sampler => ({ id: sampler.id ?? null, index: sampler.index ?? null, path: sampler.path || null, map: sampler.map || null })),
  };
  const canonical = {
    materialPath,
    shader: descriptor?.shader || null,
    flags: descriptor?.flags ?? null,
    samplers: (descriptor?.samplers || []).map((sampler, index) => ({ id: sampler.id ?? null, index: sampler.index ?? null, textureResourceId: dependencies.find(dependency => dependency.samplerIndex === index)?.resourceId || null })),
    dependencies: dependencies.map(dependency => dependency.resourceId),
  };
  const descriptorHash = sha256(stable(canonical));
  return { id: `material:sha256:${descriptorHash}`, kind: 'material', materialPath, descriptorHash, descriptor: sourceDescriptor, canonical, dependencies };
}

const active = await readJson(activePath);
const sceneIds = requestedScenes || Object.keys(active.scenes || {});
if (!sceneIds.length) throw new Error(`No scenes in ${relative(activePath)}`);
for (const sceneId of sceneIds) if (!active.scenes?.[sceneId]) throw new Error(`Unknown scene ${sceneId}`);

const owners = new Map();
const edges = [];
const sceneResources = new Map();
const cooccurrence = new Map();
const warnings = [];
const maps = {};

function addEdge(from, to, role, details = {}) {
  edges.push({ from, to, role, ...details });
}
function addCooccurrence(left, right, kind) {
  if (left === right) return;
  const [a, b] = [left, right].sort();
  const key = `${kind}:${a}|${b}`;
  const entry = cooccurrence.get(key) || { left: a, right: b, kind, count: 0 };
  entry.count++;
  cooccurrence.set(key, entry);
}

for (const sceneId of sceneIds) {
  const activeScene = active.scenes[sceneId];
  const sceneRoot = path.resolve(path.dirname(activePath), activeScene.base);
  const manifestPath = path.join(sceneRoot, 'scene.json');
  const manifest = await readJson(manifestPath);
  const sceneOwnerId = `scene:${sceneId}`;
  const resourceSet = new Set();
  const envelope = spawnEnvelope(manifest);
  const map = {
    id: sceneId,
    name: manifest.name || activeScene.name || null,
    en: manifest.en || activeScene.en || null,
    manifest: { path: relative(manifestPath), sha256: activeScene.manifestSha256 || null },
    legacyManifest: { sourcePath: relative(manifestPath), sourceFile: manifestPath },
    spawn: envelope ? { source: envelope.source, point: envelope.point.map(round), envelope: finiteAabb(envelope.bounds) } : null,
    paths: {},
    models: [],
    bootstrap: { modelIndices: [], modelOwnerIds: [], resources: [], resourceBytes: 0 },
    connections: (manifest.connections || []).map(connection => ({ id: connection.id, targetScene: connection.targetScene, targetConnection: connection.targetConnection || null })),
  };
  owners.set(sceneOwnerId, { id: sceneOwnerId, kind: 'scene', sceneId, dependencies: [] });

  const manifestResource = `manifest:sha256:${activeScene.manifestSha256 || sha256(await fsp.readFile(manifestPath))}`;
  if (!resources.has(manifestResource)) resources.set(manifestResource, { id: manifestResource, type: 'manifest', sha256: manifestResource.split(':').at(-1), sizeBytes: (await fsp.stat(manifestPath)).size, sourcePaths: [relative(manifestPath)], sources: [manifestPath] });
  addEdge(sceneOwnerId, manifestResource, 'scene-manifest');
  resourceSet.add(manifestResource);

  const mapImagePath = ['map.png', 'map.webp', 'map.jpg', 'map.jpeg'].find(candidate => fs.existsSync(path.join(sceneRoot, candidate)));
  if (mapImagePath) {
    const mapImage = await blobResource('texture', path.join(sceneRoot, mapImagePath));
    aliases[`scene:${sceneId}:path:${mapImagePath}`] = mapImage;
    map.paths[mapImagePath] = mapImage;
    if (manifest.mapTexture) {
      aliases[`scene:${sceneId}:path:${manifest.mapTexture}`] = mapImage;
      map.paths[manifest.mapTexture] = mapImage;
    }
    addEdge(sceneOwnerId, mapImage, 'scene-map-image', { path: mapImagePath, legacyPath: manifest.mapTexture || null });
    resourceSet.add(mapImage);
  } else if (manifest.mapTexture && fs.existsSync(path.join(sceneRoot, manifest.mapTexture))) {
    const mapTexture = await blobResource('texture', path.join(sceneRoot, manifest.mapTexture));
    aliases[`scene:${sceneId}:path:${manifest.mapTexture}`] = mapTexture;
    map.paths[manifest.mapTexture] = mapTexture;
    addEdge(sceneOwnerId, mapTexture, 'scene-map-texture', { path: manifest.mapTexture });
    resourceSet.add(mapTexture);
  }
  if (manifest.collisionFile && fs.existsSync(path.join(sceneRoot, manifest.collisionFile))) {
    const collision = await blobResource('collision', path.join(sceneRoot, manifest.collisionFile));
    aliases[`scene:${sceneId}:path:${manifest.collisionFile}`] = collision;
    map.paths[manifest.collisionFile] = collision;
    addEdge(sceneOwnerId, collision, 'scene-collision', { path: manifest.collisionFile });
    resourceSet.add(collision);
  }

  const materialByPath = new Map();
  const getMaterial = async materialPath => {
    if (materialByPath.has(materialPath)) return materialByPath.get(materialPath);
    const descriptor = manifest.materials?.[materialPath];
    const dependencies = [];
    const textureUses = (descriptor?.samplers || []).map((sampler, samplerIndex) => ({ sampler, samplerIndex })).filter(({ sampler }) => sampler.map && sampler.path);
    if (descriptor && !textureUses.length) warnings.push({ scene: sceneId, code: 'material-without-sampler-map', materialPath });
    for (const { sampler, samplerIndex } of textureUses) {
      const textureFile = path.join(sceneRoot, sampler.map);
      if (!fs.existsSync(textureFile)) {
        warnings.push({ scene: sceneId, code: 'missing-material-texture', materialPath, map: sampler.map });
        continue;
      }
      const texture = await blobResource('texture', textureFile);
      aliases[`scene:${sceneId}:path:${sampler.map}`] = texture;
      map.paths[sampler.map] = texture;
      dependencies.push({ samplerIndex, resourceId: texture, sourcePath: sampler.path, map: sampler.map, samplerId: sampler.id ?? null });
    }
    const record = makeMaterialRecord(sceneId, materialPath, descriptor, dependencies, warnings);
    resources.set(record.id, {
      id: record.id,
      type: 'material',
      sha256: record.descriptorHash,
      sizeBytes: 0,
      sourcePaths: [],
      sources: [],
      metadata: { materialPath: record.materialPath, descriptor: record.descriptor, canonical: record.canonical },
      dependencies: record.dependencies.map(dependency => dependency.resourceId),
    });
    materialByPath.set(materialPath, record);
    return record;
  };

  for (const [modelIndex, model] of (manifest.models || []).entries()) {
    const glbFile = path.join(sceneRoot, model.url);
    if (!fs.existsSync(glbFile)) {
      warnings.push({ scene: sceneId, code: 'missing-model', url: model.url });
      continue;
    }
    const glb = await blobResource('glb', glbFile);
    aliases[`scene:${sceneId}:path:${model.url}`] = glb;
    map.paths[model.url] = glb;
    const document = await readGlbJson(glbFile);
    const geometry = geometryFromGlb(document);
    const ownerId = `scene-model:${sceneId}:${modelIndex}`;
    const modelBounds = emptyBounds();
    const bootstrapInstanceIndices = [];
    const instanceBounds = [];
    for (const [instanceIndex, placement] of (model.matrices || []).entries()) {
      const transformedBounds = transformBounds(geometry.localBounds, placement);
      const serializableBounds = finiteAabb(transformedBounds);
      instanceBounds.push(serializableBounds);
      mergeBounds(modelBounds, transformedBounds);
      if (envelope && intersects(transformedBounds, envelope.bounds)) bootstrapInstanceIndices.push(instanceIndex);
    }
    const materialPaths = [...new Set(geometry.primitiveUses.map(use => use.materialPath).filter(Boolean))];
    const materialIds = [];
    for (const materialPath of materialPaths) {
      const material = await getMaterial(materialPath);
      materialIds.push(material.id);
    }
    owners.set(ownerId, {
      id: ownerId,
      kind: 'scene-model',
      sceneId,
      modelIndex,
      asset: model.asset || null,
      url: model.url,
      glbResourceId: glb,
      placementCount: model.matrices?.length || 0,
      bounds: finiteAabb(modelBounds),
      bootstrapInstanceIndices,
      dependencies: [glb, ...materialIds],
      materialResources: materialIds,
    });
    addEdge(sceneOwnerId, ownerId, 'scene-model-owner');
    addEdge(ownerId, glb, 'model-glb', { url: model.url, asset: model.asset || null });
    resourceSet.add(glb);
    for (const materialId of materialIds) {
      const material = resources.get(materialId);
      addEdge(ownerId, materialId, 'model-material');
      addCooccurrence(glb, materialId, 'model-material');
      resourceSet.add(materialId);
      for (const dependency of material.dependencies) {
        const metadata = material.metadata.descriptor.samplers.find(sampler => aliases[`scene:${sceneId}:path:${sampler.map}`] === dependency) || {};
        addEdge(materialId, dependency, 'material-texture', { materialPath: material.metadata.materialPath, sourcePath: metadata.path || null, map: metadata.map || null, samplerId: metadata.id ?? null });
        addCooccurrence(materialId, dependency, 'material-texture');
        resourceSet.add(dependency);
      }
    }
    const modelRecord = { index: modelIndex, ownerId, glbResourceId: glb, url: model.url, asset: model.asset || null, placementCount: model.matrices?.length || 0, bounds: finiteAabb(modelBounds), instanceBounds, materialResources: materialIds, bootstrapInstanceIndices };
    map.models.push(modelRecord);
    if (bootstrapInstanceIndices.length) {
      map.bootstrap.modelIndices.push(modelIndex);
      map.bootstrap.modelOwnerIds.push(ownerId);
    }
  }
  const bootstrapResourceSet = new Set();
  for (const ownerId of map.bootstrap.modelOwnerIds) {
    for (const dependency of owners.get(ownerId).dependencies) {
      if (resources.has(dependency)) bootstrapResourceSet.add(dependency);
      const material = resources.get(dependency);
      for (const texture of material?.dependencies || []) bootstrapResourceSet.add(texture);
    }
  }
  map.bootstrap.resources = [...bootstrapResourceSet].sort();
  map.bootstrap.resourceBytes = map.bootstrap.resources.reduce((sum, id) => sum + (resources.get(id)?.sizeBytes || 0), 0);
  map.resources = [...resourceSet].sort();
  map.resourceBytes = map.resources.reduce((sum, id) => sum + (resources.get(id)?.sizeBytes || 0), 0);
  maps[sceneId] = map;
  sceneResources.set(sceneId, resourceSet);
}

for (const resource of resources.values()) {
  resource.sourcePaths.sort();
  resource.sources.sort();
}
const reusedResources = [...resources.values()]
  .map(resource => {
    const scenes = [...sceneResources].filter(([, set]) => set.has(resource.id)).map(([sceneId]) => sceneId);
    return { resourceId: resource.id, scenes, sceneCount: scenes.length, sizeBytes: resource.sizeBytes };
  })
  .filter(entry => entry.sceneCount > 1)
  .sort((a, b) => b.sizeBytes * b.sceneCount - a.sizeBytes * a.sceneCount || a.resourceId.localeCompare(b.resourceId));
const bytesByType = {};
for (const resource of resources.values()) bytesByType[resource.type] = (bytesByType[resource.type] || 0) + resource.sizeBytes;
const input = {
  activePath: relative(activePath),
  runId: active.runId || null,
  sceneIds,
  spawnEnvelope: { radius: spawnRadius, halfHeight: spawnHeight },
};
const stats = {
  uniqueResourceCount: resources.size,
  uniqueResourceBytes: [...resources.values()].reduce((sum, resource) => sum + resource.sizeBytes, 0),
  uniqueResourceBytesByType: bytesByType,
  materialResourceCount: [...resources.values()].filter(resource => resource.type === 'material').length,
  ownerCount: owners.size,
  edgeCount: edges.length,
  sceneCount: sceneIds.length,
  bootstrapResourceBytes: Object.fromEntries(Object.entries(maps).map(([sceneId, map]) => [sceneId, map.bootstrap.resourceBytes])),
};

const requestedOut = option('out') || 'work/asset-performance/reference-analysis';
const outputPath = path.resolve(root, requestedOut.endsWith('.json') ? requestedOut : path.join(requestedOut, 'reference-analysis.json'));
await fsp.mkdir(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.tmp`;
const stream = fs.createWriteStream(temporaryPath);
try {
  await writeChunk(stream, `{"schemaVersion":1,"input":${JSON.stringify(input)},"resources":`);
  await writeJsonEntries(stream, [...resources].sort(([a], [b]) => a.localeCompare(b)));
  await writeChunk(stream, ',"aliases":');
  await writeJsonEntries(stream, Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)));
  await writeChunk(stream, ',"owners":');
  await writeJsonEntries(stream, [...owners].sort(([a], [b]) => a.localeCompare(b)));
  await writeChunk(stream, ',"edges":');
  await writeJsonValues(stream, edges);
  await writeChunk(stream, ',"maps":');
  await writeJsonEntries(stream, Object.entries(maps).sort(([a], [b]) => a.localeCompare(b)));
  await writeChunk(stream, ',"reuse":{"resources":');
  await writeJsonValues(stream, reusedResources);
  await writeChunk(stream, '},"cooccurrence":');
  await writeJsonValues(stream, [...cooccurrence.values()].sort((a, b) => b.count - a.count || a.left.localeCompare(b.left)));
  await writeChunk(stream, `,"stats":${JSON.stringify(stats)},"warnings":`);
  await writeJsonValues(stream, warnings);
  await writeChunk(stream, '}');
  stream.end();
  await once(stream, 'finish');
  await fsp.rename(temporaryPath, outputPath);
} catch (error) {
  stream.destroy();
  await fsp.rm(temporaryPath, { force: true });
  throw error;
}
console.log(JSON.stringify({ output: relative(outputPath), scenes: sceneIds.length, resources: resources.size, materials: stats.materialResourceCount, bytes: stats.uniqueResourceBytes, warnings: warnings.length }, null, 2));
