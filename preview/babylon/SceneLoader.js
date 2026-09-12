import {
  Matrix,
  Quaternion,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { SceneLoader as BabylonSceneLoader } from '@babylonjs/core/Loading/sceneLoader.js';
import '@babylonjs/loaders/glTF/index.js';
import '@babylonjs/core/Meshes/meshLODLevel.js';
import { createLodBuilder } from './LodBuilder.js';

const DEFAULT_CELL_SIZE = 128;
const DEFAULT_WORKERS = 4;
const DEFAULT_BOOTSTRAP_RADIUS = 35;

function asByteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Babylon GLB loader expected an ArrayBuffer or typed array');
}

function asMatrix(values, instanceIndex = -1, modelIndex = -1) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new Error(`Invalid source transform for model ${modelIndex}, instance ${instanceIndex}: expected 16 column-major values`);
  }
  if (values.length !== 16 || [...values].some(value => !Number.isFinite(value))) {
    throw new Error(`Invalid source transform for model ${modelIndex}, instance ${instanceIndex}: expected 16 finite column-major values`);
  }
  // The source manifest is column-major, which matches Babylon's Matrix storage.
  return Matrix.FromArray(values);
}

function matrixPosition(matrix) {
  const values = matrix.m;
  return new Vector3(values[12], values[13], values[14]);
}

function determinantSign(matrix) {
  return matrix.determinant() < 0 ? 'negative' : 'positive';
}

function cellFor(position, cellSize) {
  return `${Math.floor(position.x / cellSize)}:${Math.floor(position.z / cellSize)}`;
}

function distanceSquaredToRecord(record, position) {
  const bounds = record.instanceBounds;
  if (!bounds?.length) {
    const matrices = record.matrices || [];
    if (!matrices.length) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (const values of matrices) {
      const matrix = asMatrix(values);
      const p = matrixPosition(matrix);
      sum += Vector3.DistanceSquared(p, position);
    }
    return sum / matrices.length;
  }
  let best = Number.POSITIVE_INFINITY;
  for (const bound of bounds) {
    const min = bound.min || bound[0];
    const max = bound.max || bound[1];
    if (!min || !max) continue;
    const dx = position.x < min[0] ? min[0] - position.x : position.x > max[0] ? position.x - max[0] : 0;
    const dy = position.y < min[1] ? min[1] - position.y : position.y > max[1] ? position.y - max[1] : 0;
    const dz = position.z < min[2] ? min[2] - position.z : position.z > max[2] ? position.z - max[2] : 0;
    best = Math.min(best, dx * dx + dy * dy + dz * dz);
  }
  return best;
}

function gltfExtras(mesh) {
  const metadata = mesh?.metadata;
  const candidates = [
    metadata?.gltf?.extras,
    metadata?.gltfMetadata?.extras,
    metadata?.gltf?.node?.extras,
    metadata?.gltfMetadata?.node?.extras,
    metadata?.extras,
  ];
  return candidates.find(value => value && typeof value === 'object') || {};
}

function materialDescriptor(manifest, resourceId) {
  const resource = manifest?.resources?.[resourceId];
  if (!resource) return null;
  return {
    resourceId,
    ...resource.metadata?.descriptor,
    metadata: resource.metadata || {},
    canonical: resource.metadata?.canonical || null,
  };
}

async function callMaterialAdapter(adapter, mesh, context) {
  if (!adapter) return;
  if (typeof adapter.getMaterial === 'function' && context.materialPath) {
    const material = await adapter.getMaterial(context.materialPath, mesh, {
      priority: context.priority ?? 0,
      preview: context.preview !== false,
    });
    if (material) mesh.material = material;
    context.environmentAdapter?.applyToMaterial?.(mesh.material);
    return material;
  }
  const methods = ['applyToMesh', 'applyMaterial', 'adaptMesh', 'adapt'];
  for (const name of methods) {
    if (typeof adapter[name] !== 'function') continue;
    const result = await adapter[name](mesh, context);
    if (result?.material) mesh.material = result.material;
    else if (result && result !== mesh && result.isMaterial) mesh.material = result;
    return result;
  }
}

async function queueGpu(queue, task, priority = 0) {
  if (!queue) return task();
  if (typeof queue.enqueue === 'function') return queue.enqueue(task, { priority });
  if (typeof queue.schedule === 'function') return queue.schedule(task, { priority });
  if (typeof queue.run === 'function') return queue.run(task, { priority });
  return task();
}

