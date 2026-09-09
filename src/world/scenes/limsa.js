import * as THREE from 'three';
import { createDummy, createNpc } from '../actors.js';
import { MATERIALS, addArch, addBanners, addBridge, addCrystal, addPath, addPlanter, addPlaza, addRockGarden, addSail, addSkyDome, addTower, addWater, box, cylinder, material, mesh } from '../assets.js';

const register = (state, group, entity) => { group.add(entity.object); state.registry.register(entity); };
const path = (state, group, x, z, w, d, rotation = 0) => { state.paths.push({ x, z, w, d, rotation }); return addPath(group, x, z, w, d, material(0xbdc9c6, { map: MATERIALS.limestone.map, roughness: 0.84 }), rotation); };

function maritimeHouse(state, group, x, z, scale = 1, rotation = 0) {
  const house = new THREE.Group();
  house.position.set(x, 0, z); house.rotation.y = rotation;
  const wall = material(0xd6dfd8, { map: MATERIALS.limestone.map, roughness: 0.82 });
  box(house, 7.4 * scale, 5.1 * scale, 5.3 * scale, wall, 0, 2.55 * scale, 0);
  box(house, 7.9 * scale, 0.42 * scale, 5.8 * scale, MATERIALS.stoneDark, 0, 5.03 * scale, 0);
  const roof = mesh(new THREE.ConeGeometry(4.9 * scale, 2.8 * scale, 4), material(0x38566b, { roughness: 0.82 }), 0, 6.6 * scale, 0);
  roof.rotation.y = Math.PI * 0.25; house.add(roof);
  for (let i = -2; i <= 2; i += 1) box(house, 0.18 * scale, 5.25 * scale, 5.7 * scale, MATERIALS.stoneDark, i * 1.42 * scale, 2.6 * scale, 0);
  for (const y of [2.05, 3.55]) for (const dx of [-2.35, 0, 2.35]) {
    const window = box(house, 0.9 * scale, 0.9 * scale, 0.1 * scale, material(0x76bed0, { emissive: 0x2b7188, emissiveIntensity: 0.75 }), dx * scale, y * scale, 2.7 * scale);
    window.castShadow = false;
  }
  box(house, 4.3 * scale, 0.18 * scale, 1.25 * scale, MATERIALS.wood, 0, 2.05 * scale, 3.16 * scale);
  [-1.7, 1.7].forEach((dx) => cylinder(house, 0.09 * scale, 0.13 * scale, 1.25 * scale, MATERIALS.wood, dx * scale, 1.45 * scale, 3.16 * scale, 7));
  group.add(house);
  state.obstacles.push({ x, z, radius: 4.4 * scale });
}

function addPierRail(group, x, z, length, rotation = 0) {
  const pier = new THREE.Group(); pier.position.set(x, 0, z); pier.rotation.y = rotation;
  box(pier, 4.5, 0.42, length, MATERIALS.wood, 0, 0.21, 0);
  for (let i = -length * 0.45; i <= length * 0.45; i += 2.3) {
    [-2, 2].forEach((dx) => cylinder(pier, 0.08, 0.1, 1.1, MATERIALS.wood, dx, 0.75, i, 6));
    box(pier, 0.1, 0.1, 2.3, MATERIALS.paleWood, -2, 1.13, i + 1.1);
    box(pier, 0.1, 0.1, 2.3, MATERIALS.paleWood, 2, 1.13, i + 1.1);
  }
  group.add(pier);
}

function harborTower(state, group, x, z, height = 24, radius = 3.6) {
  addTower(state, group, x, z, height, radius);
  const gallery = new THREE.Group();
  gallery.position.set(x, height * 0.66, z);
  const pale = material(0xe0e6df, { map: MATERIALS.limestone.map, roughness: 0.78 });
  cylinder(gallery, radius * 1.32, radius * 1.32, 0.34, pale, 0, 0, 0, 16);
  for (let i = 0; i < 12; i += 1) {
    const a = i * Math.PI / 6;
    cylinder(gallery, 0.09, 0.11, 1.35, pale, Math.sin(a) * radius * 1.08, 0.7, Math.cos(a) * radius * 1.08, 7);
  }
  const lamp = mesh(new THREE.SphereGeometry(0.42, 10, 8), material(0x90eaff, { emissive: 0x2e8da6, emissiveIntensity: 1.4 }), 0, 1.55, 0, false);
  gallery.add(lamp);
  group.add(gallery);
}

