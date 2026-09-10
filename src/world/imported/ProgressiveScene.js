import * as THREE from 'three';
import { ClientMaterials } from './ClientMaterials.js';
import { MeshNavigation } from './MeshNavigation.js';
import { mapAssetRuntime as runtime } from '../../assets/MapAssets.js';
import { assetProfiler } from '../../assets/AssetProfiler.js';
import { disposeObject } from '../assets.js';
import { StreamingNavigation } from './StreamingNavigation.js';
import { decompressGzip } from '../../assets/Decompress.js';

runtime.decoder('navigation', async (_, record, store, options) => {
  const payload = store.get(record.dependencies[0]);
  if (!payload) throw new Error(`Collision dependency is not retained: ${record.dependencies[0]}`);
  const meta = record.metadata;
  assetProfiler.mark('collision:decode:start');
  const bytes = meta.encoding === 'gzip'
    ? await decompressGzip(payload)
    : payload.slice(0);
  if (bytes.byteLength !== meta.bytes) throw new Error('Collision byte count mismatch');
  assetProfiler.mark('collision:decode:complete', { bytes: bytes.byteLength });
  options.signal?.throwIfAborted();
  assetProfiler.mark('bvh:start');
  const navigation = await MeshNavigation.create(new Float32Array(bytes));
  navigation.assetRuntimeOwned = true;
  record.runtimeBytes = bytes.byteLength + navigation.geometry.index.array.byteLength;
  assetProfiler.mark('bvh:complete');
  return navigation;
}, navigation => navigation.dispose());

