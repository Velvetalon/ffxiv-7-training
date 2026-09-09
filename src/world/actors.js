import * as THREE from 'three';
import { mesh, cylinder, box, material } from './assets.js';
import { paintedMaterial } from './art/Materials.js';

export const CHARACTER_APPEARANCES = {
  WHM: { outfit: '#f5eedc', trim: '#a95854', weapon: 'staff' },
  PCT: { outfit: '#304f70', trim: '#dfa4ad', weapon: 'brush' },
  RPR: { outfit: '#34344b', trim: '#8f4868', weapon: 'scythe' },
  default: { outfit: '#5c7482', trim: '#d1b87b', weapon: 'staff' },
};
function faceTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 54, 8, 64, 68, 70);
  gradient.addColorStop(0, '#f5d4b2'); gradient.addColorStop(1, '#c9937b');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  for (const x of [44, 84]) {
    ctx.strokeStyle = '#4e3540'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x - 10, 50); ctx.quadraticCurveTo(x, 44, x + 7, 49); ctx.stroke();
    ctx.fillStyle = '#f5eade'; ctx.beginPath(); ctx.ellipse(x, 61, 9, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#527a78'; ctx.beginPath(); ctx.ellipse(x, 63, 5, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#253342'; ctx.fillRect(x - 2, 58, 4, 10); ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 1, 57, 3, 3);
    ctx.fillStyle = '#da92795a'; ctx.beginPath(); ctx.ellipse(x - 3, 80, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#a3685f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(59, 96); ctx.quadraticCurveTo(65, 99, 70, 95); ctx.stroke();
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.userData.sceneOwned = true; return map;
}
function lathe(parent, points, mat, x = 0, y = 0, z = 0) {
  const geometry = new THREE.LatheGeometry(points.map(([r, h]) => new THREE.Vector2(r, h)), 40);
  const object = mesh(geometry, mat, x, y, z); parent.add(object); return object;
}
export function createCharacter(job) {
  const appearance = CHARACTER_APPEARANCES[job] || CHARACTER_APPEARANCES.default;
  const root = new THREE.Group(); root.name = 'player';
  const rig = Object.fromEntries(['body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'weapon'].map(name => [name, new THREE.Group()]));
  root.userData.rig = rig;
  for (const [name, group] of Object.entries(rig)) { group.name = name; root.add(group); }
  const outfit = paintedMaterial('cloth', appearance.outfit), trim = paintedMaterial('cloth', appearance.trim);
  const skin = material('#edc5a3'), hair = material('#493e3c'), leather = paintedMaterial('wood', '#514747');
  for (const [i, leg] of [rig.leftLeg, rig.rightLeg].entries()) {
    leg.position.set(i ? 0.15 : -0.15, 0.62, 0);
    cylinder(leg, 0.12, 0.09, 0.8, outfit, 0, -0.22, 0, 24);
    const boot = mesh(new THREE.CapsuleGeometry(0.12, 0.32, 8, 16), leather, 0, -0.43, 0.04); leg.add(boot);
    const toe = mesh(new THREE.SphereGeometry(0.14, 20, 12), leather, 0, -0.58, 0.13); toe.scale.set(1, 0.55, 1.6); leg.add(toe);
  }
  lathe(rig.body, [[0.31, 0.95], [0.24, 1.12], [0.28, 1.4], [0.34, 1.56], [0.17, 1.67]], outfit);
  if (job !== 'PCT') {
    const skirt = lathe(rig.body, [[0.47, 0.23], [0.46, 0.3], [0.39, 0.64], [0.28, 1.03]], outfit);
    skirt.scale.z = 0.8;
    const hem = mesh(new THREE.TorusGeometry(0.445, 0.055, 10, 48), trim, 0, 0.3, 0); hem.rotation.x = Math.PI / 2; hem.scale.y = 0.8; rig.body.add(hem);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const ribbon = mesh(new THREE.PlaneGeometry(0.08, 0.57), trim, Math.sin(a) * 0.4, 0.57, Math.cos(a) * 0.33);
      ribbon.rotation.y = a; rig.body.add(ribbon);
    }
  }
  const belt = mesh(new THREE.TorusGeometry(0.26, 0.045, 10, 40), leather, 0, 1.07, 0); belt.rotation.x = Math.PI / 2; rig.body.add(belt);
  rig.body.add(mesh(new THREE.SphereGeometry(0.055, 12, 8), material('#dac18a', { metalness: 0.5 }), 0, 1.08, 0.28));
  const shoulder = mesh(new THREE.SphereGeometry(0.36, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.48), trim, 0, 1.5, 0);
  shoulder.scale.set(1.18, 0.38, 0.9); rig.body.add(shoulder);
  cylinder(rig.body, 0.09, 0.1, 0.16, skin, 0, 1.73, 0, 20);
  const head = mesh(new THREE.SphereGeometry(0.24, 32, 24), skin, 0, 1.99, 0); head.scale.y = 1.16; rig.body.add(head);
  const face = mesh(new THREE.SphereGeometry(0.244, 28, 20, Math.PI / 2 - 0.83, 1.66, 0.58, 1.8), new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.9 }), 0, 1.99, 0);
  face.rotation.y = 0; face.scale.y = 1.16; rig.body.add(face);
  const cap = mesh(new THREE.SphereGeometry(0.257, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.58), hair, 0, 2.04, -0.035); rig.body.add(cap);
  for (let i = 0; i < 9; i++) {
    const lock = mesh(new THREE.CapsuleGeometry(0.045, 0.19, 6, 12), hair, -0.22 + i * 0.055, 2.13 - Math.abs(i - 4) * 0.022, 0.15);
    lock.rotation.z = -0.32 + i * 0.07; rig.body.add(lock);
  }
  if (job === 'PCT') {
    const beret = mesh(new THREE.SphereGeometry(0.33, 32, 20), trim, 0.06, 2.25, -0.01); beret.scale.y = 0.34; rig.body.add(beret);
    const feather = mesh(new THREE.CapsuleGeometry(0.025, 0.28, 6, 12), material('#e9ddb2'), -0.2, 2.42, 0); feather.rotation.z = -0.45; rig.body.add(feather);
  } else if (job === 'RPR') {
    const hood = mesh(new THREE.SphereGeometry(0.29, 32, 20, 0.3, Math.PI * 1.8, 0, Math.PI * 0.78), outfit, 0, 2.06, -0.06); rig.body.add(hood);
  }
  for (const [i, arm] of [rig.leftArm, rig.rightArm].entries()) {
    arm.position.set(i ? 0.34 : -0.34, 1.53, 0);
    const sleeve = mesh(new THREE.CapsuleGeometry(0.115, 0.3, 8, 20), outfit, i ? 0.05 : -0.05, -0.24, 0); arm.add(sleeve);
    cylinder(arm, 0.14, 0.14, 0.08, trim, 0, -0.44, 0, 24);
    arm.add(mesh(new THREE.SphereGeometry(0.09, 20, 16), skin, 0, -0.53, 0.01));
  }
  const weapon = rig.weapon; weapon.position.set(0.57, 0.3, 0.04);
  const shaft = cylinder(weapon, 0.027, 0.036, 2.3, leather, 0, 1.1, 0, 20);
  if (appearance.weapon === 'staff') {
    const ring = mesh(new THREE.TorusGeometry(0.21, 0.035, 12, 40), material('#bba777', { metalness: 0.4 }), 0, 2.2, 0); weapon.add(ring);
    weapon.add(mesh(new THREE.OctahedronGeometry(0.12), material('#9de8d4', { emissive: '#399d83', emissiveIntensity: 0.5 }), 0, 2.2, 0));
  } else if (appearance.weapon === 'brush') {
    cylinder(weapon, 0.085, 0.07, 0.3, material('#ccac6e'), 0, 2.05, 0, 24);
    lathe(weapon, [[0.08, 0], [0.11, 0.12], [0.045, 0.38], [0, 0.46]], paintedMaterial('cloth', '#dfc5bc'), 0, 2.18, 0);
  } else {
    const bladeShape = new THREE.Shape(); bladeShape.moveTo(0.02, 0); bladeShape.bezierCurveTo(-0.3, 0.35, -0.7, 0.42, -0.95, -0.08); bladeShape.bezierCurveTo(-0.55, 0.08, -0.28, 0.07, 0.02, -0.12); bladeShape.closePath();
    const blade = mesh(new THREE.ExtrudeGeometry(bladeShape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.015, bevelThickness: 0.015, bevelSegments: 2, curveSegments: 28 }), material('#bbc3c8', { metalness: 0.55, roughness: 0.42 }), 0, 2.2, 0);
    weapon.add(blade);
  }
  return root;
}

