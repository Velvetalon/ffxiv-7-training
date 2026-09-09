import * as THREE from 'three';
import { paintedMaterial } from './Materials.js';
import { mesh, box, cylinder, material, addCrystal, addPlanter, addSail } from '../assets.js';

function arch(parent, x, y, z, width, height, mat) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0); shape.lineTo(-width / 2, height - width / 2);
  shape.absarc(0, height - width / 2, width / 2, Math.PI, 0, true); shape.lineTo(width / 2, 0);
  const face = mesh(new THREE.ShapeGeometry(shape, 28), mat, x, y, z);
  parent.add(face); return face;
}
function curvedRoof(parent, radius, height, y, mat, theme) {
  const profile = [
    new THREE.Vector2(radius, 0), new THREE.Vector2(radius * 0.97, 0.2),
    new THREE.Vector2(radius * 0.79, height * 0.17), new THREE.Vector2(radius * 0.51, height * 0.42),
    new THREE.Vector2(radius * 0.18, height * 0.83), new THREE.Vector2(0.025, height),
  ];
  const roof = mesh(new THREE.LatheGeometry(profile, 48), mat, 0, y, 0);
  parent.add(roof);
  const edge = mesh(new THREE.TorusGeometry(radius, 0.08, 8, 64), material(theme === 'limsa' ? '#d5c6a2' : '#c69b61'), 0, y, 0);
  edge.rotation.x = Math.PI / 2; parent.add(edge);
}
function facade(parent, width, height, depth, theme, tower = false) {
  const pale = theme === 'limsa';
  const wall = paintedMaterial(pale ? 'marble' : 'wood');
  const trim = paintedMaterial(pale ? 'stone' : 'bark');
  const roof = paintedMaterial('roof', pale ? '#819aaa' : '#97aa77', 2);
  if (tower) cylinder(parent, width * 0.45, width * 0.48, height, wall, 0, height / 2, 0, 40);
  else box(parent, width, height, depth, wall, 0, height / 2, 0);
  const z = tower ? width * 0.455 : depth / 2 + 0.035;
  for (let floor = 0; floor < Math.max(1, Math.floor(height / 3)); floor++) {
    box(parent, width * 1.03, 0.18, depth * 1.025, trim, 0, floor * 3 + 0.3, 0);
    for (const x of [-width * 0.3, 0, width * 0.3]) {
      const isDoor = floor === 0 && x === 0;
      arch(parent, x, floor * 3 + 0.45, z + 0.01, isDoor ? 1.45 : 1.15, isDoor ? 2.55 : 1.9, material(pale ? '#415767' : '#503e2d'));
      if (!isDoor) {
        arch(parent, x, floor * 3 + 0.58, z + 0.03, 0.92, 1.62, material('#e6cb87', { emissive: '#806334', emissiveIntensity: 0.18 }));
        box(parent, 0.07, 1.58, 0.1, trim, x, floor * 3 + 1.3, z + 0.09);
        box(parent, 0.92, 0.07, 0.1, trim, x, floor * 3 + 1.25, z + 0.09);
      }
    }
  }
  for (const x of [-0.49, -0.18, 0.18, 0.49]) box(parent, 0.17, height + 0.3, depth * 1.03, trim, x * width, height / 2, 0);
  curvedRoof(parent, width * 0.68, width * (tower ? 0.52 : 0.37), height, roof, theme);
  const step = paintedMaterial(pale ? 'marble' : 'wood');
  for (let i = 0; i < 3; i++) box(parent, width * 0.52 + (3 - i) * 0.3, 0.16, 0.65, step, 0, 0.08 + i * 0.16, z + 1.55 - i * 0.5);
}

function waterwheel(parent) {
  const wheel = new THREE.Group(); wheel.position.set(0, 4, 0);
  const wood = paintedMaterial('wood'), brass = material('#b79a68', { metalness: 0.3, roughness: 0.65 });
  for (const z of [-0.8, 0.8]) wheel.add(mesh(new THREE.TorusGeometry(3.3, 0.18, 12, 64), wood, 0, 0, z));
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    const spoke = box(wheel, 0.15, 6.4, 0.18, wood, 0, 0, 0); spoke.rotation.z = a;
    const blade = box(wheel, 0.75, 0.25, 1.9, wood, Math.sin(a) * 3.25, Math.cos(a) * 3.25, 0); blade.rotation.z = -a;
  }
  const axle = cylinder(wheel, 0.2, 0.2, 3, brass, 0, 0, 0, 24); axle.rotation.x = Math.PI / 2;
  parent.add(wheel); parent.userData.wheel = wheel;
}

