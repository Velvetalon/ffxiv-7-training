#!/usr/bin/env node
/* Compare an exported scene against an independently exported raw LGB/SGB tree. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseCli } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'tools', 'map-tools', 'world-catalog.json');
const DEFAULT_RUNTIME = path.join(REPO_ROOT, 'public', 'extracted');
const DEFAULT_SOURCE = process.env.FFXIV_MAP_SOURCE || 'G:\\FFXIV-MapTools\\exports';
const DEFAULT_THRESHOLDS = { coordinate: 0.01, rotation: 0.001, scale: 0.001 };
const EVENT_LAYER = /(?:festival|season|event|halloween|christmas)/i;

function usage() {
  console.log(`Usage: node scripts/check-map-position.mjs <scene-id|all> [options]

Options:
  --source=DIR              Independent raw export root (default: FFXIV_MAP_SOURCE or G:\\FFXIV-MapTools\\exports)
  --runtime=DIR             Runtime/export root containing active.json (default: public/extracted)
  --runtime-state=FILE      Optional runtime mesh snapshot with sourceAsset/sourceInstanceIndices
  --focus=abnormal-only     Emit anomalies only (also accepts all)
  --out=FILE                Detail JSON path (default: work/map-position/check-map-position-<scene>.json)
  --coordinate-threshold=N  Position delta in world units (default: ${DEFAULT_THRESHOLDS.coordinate})
  --rotation-threshold=N    Rotation delta in radians (default: ${DEFAULT_THRESHOLDS.rotation})
  --scale-threshold=N       Absolute scale delta (default: ${DEFAULT_THRESHOLDS.scale})
`);
}

function parseArgs(argv) {
  const strings = ['source', 'runtime', 'runtime-state', 'focus', 'out',
    'coordinate-threshold', 'rotation-threshold', 'scale-threshold'];
  const parsed = parseCli({
    args: argv, allowPositionals: true,
    options: { help: { type: 'boolean' }, ...Object.fromEntries(strings.map(key => [key, { type: 'string' }])) },
  });
  return { scene: parsed.positionals[0] || 'all', values: new Map(Object.entries(parsed.values)) };
}

function option(values, key, fallback) {
  const value = values.get(key);
  return value === undefined || value === true || value === '' ? fallback : value;
}

function numberOption(values, key, fallback) {
  const value = Number(option(values, key, fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid --${key}: expected a non-negative number`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolve(value) {
  return path.resolve(value);
}

function normalizeVirtual(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function u32(data, offset) {
  if (offset < 0 || offset + 4 > data.length) throw new Error(`u32 out of bounds at ${offset}`);
  return data.readUInt32LE(offset);
}

function u16(data, offset) {
  if (offset < 0 || offset + 2 > data.length) throw new Error(`u16 out of bounds at ${offset}`);
  return data.readUInt16LE(offset);
}

function f32(data, offset) {
  if (offset < 0 || offset + 4 > data.length) throw new Error(`float out of bounds at ${offset}`);
  return data.readFloatLE(offset);
}

function text(data, offset) {
  if (offset <= 0 || offset >= data.length) return '';
  const end = data.indexOf(0, offset);
  return data.toString('utf8', offset, end < 0 ? data.length : end);
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(left, right) {
  return Array.from({ length: 16 }, (_, index) => {
    const column = Math.floor(index / 4);
    const row = index % 4;
    let value = 0;
    for (let k = 0; k < 4; k++) value += left[k * 4 + row] * right[column * 4 + k];
    return value;
  });
}

// FFXIV/Lumina stores Euler XYZ transforms. Keep this column-major formula in
// lockstep with tools/map-tools/verify_source_data.py.
function trs(item) {
  if (![...item.position, ...item.rotation, ...item.scale].every(Number.isFinite)) {
    throw new Error(`non-finite source transform: ${item.sourceFile || item.asset}`);
  }
  const [x, y, z] = item.rotation;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  const rx = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1];
  const ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
  const rz = [cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scale = [item.scale[0], 0, 0, 0, 0, item.scale[1], 0, 0, 0, 0, item.scale[2], 0, 0, 0, 0, 1];
  const result = multiply(multiply(multiply(rx, ry), rz), scale);
  result[12] = item.position[0]; result[13] = item.position[1]; result[14] = item.position[2];
  return result;
}

function readLayer(data, offset, sourceFile) {
  const nameOffset = u32(data, offset + 4);
  const objectsOffset = u32(data, offset + 8);
  const count = u32(data, offset + 12);
  const layer = { id: u32(data, offset), name: text(data, offset + nameOffset), festival: u16(data, offset + 24), objects: [] };
  for (let index = 0; index < count; index++) {
    const relative = u32(data, offset + objectsOffset + index * 4);
    const itemOffset = offset + objectsOffset + relative;
    const kind = u32(data, itemOffset);
    const instanceId = u32(data, itemOffset + 4);
    const itemName = u32(data, itemOffset + 8);
    const values = Array.from({ length: 9 }, (_, i) => f32(data, itemOffset + 12 + i * 4));
    const item = {
      kind,
      instanceId,
      name: text(data, itemOffset + itemName),
      position: values.slice(0, 3),
      rotation: values.slice(3, 6),
      scale: values.slice(6, 9),
      sourceFile,
      layer: layer.id,
      ordinal: index,
    };
    if (kind === 1 || kind === 6) {
      const assetOffset = u32(data, itemOffset + 48);
      item.asset = text(data, itemOffset + assetOffset);
    }
    layer.objects.push(item);
  }
  return layer;
}

function readLayout(file) {
  const data = fs.readFileSync(file);
  const sourceFile = normalizeVirtual(file);
  if (data.toString('ascii', 0, 4) === 'LGB1') {
    const count = u32(data, 32);
    return Array.from({ length: count }, (_, index) => readLayer(data, 36 + u32(data, 36 + index * 4), sourceFile));
  }
  if (data.toString('ascii', 0, 4) === 'SGB1') {
    const groupOffset = u32(data, 20);
    const groupCount = u32(data, 24);
    const layers = [];
    for (let group = 0; group < groupCount; group++) {
      const start = 20 + groupOffset + group * 4;
      const entriesOffset = u32(data, start + 8);
      const count = u32(data, start + 12);
      for (let index = 0; index < count; index++) {
        const layerOffset = start + entriesOffset + u32(data, start + entriesOffset + index * 4);
        layers.push(readLayer(data, layerOffset, sourceFile));
      }
    }
    return layers;
  }
  throw new Error(`${file}: unsupported layout header`);
}

function roundMatrix(matrix, digits = 4) {
  const scale = 10 ** digits;
  return matrix.map(value => Math.round(value * scale) / scale);
}

function matrixKey(matrix) {
  return roundMatrix(matrix).join(',');
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter(record => {
    const key = matrixKey(record.matrix);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findAetheryteVisual(sourceRoot) {
  const directory = path.join(sourceRoot, 'bgcommon', 'world', 'aet', 'shared', 'for_bg');
  const generic = path.join(directory, 'sgbg_w_aet_001_01a.sgb');
  if (fs.existsSync(generic)) return 'bgcommon/world/aet/shared/for_bg/sgbg_w_aet_001_01a.sgb';
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory).filter(name => name.toLowerCase().endsWith('.sgb'));
  return candidates.length === 1 ? `bgcommon/world/aet/shared/for_bg/${candidates[0]}` : null;
}

function expectedPlacements(sourceRoot, scene, sourceManifest) {
  const root = sourceManifest.root;
  const layoutPath = path.join(sourceRoot, root, 'level', 'bg.lgb');
  if (!fs.existsSync(layoutPath)) throw new Error(`missing raw source layout: ${normalizeVirtual(path.relative(sourceRoot, layoutPath))}`);
  const groups = new Map();
  const sharedCache = new Map();
  const add = (asset, record) => {
    if (!asset || !asset.endsWith('.mdl')) return;
    if (!groups.has(asset)) groups.set(asset, []);
    groups.get(asset).push(record);
  };
  const visit = (item, parent, trail, parentChain) => {
    const local = trs(item);
    const world = multiply(parent, local);
    const asset = normalizeVirtual(item.asset);
    if (item.kind === 1 && asset.endsWith('.mdl')) {
      add(asset, {
        asset,
        matrix: world,
        localMatrix: local,
        sourceFile: item.sourceFile,
        sourceInstanceId: item.instanceId,
        sourceLayer: item.layer,
        sourceOrdinal: item.ordinal,
        parentDepth: parentChain.length,
        parentChain,
      });
      return;
    }
    if (item.kind !== 6 || !asset.endsWith('.sgb') || trail.includes(asset)) return;
    const sgbPath = path.join(sourceRoot, asset);
    if (!sharedCache.has(asset)) sharedCache.set(asset, readLayout(sgbPath));
    for (const layer of sharedCache.get(asset)) {
      for (const child of layer.objects) visit(child, world, [...trail, asset], [
        ...parentChain,
        { asset, instanceId: item.instanceId, sourceFile: item.sourceFile, layer: item.layer },
      ]);
    }
  };
  for (const layer of readLayout(layoutPath)) {
    if (layer.festival !== 0 || EVENT_LAYER.test(layer.name)) continue;
    for (const item of layer.objects) visit(item, identity(), [], []);
  }
  for (const item of sourceManifest.layouts || []) {
    if (item.type !== 'TerrainPlate' || !item.model) continue;
    const asset = normalizeVirtual(item.model);
    const point = item.translation;
    add(asset, {
      asset,
      matrix: [...identity().slice(0, 12), point.X, point.Y, point.Z, 1],
      localMatrix: [...identity().slice(0, 12), point.X, point.Y, point.Z, 1],
      sourceFile: normalizeVirtual(item.source),
      sourceInstanceId: null,
      sourceLayer: null,
      sourceOrdinal: item.plateIndex,
      parentDepth: 0,
      parentChain: [],
    });
  }
  const aetheryte = (sourceManifest.layouts || []).find(item => item.type === 'Aetheryte');
  const visual = findAetheryteVisual(sourceRoot);
  if (aetheryte && visual) {
    const point = aetheryte.translation;
    const item = { kind: 6, asset: visual, instanceId: aetheryte.InstanceId, sourceFile: normalizeVirtual(aetheryte.source), layer: aetheryte.layer, ordinal: 0, position: [point.X, point.Y, point.Z], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const nested = [];
    const collect = (node, parent, trail, parentChain) => {
      const local = trs(node);
      const world = multiply(parent, local);
      const asset = normalizeVirtual(node.asset);
      if (node.kind === 1 && asset.endsWith('.mdl')) {
        nested.push({
          asset, matrix: world, localMatrix: local, sourceFile: node.sourceFile,
          sourceInstanceId: node.instanceId, sourceLayer: node.layer, sourceOrdinal: node.ordinal,
          parentDepth: parentChain.length, parentChain,
        });
      } else if (node.kind === 6 && asset.endsWith('.sgb') && !trail.includes(asset)) {
        const sgbPath = path.join(sourceRoot, asset);
        if (!sharedCache.has(asset)) sharedCache.set(asset, readLayout(sgbPath));
        for (const layer of sharedCache.get(asset)) for (const child of layer.objects)
          collect(child, world, [...trail, asset], [...parentChain, { asset, instanceId: node.instanceId, sourceFile: node.sourceFile, layer: node.layer }]);
      }
    };
    collect(item, identity(), [], []);
    for (const record of nested) add(record.asset, record);
  }
  return new Map([...groups].map(([asset, records]) => [asset, dedupeRecords(records)]));
}

function vectorLength(x, y, z) {
  return Math.hypot(x, y, z);
}

function rotationAngle(left, right) {
  const columns = matrix => [0, 1, 2].map(column => {
    const x = matrix[column * 4], y = matrix[column * 4 + 1], z = matrix[column * 4 + 2];
    const length = vectorLength(x, y, z);
    return length > 1e-9 ? [x / length, y / length, z / length] : null;
  });
  const a = columns(left), b = columns(right);
  if (a.some(value => !value) || b.some(value => !value)) return Number.POSITIVE_INFINITY;
  const trace = a.reduce((total, column, index) => total + column[0] * b[index][0] + column[1] * b[index][1] + column[2] * b[index][2], 0);
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
}

function metrics(expected, actual) {
  const coordinate = Math.hypot(actual[12] - expected[12], actual[13] - expected[13], actual[14] - expected[14]);
  const scale = Math.max(...[0, 1, 2].map(column => Math.abs(
    vectorLength(actual[column * 4], actual[column * 4 + 1], actual[column * 4 + 2]) -
    vectorLength(expected[column * 4], expected[column * 4 + 1], expected[column * 4 + 2]),
  )));
  return { coordinate, rotation: rotationAngle(expected, actual), scale };
}

function matrixDistance(left, right) {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index])));
}

function classify(expected, actual, delta, thresholds) {
  const classifications = [];
  if (delta.coordinate > thresholds.coordinate) classifications.push('coordinate');
  if (delta.rotation > thresholds.rotation) classifications.push('rotation');
  if (delta.scale > thresholds.scale) classifications.push('scale');
  if (expected.parentDepth > 0 && classifications.length && matrixDistance(expected.localMatrix, actual) <= Math.max(thresholds.coordinate, thresholds.scale, thresholds.rotation)) {
    classifications.unshift('parent');
  }
  return classifications;
}

function compactVector(matrix) {
  return matrix.slice(12, 15).map(value => Number(value.toFixed(6)));
}

function validMatrix(matrix) {
  return Array.isArray(matrix) && matrix.length === 16 && matrix.every(Number.isFinite);
}

function runtimePlacements(runtimeManifest, runtimeState, anomalies) {
  if (!runtimeState) {
    return new Map(runtimeManifest.models.map(model => [normalizeVirtual(model.asset), model.matrices.flatMap((matrix, index) => {
      if (validMatrix(matrix)) return [{ matrix, sourceIndex: index, runtimeSource: 'scene-manifest' }];
      anomalies.push({ classification: ['invalid-transform'], asset: model.asset, sourceIndex: index, reason: 'matrix must contain 16 finite numbers' });
      return [];
    })]));
  }
  const meshes = runtimeState.meshes || runtimeState.models || [];
  const result = new Map();
  for (const mesh of meshes) {
    const asset = normalizeVirtual(mesh.sourceAsset || mesh.asset || String(mesh.name || '').replace(/:lod$/, ''));
    const matrices = mesh.matrices || mesh.transforms || [];
    const indices = mesh.sourceInstanceIndices || mesh.instanceIndices || [];
    if (!asset || !matrices.length) continue;
    if (!result.has(asset)) result.set(asset, []);
    matrices.forEach((matrix, index) => {
      const sourceIndex = Number.isInteger(indices[index]) ? indices[index] : null;
      if (!validMatrix(matrix)) {
        anomalies.push({ classification: ['invalid-transform'], asset, sourceIndex, reason: 'matrix must contain 16 finite numbers' });
        return;
      }
      const records = result.get(asset);
      const existing = records.find(record => sourceIndex !== null
        ? record.sourceIndex === sourceIndex : matrixDistance(record.matrix, matrix) < 1e-7);
      if (existing) {
        if (matrixDistance(existing.matrix, matrix) > 1e-7) anomalies.push({
          classification: ['conflicting-transform'], asset, sourceIndex,
          reason: 'primitives with the same source instance disagree',
          expectedPosition: compactVector(existing.matrix), actualPosition: compactVector(matrix),
        });
        return;
      }
      records.push({ matrix, sourceIndex, runtimeSource: 'runtime-state' });
    });
  }
  return result;
}

function compareScene({ scene, catalogScene, sourceRoot, runtimeRoot, active, runtimeState, thresholds }) {
  const sourceDirectory = path.join(sourceRoot, scene);
  const sourceManifestPath = path.join(sourceDirectory, 'manifest.json');
  const runtimeDirectory = active?.scenes?.[scene]?.base
    ? path.resolve(runtimeRoot, active.scenes[scene].base)
    : path.join(runtimeRoot, scene);
  const runtimeManifestPath = path.join(runtimeDirectory, 'scene.json');
  const base = { scene, name: catalogScene.name || scene, source: { manifest: sourceManifestPath, clientVersion: null, independent: true }, runtime: { manifest: runtimeManifestPath }, anomalies: [] };
  if (!fs.existsSync(sourceManifestPath)) return { ...base, status: 'reference-unavailable', reason: 'missing source manifest' };
  if (!fs.existsSync(runtimeManifestPath)) return { ...base, status: 'runtime-unavailable', reason: 'missing runtime scene manifest' };
  if (samePath(sourceManifestPath, runtimeManifestPath)) return { ...base, status: 'reference-unavailable', reason: 'source and runtime manifest are the same file' };
  let sourceManifest;
  let runtimeManifest;
  try { sourceManifest = readJson(sourceManifestPath); runtimeManifest = readJson(runtimeManifestPath); }
  catch (error) { return { ...base, status: 'reference-unavailable', reason: `manifest parse failed: ${error.message}` }; }
  base.source.clientVersion = sourceManifest.gameVersion || sourceManifest.sourceVersion || null;
  base.source.layoutRoot = normalizeVirtual(sourceManifest.root);
  base.source.kind = 'rawLGB-SGB+terrain';
  let expected;
  try { expected = expectedPlacements(sourceDirectory, scene, sourceManifest); }
  catch (error) { return { ...base, status: 'reference-unavailable', reason: error.message }; }
  if (runtimeState && !fs.existsSync(runtimeState)) return { ...base, status: 'runtime-unavailable', reason: 'requested runtime snapshot does not exist' };
  const state = runtimeState ? readJson(runtimeState) : null;
  const actual = runtimePlacements(runtimeManifest, state, base.anomalies);
  const expectedAssets = new Set(expected.keys());
  const actualAssets = new Set(actual.keys());
  for (const asset of [...expectedAssets].filter(value => !actualAssets.has(value))) {
    base.anomalies.push({ classification: ['resource'], asset, resourceId: asset, reason: 'source placement resource is missing from runtime', expectedCount: expected.get(asset).length, actualCount: 0 });
  }
  for (const asset of [...actualAssets].filter(value => !expectedAssets.has(value))) {
    base.anomalies.push({ classification: ['resource'], asset, resourceId: asset, reason: 'runtime placement resource is absent from source reference', expectedCount: 0, actualCount: actual.get(asset).length });
  }
  let matched = 0;
  for (const [asset, sourceRecords] of expected) {
    const runtimeRecords = actual.get(asset) || [];
    const used = new Set();
    for (let sourceIndex = 0; sourceIndex < sourceRecords.length; sourceIndex++) {
      const sourceRecord = sourceRecords[sourceIndex];
      let actualIndex = -1;
      if (runtimeRecords.some(record => record.sourceIndex === sourceIndex)) actualIndex = runtimeRecords.findIndex(record => record.sourceIndex === sourceIndex);
      if (actualIndex < 0 && runtimeRecords[sourceIndex] && !used.has(sourceIndex)) actualIndex = sourceIndex;
      if (actualIndex < 0) {
        let best = Number.POSITIVE_INFINITY;
        runtimeRecords.forEach((record, index) => {
          if (used.has(index)) return;
          const score = matrixDistance(sourceRecord.matrix, record.matrix);
          if (score < best) { best = score; actualIndex = index; }
        });
      }
      if (actualIndex < 0 || !runtimeRecords[actualIndex]) continue;
      used.add(actualIndex); matched++;
      const actualRecord = runtimeRecords[actualIndex];
      const delta = metrics(sourceRecord.matrix, actualRecord.matrix);
      const classification = classify(sourceRecord, actualRecord.matrix, delta, thresholds);
      if (!classification.length) continue;
      base.anomalies.push({
        classification,
        asset,
        resourceId: asset,
        sourceIndex,
        sourceInstanceId: sourceRecord.sourceInstanceId,
        sourceFile: sourceRecord.sourceFile,
        parentDepth: sourceRecord.parentDepth,
        parentChain: sourceRecord.parentChain,
        expectedPosition: compactVector(sourceRecord.matrix),
        actualPosition: compactVector(actualRecord.matrix),
        delta: {
          coordinate: Number(delta.coordinate.toFixed(6)),
          rotation: Number(delta.rotation.toFixed(8)),
          scale: Number(delta.scale.toFixed(6)),
        },
        runtimeSource: actualRecord.runtimeSource,
      });
    }
    if (runtimeRecords.length !== sourceRecords.length && expectedAssets.has(asset) && actualAssets.has(asset)) {
      base.anomalies.push({ classification: ['resource'], asset, resourceId: asset, reason: 'placement count differs', expectedCount: sourceRecords.length, actualCount: runtimeRecords.length });
    }
  }
  base.stats = {
    expectedAssets: expected.size,
    runtimeAssets: actual.size,
    expectedPlacements: [...expected.values()].reduce((total, records) => total + records.length, 0),
    runtimePlacements: [...actual.values()].reduce((total, records) => total + records.length, 0),
    matchedPlacements: matched,
  };
  base.status = base.anomalies.length ? 'abnormal' : 'pass';
  return base;
}

function detailPath(value, scene) {
  return resolve(value || path.join(REPO_ROOT, 'work', 'map-position', `check-map-position-${scene.replace(/[^A-Za-z0-9._-]/g, '_')}.json`));
}

function main() {
  const { scene, values } = parseArgs(process.argv.slice(2));
  if (values.has('help')) { usage(); return 0; }
  const runtimeRoot = resolve(option(values, 'runtime', DEFAULT_RUNTIME));
  const requestedSource = resolve(option(values, 'source', DEFAULT_SOURCE));
  const sourceRoot = fs.existsSync(requestedSource) ? requestedSource : resolve(path.join(REPO_ROOT, 'tools', 'map-tools', 'exports'));
  const focus = option(values, 'focus', 'abnormal-only');
  const thresholds = {
    coordinate: numberOption(values, 'coordinate-threshold', DEFAULT_THRESHOLDS.coordinate),
    rotation: numberOption(values, 'rotation-threshold', DEFAULT_THRESHOLDS.rotation),
    scale: numberOption(values, 'scale-threshold', DEFAULT_THRESHOLDS.scale),
  };
  if (!fs.existsSync(CATALOG_PATH)) throw new Error(`Missing catalog: ${CATALOG_PATH}`);
  const catalog = readJson(CATALOG_PATH);
  const scenes = new Map(catalog.scenes.map(item => [item.id, item]));
  const selected = scene === 'all' ? [...scenes.keys()] : [scene];
  const unknown = selected.filter(id => !scenes.has(id));
  if (unknown.length) throw new Error(`Unknown catalog scene: ${unknown.join(', ')}`);
  const activePath = path.join(runtimeRoot, 'active.json');
  const active = fs.existsSync(activePath) ? readJson(activePath) : null;
  const runtimeState = option(values, 'runtime-state', null);
  if (runtimeState && selected.length !== 1) throw new Error('--runtime-state requires one scene ID');
  const maps = selected.map(id => compareScene({
    scene: id,
    catalogScene: scenes.get(id),
    sourceRoot,
    runtimeRoot,
    active,
    runtimeState: runtimeState ? resolve(runtimeState) : null,
    thresholds,
  }));
  const summary = {
    schemaVersion: 1,
    status: maps.some(map => map.status === 'reference-unavailable' || map.status === 'runtime-unavailable') ? 'reference-unavailable' : maps.some(map => map.status === 'abnormal') ? 'abnormal' : 'pass',
    requested: scene,
    checkedMaps: maps.filter(map => map.status === 'pass' || map.status === 'abnormal').length,
    totalMaps: maps.length,
    abnormalMaps: maps.filter(map => map.status === 'abnormal').length,
    referenceUnavailable: maps.filter(map => map.status === 'reference-unavailable').map(map => ({ scene: map.scene, reason: map.reason })),
    runtimeUnavailable: maps.filter(map => map.status === 'runtime-unavailable').map(map => ({ scene: map.scene, reason: map.reason })),
    anomalyCount: maps.reduce((total, map) => total + map.anomalies.length, 0),
    classifications: maps.flatMap(map => map.anomalies).flatMap(anomaly => anomaly.classification).reduce((counts, type) => ({ ...counts, [type]: (counts[type] || 0) + 1 }), {}),
    sourceRoot,
    runtimeRoot,
    thresholds,
    independentReference: !samePath(sourceRoot, runtimeRoot),
  };
  const detail = { ...summary, focus, maps: focus === 'abnormal-only' ? maps.filter(map => map.status !== 'pass') : maps };
  const output = detailPath(option(values, 'out', null), scene);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(detail, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ...summary, detailFile: output, anomaliesTruncated: summary.anomalyCount > 20,
    anomalies: maps.flatMap(map => map.anomalies.slice(0, 20).map(anomaly => ({
      scene: map.scene, asset: anomaly.asset, classification: anomaly.classification,
      expectedPosition: anomaly.expectedPosition, actualPosition: anomaly.actualPosition, delta: anomaly.delta,
    }))).slice(0, 20),
  }, null, 2));
  return summary.status === 'pass' ? 0 : summary.status === 'abnormal' ? 1 : 2;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error.message);
  usage();
  process.exitCode = 2;
}
