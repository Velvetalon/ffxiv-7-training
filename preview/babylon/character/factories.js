import { Color3, MeshBuilder, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';

export const CHARACTER_APPEARANCES = Object.freeze({
  WHM: { outfit: '#f5eedc', trim: '#a95854', weapon: 'staff' },
  PCT: { outfit: '#304f70', trim: '#dfa4ad', weapon: 'brush' },
  RPR: { outfit: '#34344b', trim: '#8f4868', weapon: 'scythe' },
  default: { outfit: '#5c7482', trim: '#d1b87b', weapon: 'staff' },
});

function color(value) {
  return typeof value === 'number' ? Color3.FromHexString(`#${value.toString(16).padStart(6, '0')}`) : Color3.FromHexString(value);
}

function material(scene, name, value, { emissive = null, alpha = 1 } = {}) {
  const result = new StandardMaterial(name, scene);
  result.diffuseColor = color(value);
  result.specularColor.copyFromFloats(0.08, 0.08, 0.08);
  if (emissive) result.emissiveColor = color(emissive);
  result.alpha = alpha;
  return result;
}

function attach(mesh, parent, position = [0, 0, 0], scaling = null) {
  mesh.parent = parent;
  mesh.position.copyFrom(Vector3.FromArray(position));
  if (scaling) mesh.scaling.copyFrom(Vector3.FromArray(scaling));
  mesh.isPickable = true;
  return mesh;
}

function capsule(name, scene, parent, height, radius, position, mat) {
  const mesh = attach(MeshBuilder.CreateCapsule(name, { height, radius, tessellation: 16 }, scene), parent, position, null);
  mesh.material = mat;
  return mesh;
}

function node(name, scene, parent) {
  const result = new TransformNode(name, scene);
  result.parent = parent;
  return result;
}

function setMeshMaterial(mesh, value) {
  mesh.material = value;
  return mesh;
}

export function createCharacter(jobId = 'WHM', scene) {
  if (!scene) throw new Error('createCharacter requires a Babylon scene');
  const appearance = CHARACTER_APPEARANCES[jobId] || CHARACTER_APPEARANCES.default;
  const root = new TransformNode('player', scene);
  const rig = Object.fromEntries(['body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'weapon'].map(name => [
    name,
    node(name, scene, root),
  ]));
  root.metadata = { ...(root.metadata || {}), rig, proceduralCharacter: true };
  const outfit = material(scene, `${jobId}:outfit`, appearance.outfit);
  const trim = material(scene, `${jobId}:trim`, appearance.trim);
  const skin = material(scene, `${jobId}:skin`, '#edc5a3');
  const hair = material(scene, `${jobId}:hair`, '#493e3c');
  const leather = material(scene, `${jobId}:leather`, '#514747');
  const metal = material(scene, `${jobId}:metal`, '#bba777');

  for (const [index, leg] of [rig.leftLeg, rig.rightLeg].entries()) {
    leg.position.copyFromFloats(index ? 0.15 : -0.15, 0.62, 0);
    setMeshMaterial(capsule(`leg:${index}`, scene, leg, 0.9, 0.115, [0, -0.22, 0], outfit), outfit);
    setMeshMaterial(capsule(`boot:${index}`, scene, leg, 0.48, 0.13, [0, -0.55, 0.07], leather), leather);
  }

  const torso = attach(MeshBuilder.CreateCylinder('torso', {
    height: 1.3, diameterTop: 0.34, diameterBottom: jobId === 'PCT' ? 0.66 : 0.84, tessellation: 24,
  }, scene), rig.body, [0, 1.03, 0]);
  torso.material = outfit;
  const shoulder = attach(MeshBuilder.CreateSphere('shoulders', { diameter: 0.72, segments: 20 }, scene), rig.body, [0, 1.55, 0], [1.15, 0.38, 0.9]);
  shoulder.material = trim;
  const neck = attach(MeshBuilder.CreateCylinder('neck', { height: 0.18, diameter: 0.2, tessellation: 16 }, scene), rig.body, [0, 1.75, 0]);
  neck.material = skin;
  const head = attach(MeshBuilder.CreateSphere('head', { diameter: 0.5, segments: 24 }, scene), rig.body, [0, 2.02, 0], [1, 1.16, 0.95]);
  head.material = skin;
  const hairCap = attach(MeshBuilder.CreateSphere('hair', { diameter: 0.53, segments: 20, slice: 0.58 }, scene), rig.body, [0, 2.11, -0.02], [1.03, 0.7, 1.02]);
  hairCap.material = hair;
  for (const side of [-1, 1]) {
    const eye = attach(MeshBuilder.CreateSphere(`eye:${side}`, { diameter: 0.055, segments: 10 }, scene), rig.body, [side * 0.095, 2.04, 0.226], [1, 1.25, 0.55]);
    eye.material = material(scene, `eye-mat:${side}`, '#355c67');
  }

  for (const [index, arm] of [rig.leftArm, rig.rightArm].entries()) {
    arm.position.copyFromFloats(index ? 0.36 : -0.36, 1.55, 0);
    const sleeve = capsule(`arm:${index}`, scene, arm, 0.72, 0.12, [0, -0.29, 0], outfit);
    sleeve.material = outfit;
    const hand = attach(MeshBuilder.CreateSphere(`hand:${index}`, { diameter: 0.19, segments: 14 }, scene), arm, [0, -0.65, 0]);
    hand.material = skin;
  }

  rig.weapon.position.copyFromFloats(0.56, 0.28, 0.05);
  const shaft = attach(MeshBuilder.CreateCylinder('weapon-shaft', { height: 2.3, diameter: 0.055, tessellation: 16 }, scene), rig.weapon, [0, 1.1, 0]);
  shaft.material = leather;
  if (appearance.weapon === 'staff') {
    const ring = attach(MeshBuilder.CreateTorus('weapon-ring', { diameter: 0.42, thickness: 0.055, tessellation: 28 }, scene), rig.weapon, [0, 2.18, 0]);
    ring.material = metal;
    const crystal = attach(MeshBuilder.CreatePolyhedron('weapon-crystal', { type: 1, size: 0.14 }, scene), rig.weapon, [0, 2.18, 0]);
    crystal.material = material(scene, 'weapon-crystal-material', '#9de8d4', { emissive: '#399d83' });
  } else if (appearance.weapon === 'brush') {
    const brush = attach(MeshBuilder.CreateCylinder('weapon-brush', { height: 0.46, diameterTop: 0, diameterBottom: 0.18, tessellation: 18 }, scene), rig.weapon, [0, 2.17, 0]);
    brush.material = trim;
  } else {
    const blade = attach(MeshBuilder.CreateBox('weapon-blade', { width: 0.82, height: 0.11, depth: 0.045 }, scene), rig.weapon, [-0.38, 2.18, 0]);
    blade.material = material(scene, 'weapon-blade-material', '#bbc3c8');
    blade.rotation.z = -0.34;
  }
  return root;
}