export function createDummy() {
  const root = new THREE.Group(), straw = paintedMaterial('bark', '#c8ae7d'), timber = paintedMaterial('wood');
  cylinder(root, 0.14, 0.19, 2.7, timber, 0, 1.35, 0, 24);
  root.add(mesh(new THREE.CapsuleGeometry(0.42, 0.75, 12, 32), straw, 0, 1.53, 0));
  root.add(mesh(new THREE.SphereGeometry(0.3, 28, 20), straw, 0, 2.35, 0));
  const cross = cylinder(root, 0.08, 0.08, 2, timber, 0, 1.8, 0, 24); cross.rotation.z = Math.PI / 2;
  for (const y of [1.1, 1.4, 1.8]) {
    const band = mesh(new THREE.TorusGeometry(0.425, 0.025, 8, 40), material('#665144'), 0, y, 0); band.rotation.x = Math.PI / 2; root.add(band);
  }
  for (const [r, color] of [[0.26, '#803e3a'], [0.18, '#e4d3a9'], [0.085, '#9e514a']]) {
    root.add(mesh(new THREE.CircleGeometry(r, 32), material(color), 0, 1.65, 0.445));
  }
  const ring = mesh(new THREE.RingGeometry(0.93, 1.02, 64), new THREE.MeshBasicMaterial({ color: '#eec780', side: THREE.DoubleSide }), 0, 0.06, 0, false);
  ring.rotation.x = -Math.PI / 2; ring.name = 'target-ring'; root.add(ring);
  const marker = mesh(new THREE.ConeGeometry(0.14, 0.35, 4), new THREE.MeshBasicMaterial({ color: '#f0d999' }), 0, 3, 0, false); marker.name = 'target-marker'; root.add(marker);
  return root;
}
export function createNpc(color = 0x64746e) {
  const npc = createCharacter('default');
  npc.userData.rig.weapon.visible = false;
  npc.scale.setScalar(0.95);
  return npc;
}
