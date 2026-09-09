import * as THREE from 'three';
import { MATERIALS, box, cylinder, material, mesh } from './assets.js';

export const CHARACTER_APPEARANCES = {
  WHM: { outfit: 0xf0ede4, trim: 0x77cee0, trimGlow: 0x123d4c, weapon: 'staff' },
  PCT: { outfit: 0xe4a8c1, trim: 0x77cee0, trimGlow: 0x123d4c, weapon: 'brush' },
  RPR: { outfit: 0x432445, trim: 0xc74c68, trimGlow: 0x3f0916, weapon: 'scythe' },
  default: { outfit: 0x50647a, trim: 0x93d5de, trimGlow: 0x153c4a, weapon: 'staff' },
};

export function createCharacter(job) {
  const root = new THREE.Group();
  root.name = 'player';
  const rig = {
    body: new THREE.Group(),
    leftArm: new THREE.Group(),
    rightArm: new THREE.Group(),
    leftLeg: new THREE.Group(),
    rightLeg: new THREE.Group(),
    weapon: new THREE.Group(),
  };
  root.userData.rig = rig;
  rig.body.name = 'body';
  rig.leftArm.name = 'leftArm';
  rig.rightArm.name = 'rightArm';
  rig.leftLeg.name = 'leftLeg';
  rig.rightLeg.name = 'rightLeg';
  rig.weapon.name = 'weapon';
  root.add(rig.body, rig.leftArm, rig.rightArm, rig.leftLeg, rig.rightLeg, rig.weapon);
  const appearance = CHARACTER_APPEARANCES[job] || CHARACTER_APPEARANCES.default;
  const skin = material(0xe4b297, { roughness: 0.72 });
  const hair = material(0x273346, { roughness: 0.82 });
  const outfit = material(appearance.outfit, { roughness: 0.78 });
  const trim = material(appearance.trim, { emissive: appearance.trimGlow, emissiveIntensity: 0.6 });
  [rig.leftLeg, rig.rightLeg].forEach((leg, index) => {
    leg.position.set(index ? 0.22 : -0.22, 0.53, 0);
    cylinder(leg, 0.15, 0.19, 1.06, outfit, 0, 0, 0, 8);
  });
  const torso = mesh(new THREE.CapsuleGeometry(0.42, 0.88, 5, 10), outfit, 0, 1.68, 0);
  torso.scale.set(1, 1.12, 0.82);
  rig.body.add(torso);
  const mantle = mesh(new THREE.ConeGeometry(0.62, 1.15, 8, 1, true), material(appearance.weapon === 'scythe' ? 0x24172a : appearance.weapon === 'brush' ? 0xf0c3d3 : 0xd7e8ea, { side: THREE.DoubleSide, roughness: 0.86 }), 0, 1.46, 0.1);
  mantle.scale.z = 0.52;
  mantle.rotation.x = Math.PI;
  rig.body.add(mantle);
  const belt = mesh(new THREE.TorusGeometry(0.36, 0.055, 6, 12), trim, 0, 1.32, 0);
  belt.rotation.x = Math.PI / 2;
  rig.body.add(belt, mesh(new THREE.SphereGeometry(0.37, 12, 10), skin, 0, 2.78, 0));
  const fringe = mesh(new THREE.SphereGeometry(0.39, 10, 8), hair, 0, 2.96, 0.04);
  fringe.scale.set(1.04, 0.52, 1.03);
  rig.body.add(fringe);
  const collar = mesh(new THREE.TorusGeometry(0.39, 0.065, 6, 12), trim, 0, 2.29, 0);
  collar.rotation.x = Math.PI * 0.5;
  rig.body.add(collar);
  [rig.leftArm, rig.rightArm].forEach((armRoot, index) => {
    const side = index ? 1 : -1;
    armRoot.position.set(side * 0.43, 2.06, 0);
    const arm = cylinder(armRoot, 0.13, 0.16, 1.06, outfit, side * 0.08, -0.53, 0, 8);
    arm.rotation.z = side * -0.36;
  });
  const weapon = rig.weapon;
  weapon.position.set(0.78, 1.05, -0.08);
  if (appearance.weapon === 'staff') {
    const shaft = cylinder(weapon, 0.052, 0.075, 2.8, MATERIALS.paleWood, 0, 1.35, 0, 7);
    shaft.rotation.z = -0.22;
    const bloom = mesh(new THREE.IcosahedronGeometry(0.32, 1), trim, -0.3, 2.64, 0);
    bloom.scale.y = 1.45;
    weapon.add(bloom);
  } else if (appearance.weapon === 'brush') {
    const brush = cylinder(weapon, 0.09, 0.11, 2.25, MATERIALS.paleWood, 0, 1.1, 0, 8);
    brush.rotation.z = -0.36;
    const tip = mesh(new THREE.ConeGeometry(0.2, 0.48, 8), trim, -0.4, 2.15, 0);
    tip.rotation.z = -0.36;
    weapon.add(brush, tip);
  } else {
    const handle = cylinder(weapon, 0.065, 0.09, 2.6, MATERIALS.wood, 0, 1.28, 0, 8);
    handle.rotation.z = -0.25;
    const blade = mesh(new THREE.TorusGeometry(0.66, 0.1, 6, 12, Math.PI * 1.35), trim, -0.47, 2.36, 0);
    blade.rotation.z = -0.72;
    weapon.add(handle, blade);
  }
  root.add(weapon);
  return root;
}

