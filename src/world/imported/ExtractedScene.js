import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadExtractedScene(id, onProgress = () => {}) {
  const base = `/extracted/${id}/`;
  const response = await fetch(`${base}scene.json`);
  if (!response.ok) throw new Error(`地图资源未就绪：${id}`);
  const manifest = await response.json();
  const group = new THREE.Group();
  group.name = `client-map-${id}`;
  const loader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  const materials = new Map();
  const textures = new Map();
  const colliders = [];
  let completed = 0, cursor = 0;
  async function getMaterial(path) {
    if (materials.has(path)) return materials.get(path);
      const promise = (async () => {
        const record = manifest.materials[path];
        let map;
      if (record?.map) {
        if (!textures.has(record.map)) textures.set(record.map, textureLoader.loadAsync(base + record.map));
        map = await textures.get(record.map);
        map.colorSpace = THREE.SRGBColorSpace;
        map.wrapS = map.wrapT = THREE.RepeatWrapping;
        map.flipY = false;
        map.anisotropy = 4;
        map.userData.sceneOwned = true;
      }
      const water = /water/i.test(record?.shader || path || '');
      const foliage = /(?:tre[ea]|leaf|grass|shiba|kus[ae]|plant)/i.test(path || '');
      let normalMap;
      let specularMap;
      if (record?.normalMap) {
        if (!textures.has(record.normalMap)) textures.set(record.normalMap, textureLoader.loadAsync(base + record.normalMap));
        normalMap = await textures.get(record.normalMap);
        normalMap.colorSpace = THREE.NoColorSpace;
        normalMap.flipY = false;
        normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
      }
      if (record?.specularMap) {
        if (!textures.has(record.specularMap)) textures.set(record.specularMap, textureLoader.loadAsync(base + record.specularMap));
        specularMap = await textures.get(record.specularMap);
        specularMap.colorSpace = THREE.NoColorSpace;
        specularMap.flipY = false;
        specularMap.wrapS = specularMap.wrapT = THREE.RepeatWrapping;
      }
      const diffuseColor = record?.diffuseColor || [1, 1, 1];
      const mat = new THREE.MeshStandardMaterial({
        map: map || null,
        normalMap: normalMap || null,
        normalScale: new THREE.Vector2(record?.normalScale || 1, record?.normalScale || 1),
        roughnessMap: specularMap || null,
        color: map ? new THREE.Color(diffuseColor[0], diffuseColor[1], diffuseColor[2]) : water ? '#6dabae' : '#abb4a9',
        roughness: water ? 0.2 : 0.95, metalness: 0,
        side: THREE.DoubleSide, alphaTest: foliage ? 0.4 : 0.05,
        transparent: water, opacity: water ? 0.7 : 1,
      });
      if (map && record?.colorUVScale) map.repeat.set(record.colorUVScale[0] || 1, record.colorUVScale[1] || 1);
      if (normalMap && record?.normalUVScale) normalMap.repeat.set(record.normalUVScale[0] || 1, record.normalUVScale[1] || 1);
      if (specularMap && record?.specularUVScale) specularMap.repeat.set(record.specularUVScale[0] || 1, record.specularUVScale[1] || 1);
      mat.name = path || 'unmapped';
      return mat;
    })();
    materials.set(path, promise);
    return promise;
  }
  async function worker() {
    while (cursor < manifest.models.length) {
      const item = manifest.models[cursor++];
      const gltf = await loader.loadAsync(base + item.url);
      const primitives = [];
      gltf.scene.traverse(node => { if (node.isMesh) primitives.push(node); });
      for (const primitive of primitives) {
        const path = primitive.userData.materialPath || primitive.parent?.userData.materialPath;
        const mat = await getMaterial(path);
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
  return { group, manifest, colliders };
}
