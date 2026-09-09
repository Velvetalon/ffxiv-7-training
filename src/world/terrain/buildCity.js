import * as THREE from 'three';
import { getLayout } from './layouts.js';
import { insidePolygon } from './Navigation.js';
import { paintedMaterial, worldUV } from '../art/Materials.js';
import { buildLandmark } from '../art/Architecture.js';
import { addWoodland, addPaintedSky } from '../art/Vegetation.js';
import { createDummy, createNpc } from '../actors.js';
import { addWater, addLight, box, cylinder, material, mesh } from '../assets.js';
import { makeLabel } from '../SpriteView.js';

function shapeOf(points) {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)); shape.closePath();
  return shape;
}
function addPlatform(group, surface, maritime) {
  const depth = maritime ? (surface.height || 0) + 5 : 1.8;
  const geometry = new THREE.ExtrudeGeometry(shapeOf(surface.points), { depth, bevelEnabled: false, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  const top = paintedMaterial(surface.kind === 'earth' ? 'earth' : surface.kind === 'wood' ? 'wood' : maritime ? 'marble' : 'stone');
  const edge = paintedMaterial(maritime ? 'marble' : 'bark', maritime ? '#c6c5b9' : '#91876a');
  worldUV(geometry, surface.kind === 'wood' ? 0.22 : 0.17);
  const platform = mesh(geometry, [top, edge], 0, (surface.height || 0) - depth - 0.05, 0);
  group.add(platform);
}
function roadVertices(road) {
  const data = [];
  for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1], b = road.points[i];
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz), n = [-dz / length * road.width / 2, dx / length * road.width / 2];
    const start = (road.height || 0) + ((road.endHeight ?? road.height ?? 0) - (road.height || 0)) * (i - 1) / (road.points.length - 1);
    const end = (road.height || 0) + ((road.endHeight ?? road.height ?? 0) - (road.height || 0)) * i / (road.points.length - 1);
    const al = [a[0] + n[0], start + 0.06, a[1] + n[1]], ar = [a[0] - n[0], start + 0.06, a[1] - n[1]];
    const bl = [b[0] + n[0], end + 0.06, b[1] + n[1]], br = [b[0] - n[0], end + 0.06, b[1] - n[1]];
    data.push(...al, ...bl, ...ar, ...ar, ...bl, ...br);
  }
  return data;
}
function addRoad(state, group, road, maritime, materials) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(roadVertices(road), 3));
  geo.computeVertexNormals(); worldUV(geo, road.kind === 'wood' ? 0.2 : 0.17);
  const surface = mesh(geo, materials[road.kind], 0, 0, 0, false);
  surface.material.side = THREE.DoubleSide; group.add(surface);
  road.points.forEach(([x, z], i) => {
    const h = (road.height || 0) + ((road.endHeight ?? road.height ?? 0) - (road.height || 0)) * i / (road.points.length - 1);
    const disk = new THREE.CircleGeometry(road.width / 2, 32); disk.rotateX(-Math.PI / 2); disk.translate(x, h + 0.055, z); worldUV(disk);
    group.add(mesh(disk, materials[road.kind], 0, 0, 0, false));
  });
  if (maritime || road.kind === 'wood') {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i], dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz), normal = new THREE.Vector2(-dz, dx).normalize();
      for (let distance = 0; distance < len; distance += 3.5) {
        const t = distance / len, x = a[0] + dx * t, z = a[1] + dz * t;
        const h = state.navigation.surfaceAt(x, z)?.height || 0;
        for (const side of [-1, 1]) {
          const px = x + normal.x * (road.width / 2 + 0.05) * side, pz = z + normal.y * (road.width / 2 + 0.05) * side;
          if (state.layout.surfaces.some(area => insidePolygon(px, pz, area.points))) continue;
          const railMaterial = maritime ? materials.marble : materials.wood;
          cylinder(group, 0.1, 0.15, 1.1, railMaterial, px, h + 0.55, pz, 12);
          const beam = box(group, 0.1, 0.14, Math.min(3.5, len - distance), railMaterial, px + dx / len * 1.6, h + 1.03, pz + dz / len * 1.6);
          beam.rotation.y = Math.atan2(dx, dz);
        }
        if (maritime && distance % 7 < 0.1) cylinder(group, 0.7, 1, h + 5, materials.marble, x, (h - 5) / 2, z, 20);
      }
    }
  }
}

