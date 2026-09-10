import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ClientMaterials } from './ClientMaterials.js';
import { repairRenderAttributes } from './GeometryAttributes.js';

export async function loadExtractedScene(id, onProgress = () => {}) {
  const root = `${import.meta.env.BASE_URL}extracted/`;
  let base = `${root}${id}/`;
  const activeResponse = await fetch(`${root}active.json`, { cache: 'no-store' });
  if (activeResponse.ok) {
    const active = await activeResponse.json();
    if (active.scenes?.[id]?.base) base = `${root}${active.scenes[id].base}`;
  }
  const response = await fetch(`${base}scene.json`);
  if (!response.ok) throw new Error(`地图资源未就绪：${id}`);
  const manifest = await response.json();
  const group = new THREE.Group();
  group.name = `client-map-${id}`;
  const loader = new GLTFLoader();
  const materials = new ClientMaterials(base, manifest);
  const colliders = [];
  let completed = 0, cursor = 0;
  async function worker() {
    while (cursor < manifest.models.length) {
      const item = manifest.models[cursor++];
      const gltf = await loader.loadAsync(base + item.url);
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
      onProgress(completed / manifest.models.length);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return { group, manifest, colliders, base };
}
