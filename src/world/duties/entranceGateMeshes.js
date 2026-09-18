import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

export function mountDutyEntranceGates(scene, entrances, parent = null) {
  const root = new TransformNode('DutyEntranceGates', scene);
  root.parent = parent;
  const material = new StandardMaterial('DutyEntranceGateMaterial', scene);
  const tint = Color3.FromHexString('#e2c268');
  material.emissiveColor = tint;
  material.diffuseColor = tint.scale(0.12);
  material.alpha = 0.72;
  material.disableLighting = true;
  for (const gate of entrances || []) {
    const marker = new TransformNode(`duty-entrance:${gate.dutyKey}`, scene);
    marker.parent = root;
    marker.position.set(gate.position.x, gate.position.y, gate.position.z);
    marker.metadata = { dutyEntrance: gate };
    const ring = MeshBuilder.CreateTorus(`duty-entrance-ring:${gate.dutyKey}`, {
      diameter: 2.8, thickness: 0.16, tessellation: 28,
    }, scene);
    ring.parent = marker;
    ring.rotation.x = Math.PI * 0.5;
    ring.position.y = 0.14;
    ring.material = material;
    ring.metadata = { dutyEntrance: gate };
    ring.isPickable = true;
    const beam = MeshBuilder.CreateCylinder(`duty-entrance-beam:${gate.dutyKey}`, {
      height: 2.4, diameterTop: 0.16, diameterBottom: 0.56, tessellation: 10,
    }, scene);
    beam.parent = marker;
    beam.position.y = 1.2;
    beam.material = material;
    beam.metadata = { dutyEntrance: gate };
    beam.isPickable = true;
  }
  return { root, material };
}