function receivesOpaqueShadows(mesh) {
  const material = mesh?.material;
  if (!material) return false;
  // Alpha-tested grates still receive shadows. Only blended materials such as
  // water and particles are excluded from the native opaque receiver path.
  return !material.needAlphaBlending?.();
}

function applyWorldMatrix(mesh, matrix) {
  // Keep the complete source matrix. Decomposing a rotated non-uniform scale
  // into TRS can discard shear and changes the authored placement.
  mesh.freezeWorldMatrix(matrix.clone(), false);
}

function normalizeBytes(value) {
  if (value && typeof value === 'object' && 'bytes' in value) return value.bytes;
  return value;
}

function priorityForRecord(record, position) {
  // Both AssetRuntime's fetch scheduler and GpuUploadQueue sort ascending.
  return Math.min(1000000, Math.max(0, Math.floor(distanceSquaredToRecord(record, position))));
}

function multiplyColumnMajor(left, right) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}

function transformColumnMajor(matrix, point) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const divisor = w && w !== 1 ? w : 1;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor,
  ];
}

/**
 * Babylon-only map loader. Asset bytes and metadata remain owned by BabylonAssets;
 * this module only creates Babylon containers, geometry instances and scene nodes.
 */
export function createBabylonMapLoader({
  scene,
  assets,
  materialAdapter = null,
  environmentAdapter = null,
  gpuQueue = null,
  root: rootNode = null,
  cellSize = DEFAULT_CELL_SIZE,
  workers = DEFAULT_WORKERS,
  bootstrapRadius = DEFAULT_BOOTSTRAP_RADIUS,
  onProgress = () => {},
  onError = () => {},
} = {}) {
  if (!scene) throw new Error('createBabylonMapLoader requires a Babylon scene');
  if (!assets?.load) throw new Error('createBabylonMapLoader requires BabylonAssets');

  const mapId = assets.mapId || assets.config?.mapId || 'unknown';
  const map = assets.map;
  const legacy = assets.legacy || map?.legacyManifest;
  const manifest = assets.manifest;
  if (!map || !legacy) throw new Error(`Map metadata is unavailable for ${mapId}`);

  const cameraPosition = new Vector3(...(legacy.training?.spawn
    ? [legacy.training.spawn.x, legacy.training.spawn.y, legacy.training.spawn.z]
    : legacy.spawn || [0, 0, 0]));
  const templates = new Map();
  const lodSources = new Map();
  const lodBuilder = createLodBuilder({ onError });
  const records = [];
  const cells = new Map();
  const failures = [];
  const resourcePromises = new Map();
  const pending = [];
  let disposed = false;
  const state = {
    phase: 'created',
    totalModels: 0,
    loadedModels: 0,
    instantiatedModels: 0,
    sourcePlacementCount: 0,
    renderedPrimitiveCount: 0,
    instanceCount: 0,
    meshCount: 0,
    triangleCount: 0,
    bootstrapCount: 0,
    remaining: 0,
    failures,
    cells,
    sourceInstanceIndices: [],
    runtimeWorldMatrices: [],
    runtimePlacements: new Map(),
    transformProofs: [],
    lod: {
      enabled: true,
      pending: 0,
      completed: 0,
      skipped: 0,
      failures: [],
      distances: [65, 150],
      hysteresis: 0.12,
      source: 'src/world/imported/LodSimplifier.js',
      sourceWorker: 'src/world/imported/LodWorker.js',
      reason: 'Native Babylon indexed LOD variants retain original vertex attributes and materials',
    },
  };

  const modelEntries = map.models || [];
  for (let index = 0; index < modelEntries.length; index += 1) {
    const mapModel = modelEntries[index] || {};
    const modelIndex = Number.isInteger(mapModel.index) ? mapModel.index : index;
    const legacyModel = legacy.models?.[modelIndex] || {};
    const resourceId = mapModel.resourceId || map.paths?.[legacyModel.url] || null;
    records.push({
      index: modelIndex,
      id: mapModel.id || `scene-model:${mapId}:${modelIndex}`,
      resourceId,
      asset: legacyModel.asset || '',
      matrices: legacyModel.matrices || [],
      instanceBounds: mapModel.instanceBounds || [],
      materialResources: mapModel.materialResources || [],
      loaded: false,
      instantiated: false,
      failed: false,
      missingResource: !resourceId,
    });
  }
  state.totalModels = records.length;

  const bootstrapIndices = new Set(
    map.bootstrap?.modelIndices?.filter(index => records.some(record => record.index === index)) || [],
  );
  if (!bootstrapIndices.size) {
    const radiusSquared = bootstrapRadius * bootstrapRadius;
    for (const record of records) {
      if (distanceSquaredToRecord(record, cameraPosition) <= radiusSquared) bootstrapIndices.add(record.index);
    }
  }
  state.bootstrapCount = bootstrapIndices.size;
  for (const record of records) {
    record.bootstrap = bootstrapIndices.has(record.index);
    if (!bootstrapIndices.has(record.index)) pending.push(record);
  }
  state.remaining = pending.length;

  function report(extra = {}) {
    state.remaining = pending.length;
    onProgress({ ...state, ...extra, failures: failures.slice() });
  }

  function createCell(record, sourceMatrix, instanceIndex) {
    if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
    const position = matrixPosition(sourceMatrix);
    const sign = determinantSign(sourceMatrix);
    const key = `${cellFor(position, cellSize)}:${sign}`;
    let cell = cells.get(key);
    if (!cell) {
      const cellRoot = new TransformNode(`${mapId}:Cell:${key}`, scene);
      cellRoot.metadata = { ff14: { kind: 'spatial-cell', key, cellSize, determinantSign: sign } };
      cell = { key, root: cellRoot, sign, instances: 0, modelIndices: new Set() };
      cells.set(key, cell);
      if (rootNode) cellRoot.parent = rootNode;
    }
    cell.instances += 1;
    cell.modelIndices.add(record.index);
    return cell;
  }

  async function loadTemplate(record) {
    if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
    if (templates.has(record.resourceId)) return templates.get(record.resourceId);
    if (resourcePromises.has(record.resourceId)) return resourcePromises.get(record.resourceId);

    const promise = (async () => {
      if (!record.resourceId) {
        throw new Error(`Missing GLB resource for model ${record.index} (${record.asset || 'unknown asset'})`);
      }
      const bytes = normalizeBytes(await assets.load(record.resourceId, {
        priority: priorityForRecord(record, cameraPosition),
        signal: assets.signal,
      }));
      const container = await BabylonSceneLoader.LoadAssetContainerAsync(
        'data:',
        asByteView(bytes),
        scene,
        undefined,
        '.glb',
      );
      if (disposed) {
        container.dispose();
        throw new DOMException('Babylon map loader disposed', 'AbortError');
      }
      const unresolvedMaterials = record.materialResources.filter(id => !manifest?.resources?.[id]);
      if (unresolvedMaterials.length) {
        throw new Error(`Missing material resources for model ${record.index}: ${unresolvedMaterials.join(', ')}`);
      }
      const descriptors = record.materialResources.map(id => materialDescriptor(manifest, id));
      const meshes = [];
      for (const mesh of container.meshes || []) {
        if (typeof mesh.getTotalVertices === 'function' && mesh.getTotalVertices() === 0) continue;
        const templateWorld = mesh.computeWorldMatrix(true).clone();
        const extras = gltfExtras(mesh);
        const metadata = {
          modelIndex: record.index,
          resourceId: record.resourceId,
          asset: record.asset,
          materialResources: record.materialResources.slice(),
          materialDescriptors: descriptors,
          materialPath: extras.materialPath || descriptors[0]?.materialPath || null,
          sourceMatrixLayout: 'column-major',
          templateWorldMatrix: Array.from(templateWorld.m),
        };
        mesh.metadata = { ...(mesh.metadata || {}), ff14: metadata };
        await callMaterialAdapter(materialAdapter, mesh, {
          scene,
          assets,
          manifest,
          map,
          legacy,
          record,
          descriptors,
          materialPath: metadata.materialPath,
          environmentAdapter,
          priority: priorityForRecord(record, cameraPosition),
          preview: true,
        });
        mesh.receiveShadows = receivesOpaqueShadows(mesh);
        // Flatten the template node. Every instance receives exactly one composed
        // source*template world matrix below, avoiding parent or offset duplication.
        mesh.parent = null;
        mesh.position.set(0, 0, 0);
        mesh.rotationQuaternion = Quaternion.Identity();
        mesh.scaling.set(1, 1, 1);
        mesh.isVisible = false;
        mesh.setEnabled(false);
        meshes.push({ mesh, templateWorld, metadata });
      }
      for (const root of container.rootNodes || []) root.setEnabled(false);
      if (disposed) {
        container.dispose();
        throw new DOMException('Babylon map loader disposed', 'AbortError');
      }
      const template = { container, meshes };
      templates.set(record.resourceId, template);
      return template;
    })();
    resourcePromises.set(record.resourceId, promise);
    try {
      return await promise;
    } finally {
      resourcePromises.delete(record.resourceId);
    }
  }

  function attachLodLevels(source, levels) {
    if (disposed) return;
    const entries = levels.map((level, index) => {
      const mesh = source.clone(`${source.name}:lod${index + 1}`, null, true);
      if (!mesh) throw new Error(`Unable to clone native LOD mesh for ${source.name}`);
      mesh.parent = null;
      mesh.makeGeometryUnique();
      mesh.setIndices(level.indices, undefined, true);
      mesh.isVisible = false;
      mesh.setEnabled(false);
      return { distance: lodBuilder.levels[index].distance, mesh };
    });
    lodSources.set(source, entries);
    if (state.lod.enabled) {
      for (const entry of entries) source.addLODLevel(entry.distance, entry.mesh);
    }
  }

  function scheduleLod(template, record) {
    if (!template || record.lodScheduled) return;
    record.lodScheduled = true;
    for (const entry of template.meshes) {
      state.lod.pending += 1;
      void lodBuilder.simplify(entry.mesh).then(levels => {
        if (!levels.length) {
          state.lod.skipped += 1;
          return;
        }
        attachLodLevels(entry.mesh, levels);
        state.lod.completed += 1;
      }).catch(error => {
        // Full source geometry remains active; errors are retained for QA.
        state.lod.failures.push({ modelIndex: record.index, mesh: entry.mesh.name, message: error.message });
        onError(error, record);
      }).finally(() => {
        state.lod.pending -= 1;
        report({ current: record.index, lod: true });
      });
    }
  }

  async function instantiate(record, template) {
    if (record.instantiated) return;
    if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
    const maybeRecordTransformProof = (entry, sourceMatrix, runtimeWorld, cell, instanceIndex) => {
      if (state.transformProofs.length >= 32) return;
      const hasSign = state.transformProofs.some(proof => proof.determinantSign === cell.sign);
      if (hasSign && state.transformProofs.length >= 8) return;
      const positions = entry.mesh.getVerticesData?.('position');
      if (!positions || positions.length < 3) return;
      const localVertices = [];
      const expectedWorldVertices = [];
      const runtimeWorldVertices = [];
      const expectedWorldMatrix = multiplyColumnMajor(Array.from(sourceMatrix.m), Array.from(entry.templateWorld.m));
      const runtimeWorldMatrix = Array.from(runtimeWorld.m);
      const vertexCount = Math.min(3, Math.floor(positions.length / 3));
      let maxError = 0;
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const local = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
        const expected = transformColumnMajor(expectedWorldMatrix, local);
        const actual = Vector3.TransformCoordinates(Vector3.FromArray(local), runtimeWorld).asArray();
        localVertices.push(local);
        expectedWorldVertices.push(expected);
        runtimeWorldVertices.push(actual);
        maxError = Math.max(maxError, ...actual.map((value, index) => Math.abs(value - expected[index])));
      }
      state.transformProofs.push({
        sourceAsset: record.asset,
        modelIndex: record.index,
        sourceInstanceIndex: instanceIndex,
        determinantSign: cell.sign,
        localVertices,
        expectedWorldVertices,
        runtimeWorldVertices,
        expectedWorldMatrix,
        runtimeWorldMatrix,
        maxError,
      });
    };
    await queueGpu(gpuQueue, async () => {
      if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
      const matrices = record.matrices.map((values, instanceIndex) => asMatrix(values, instanceIndex, record.index));
      for (const entry of template.meshes) {
        for (let instanceIndex = 0; instanceIndex < matrices.length; instanceIndex += 1) {
          const sourceMatrix = matrices[instanceIndex];
          // Babylon documents A.multiply(B) as applying B to A (result = B x A).
          // Apply the GLB primitive-local transform first, then the source world
          // matrix, so a source translation remains the manifest translation.
          const worldMatrix = entry.templateWorld.multiply(sourceMatrix);
          const cell = createCell(record, sourceMatrix, instanceIndex);
          // Regular Babylon instances retain per-instance frustum selection and
          // correctly handle mirrored determinants without thin-instance mixing.
          const instance = entry.mesh.createInstance(
            `${mapId}:${record.index}:${instanceIndex}:${entry.mesh.uniqueId}:${cell.key}`,
          );
          if (!instance) throw new Error(`Unable to create Babylon instance for model ${record.index}, instance ${instanceIndex}`);
          instance.parent = cell.root;
          instance.metadata = {
            ...(instance.metadata || {}),
            ff14: {
              ...(entry.metadata || {}),
              sourceAsset: record.asset,
              instanceIndex,
              sourceInstanceIndex: instanceIndex,
              determinantSign: cell.sign,
              spatialCell: cell.key,
              sourceMatrix: Array.from(sourceMatrix.m),
            },
          };
          applyWorldMatrix(instance, worldMatrix);
          instance.isVisible = true;
          instance.setEnabled(true);
          instance.receiveShadows = entry.mesh.receiveShadows;
          const runtimeWorld = instance.getWorldMatrix().clone();
          instance.metadata.ff14.worldMatrix = Array.from(runtimeWorld.m);
          maybeRecordTransformProof(entry, sourceMatrix, runtimeWorld, cell, instanceIndex);
          const placementKey = `${record.index}:${instanceIndex}`;
          if (!state.runtimePlacements.has(placementKey)) {
            const actualWorld = Array.from(runtimeWorld.m);
            state.runtimePlacements.set(placementKey, {
              sourceAsset: record.asset,
              modelIndex: record.index,
              sourceInstanceIndex: instanceIndex,
              matrix: actualWorld,
            });
            state.sourcePlacementCount += 1;
            state.sourceInstanceIndices.push({ modelIndex: record.index, instanceIndex });
            state.runtimeWorldMatrices.push({ modelIndex: record.index, instanceIndex, matrix: actualWorld });
          }
          state.instanceCount += 1;
          state.meshCount += 1;
          state.renderedPrimitiveCount += 1;
          const indices = typeof instance.getTotalIndices === 'function' ? instance.getTotalIndices() : 0;
          state.triangleCount += Math.floor(indices / 3);
        }
        environmentAdapter?.addShadowCaster?.(entry.mesh);
      }
    }, priorityForRecord(record, cameraPosition));
    record.instantiated = true;
    state.instantiatedModels += 1;
  }

  async function performLoadRecord(record) {
    if (disposed) return record;
    if (record.loaded && record.instantiated) return record;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (disposed) return record;
        const template = await loadTemplate(record);
        record.template = template;
        record.loaded = true;
        await instantiate(record, template);
        if (!record.loadedReported) {
          record.loadedReported = true;
          state.loadedModels += 1;
        }
        if (state.phase !== 'bootstrap') scheduleLod(template, record);
        report({ current: record.index });
        return record;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
    record.failed = true;
    failures.push({ index: record.index, resourceId: record.resourceId, message: lastError?.message || String(lastError) });
    onError(lastError, record);
    report({ current: record.index });
    return record;
  }

  function loadRecord(record) {
    if (record.loadPromise) return record.loadPromise;
    record.loadPromise = performLoadRecord(record).finally(() => { record.loadPromise = null; });
    return record.loadPromise;
  }

  async function loadBootstrap() {
    if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
    state.phase = 'bootstrap';
    report();
    const bootstrap = records.filter(record => bootstrapIndices.has(record.index));
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < bootstrap.length) {
        const record = bootstrap[cursor++];
        await loadRecord(record);
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, Math.max(1, bootstrap.length)) }, runWorker));
    state.bootstrapFailures = failures.filter(failure => bootstrapIndices.has(failure.index));
    state.bootstrapRenderable = state.instantiatedModels > 0 && state.meshCount > 0;
    state.phase = 'interactive';
    for (const record of bootstrap) scheduleLod(record.template, record);
    report();
    return state;
  }

  let streamPromise = null;
  async function loadRemaining() {
    if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
    if (streamPromise) return streamPromise;
    streamPromise = (async () => {
      state.phase = 'streaming';
      report();
      const runWorker = async () => {
        while (pending.length) {
          pending.sort((a, b) => distanceSquaredToRecord(a, cameraPosition) - distanceSquaredToRecord(b, cameraPosition));
          const record = pending.shift();
          if (record) await loadRecord(record);
        }
      };
      await Promise.all(Array.from({ length: Math.min(workers, Math.max(1, pending.length)) }, runWorker));
      state.phase = failures.length ? 'complete-with-errors' : 'complete';
      report();
      return state;
    })();
    return streamPromise;
  }

  function setCameraPosition(position) {
    if (position?.clone) cameraPosition.copyFrom(position);
    else if (Array.isArray(position)) cameraPosition.set(position[0] || 0, position[1] || 0, position[2] || 0);
  }

  function isLocationReady(position, radius = bootstrapRadius) {
    const source = position?.clone ? position : Vector3.FromArray(position || [0, 0, 0]);
    const radiusSquared = radius * radius;
    return records.every(record => distanceSquaredToRecord(record, source) > radiusSquared || record.instantiated);
  }

  async function ensureLocation(position, radius = bootstrapRadius) {
    if (disposed) throw new DOMException('Babylon map loader disposed', 'AbortError');
    setCameraPosition(position);
    const radiusSquared = radius * radius;
    const needed = records
      .filter(record => !record.instantiated && distanceSquaredToRecord(record, cameraPosition) <= radiusSquared)
      .sort((left, right) => distanceSquaredToRecord(left, cameraPosition) - distanceSquaredToRecord(right, cameraPosition));
    for (const record of needed) {
      const index = pending.indexOf(record);
      if (index >= 0) pending.splice(index, 1);
    }
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < needed.length) await loadRecord(needed[cursor++]);
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, needed.length)) }, runWorker));
    return isLocationReady(position, radius);
  }

  function diagnostics({ includeTransforms = false } = {}) {
    const result = {
      mapId,
      territoryId: legacy.territoryId,
      modelCount: records.length,
      transformCount: records.reduce((sum, record) => sum + record.matrices.length, 0),
      loadedModels: state.loadedModels,
      instantiatedModels: state.instantiatedModels,
      instanceCount: state.instanceCount,
      sourcePlacementCount: state.sourcePlacementCount,
      renderedPrimitiveCount: state.renderedPrimitiveCount,
      meshCount: state.meshCount,
      triangleCount: state.triangleCount,
      lod: { ...state.lod, distances: state.lod.distances.slice(), failures: state.lod.failures.slice() },
      batchSourceCount: templates.size,
      spatialCellCount: cells.size,
      cellSize,
      bootstrapModelCount: bootstrapIndices.size,
      bootstrapRenderable: Boolean(state.bootstrapRenderable),
      bootstrapFailures: [...(state.bootstrapFailures || [])],
      remainingModelCount: pending.length,
      failures: failures.slice(),
      determinantGroups: [...cells.values()].reduce((result, cell) => {
        result[cell.sign] = (result[cell.sign] || 0) + 1;
        return result;
      }, {}),
    };
    if (includeTransforms) {
      result.sourceInstanceIndices = state.sourceInstanceIndices.slice();
      result.runtimeWorldMatrices = state.runtimeWorldMatrices.slice();
      result.transformProofs = state.transformProofs.slice();
    }
    return result;
  }

  return {
    map,
    legacy,
    manifest,
    records,
    state,
    loadBootstrap,
    loadRemaining,
    loadAll: loadRemaining,
    setCameraPosition,
    isLocationReady,
    ensureLocation,
    setLodEnabled(enabled) {
      const active = Boolean(enabled);
      if (state.lod.enabled === active) return active;
      state.lod.enabled = active;
      for (const [source, levels] of lodSources) {
        if (active) {
          for (const entry of levels) source.addLODLevel(entry.distance, entry.mesh);
        } else {
          for (const entry of levels) source.removeLODLevel(entry.mesh);
        }
      }
      report({ lod: true });
      return active;
    },
    runtimeSnapshot() {
      const grouped = new Map();
      for (const placement of state.runtimePlacements.values()) {
        if (!grouped.has(placement.sourceAsset)) {
          grouped.set(placement.sourceAsset, { sourceAsset: placement.sourceAsset, matrices: [], sourceInstanceIndices: [] });
        }
        const mesh = grouped.get(placement.sourceAsset);
        mesh.matrices.push(placement.matrix.slice());
        mesh.sourceInstanceIndices.push(placement.sourceInstanceIndex);
      }
      return { meshes: [...grouped.values()] };
    },
    getSpatialRoots() {
      return [...cells.values()].map(cell => cell.root);
    },
    diagnostics,
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.length = 0;
      for (const cell of cells.values()) cell.root.dispose(false, true);
      for (const template of templates.values()) {
        template.container.dispose();
      }
      cells.clear();
      templates.clear();
      lodSources.clear();
      lodBuilder.dispose();
    },
  };
}

export default createBabylonMapLoader;