export function createDummy() {
  const root = new THREE.Group();
  root.rotation.y = Math.PI;
  const straw = material(0xc89a58, { roughness: 0.96 });
  cylinder(root, 0.56, 0.66, 2.68, straw, 0, 1.8, 0, 12);
  for (let i = 0; i < 7; i += 1) {
    const band = mesh(new THREE.TorusGeometry(0.58, 0.035, 6, 18), material(0x76502c), 0, 0.8 + i * 0.38, 0);
    band.rotation.x = Math.PI * 0.5;
    root.add(band);
  }
  root.add(mesh(new THREE.SphereGeometry(0.46, 10, 8), straw, 0, 3.4, 0));
  cylinder(root, 0.42, 0.55, 0.62, MATERIALS.wood, 0, 0.31, 0, 9);
  const arms = box(root, 2.45, 0.16, 0.16, MATERIALS.wood, 0, 2.2, 0);
  arms.rotation.z = -0.08;
  const ring = mesh(new THREE.RingGeometry(0.92, 1.08, 40), new THREE.MeshBasicMaterial({ color: 0xf0b651, transparent: true, opacity: 0.85, side: THREE.DoubleSide }), 0, 0.045, 0, false);
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'target-ring';
  const marker = mesh(new THREE.ConeGeometry(0.32, 0.72, 4), new THREE.MeshBasicMaterial({ color: 0xffe89a }), 0, 4.35, 0, false);
  marker.rotation.y = Math.PI * 0.25;
  marker.name = 'target-marker';
  root.add(ring, marker);
  for (let i = 0; i < 4; i += 1) root.add(mesh(new THREE.ConeGeometry(0.17, 0.65, 6), straw, Math.cos(i * 1.57) * 0.38, 3.55, Math.sin(i * 1.57) * 0.38));
  return root;
}

export function createNpc(color = 0x5672a6) {
  const npc = new THREE.Group();
  cylinder(npc, 0.34, 0.55, 1.75, material(color, { roughness: 0.85 }), 0, 0.88, 0, 9);
  npc.add(mesh(new THREE.SphereGeometry(0.3, 10, 8), material(0xd9a98d), 0, 2.03, 0));
  const hair = mesh(new THREE.SphereGeometry(0.32, 9, 7), material(0x2b2732), 0, 2.2, 0);
  hair.scale.y = 0.6;
  npc.add(hair);
  return npc;
}