export const createInitialCharacter = createCharacter;

export function createDummy(scene) {
  if (!scene) throw new Error('createDummy requires a Babylon scene');
  const root = new TransformNode('training-dummy', scene);
  root.metadata = { ...(root.metadata || {}), targetable: true, proceduralDummy: true };
  const straw = material(scene, 'dummy-straw', '#c8ae7d');
  const timber = material(scene, 'dummy-timber', '#665144');
  const post = attach(MeshBuilder.CreateCylinder('dummy-post', { height: 2.7, diameter: 0.22, tessellation: 20 }, scene), root, [0, 1.35, 0]);
  post.material = timber;
  const body = capsule('dummy-body', scene, root, 1.2, 0.4, [0, 1.55, 0], straw);
  body.material = straw;
  const head = attach(MeshBuilder.CreateSphere('dummy-head', { diameter: 0.58, segments: 18 }, scene), root, [0, 2.35, 0]);
  head.material = straw;
  const cross = attach(MeshBuilder.CreateCylinder('dummy-crossbar', { height: 2, diameter: 0.14, tessellation: 16 }, scene), root, [0, 1.8, 0]);
  cross.material = timber;
  cross.rotation.z = Math.PI / 2;
  const target = attach(MeshBuilder.CreateDisc('dummy-target', { radius: 0.28, tessellation: 32, sideOrientation: 2 }, scene), root, [0, 1.65, 0.42]);
  target.material = material(scene, 'dummy-target-material', '#9e514a');
  const ring = attach(MeshBuilder.CreateTorus('target-ring', { diameter: 1.9, thickness: 0.07, tessellation: 48 }, scene), root, [0, 0.06, 0]);
  ring.name = 'target-ring';
  ring.rotation.x = Math.PI / 2;
  ring.material = material(scene, 'target-ring-material', '#eec780', { emissive: '#6c4f18', alpha: 0.92 });
  const marker = attach(MeshBuilder.CreateCylinder('target-marker', { height: 0.35, diameterTop: 0, diameterBottom: 0.28, tessellation: 4 }, scene), root, [0, 3, 0]);
  marker.name = 'target-marker';
  marker.material = material(scene, 'target-marker-material', '#f0d999', { emissive: '#6c4f18' });
  return root;
}