export function buildCity(state, group, id) {
  const layout = getLayout(id), maritime = id === 'limsa', b = layout.bounds;
  state.layout = layout; state.fogColor = maritime ? 0xa7c6cf : 0xb5c9b4;
  state.bounds = 320;
  addPaintedSky(group, id);
  const mats = { stone: paintedMaterial(maritime ? 'marble' : 'stone'), wood: paintedMaterial('wood'), earth: paintedMaterial('earth'), grass: paintedMaterial('grass'), marble: paintedMaterial('marble') };
  if (maritime) {
    const water = addWater(state, group, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, 750, 650, 0x438b9c); water.position.y = -4.5;
  } else {
    const geo = new THREE.PlaneGeometry(b.maxX - b.minX + 60, b.maxZ - b.minZ + 60, 160, 110); geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position, centerX = (b.maxX + b.minX) / 2, centerZ = (b.maxZ + b.minZ) / 2;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + centerX, z = p.getZ(i) + centerZ;
      const wet = layout.water.some(water => insidePolygon(x, z, water.points));
      p.setXYZ(i, x, wet ? -3.5 : -0.9 + Math.sin(x * 0.07) * Math.cos(z * 0.09) * 0.25, z);
    }
    geo.computeVertexNormals(); worldUV(geo, 0.11); group.add(mesh(geo, mats.grass));
    for (const water of layout.water) {
      const geometry = new THREE.ShapeGeometry(shapeOf(water.points), 24); geometry.rotateX(-Math.PI / 2); worldUV(geometry, 0.1);
      group.add(mesh(geometry, material('#397f83', { roughness: 0.24, metalness: 0.12, transparent: true, opacity: 0.93 }), 0, -0.75, 0, false));
    }
    addWoodland(state, group, layout);
  }
  for (const surface of layout.surfaces) addPlatform(group, surface, maritime);
  for (const road of layout.roads) addRoad(state, group, road, maritime, mats);
  state.architecture = layout.landmarks.map(landmark => buildLandmark(state, group, landmark, id));
  state.landmarkLabels = layout.landmarks.map(landmark => {
    const label = makeLabel(landmark.name);
    label.position.set(landmark.x, (state.navigation.surfaceAt(landmark.x, landmark.z)?.height || 0) + 3.2, landmark.z + 2);
    group.add(label); return label;
  });
  const register = entity => { group.add(entity.object); state.registry.register(entity); };
  const dummy = createDummy();
  dummy.position.set(layout.dummy.x, state.navigation.surfaceAt(layout.dummy.x, layout.dummy.z)?.height || 0, layout.dummy.z);
  dummy.rotation.y = layout.dummy.rotation;
  register({ id: 'wooden-dummy', name: '训练木人', type: 'dummy', object: dummy, hp: 100, level: 100 });
  for (const npc of layout.npcs) {
    const object = createNpc(maritime ? 0x557a9a : 0x727b51);
    const baseY = state.navigation.surfaceAt(npc.x, npc.z)?.height || 0;
    const occupied = Math.hypot(npc.x - layout.dummy.x, npc.z - layout.dummy.z) < 2.5;
    const point = occupied ? state.navigation.nearestWalkable(npc.x - 4, npc.z + 2) : npc;
    object.position.set(point.x, state.navigation.surfaceAt(point.x, point.z)?.height || 0, point.z);
    register({ ...npc, type: 'npc', object, baseY: object.position.y });
  }
  const spawn = layout.spawn;
  state.spawn.set(spawn.x, state.navigation.surfaceAt(spawn.x, spawn.z)?.height || 0, spawn.z);
  for (let i = 0; i < layout.roads.length; i++) {
    const road = layout.roads[i];
    const [x, z] = road.points[0], y = state.navigation.surfaceAt(x, z)?.height || 0;
    const lampX = x + road.width / 2 + 0.4;
    cylinder(group, 0.08, 0.13, 3.5, mats.wood, lampX, y + 1.75, z, 14);
    const globe = mesh(new THREE.SphereGeometry(0.22, 16, 12), material('#f4dc9b', { emissive: '#cbb578', emissiveIntensity: 0.5 }), lampX, y + 3.6, z, false);
    group.add(globe);
  }
}
