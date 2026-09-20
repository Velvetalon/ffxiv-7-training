import { Color3, MeshBuilder, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { mapImageBounds } from '../../src/world/imported/MapCoordinates.js';

function optionalMapImageBounds(sceneId, legacy) {
  if (legacy?.imageBounds) return legacy.imageBounds;
  if (!legacy?.mapTexture) return null;
  try {
    return mapImageBounds(sceneId);
  } catch {
    // Hidden territories may not have a catalog map canvas. The minimap can
    // still render collision bounds and landmarks without a background image.
    return null;
  }
}

const LANDMARK_NAMES = {
  "The Roost": '栖木旅馆',
  'Carline Canopy': '魔女咖啡馆',
  "Quiver's Hold": '弓术师行会',
  "Adders' Nest": '双蛇党军营',
  'Oak Atrium': '木工行会',
  'The Octant': '八分仪广场',
  "Hawkers' Alley": '商人街',
  "Fisherman's Bottom": '捕鱼人行会',
  'Chocobokeep': '陆行鸟房',
  "Carpenters' Guild": '木工行会',
  'Gridania Aetheryte Plaza': '格里达尼亚以太广场',
  'Limsa Lominsa Aetheryte Plaza': '利姆萨以太广场',
  'Airship Landing': '飞艇坪',
  'Ferry Docks': '渡船码头',
  "Figaga's Gift": '水车',
  'The Knot': '圆坛',
  'Blue Badger Gate': '蓝獾门',
  'White Wolf Gate': '白狼门',
  "East Hawkers' Alley": '东商人街',
  "West Hawkers' Alley": '西商人街',
  "Mealvaan's Gate": '秘术师行会',
  'The Astalicia': '阿斯塔利西亚号',
  'Bulwark Hall': '壁垒商会',
  "Crow's Lift": '乌鸦升降机',
  'Zephyr Gate': '和风陆门',
  'Acorn Orchard': '橡果园',
  "Hawkers' Round": '商人圆台',
  'Lominsan Ferry Docks': '利姆萨渡船码头',
};

function descendants(root) {
  return [...(root?.getChildMeshes?.(false) || []), ...(root?.getChildTransformNodes?.(false) || [])];
}

export class EntityRegistry {
  constructor() {
    this.entities = new Map();
  }

  clear() {
    this.entities.clear();
  }

  register(entity) {
    if (!entity?.id || !entity?.object) throw new Error('Entity requires an id and Babylon transform root');
    this.entities.set(entity.id, entity);
    entity.object.metadata = { ...(entity.object.metadata || {}), entityId: entity.id };
    for (const node of descendants(entity.object)) {
      node.metadata = { ...(node.metadata || {}), entityId: entity.id };
      if ('isPickable' in node) node.isPickable = true;
    }
    return entity;
  }

  spawn(entity) { return this.register(entity); }
  get(id) { return this.entities.get(id) || null; }
  values() { return [...this.entities.values()]; }

  nearestTarget(position) {
    let nearest = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const entity of this.entities.values()) {
      if (entity.type !== 'dummy' && entity.type !== 'monster') continue;
      const next = Vector3.Distance(position, entity.object.position);
      if (next < distance) { nearest = entity; distance = next; }
    }
    return nearest;
  }

  pickRoots() { return this.values().map(entity => entity.object); }

  setTargetVisual(entity) {
    for (const value of this.entities.values()) {
      if (value.type !== 'dummy' && value.type !== 'monster') continue;
      const active = value === entity;
      for (const node of descendants(value.object)) {
        if (node.name === 'target-ring' || node.name === 'target-marker') node.setEnabled(active);
      }
    }
  }

  getInfo() {
    return this.values().map(entity => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      x: Number(entity.object.position.x.toFixed(2)),
      z: Number(entity.object.position.z.toFixed(2)),
    }));
  }
}

export function connectionDistance(connection, point) {
  const [x, y, z] = connection.position;
  if (Math.abs(point.y - y) > 4) return Number.POSITIVE_INFINITY;
  return Math.hypot(point.x - x, point.z - z);
}

export function nearestConnection(connections, point) {
  let nearest = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const connection of connections || []) {
    const candidate = connectionDistance(connection, point);
    if (candidate <= (connection.radius || 3) && candidate < distance) {
      nearest = connection;
      distance = candidate;
    }
  }
  return nearest;
}

export function findArrival(manifest, navigation, entry = {}) {
  const connection = entry.arrivalConnection
    ? manifest.connections?.find(item => item.id === entry.arrivalConnection)
    : null;
  if (entry.arrivalConnection && !connection) throw new Error('目标地图缺少对应连接点');
  const destination = entry.arrival || connection?.spawn || connection?.position;
  if (!destination) return null;
  const [x, y, z] = destination;
  const floor = navigation.nearestWalkable(x, z, 10, y);
  if (!floor || Math.abs(floor.y - y) > 5) throw new Error('区域连接点没有可安全落地的位置');
  return floor;
}

