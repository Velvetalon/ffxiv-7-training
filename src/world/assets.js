import * as THREE from 'three';

const shared = (options) => {
  const value = new THREE.MeshStandardMaterial(options);
  value.userData.sharedWorldMaterial = true;
  return value;
};

export const MATERIALS = {
  grass: shared({ color: 0x315d39, roughness: 0.96 }),
  path: shared({ color: 0x806447, roughness: 1 }),
  wood: shared({ color: 0x55351e, roughness: 0.88 }),
  paleWood: shared({ color: 0xa77a48, roughness: 0.82 }),
  roof: shared({ color: 0x263a3a, roughness: 0.86 }),
  leaves: shared({ color: 0x274d36, roughness: 0.9 }),
  leavesLight: shared({ color: 0x426d42, roughness: 0.9 }),
  stone: shared({ color: 0xc8d0c3, roughness: 0.82 }),
  limestone: shared({ color: 0xf4f2e7, roughness: 0.84 }),
  stoneDark: shared({ color: 0x77888c, roughness: 0.88 }),
  sail: shared({ color: 0xece6d1, roughness: 0.96, side: THREE.DoubleSide }),
  brass: shared({ color: 0xc8a960, metalness: 0.45, roughness: 0.38 }),
};

const textureCache = new Map();