export async function loadProgressiveScene(id, map, { entry = {}, renderer, onProgress = () => {} } = {}) {
  const manifest = map.legacyManifest;
  const controller = new AbortController();
  const signal = controller.signal;
  const group = new THREE.Group();
  group.name = `client-map-${id}`;
  const retained = new Set();
  const completed = new Set();
  const pending = new Map();
  const enhancementQueue = [];
  const queuedMaterials = new Set();
  let wakeEnhancements = () => {};
  const materials = new ClientMaterials('', manifest, { runtime, paths: map.paths, signal, mapId: id });
  const connection = entry.arrivalConnection ? manifest.connections?.find(item => item.id === entry.arrivalConnection) : null;
  let center = entry.arrival || connection?.spawn || connection?.position || manifest.training?.spawn || manifest.spawn || manifest.aetheryte;
  if (!Array.isArray(center)) center = [center.x, center.y, center.z];
  const options = priority => ({ signal, mapId: id, priority });
  const retain = async (resource, priority) => {
    const value = await runtime.load(resource, options(priority));
    if (signal.aborted) {
      runtime.release(resource);
      signal.throwIfAborted();
    }
    if (retained.has(resource)) runtime.release(resource);
    else retained.add(resource);
    return value;
  };
  const collision = map.paths[manifest.collisionFile || 'collision.bin'];
  let streamingNavigation;
  const navigationResource = (resource, encoding, bytes, priority) => {
    const id = `navigation:${resource}`;
    runtime.registry.register(id, {
      type: 'navigation', hash: resource, virtual: true, size: 0, dependencies: [resource],
      metadata: { encoding, bytes },
    });
    return retain(id, priority);
  };
  const navigationTask = map.collisionChunks?.length ? (async () => {
    streamingNavigation = new StreamingNavigation(map.collisionBounds, map.collisionChunks, (chunk, priority) => {
      const resource = runtime.registry.get(chunk.resourceId);
      return navigationResource(chunk.resourceId, resource.metadata.encoding, resource.metadata.rawBytes, priority);
    });
    const training = manifest.training?.spawn || manifest.spawn || manifest.aetheryte;
    const trainingPoint = Array.isArray(training) ? training : [training.x, training.y, training.z];
    await streamingNavigation.ensure(center);
    // Existing encounters remain at the source training area when arriving at a portal.
    await streamingNavigation.ensure(trainingPoint);
    return streamingNavigation;
  })() : navigationResource(collision, manifest.collisionEncoding, manifest.collisionBytes, -10);
  navigationTask.catch(() => {});
  const near = (model, point, radius) => model.instanceBounds.some(bounds =>
    bounds.min[0] <= point[0] + radius && bounds.max[0] >= point[0] - radius &&
    bounds.min[2] <= point[2] + radius && bounds.max[2] >= point[2] - radius &&
    bounds.min[1] <= point[1] + 80 && bounds.max[1] >= point[1] - 80);
  const distance = model => Math.min(...model.instanceBounds.map(bounds => {
    const dx = Math.max(bounds.min[0] - center[0], 0, center[0] - bounds.max[0]);
    const dz = Math.max(bounds.min[2] - center[2], 0, center[2] - bounds.max[2]);
    return dx * dx + dz * dz;
  }));
  async function loadModel(model, priority) {
    if (completed.has(model.index)) return;
    if (pending.has(model.index)) return pending.get(model.index);
    const task = (async () => {
      const gltf = await retain(model.resourceId, priority);
      const item = manifest.models[model.index];
      const primitives = [];
      gltf.scene.traverse(node => { if (node.isMesh) primitives.push(node); });
      const instances = await Promise.all(primitives.map(async primitive => {
        const path = primitive.userData.materialPath || primitive.parent?.userData.materialPath;
        const material = await materials.get(path, primitive.geometry, priority);
        if (!queuedMaterials.has(material)) {
          queuedMaterials.add(material);
          enhancementQueue.push(material);
          wakeEnhancements();
        }
        signal.throwIfAborted();
        await runtime.gpu.enqueue(() => {
          if (!loaded.renderer) return;
          for (const value of Object.values(material)) if (value?.isTexture) loaded.renderer.initTexture(value);
          for (const value of material.userData.ownedTextures || []) loaded.renderer.initTexture(value);
        }, { ...options(priority), onTiming: cpuMs => assetProfiler.resource('gpu-upload-cpu', { cpuMs }) });
        const instantiateStarted = performance.now();
        const mesh = new THREE.InstancedMesh(primitive.geometry, material, item.matrices.length);
        mesh.name = item.asset;
        const matrix = new THREE.Matrix4();
        item.matrices.forEach((elements, i) => mesh.setMatrixAt(i, matrix.fromArray(elements)));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        mesh.receiveShadow = true;
        mesh.userData.sourceAsset = item.asset;
        assetProfiler.resource('instantiate-cpu', { mapId: id, resourceId: model.resourceId, cpuMs: performance.now() - instantiateStarted, instances: item.matrices.length });
        return mesh;
      }));
      signal.throwIfAborted();
      for (const mesh of instances) group.add(mesh);
      completed.add(model.index);
      onProgress(completed.size / map.models.length);
    })().finally(() => pending.delete(model.index));
    pending.set(model.index, task);
    return task;
  }
  const loaded = {
    group, manifest, base: '', colliders: [], navigationTask, controller, renderer,
    streaming: true, completed, map, fullyLoaded: null, streamError: null,
    canMoveTo(point) {
      center = [point.x, point.y, point.z];
      return (!streamingNavigation || streamingNavigation.isReady(center)) &&
        map.models.every(model => !near(model, center, 18) || completed.has(model.index));
    },
    async prepareLocation(point) {
      center = [point.x, point.y, point.z];
      await streamingNavigation?.ensure(center);
      const needed = map.models.filter(model => near(model, center, 35) && !completed.has(model.index));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, needed.length) }, async () => {
        while (cursor < needed.length) await loadModel(needed[cursor++], 0);
      }));
      signal.throwIfAborted();
    },
    release() {
      controller.abort();
      wakeEnhancements();
      streamingNavigation?.dispose();
      if (this.mapImageUrl) URL.revokeObjectURL(this.mapImageUrl);
      materials.release();
      for (const resource of retained) runtime.release(resource);
      retained.clear();
    },
    startStreaming(renderer) {
      this.renderer = renderer;
      if (this.fullyLoaded) return this.fullyLoaded;
      const remaining = new Set(map.models.filter(model => !completed.has(model.index)));
      let modelsDone = false;
      const waiters = [];
      wakeEnhancements = () => { while (waiters.length) waiters.shift()(); };
      const worker = async () => {
        while (remaining.size) {
          signal.throwIfAborted();
          const model = [...remaining].sort((a, b) => distance(a) - distance(b))[0];
          remaining.delete(model);
          await loadModel(model, near(model, center, 64) ? 5 : 20);
        }
      };
      const modelsReady = Promise.all(Array.from({ length: 3 }, worker)).finally(() => {
        modelsDone = true;
        wakeEnhancements();
      });
      const upgrade = async () => {
        while (true) {
          signal.throwIfAborted();
          const material = enhancementQueue.shift();
          if (material) await materials.upgradeMaterial(material, renderer, 20);
          else if (modelsDone) return;
          else await new Promise(resolve => waiters.push(resolve));
        }
      };
      const collisionReady = streamingNavigation ? navigationResource(collision, manifest.collisionEncoding, manifest.collisionBytes, 10).then(navigation => {
        signal.throwIfAborted();
        streamingNavigation.useComplete(navigation);
        loaded.fullCollisionReady = true;
        loaded.fullCollisionBytes = navigation.geometry.attributes.position.array.byteLength;
        // Near chunks bridge the first frame; one complete BVH avoids thousands
        // of serial worker jobs when filling the background collision world.
        for (const chunk of map.collisionChunks) {
          const id = `navigation:${chunk.resourceId}`;
          if (retained.delete(id)) runtime.release(id);
        }
        assetProfiler.mark('collision:fully-ready', { sceneId: id, rawBytes: manifest.collisionBytes });
      }) : null;
      const imageId = map.paths['map.png'];
      const mapReady = imageId ? retain(imageId, 15).then(bytes => {
        signal.throwIfAborted();
        loaded.mapImageUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        if (loaded.layout) loaded.layout.image = loaded.mapImageUrl;
      }) : null;
      this.fullyLoaded = Promise.all([modelsReady, collisionReady, mapReady, ...Array.from({ length: 3 }, upgrade)]).then(() => {
        materials.releasePreviews();
        this.streaming = false;
        assetProfiler.mark('fully-loaded', { sceneId: id, models: completed.size });
      }).catch(error => {
        if (!signal.aborted) {
          this.streamError = error;
          assetProfiler.mark('stream-error', { sceneId: id, message: error.message });
        }
      });
      return this.fullyLoaded;
    },
  };
  try {
    const bootstrap = map.models.filter(model => near(model, center, 35));
    const initialResources = new Set(bootstrap.map(model => model.resourceId));
    for (const model of bootstrap) {
      for (const materialId of model.materialResources) {
        for (const id of runtime.registry.get(materialId).dependencies) {
          const resource = runtime.registry.get(id);
          initialResources.add(resource.metadata?.preview || id);
        }
      }
    }
    runtime.planResources([...initialResources], runtime.rangePolicy);
    // Bundle membership is known at build time: start the few required preview
    // packs alongside geometry instead of discovering textures after GLB parse.
    const initialBundles = [...new Set([...initialResources].map(id => runtime.registry.get(id).bundle).filter(id => id && !runtime.rangeBundles.has(id)))];
    const prefetch = Promise.all(initialBundles.map(id => runtime.bundle(id, options(0))));
    prefetch.catch(() => {});
    assetProfiler.mark('bootstrap:start', { models: bootstrap.length });
    let cursor = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (cursor < bootstrap.length) await loadModel(bootstrap[cursor++], 0);
    }));
    await prefetch;
    assetProfiler.mark('bootstrap:ready', { models: completed.size });
    return loaded;
  } catch (error) {
    loaded.release();
    await Promise.allSettled([...pending.values(), navigationTask]);
    // Late completions after abort cannot retain resources.
    for (const resource of retained) runtime.release(resource);
    disposeObject(group);
    throw error;
  }
}