function market(parent, theme, width) {
  const timber = paintedMaterial('wood'), cream = paintedMaterial('cloth');
  for (let i = 0; i < 3; i++) {
    const stall = new THREE.Group(); stall.position.x = (i - 1) * width / 3;
    box(stall, width / 3 - 0.4, 1, 1.7, timber, 0, 0.5, 0);
    for (const x of [-1, 1]) cylinder(stall, 0.07, 0.1, 3.5, timber, x * (width / 6 - 0.3), 1.75, 0.5, 12);
    const canopy = new THREE.Mesh(new THREE.PlaneGeometry(width / 3 + 0.4, 3, 10, 6), cream.clone());
    canopy.material.color.set(i % 2 ? '#7899a1' : '#ca8e78'); canopy.material.side = THREE.DoubleSide;
    canopy.rotation.x = -Math.PI * 0.38; canopy.position.set(0, 3.25, 0); stall.add(canopy);
    for (let n = 0; n < 5; n++) stall.add(mesh(new THREE.SphereGeometry(0.17, 12, 8), material(n % 2 ? '#c49549' : '#c07570'), -1 + n * 0.45, 1.1, 0));
    parent.add(stall);
  }
}

export function buildLandmark(state, parent, landmark, theme) {
  const root = new THREE.Group();
  const floor = state.navigation.surfaceAt(landmark.x, landmark.z)?.height || 0;
  const height = landmark.height || 8, width = Math.min(landmark.w || 12, 22), depth = Math.min(landmark.d || 10, 15);
  // Landmark coordinates are visitor/entrance positions; facades sit behind them.
  root.position.set(landmark.x, floor, landmark.z - (['crystal', 'waterwheel', 'ship', 'dock'].includes(landmark.type) ? 0 : depth * 0.47));
  if (landmark.type === 'crystal') {
    const crystal = addCrystal(state, parent, landmark.x, landmark.z, theme === 'limsa' ? 1.4 : 1.25);
    crystal.position.y += floor + 2.4; crystal.userData.baseY = crystal.position.y;
    const base = crystal.children.find(child => child.geometry?.type === 'CylinderGeometry');
    if (base) { crystal.remove(base); parent.add(base); base.position.set(landmark.x, floor + 0.5, landmark.z); }
    const plinth = cylinder(parent, 1.35, 1.8, 2.5, paintedMaterial('marble', '#b6c5bf'), landmark.x, floor + 1.25, landmark.z, 48);
    plinth.castShadow = true;
    return crystal;
  }
  if (landmark.type === 'waterwheel') waterwheel(root);
  else if (landmark.type === 'market') market(root, theme, width);
  else if (landmark.type === 'ship') {
    addSail(root, 0, -4, 4.2, -Math.PI / 2);
  } else if (landmark.type === 'gate' || landmark.type === 'lift') {
    const mat = paintedMaterial(theme === 'limsa' ? 'marble' : 'wood');
    cylinder(root, 1.1, 1.3, height, mat, -width / 3, height / 2, 0, 32);
    cylinder(root, 1.1, 1.3, height, mat, width / 3, height / 2, 0, 32);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-width / 3, height * 0.75, 0), new THREE.Vector3(0, height * 1.18, 0), new THREE.Vector3(width / 3, height * 0.75, 0));
    root.add(mesh(new THREE.TubeGeometry(curve, 32, 0.38, 12), mat));
    box(root, width * 0.8, 0.5, 1.7, mat, 0, height * 0.78, 0);
  } else if (landmark.type === 'dock') {
    market(root, theme, width * 0.6); addSail(root, -8, -9, 1.7, 0.3);
  } else facade(root, width * 0.73, height, depth * 0.77, theme, landmark.type === 'tower');
  parent.add(root);
  return root;
}
