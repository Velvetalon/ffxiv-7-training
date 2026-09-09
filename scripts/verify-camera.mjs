import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FollowCamera } from '../src/world/camera/FollowCamera.js';
const camera = new THREE.PerspectiveCamera(52, 1.6, 0.1, 650);
const scene = new THREE.Scene(), parent = new THREE.Group(), player = new THREE.Group();
scene.add(parent); parent.add(player);
const controller = new FollowCamera(camera);
const options = { azimuth: 0.7, polar: 1.2, distance: 14 };
function centered(label) {
  const ndc = player.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.45, 0)).project(camera);
  assert(Math.abs(ndc.x) < 1e-6 && Math.abs(ndc.y) < 1e-6, `${label}: player pivot drifted (${ndc.x}, ${ndc.y})`);
}
for (let i = 0; i < 180; i++) {
  player.position.set(i * 0.8, Math.sin(i * 0.04) * 12, -i * 0.5);
  controller.update(player, options, 1 / 60);
  centered('movement and elevation');
}
parent.position.set(90, 7, -60); player.position.set(-340, 18, 43);
controller.update(player, options, 1 / 60); centered('teleport and parent transform');
for (let i = 1; i <= 12; i++) {
  controller.update(player, { ...options, azimuth: i * 0.3, navigation: { cameraHit: () => ({ distance: i * 0.1 }) } }, 1 / 60);
  centered('near-wall collision');
  assert(camera.position.distanceTo(controller.pivot) <= Math.max(0.3, i * 0.1) + 1e-8);
}
controller.reset(); controller.update(player, options, 0);
assert(Math.abs(camera.position.distanceTo(controller.pivot) - 14) < 1e-8); centered('reset');
console.log('Player follow, elevation, teleport, parent transform, orbit and camera collision: PASS');