export function createNpc(scene, colorValue = 0x64746e) {
  const npc = createCharacter('default', scene);
  npc.name = 'npc';
  npc.scaling.setAll(0.95);
  const rig = npc.metadata.rig;
  rig.weapon.setEnabled(false);
  for (const mesh of rig.body.getChildMeshes(false)) {
    if (mesh.name === 'torso') mesh.material.diffuseColor = color(colorValue);
  }
  return npc;
}

export class ActorAnimation {
  constructor(player) {
    this.player = player;
    this.action = null;
  }

  setPlayer(player) {
    this.player = player;
    this.action = null;
  }

  trigger(event = {}, jobId = 'WHM') {
    if (event.type === 'error') return;
    this.action = { age: 0, duration: event.type === 'cast' ? 0.7 : 0.46, jobId, type: event.type || 'hit' };
  }

  update(dt, moving, time = 0) {
    const rig = this.player?.metadata?.rig;
    if (!rig) return;
    const walk = moving ? Math.sin(time * 10) : 0;
    const bob = moving ? Math.abs(Math.sin(time * 10)) * 0.055 : Math.sin(time * 2.1) * 0.012;
    rig.body.position.y = bob;
    rig.leftLeg.rotation.x = walk * 0.58;
    rig.rightLeg.rotation.x = -walk * 0.58;
    rig.leftArm.rotation.x = -walk * 0.33;
    rig.rightArm.rotation.x = walk * 0.33;
    rig.weapon.rotation.copyFromFloats(0, 0, 0);
    if (!this.action) return;
    this.action.age += dt;
    const phase = Math.min(1, this.action.age / this.action.duration);
    const windup = Math.sin(Math.min(phase, 0.5) * Math.PI);
    const strike = Math.sin(phase * Math.PI);
    if (this.action.jobId === 'RPR') {
      rig.rightArm.rotation.z = -0.62 * windup;
      rig.leftArm.rotation.z = 0.34 * windup;
      rig.weapon.rotation.z = -1.9 * strike;
      rig.body.rotation.y = -0.28 * strike;
    } else if (this.action.jobId === 'PCT') {
      rig.rightArm.rotation.z = -0.34 * windup;
      rig.leftArm.rotation.z = 0.22 * windup;
      rig.weapon.rotation.z = -0.75 * strike;
      rig.body.rotation.z = 0.09 * strike;
    } else {
      rig.rightArm.rotation.z = -0.42 * windup;
      rig.leftArm.rotation.z = 0.24 * windup;
      rig.weapon.rotation.z = -0.42 * strike;
      rig.body.rotation.z = 0.06 * strike;
    }
    if (phase < 1) return;
    rig.body.rotation.copyFromFloats(0, 0, 0);
    this.action = null;
  }
}
