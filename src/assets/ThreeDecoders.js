import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { repairRenderAttributes } from '../world/imported/GeometryAttributes.js';

export function installThreeDecoders(runtime) {
  const loader = new GLTFLoader();
  runtime.decoder('glb', async (bytes, record) => {
    const gltf = await loader.parseAsync(bytes, '');
    let size = 0;
    const geometries = new Set();
    gltf.scene.traverse(node => {
      if (!node.isMesh) return;
      const geometry = node.geometry;
      if (!geometries.has(geometry)) {
        repairRenderAttributes(geometry);
        geometry.userData.assetRuntimeOwned = true;
        if (geometry.attributes.uv1) {
          const colors = geometry.attributes.color;
          const weights = Float32Array.from({ length: geometry.attributes.position.count }, (_, i) => colors?.itemSize === 4 ? colors.getW(i) : 0);
          geometry.setAttribute('clientBlend', new THREE.BufferAttribute(weights, 1));
        }
        for (const attribute of Object.values(geometry.attributes)) size += attribute.array.byteLength;
        size += geometry.index?.array.byteLength || 0;
        geometries.add(geometry);
      }
    });
    record.runtimeBytes = size;
    return gltf;
  }, gltf => {
    const geometries = new Set(), materials = new Set();
    gltf.scene.traverse(node => {
      if (node.geometry) geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) materials.add(material);
    });
    geometries.forEach(value => value.dispose());
    materials.forEach(value => value.dispose());
  });
  runtime.decoder('texture', async (bytes, record) => {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: record.mimeType || record.metadata?.mimeType || record.metadata?.mime || 'application/octet-stream' }), {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    record.runtimeBytes = bitmap.width * bitmap.height * 4;
    return bitmap;
  }, bitmap => bitmap.close());
  runtime.decoder('texture-view', async (_, record, store) => {
    const { resource, colorSpace, scale } = record.metadata;
    const bitmap = store.get(resource);
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = colorSpace;
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(scale[0] ?? 1, scale[1] ?? 1);
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    texture.userData.assetRuntimeOwned = true;
    record.runtimeBytes = Math.ceil(bitmap.width * bitmap.height * 4 * 4 / 3);
    return texture;
  }, texture => texture.dispose());
  runtime.decoder('material', (_, record) => record.metadata);
}