function canvasTexture(kind, repeatX = 1, repeatY = repeatX) {
  const key = `${kind}:${repeatX}:${repeatY}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const noise = (x, y, seed = 0) => ((Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453) % 1 + 1) * 0.5;
  if (kind === 'grass') {
    ctx.fillStyle = '#315d39'; ctx.fillRect(0, 0, 192, 192);
    for (let i = 0; i < 1000; i += 1) { const x = Math.random() * 192; const y = Math.random() * 192; ctx.fillStyle = i % 4 ? '#3f7040' : '#23472e'; ctx.fillRect(x, y, 1, 1 + Math.random() * 3); }
  } else if (kind === 'cobble') {
    ctx.fillStyle = '#899895'; ctx.fillRect(0, 0, 192, 192);
    for (let y = 0; y < 12; y += 1) for (let x = 0; x < 10; x += 1) {
      const ox = (y % 2) * 9 + x * 20 + 2; const oy = y * 16 + 2;
      ctx.fillStyle = noise(x, y) > 0.56 ? '#adbbb5' : '#748581';
      ctx.fillRect(ox, oy, 17, 13); ctx.strokeStyle = '#566765'; ctx.lineWidth = 1; ctx.strokeRect(ox, oy, 17, 13);
    }
  } else if (kind === 'limestone') {
    ctx.fillStyle = '#aab6ae'; ctx.fillRect(0, 0, 192, 192);
    for (let y = 0; y < 8; y++) for (let x = -1; x < 5; x++) {
      const ox = x * 48 + (y % 2) * 24, oy = y * 24;
      ctx.fillStyle = noise(x, y) > 0.5 ? '#ececdf' : '#d8dfd6';
      ctx.fillRect(ox + 1, oy + 1, 46, 22);
    }
  } else if (kind === 'earth') {
    ctx.fillStyle = '#7a5a3b'; ctx.fillRect(0, 0, 192, 192);
    for (let i = 0; i < 460; i += 1) { const x = Math.random() * 192; const y = Math.random() * 192; ctx.fillStyle = i % 3 ? '#8d6a45' : '#5e442d'; ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2); }
  } else if (kind === 'wood') {
    ctx.fillStyle = '#704724'; ctx.fillRect(0, 0, 192, 192);
    for (let y = 4; y < 192; y += 13) { ctx.fillStyle = y % 26 ? '#8e6132' : '#5d351b'; ctx.fillRect(0, y, 192, 9); ctx.strokeStyle = '#3f2514'; ctx.strokeRect(0, y, 192, 9); }
    for (let i = 0; i < 80; i += 1) { ctx.fillStyle = 'rgba(40,22,10,.26)'; ctx.fillRect(Math.random() * 192, Math.random() * 192, 1, 9 + Math.random() * 25); }
  } else if (kind === 'bark') {
    ctx.fillStyle = '#4a2e1d'; ctx.fillRect(0, 0, 192, 192);
    for (let x = 0; x < 192; x += 8) { ctx.fillStyle = x % 16 ? '#674126' : '#2c1b15'; ctx.fillRect(x, 0, 4, 192); }
  } else if (kind === 'water') {
    ctx.fillStyle = '#176b79'; ctx.fillRect(0, 0, 192, 192);
    for (let y = 8; y < 192; y += 18) { ctx.strokeStyle = y % 36 ? 'rgba(103,225,232,.26)' : 'rgba(213,255,252,.35)'; ctx.lineWidth = 2; ctx.beginPath(); for (let x = 0; x <= 192; x += 12) ctx.lineTo(x, y + Math.sin(x * 0.12 + y) * 3); ctx.stroke(); }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  textureCache.set(key, texture);
  return texture;
}

export function initializeArtMaterials() {
  if (MATERIALS.grass.map) return;
  MATERIALS.grass.map = canvasTexture('grass', 18, 18);
  MATERIALS.path.map = canvasTexture('earth', 7, 12);
  MATERIALS.path.color.set(0xc19d62);
  MATERIALS.wood.map = canvasTexture('wood', 2, 3);
  MATERIALS.paleWood.map = canvasTexture('wood', 2, 3);
  MATERIALS.stone.map = canvasTexture('cobble', 3, 3);
  MATERIALS.limestone.map = canvasTexture('limestone', 3, 3);
  MATERIALS.stoneDark.map = canvasTexture('cobble', 3, 3);
  MATERIALS.roof.map = canvasTexture('wood', 3, 5);
}

export function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.78, ...options });
}

export function mesh(geometry, mat, x = 0, y = 0, z = 0, cast = true) {
  const node = new THREE.Mesh(geometry, mat);
  node.position.set(x, y, z);
  node.castShadow = cast;
  node.receiveShadow = true;
  return node;
}

export function box(parent, w, h, d, mat, x, y, z, options = {}) {
  const node = mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z, options.cast !== false);
  if (options.rotation) node.rotation.set(...options.rotation);
  parent.add(node);
  return node;
}

export function cylinder(parent, radiusTop, radiusBottom, height, mat, x, y, z, segments = 10) {
  const node = mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), mat, x, y, z);
  parent.add(node);
  return node;
}

export function addLight(group, color, intensity, distance, x, y, z) {
  const light = new THREE.PointLight(color, intensity, distance, 2);
  light.position.set(x, y, z);
  group.add(light);
  return light;
}

export function addGround(group, color, bounds) {
  const ground = mesh(new THREE.PlaneGeometry(bounds * 2, bounds * 2), material(color, { roughness: 1 }), 0, 0, 0, false);
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);
  return ground;
}

export function addPath(group, x, z, w, d, color = MATERIALS.path, rotation = 0) {
  return box(group, w, 0.035, d, color, x, 0.018, z, { cast: false, rotation: [0, rotation, 0] });
}

export function addWater(state, group, x, z, w, d, color = 0x1c7384) {
  const geometry = new THREE.PlaneGeometry(w, d, 18, 18);
  geometry.rotateX(-Math.PI / 2);
  const surface = mesh(geometry, material(color, { map: canvasTexture('water', Math.max(2, w / 14), Math.max(2, d / 14)), metalness: 0.12, roughness: 0.22, transparent: true, opacity: 0.9 }), x, -0.04, z, false);
  state.water.push({ mesh: surface, base: Float32Array.from(geometry.attributes.position.array), phase: Math.random() * Math.PI * 2 });
  group.add(surface);
  return surface;
}

export function animateWater(water, time) {
  water.forEach(({ mesh: surface, base, phase }) => {
    const position = surface.geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const offset = i * 3;
      position.array[offset + 1] = base[offset + 1]
        + Math.sin(base[offset] * 0.16 + time * 1.4 + phase) * 0.07
        + Math.cos(base[offset + 2] * 0.19 + time + phase) * 0.045;
    }
    position.needsUpdate = true;
  });
}

export function addCrystal(state, group, x, z, scale = 1, color = 0x73e9ff) {
  const root = new THREE.Group();
  root.position.set(x, 1.4 * scale, z);
  root.userData.baseY = 1.4 * scale;
  const glow = material(color, { emissive: 0x087b9b, emissiveIntensity: 0.72, roughness: 0.1, metalness: 0.25, transparent: true, opacity: 0.7, depthWrite: false });
  const core = mesh(new THREE.OctahedronGeometry(1.34 * scale, 1), glow);
  core.scale.y = 2.9;
  root.add(core);
  for (let i = 0; i < 4; i += 1) {
    const angle = i * Math.PI * 0.5 + 0.35;
    const shard = mesh(new THREE.OctahedronGeometry(0.38 * scale, 0), glow, Math.cos(angle) * 1.75 * scale, -0.55 * scale, Math.sin(angle) * 1.75 * scale);
    shard.rotation.set(angle, 0.4, -angle);
    shard.scale.y = 2.2;
    root.add(shard);
  }
  cylinder(root, 2.25 * scale, 2.6 * scale, 0.8 * scale, MATERIALS.stoneDark, 0, -1.05 * scale, 0, 10);
  const ringMaterial = material(0xd4bd72, { metalness: 0.78, roughness: 0.22 });
  for (let i = 0; i < 3; i += 1) {
    const ring = mesh(new THREE.TorusGeometry((1.75 + i * 0.16) * scale, 0.06 * scale, 8, 36), ringMaterial, 0, (0.3 + i * 0.7) * scale, 0, false);
    ring.rotation.set(i === 0 ? Math.PI * 0.5 : 0.55 + i * 0.4, i * 1.04, 0);
    root.add(ring);
  }
  for (let i = 0; i < 4; i += 1) {
    const orb = mesh(new THREE.SphereGeometry(0.13 * scale, 8, 6), material(0x96f6ff, { emissive: 0x49ddef, emissiveIntensity: 2 }), Math.cos(i * Math.PI * 0.5) * 2.15 * scale, 0.7 * scale, Math.sin(i * Math.PI * 0.5) * 2.15 * scale, false);
    root.add(orb);
  }
  addLight(root, 0x2fd4eb, 2.8 * scale, 23 * scale, 0, 2.4 * scale, 0);
  group.add(root);
  state.crystals.push(root);
  return root;
}

export function animateCrystals(crystals, time, dt) {
  crystals.forEach((crystal, index) => {
    crystal.rotation.y += dt * (0.17 + index * 0.025);
    crystal.position.y = crystal.userData.baseY + Math.sin(time * 1.7 + index) * 0.14;
  });
}

export function addTree(state, group, x, z, scale = 1, color = MATERIALS.leaves) {
  const tree = new THREE.Group();
  tree.position.set(x, 0, z);
  cylinder(tree, 0.5 * scale, 0.8 * scale, 6.3 * scale, MATERIALS.wood, 0, 3.15 * scale, 0, 9);
  for (let i = 0; i < 5; i += 1) {
    const angle = i * 1.256;
    const branch = cylinder(tree, 0.12 * scale, 0.25 * scale, 2.5 * scale, MATERIALS.wood, Math.cos(angle) * 0.85 * scale, 5.2 * scale, Math.sin(angle) * 0.85 * scale, 7);
    branch.rotation.z = Math.cos(angle) * 0.82;
    branch.rotation.x = Math.sin(angle) * 0.82;
  }
  const crown = mesh(new THREE.IcosahedronGeometry(2.45 * scale, 1), color, 0, 7.2 * scale, 0);
  crown.scale.set(1.2, 0.84, 1.1);
  tree.add(crown);
  tree.add(mesh(new THREE.IcosahedronGeometry(1.65 * scale, 1), MATERIALS.leavesLight, -0.8 * scale, 8.2 * scale, 0.35 * scale));
  group.add(tree);
  state.obstacles.push({ x, z, radius: 1.15 * scale });
  return tree;
}

export function addLodge(state, group, x, z, scale = 1, rotation = 0) {
  const lodge = new THREE.Group();
  lodge.position.set(x, 0, z);
  lodge.rotation.y = rotation;
  box(lodge, 7 * scale, 3.9 * scale, 5.6 * scale, material(0x714a2b, { map: canvasTexture('wood', 3, 2), roughness: 0.94 }), 0, 2 * scale, 0);
  box(lodge, 7.55 * scale, 0.38 * scale, 6.2 * scale, MATERIALS.wood, 0, 4.05 * scale, 0);
  const roof = mesh(new THREE.ConeGeometry(5.25 * scale, 3.1 * scale, 4), MATERIALS.roof, 0, 5.75 * scale, 0);
  roof.rotation.y = Math.PI * 0.25;
  lodge.add(roof);
  for (let row = 0; row < 4; row += 1) box(lodge, 7.8 * scale - row * 0.55, 0.08 * scale, 0.38 * scale, MATERIALS.paleWood, 0, (4.7 + row * 0.52) * scale, 0.7 * scale + row * 0.4, { rotation: [0, Math.PI * 0.25, 0] });
  box(lodge, 1.25 * scale, 2.25 * scale, 0.18 * scale, MATERIALS.wood, 0, 1.15 * scale, 2.86 * scale);
  [-2.1, 2.1].forEach((dx) => box(lodge, 1.1 * scale, 1.05 * scale, 0.12 * scale, material(0xe6b86c, { emissive: 0xa96824, emissiveIntensity: 0.65 }), dx * scale, 2.35 * scale, 2.87 * scale));
  for (let i = -3; i <= 3; i += 1) box(lodge, 0.12 * scale, 4.1 * scale, 6.05 * scale, MATERIALS.paleWood, i * scale, 2.05 * scale, 0);
  box(lodge, 8 * scale, 0.2 * scale, 1.25 * scale, MATERIALS.wood, 0, 0.48 * scale, 3.25 * scale);
  [-2.8, 2.8].forEach((dx) => cylinder(lodge, 0.12 * scale, 0.16 * scale, 1.4 * scale, MATERIALS.wood, dx * scale, 1.1 * scale, 3.3 * scale, 7));
  group.add(lodge);
  state.obstacles.push({ x, z, radius: 4.25 * scale });
  return lodge;
}

export function addPlaza(group, x, z, radius = 8, options = {}) {
  const stone = material(options.color || 0xaab6ad, { map: canvasTexture('cobble', 2, 2), roughness: 0.82 });
  const disk = mesh(new THREE.CylinderGeometry(radius, radius, 0.1, 48), stone, x, 0.045, z, false);
  group.add(disk);
  const inner = mesh(new THREE.RingGeometry(radius * 0.51, radius * 0.535, 48), material(0x5f7974, { transparent: true, opacity: 0.72 }), x, 0.104, z, false);
  inner.rotation.x = -Math.PI * 0.5;
  group.add(inner);
  const border = mesh(new THREE.TorusGeometry(radius * 0.9, 0.18, 8, 48), material(options.border || 0xc9b36d, { metalness: 0.28, roughness: 0.5 }), x, 0.13, z, false);
  border.rotation.x = Math.PI * 0.5;
  group.add(border);
  for (let i = 0; i < 16; i += 1) {
    const angle = i * Math.PI * 0.125;
    const accent = mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 6), material(i % 2 ? 0xd3bc72 : 0x7599a1, { metalness: 0.28, roughness: 0.42 }), x + Math.cos(angle) * radius * 0.9, 0.15, z + Math.sin(angle) * radius * 0.9, false);
    group.add(accent);
  }
  return disk;
}

export function addPlanter(group, x, z, scale = 1) {
  const planter = new THREE.Group();
  planter.position.set(x, 0, z);
  cylinder(planter, 0.86 * scale, 1 * scale, 0.55 * scale, MATERIALS.stoneDark, 0, 0.28 * scale, 0, 10);
  for (let i = 0; i < 7; i += 1) {
    const flower = mesh(new THREE.SphereGeometry(0.18 * scale, 7, 6), material(i % 2 ? 0xe4a4ba : 0xf0cb66, { emissive: i % 2 ? 0x562334 : 0x57400f, emissiveIntensity: 0.4 }), Math.cos(i * 0.9) * 0.48 * scale, 0.68 * scale, Math.sin(i * 0.9) * 0.48 * scale, false);
    planter.add(flower);
  }
  group.add(planter);
}

export function addFoliageInstanced(group, count, radius, seed = 1, options = {}) {
  const geometry = new THREE.ConeGeometry(options.width || 0.16, options.height || 0.72, 5);
  const foliage = new THREE.InstancedMesh(geometry, material(options.color || 0x3d713d, { roughness: 0.96 }), count);
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  const random = (index, channel) => ((Math.sin((index + seed * 13) * 91.17 + channel * 17.3) * 43758.5) % 1 + 1) * 0.5;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Euler();
  const scale = new THREE.Vector3();
  const excluded = (x, z) => {
    if (options.excludeRadius && Math.hypot(x - options.excludeX, z - options.excludeZ) < options.excludeRadius) return true;
    if (options.exclusions?.some((area) => Math.hypot(x - area.x, z - area.z) < area.radius)) return true;
    return options.pathExclusions?.some((area) => {
      const dx = x - area.x; const dz = z - area.z; const c = Math.cos(-area.rotation); const s = Math.sin(-area.rotation);
      return Math.abs(dx * c - dz * s) < area.w * 0.5 + 0.55 && Math.abs(dx * s + dz * c) < area.d * 0.5 + 0.55;
    });
  };
  for (let i = 0; i < count; i += 1) {
    let theta = random(i, 1) * Math.PI * 2;
    let distance = Math.sqrt(random(i, 2)) * radius;
    for (let attempt = 0; attempt < 32 && excluded(options.x + Math.cos(theta) * distance, options.z + Math.sin(theta) * distance); attempt += 1) {
      theta = random(i + attempt * 37, 1) * Math.PI * 2;
      distance = Math.sqrt(random(i + attempt * 37, 2)) * radius;
    }
    if (excluded(options.x + Math.cos(theta) * distance, options.z + Math.sin(theta) * distance)) distance = radius * 0.96;
    position.set(options.x + Math.cos(theta) * distance, (options.y || 0) + 0.32, options.z + Math.sin(theta) * distance);
    rotation.set(0, random(i, 3) * Math.PI, random(i, 4) * 0.18 - 0.09);
    const size = 0.55 + random(i, 5) * 1.15;
    scale.set(size, size, size);
    matrix.compose(position, new THREE.Quaternion().setFromEuler(rotation), scale);
    foliage.setMatrixAt(i, matrix);
  }
  foliage.instanceMatrix.needsUpdate = true;
  group.add(foliage);
  return foliage;
}

export function addRockGarden(group, x, z, count = 9, scale = 1) {
  for (let i = 0; i < count; i += 1) {
    const angle = i * 2.41;
    const rock = mesh(new THREE.DodecahedronGeometry((0.24 + (i % 3) * 0.13) * scale, 0), material(i % 2 ? 0x65746d : 0x4f6159, { roughness: 0.96 }), x + Math.cos(angle) * (0.8 + (i % 4) * 0.45) * scale, 0.18 * scale, z + Math.sin(angle) * (0.8 + (i % 4) * 0.45) * scale);
    rock.scale.y = 0.65;
    rock.rotation.set(i * 0.7, i * 1.1, i * 0.3);
    group.add(rock);
  }
}

export function addForestBackdrop(group, options = {}) {
  const count = options.count || 70;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.52, 5.5, 7), material(0x513723, { map: canvasTexture('bark', 1, 3), roughness: 0.95 }), count);
  const canopy = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1), material(options.color || 0x294a33, { roughness: 0.96 }), count);
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3(); const scale = new THREE.Vector3(); const quat = new THREE.Quaternion();
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + Math.sin(i * 2.1) * 0.12;
    const radius = (options.radius || 48) + (i % 5) * 3;
    const size = 0.8 + (i % 7) * 0.12;
    pos.set(Math.cos(angle) * radius, 3.1 * size, Math.sin(angle) * radius);
    scale.set(size, size, size);
    matrix.compose(pos, quat, scale); trunk.setMatrixAt(i, matrix);
    pos.y = 7.4 * size; scale.set(size * 1.35, size * 0.95, size * 1.25); matrix.compose(pos, quat, scale); canopy.setMatrixAt(i, matrix);
  }
  trunk.castShadow = canopy.castShadow = true;
  trunk.instanceMatrix.needsUpdate = canopy.instanceMatrix.needsUpdate = true;
  group.add(trunk, canopy);
}

export function addSkyDome(group, color, horizon) {
  const dome = mesh(new THREE.SphereGeometry(112, 32, 18), new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, fog: false }), 0, 22, 0, false);
  group.add(dome);
  const haze = mesh(new THREE.CylinderGeometry(94, 106, 30, 48, 1, true), new THREE.MeshBasicMaterial({ color: horizon, side: THREE.BackSide, transparent: true, opacity: 0.42, fog: false }), 0, 12, 0, false);
  group.add(haze);
}

export function addBridge(group, ax, az, bx, bz, width = 2.5, raised = 1.1) {
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.hypot(dx, dz);
  const bridge = new THREE.Group();
  bridge.position.set((ax + bx) * 0.5, raised, (az + bz) * 0.5);
  bridge.rotation.y = Math.atan2(dx, dz);
  const planks = Math.max(4, Math.floor(length / 0.62));
  for (let i = 0; i <= planks; i += 1) box(bridge, width, 0.18, 0.5, i % 2 ? MATERIALS.paleWood : MATERIALS.wood, 0, 0, -length * 0.5 + (i / planks) * length);
  [-width * 0.5 + 0.14, width * 0.5 - 0.14].forEach((x) => {
    box(bridge, 0.12, 0.85, length, MATERIALS.wood, x, 0.46, 0);
    for (let i = -length * 0.45; i <= length * 0.45; i += 2.5) cylinder(bridge, 0.11, 0.11, 1.25, MATERIALS.wood, x, 0.46, i, 6);
  });
  group.add(bridge);
}

export function addArch(group, x, z, width = 5, height = 6, rotation = 0, mat = MATERIALS.stone) {
  const arch = new THREE.Group();
  arch.position.set(x, 0, z);
  arch.rotation.y = rotation;
  [-width * 0.5, width * 0.5].forEach((dx) => cylinder(arch, 0.44, 0.55, height * 0.58, mat, dx, height * 0.29, 0, 10));
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-width * 0.5, height * 0.57, 0), new THREE.Vector3(0, height * 1.1, 0), new THREE.Vector3(width * 0.5, height * 0.57, 0));
  arch.add(mesh(new THREE.TubeGeometry(curve, 14, 0.44, 8, false), mat));
  group.add(arch);
  return arch;
}

export function addTower(state, group, x, z, height = 15, radius = 3.1, wallMaterial = MATERIALS.limestone) {
  const tower = new THREE.Group();
  tower.position.set(x, 0, z);
  cylinder(tower, radius, radius * 1.16, height, wallMaterial, 0, height * 0.5, 0, 12);
  cylinder(tower, radius * 1.14, radius * 1.14, 0.56, MATERIALS.stoneDark, 0, height * 0.78, 0, 12);
  tower.add(mesh(new THREE.ConeGeometry(radius * 1.25, radius * 1.5, 10), MATERIALS.roof, 0, height + radius * 0.75, 0));
  for (let y = 3; y < height - 2; y += 3.2) {
    for (let i = 0; i < 4; i += 1) {
      const angle = i * Math.PI * 0.5 + 0.18;
      const window = box(tower, 0.48, 1.18, 0.12, material(0x8fc8d1, { emissive: 0x326c80, emissiveIntensity: 0.5 }), Math.sin(angle) * (radius + 0.03), y, Math.cos(angle) * (radius + 0.03));
      window.rotation.y = angle;
    }
  }
  group.add(tower);
  state.obstacles.push({ x, z, radius: radius + 0.7 });
  return tower;
}

export function addSail(group, x, z, scale = 1, rotation = 0) {
  const sailboat = new THREE.Group();
  sailboat.position.set(x, 0.25, z);
  sailboat.rotation.y = rotation;
  const hull = mesh(new THREE.CylinderGeometry(1.15 * scale, 1.65 * scale, 0.8 * scale, 10), MATERIALS.wood);
  hull.scale.z = 2.35;
  hull.rotation.z = Math.PI / 2;
  sailboat.add(hull);
  cylinder(sailboat, 0.1 * scale, 0.15 * scale, 7 * scale, MATERIALS.wood, 0, 3.45 * scale, 0, 7);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0.15, 6.45 * scale, 0, 0.15, 1.5 * scale, 0, 3.15 * scale, 1.5 * scale, 0], 3));
  geometry.computeVertexNormals();
  sailboat.add(mesh(geometry, MATERIALS.sail, 0, 0, 0, false));
  group.add(sailboat);
}

export function addBanners(group, x, z, count = 3) {
  for (let i = 0; i < count; i += 1) {
    const banner = new THREE.Group();
    banner.position.set(x + i * 3.1, 0, z);
    cylinder(banner, 0.07, 0.1, 5.6, MATERIALS.stoneDark, 0, 2.8, 0, 6);
    const cloth = mesh(new THREE.PlaneGeometry(1.25, 2.3, 1, 2), material(i % 2 ? 0x2e7885 : 0xa95245, { side: THREE.DoubleSide }), 0.58, 3.7, 0, false);
    cloth.rotation.y = Math.PI * 0.5;
    banner.add(cloth);
    group.add(banner);
  }
}

export function disposeObject(root) {
  const textures = new Set();
  root.traverse?.((node) => {
    if (node.isInstancedMesh) node.dispose();
    if (!node.geometry?.userData?.assetRuntimeOwned) node.geometry?.dispose();
    if (!node.material) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((value) => {
      for (const item of Object.values(value)) if (item?.isTexture && item.userData.sceneOwned && !item.userData.assetRuntimeOwned) textures.add(item);
      for (const texture of value.userData.ownedTextures || []) if (!texture.userData.assetRuntimeOwned) textures.add(texture);
      if (!value.userData.sharedWorldMaterial) value.dispose?.();
    });
  });
  textures.forEach(texture => texture.dispose());
}
