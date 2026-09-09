import * as THREE from 'three';

const textures = new WeakMap();
export function pixelTexture(canvas) {
  if (textures.has(canvas)) return textures.get(canvas);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  textures.set(canvas, texture);
  return texture;
}
export function makeSprite(canvas, width, height, anchor = 0.08) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: pixelTexture(canvas), transparent: true, alphaTest: 0.05, depthTest: false, depthWrite: false }));
  sprite.scale.set(width, height, 1);
  sprite.center.set(0.5, anchor);
  return sprite;
}
export function updateSprite(sprite, canvas) { sprite.material.map = pixelTexture(canvas); }
export function makeLabel(text, color = '#f8eac0') {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(80, text.length * 14 + 20);
  canvas.height = 30;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center'; ctx.strokeStyle = '#132d30'; ctx.lineWidth = 4;
  ctx.strokeText(text, canvas.width / 2, 19);
  ctx.fillStyle = color; ctx.fillText(text, canvas.width / 2, 19);
  const label = makeSprite(canvas, canvas.width / 24, canvas.height / 24, 0.5);
  label.material.depthTest = true;
  label.material.map.userData.sceneOwned = true;
  return label;
}
export function disposeScene(root) {
  const maps = new Set();
  root.traverse(node => {
    node.geometry?.dispose();
    for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) {
      if (material.map) maps.add(material.map);
      material.dispose();
    }
  });
  for (const map of maps) if (map.userData.sceneOwned) map.dispose();
}
