import * as THREE from 'three';
import { createDummy, createNpc } from '../actors.js';
import { MATERIALS, addBridge, addCrystal, addForestBackdrop, addFoliageInstanced, addGround, addLodge, addPath, addPlanter, addPlaza, addRockGarden, addSkyDome, addTree, addWater, box, cylinder, material, mesh } from '../assets.js';

const register = (state, group, entity) => {
  group.add(entity.object);
  state.registry.register(entity);
};

const path = (state, group, x, z, w, d, rotation = 0) => {
  state.paths.push({ x, z, w, d, rotation });
  return addPath(group, x, z, w, d, MATERIALS.path, rotation);
};

function addForestHouseCluster(state, group) {
  [[-16, -18, 1.05, 0.18], [17, -16, 1.03, -0.25], [-28, 3, 1.05, 0.4], [27, 12, 1.13, -0.22], [-21, 19, 0.9, -0.25], [13, 25, 0.92, 0.18], [31, -28, 0.83, 0.32]].forEach(([x, z, scale, rotation]) => addLodge(state, group, x, z, scale, rotation));
  [[-18, -24], [-10, -26], [18, -24], [27, -17], [-31, 10], [33, 6], [5, 30]].forEach(([x, z], index) => {
    addPlanter(group, x, z, 0.82 + (index % 3) * 0.12);
    addRockGarden(group, x + 1.5, z + 0.3, 5, 0.6);
  });
}

function addLanternWalk(group) {
  for (let i = 0; i < 14; i += 1) {
    const lamp = new THREE.Group();
    const z = 10 - i * 3.3;
    lamp.position.set(i % 2 ? 5.3 : -5.3, 0, z);
    cylinder(lamp, 0.06, 0.1, 3.35, MATERIALS.wood, 0, 1.68, 0, 7);
    lamp.add(mesh(new THREE.OctahedronGeometry(0.22, 0), material(0xffc56c, { emissive: 0xc86d23, emissiveIntensity: 1.7 }), 0, 3.22, 0, false));
    group.add(lamp);
  }
}

export function buildGridania(state, group) {
  state.bounds = 54;
  state.fogColor = 0x8fb7a2;
  addSkyDome(group, 0x8db6ad, 0xa9cfb6);
  addGround(group, 0x315d39, state.bounds);
  addForestBackdrop(group, { radius: 47, count: 94, color: 0x21442f });
  addWater(state, group, -25, -4, 17, 93, 0x176b70);
  addWater(state, group, 26, -20, 20, 37, 0x176b70);
  addPlaza(group, 0, -13.5, 13.6, { color: 0x92a397, border: 0xd7bc70 });
  path(state, group, 0, 8, 6.2, 42);
  path(state, group, -15, -13, 27, 4.6, -0.1);
  path(state, group, 15, -12, 26, 4.6, 0.1);
  path(state, group, 0, -29, 6, 21);
  path(state, group, -22, 8, 20, 3.5, 0.03);
  path(state, group, 23, 7, 18, 3.5, -0.05);
  addBridge(group, -15, 9, -33, 9, 3.2, 1.1);
  addBridge(group, 12, -21, 34, -21, 3.2, 1.12);
  addForestHouseCluster(state, group);
  addCrystal(state, group, 0, -28, 1.78, 0x56dfff);
  addLanternWalk(group);
  [[-38, -10, 1.9], [-35, 8, 1.7], [-39, 28, 1.9], [-19, 31, 1.35], [38, -2, 1.85], [36, 23, 1.9], [23, 32, 1.45], [-4, 35, 1.9], [39, -29, 1.7], [-38, -32, 1.85], [-12, -39, 1.4], [12, -40, 1.55], [5, 41, 1.5]].forEach(([x, z, scale], index) => addTree(state, group, x, z, scale, index % 3 ? MATERIALS.leaves : MATERIALS.leavesLight));
  const clearAreas = [{ x: 0, z: -13.5, radius: 16 }, ...state.obstacles];
  const foliageRules = { exclusions: clearAreas, pathExclusions: state.paths };
  addFoliageInstanced(group, 650, 45, 12, { x: 0, z: 0, color: 0x3e773d, width: 0.17, height: 0.78, ...foliageRules });
  addFoliageInstanced(group, 250, 20, 23, { x: -18, z: 17, color: 0x598d49, width: 0.13, height: 0.55, ...foliageRules });
  addFoliageInstanced(group, 210, 17, 41, { x: 21, z: -3, color: 0x517f42, width: 0.15, height: 0.64, ...foliageRules });
  const dummy = createDummy();
  dummy.position.set(0, 0, -8.1);
  register(state, group, { id: 'wooden-dummy', name: '木人木偶', type: 'dummy', object: dummy, hp: 100, level: 100, radius: 0.8, dialogue: '' });
  const guide = createNpc(0x5b7775);
  guide.position.set(7.4, 0, -5.2);
  register(state, group, { id: 'gridania-guide', name: '森都训练官 艾兰', type: 'npc', object: guide, dialogue: '以太之光的脉动很平稳。先清空心绪，再开始轮转。' });
  const merchant = createNpc(0x985a5a);
  merchant.position.set(-9, 0, -17.3);
  register(state, group, { id: 'gridania-merchant', name: '铁匠店员 伊芙', type: 'npc', object: merchant, dialogue: '不要忘了对准木人。这里的视野一直很好。' });
  state.spawn.set(0, 0, 0);
}
