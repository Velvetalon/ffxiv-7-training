import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ClientMaterials } from './ClientMaterials.js';
import { repairRenderAttributes } from './GeometryAttributes.js';
import { assetProfiler } from '../../assets/AssetProfiler.js';
import { initializeMapAssets } from '../../assets/MapAssets.js';
import { loadProgressiveScene } from './ProgressiveScene.js';

export async function loadExtractedScene(id, onProgress = () => {}, { onManifest, entry, renderer } = {}) {
  assetProfiler.mark('discovery:start', { sceneId: id });
  const root = `${import.meta.env.BASE_URL}extracted/`;
  let base = `${root}${id}/`;
  const activeResponse = await fetch(`${root}active.json`, { cache: 'no-store' });
  if (activeResponse.ok) {
    const active = await activeResponse.json();
    const assets = await initializeMapAssets(active, root, id);
    if (assets?.maps[id]) return loadProgressiveScene(id, assets.maps[id], { entry, renderer, onProgress });
    if (active.scenes?.[id]?.base) base = `${root}${active.scenes[id].base}`;
  }
  assetProfiler.mark('manifest:fetch:start', { sceneId: id, base });
  const response = await fetch(`${base}scene.json`);
  if (!response.ok) throw new Error(`地图资源未就绪：${id}`);
  const manifest = await response.json();
  onManifest?.(base, manifest);
  assetProfiler.mark('manifest:fetch:complete', { sceneId: id, models: manifest.models.length });
  const group = new THREE.Group();
  group.name = `client-map-${id}`;
  const loader = new GLTFLoader();
  const materials = new ClientMaterials(base, manifest);
  const colliders = [];
  let completed = 0, cursor = 0;
  assetProfiler.mark('models:load:start', { sceneId: id, models: manifest.models.length });
  async function worker() {
    while (cursor < manifest.models.length) {
      const item = manifest.models[cursor++];
      const fetchDecodeStartedAt = performance.now();
      const gltf = await loader.loadAsync(base + item.url);
      const fetchDecodeMs = performance.now() - fetchDecodeStartedAt;
      const instantiateStartedAt = performance.now();
      const primitives = [];
      gltf.scene.traverse(node => { if (node.isMesh) primitives.push(node); });
      for (const primitive of primitives) {
        repairRenderAttributes(primitive.geometry);
        const path = primitive.userData.materialPath || primitive.parent?.userData.materialPath;
        if (primitive.geometry.attributes.uv1) {
          const colors = primitive.geometry.attributes.color;
          const weights = Float32Array.from({ length: primitive.geometry.attributes.position.count }, (_, i) => colors?.itemSize === 4 ? colors.getW(i) : 0);
          primitive.geometry.setAttribute('clientBlend', new THREE.BufferAttribute(weights, 1));
        }
        const mat = await materials.get(path, primitive.geometry);
        const instances = new THREE.InstancedMesh(primitive.geometry, mat, item.matrices.length);
        instances.name = item.asset;
        const matrix = new THREE.Matrix4();
        item.matrices.forEach((elements, i) => { matrix.fromArray(elements); instances.setMatrixAt(i, matrix); });
        instances.instanceMatrix.needsUpdate = true;
        instances.computeBoundingBox(); instances.computeBoundingSphere();
        instances.frustumCulled = true;
        instances.castShadow = false;
        instances.receiveShadow = true;
        instances.userData.sourceAsset = item.asset;
        group.add(instances);
        // Geometry is shared by all source instances. Collision construction is separate.
        colliders.push(instances);
      }
      completed++;
      assetProfiler.resource('model:fetch-decode', { sceneId: id, asset: item.asset, durationMs: fetchDecodeMs, instances: item.matrices.length });
      assetProfiler.resource('model:instantiate', { sceneId: id, asset: item.asset, durationMs: performance.now() - instantiateStartedAt, instances: item.matrices.length });
      onProgress(completed / manifest.models.length);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  assetProfiler.mark('instantiate:complete', { sceneId: id, models: completed, meshes: group.children.length });
  return { group, manifest, colliders, base };
}