function addWhiteBridge(group, ax, az, bx, bz) {
  const dx = bx - ax; const dz = bz - az; const length = Math.hypot(dx, dz);
  const bridge = new THREE.Group();
  bridge.position.set((ax + bx) * 0.5, 3.1, (az + bz) * 0.5);
  bridge.rotation.y = Math.atan2(dx, dz);
  const stone = material(0xd6e2dd, { map: MATERIALS.limestone.map, roughness: 0.8 });
  box(bridge, 5.6, 0.62, length, stone, 0, 0, 0);
  [-2.45, 2.45].forEach((side) => {
    box(bridge, 0.2, 0.7, length, stone, side, 0.55, 0);
    for (let z = -length * 0.43; z <= length * 0.43; z += 2.6) cylinder(bridge, 0.1, 0.12, 1.25, stone, side, 0.55, z, 7);
  });
  for (let i = -1; i <= 1; i += 1) {
    const arch = new THREE.Group();
    arch.position.set(0, -2.2, i * length * 0.25);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-2.1, 0, 0), new THREE.Vector3(0, 2.4, 0), new THREE.Vector3(2.1, 0, 0));
    arch.add(mesh(new THREE.TubeGeometry(curve, 14, 0.28, 8, false), stone));
    bridge.add(arch);
  }
  group.add(bridge);
}

function addMast(group, x, z, height = 18, rotation = 0) {
  const mast = new THREE.Group();
  mast.position.set(x, 0, z); mast.rotation.y = rotation;
  cylinder(mast, 0.14, 0.2, height, MATERIALS.wood, 0, height * 0.5, 0, 8);
  box(mast, 0.12, 0.12, 8.2, MATERIALS.wood, 0, height * 0.72, 0);
  const flag = mesh(new THREE.PlaneGeometry(3.2, 2.2), material(0xe7eadf, { side: THREE.DoubleSide, roughness: 0.9 }), 1.65, height * 0.66, 0, false);
  flag.rotation.y = Math.PI * 0.5;
  mast.add(flag);
  group.add(mast);
}