export function prepareEncounter(manifest, navigation) {
  const authored = manifest.training;
  if (authored?.spawn && authored?.dummyPoint) {
    const spawn = navigation.nearestWalkable(authored.spawn.x, authored.spawn.z, 8, authored.spawn.y);
    const dummyPoint = navigation.nearestWalkable(authored.dummyPoint.x, authored.dummyPoint.z, 8, authored.dummyPoint.y);
    if (spawn && dummyPoint) return { spawn, dummyPoint, angle: Number(authored.angle) || 0 };
  }
  const [x, y, z] = manifest.spawn || manifest.aetheryte || [0, 0, 0];
  navigation.height = y;
  let center = navigation.nearestWalkable(x, z, 40, y);
  // Source spawns for instanced/hidden territories can be authored slightly
  // outside collision coverage, or on a disconnected platform. Probe outward
  // before failing the whole scene.
  if (!center) {
    search: for (const radius of [16, 32, 64, 96, 128, 192]) {
      for (let step = 0; step < 24; step += 1) {
        const angle = step * Math.PI / 12;
        center = navigation.nearestWalkable(
          x + Math.sin(angle) * radius,
          z + Math.cos(angle) * radius,
          16,
          y,
        );
        if (center) break search;
      }
    }
  }
  if (!center) throw new Error(`${manifest.scene}: 无法在源地标附近找到练习地面`);
  for (const radius of [4, 7, 10, 14, 20, 28]) {
    for (let step = 0; step < 16; step += 1) {
      const angle = step * Math.PI / 8;
      const spawn = new Vector3(center.x + Math.sin(angle) * radius, center.y, center.z + Math.cos(angle) * radius);
      const probe = new Vector3(center.x, center.y, center.z);
      navigation.move(probe, spawn.x - center.x, spawn.z - center.z);
      if (Math.hypot(probe.x - spawn.x, probe.z - spawn.z) <= 0.3 && Math.abs(probe.y - center.y) <= 1) {
        return { spawn: { x: probe.x, y: probe.y, z: probe.z }, dummyPoint: center, angle };
      }
    }
  }
  throw new Error(`${manifest.scene}: 无法在源地标附近找到相连的练习区域`);
}

export function mountConnections(scene, connections) {
  const root = new TransformNode('WorldConnections', scene);
  for (const connection of connections || []) {
    const marker = new TransformNode(`connection:${connection.id}`, scene);
    marker.parent = root;
    marker.position.fromArray(connection.position);
    marker.metadata = { connection };
    const tint = Color3.FromHexString('#9be3ef');
    const mat = new StandardMaterial(`connection-material:${connection.id}`, scene);
    mat.emissiveColor = tint;
    mat.diffuseColor = tint.scale(0.15);
    mat.alpha = 0.7;
    mat.disableLighting = true;
    const ring = MeshBuilder.CreateTorus(`connection-ring:${connection.id}`, { diameter: 2.7, thickness: 0.14, tessellation: 28 }, scene);
    ring.parent = marker;
    ring.rotation.x = Math.PI * 0.5;
    ring.position.y = 0.14;
    ring.material = mat;
    ring.metadata = { connection };
    ring.isPickable = true;
    const arrow = MeshBuilder.CreateCylinder(`connection-arrow:${connection.id}`, { height: 0.85, diameterTop: 0, diameterBottom: 0.9, tessellation: 4 }, scene);
    arrow.parent = marker;
    arrow.rotation.z = Math.PI;
    arrow.position.y = 2.6;
    arrow.material = mat;
    arrow.metadata = { connection };
    arrow.isPickable = true;
  }
  return root;
}

export function mountEncounter(world, assets, navigation, encounter, { createDummy, createNpc } = {}) {
  const scene = world.scene;
  const legacy = assets.legacy;
  const root = new TransformNode(`Encounter:${world.sceneId}`, scene);
  world.registry.clear();
  const { spawn, dummyPoint, angle } = encounter;
  const register = (id, name, type, object, point, dialogue = '') => {
    let runtime = null;
    if (type === 'npc') {
      runtime = world.createCharacterRuntime(id, object, name);
      object = runtime.root;
    }
    object.parent = root;
    object.position.set(point.x, point.y, point.z);
    world.registry.register({ id, name, type, object, runtime, baseY: point.y, hp: 100, level: 100, dialogue });
  };
  const dummy = createDummy(scene);
  dummy.rotation.y = angle + Math.PI;
  register('wooden-dummy', '训练木人', 'dummy', dummy, dummyPoint);
  const npcPoint = navigation.nearestWalkable(spawn.x - 5, spawn.z - 3, 12, spawn.y);
  if (npcPoint) {
    register(
      `${world.sceneId}-guide`,
      '演武场向导',
      'npc',
      createNpc(scene),
      npcPoint,
      '沿道路探索这片地区，靠近区域出口后按 F 前往相邻地图。也可以选择木人练习职业循环。',
    );
  }
  world.player.position.set(spawn.x, spawn.y, spawn.z);
  navigation.height = spawn.y;
  world.trainingAzimuth = angle;
  world.spawn.copyFrom(world.player.position);
  const sourcePoint = legacy.aetheryte || legacy.spawn || [spawn.x, spawn.y, spawn.z];
  const [x, y, z] = sourcePoint;
  const landmarks = (legacy.landmarks || [])
    .filter(point => point.name)
    .map(point => {
      const name = point.name.replace(/<[^>]*>/g, '');
      return { ...point, en: name, name: LANDMARK_NAMES[name] || name };
    });
  landmarks.unshift({ id: 'aetheryte', type: 'crystal', name: legacy.aetheryte ? '以太之光' : '区域入口', x, y, z });
  for (const connection of legacy.connections || []) {
    const [px, py, pz] = connection.position;
    landmarks.push({ id: `connection:${connection.id}`, name: connection.name, type: 'connection', x: px, y: py, z: pz, targetScene: connection.targetScene });
  }
  return {
    root,
    layout: {
      id: world.sceneId,
      bounds: { minX: navigation.bounds.min.x, maxX: navigation.bounds.max.x, minZ: navigation.bounds.min.z, maxZ: navigation.bounds.max.z },
      landmarks,
      roads: [],
      surfaces: [],
      water: [],
      image: null,
      imageBounds: optionalMapImageBounds(world.sceneId, legacy),
      sourceVersion: legacy.sourceVersion,
    },
  };
}
