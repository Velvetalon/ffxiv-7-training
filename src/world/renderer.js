import * as THREE from 'three';
import { initializeArtMaterials } from './assets.js';

export function createRenderer(canvas) {
  initializeArtMaterials();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

export function addLighting(root, sceneId) {
  const forest = sceneId === 'gridania';
  root.add(new THREE.HemisphereLight(forest ? 0xb9e7d0 : 0xd6f5ff, forest ? 0x283627 : 0x374e5e, 2.1));
  const sun = new THREE.DirectionalLight(forest ? 0xffe2b1 : 0xfff0cf, 2.2);
  sun.position.set(-28, 42, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;
  root.add(sun);
  const fill = new THREE.PointLight(forest ? 0xf0b55a : 0x7ecfe7, 2.5, 42, 2);
  fill.position.set(0, 8, 1);
  root.add(fill);
}

export function setQuality(renderer, scene, quality) {
  const size = quality === 'low' ? 768 : 1536;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 1.7));
  scene.traverse((node) => {
    if (node.isLight && node.castShadow && node.shadow.mapSize.x !== size) {
      node.shadow.mapSize.set(size, size);
      node.shadow.map?.dispose();
      node.shadow.map = null;
      node.shadow.needsUpdate = true;
    }
  });
}