export function buildLimsa(state, group) {
  state.bounds = 58;
  state.fogColor = 0x9ebfc7;
  state.navigationRegions.push(
    { type: 'rect', x: 0, z: 18, w: 116, d: 60, rotation: 0 },
    { type: 'circle', x: 0, z: -11.8, radius: 13.5 },
    { type: 'rect', x: -37, z: -23, w: 4.8, d: 23, rotation: 0.12 },
    { type: 'rect', x: 39, z: -24, w: 4.8, d: 26, rotation: -0.1 },
  );
  addSkyDome(group, 0x83b8cb, 0xc9dfd6);
  addWater(state, group, 0, -27, 118, 69, 0x146a87);
  const deck = mesh(new THREE.PlaneGeometry(116, 60), material(0x9baeb0, { map: MATERIALS.limestone.map, roughness: 0.92 }), 0, 0, 18, false);
  deck.rotation.x = -Math.PI / 2; group.add(deck);
  addPlaza(group, 0, -11.8, 13.5, { color: 0xb9c5c1, border: 0x4b7891 });
  path(state, group, 0, 12, 12, 68);
  path(state, group, -20, 1, 31, 6.2, -0.11);
  path(state, group, 21, 0, 34, 6.2, 0.1);
  path(state, group, 0, -28, 6, 23);
  state.paths.forEach((route) => state.navigationRegions.push({ type: 'rect', ...route }));
  addTower(state, group, -23, 13, 23, 3.75);
  addTower(state, group, 25, 18, 25, 4.3);
  addTower(state, group, 38, -3, 17, 3.2);
  addTower(state, group, -39, -3, 16, 3.2);
  maritimeHouse(state, group, -18, -17, 1.04, 0.1);
  maritimeHouse(state, group, 18, -17, 1.02, -0.08);
  maritimeHouse(state, group, -29, 6, 0.86, 0.3);
  maritimeHouse(state, group, 30, 7, 0.9, -0.3);
  [-9, 7, 22].forEach((x) => addArch(group, x, 12, 8, 10));
  addArch(group, -20, -3, 10, 8.5, Math.PI * 0.5);
  addArch(group, 20, -3, 10, 8.5, Math.PI * 0.5);
  addBridge(group, -28, -16, -5, -16, 4.7, 1.15);
  addBridge(group, 5, -16, 31, -16, 4.7, 1.15);
  addPierRail(group, -37, -23, 23, 0.12);
  addPierRail(group, 39, -24, 26, -0.1);
  addBanners(group, -13, 7.5, 10);
  addCrystal(state, group, 0, -28, 1.72, 0x64dafa);
  harborTower(state, group, -24, -46, 19, 3.8);
  harborTower(state, group, 25, -46, 18, 3.7);
  maritimeHouse(state, group, -35, -36, 0.9, 0.08);
  maritimeHouse(state, group, 35, -36, 0.9, -0.08);
  addWhiteBridge(group, -36, -39, -7, -39);
  addWhiteBridge(group, 7, -39, 36, -39);
  addMast(group, -31, -42, 19, -0.12);
  addMast(group, 31, -42, 20, 0.16);
  [-33, -25, 25, 33].forEach((x) => {
    const parapet = new THREE.Group();
    parapet.position.set(x, 0, -25);
    box(parapet, 6.4, 1.1, 1.15, material(0xd7e0d9, { map: MATERIALS.limestone.map }), 0, 0.55, 0);
    for (let i = -2; i <= 2; i += 1) cylinder(parapet, 0.13, 0.16, 1.55, MATERIALS.stone, i * 1.28, 1.15, 0, 8);
    group.add(parapet);
  });
  addSail(group, -28, -32, 1.5, 0.22);
  addSail(group, 27, -38, 1.65, -0.3);
  addSail(group, 43, -20, 1, 0.55);
  [[-30, -2], [-24, -5], [28, -4], [35, 2], [-35, 16], [36, 18]].forEach(([x, z], index) => { addPlanter(group, x, z, 0.9); addRockGarden(group, x + 2, z - 0.4, 5, 0.65 + (index % 2) * 0.1); });
  for (let i = 0; i < 10; i += 1) {
    const crate = new THREE.Group(); crate.position.set(i < 5 ? -42 + i * 2.25 : 32 + (i - 5) * 2.25, 0, i < 5 ? 17 + (i % 2) * 1.1 : 14 + (i % 2) * 1.1);
    box(crate, 1.25, 1.25, 1.25, MATERIALS.wood, 0, 0.63, 0); box(crate, 0.95, 0.95, 0.95, MATERIALS.paleWood, 0.1, 1.67, -0.08);
    group.add(crate); state.obstacles.push({ x: crate.position.x, z: crate.position.z, radius: 1.05 });
  }
  const dummy = createDummy(); dummy.position.set(0, 0, -8.1);
  register(state, group, { id: 'wooden-dummy', name: '木人木偶', type: 'dummy', object: dummy, hp: 100, level: 100, radius: 0.8, dialogue: '' });
  const deckhand = createNpc(0x284a6f); deckhand.position.set(7.2, 0, -5.3);
  register(state, group, { id: 'limsa-deckhand', name: '甲板员 瑞妮', type: 'npc', object: deckhand, dialogue: '海风会把心思吹清。对准目标，别被浪声带走。' });
  const navigator = createNpc(0x8e5159); navigator.position.set(-9, 0, -18);
  register(state, group, { id: 'limsa-navigator', name: '领港员 赛拉', type: 'npc', object: navigator, dialogue: '下层甲板的地面已经清出来了，随时可以开练。' });
  state.spawn.set(0, 0, 0);
}
