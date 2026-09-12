import {
  Color3,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

function color3(value, fallback = '#88e7ff') {
  if (value instanceof Color3) return value.clone();
  if (typeof value === 'number') return Color3.FromInts((value >> 16) & 255, (value >> 8) & 255, value & 255);
  try { return Color3.FromHexString(value || fallback); } catch { return Color3.FromHexString(fallback); }
}

function material(scene, name, color, alpha = 1) {
  const result = new StandardMaterial(name, scene);
  result.diffuseColor = color.scale(0.18);
  result.emissiveColor = color;
  result.specularColor = Color3.Black();
  result.alpha = alpha;
  result.disableLighting = true;
  result.backFaceCulling = false;
  result.disableDepthWrite = alpha < 1;
  return result;
}

function own(root, mesh, mat, velocity = null) {
  mesh.parent = root;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.metadata = { ...(mesh.metadata || {}), velocity };
  return mesh;
}

function disposeRoot(root) {
  root?.dispose(false, true);
}

export class EffectSystem {
  constructor(scene) {
    this.scene = scene;
    this.root = new TransformNode('NativeEffects', scene);
    this.active = [];
    this.fields = new Map();
  }

  play(event = {}, origin = Vector3.Zero(), jobId = 'WHM') {
    if (this.active.length > 42) this.remove(this.active.shift());
    const tint = color3(event.color, jobId === 'RPR' ? '#d94c79' : jobId === 'PCT' ? '#f0a8cf' : '#88e7ff');
    const group = new TransformNode(`effect:${event.type || 'hit'}`, this.scene);
    group.parent = this.root;
    group.position.copyFrom(origin);
    group.position.y += event.type === 'heal' ? 1.1 : 1.4;
    const type = event.type || 'hit';
    if (type === 'cast' || type === 'buff') {
      const ring = own(group, MeshBuilder.CreateTorus('cast-ring', { diameter: 1.4, thickness: 0.1, tessellation: 28 }, this.scene), material(this.scene, 'cast-ring-material', tint, 0.9));
      ring.rotation.x = Math.PI * 0.5;
      ring.position.y = 0.04;
      for (let index = 0; index < 5; index += 1) {
        const angle = index * Math.PI * 0.4;
        const shard = own(group, MeshBuilder.CreatePolyhedron(`cast-shard:${index}`, { type: 1, size: 0.13 }, this.scene), material(this.scene, `cast-shard-material:${index}`, tint));
        shard.position.set(Math.cos(angle) * 0.84, 0.15, Math.sin(angle) * 0.84);
      }
    } else {
      for (let index = 0; index < 8; index += 1) {
        const angle = index * Math.PI * 0.25;
        const speed = 1.6 + (index % 2) * 0.6;
        const shard = own(
          group,
          MeshBuilder.CreatePolyhedron(`hit-shard:${index}`, { type: 0, size: 0.14 + (index % 3) * 0.045 }, this.scene),
          material(this.scene, `hit-shard-material:${index}`, tint, 0.95),
          new Vector3(Math.cos(angle) * speed, 1 + (index % 3) * 0.45, Math.sin(angle) * speed),
        );
        shard.position.set(0, 0, 0);
      }
      own(group, MeshBuilder.CreateSphere('hit-core', { diameter: 0.64, segments: 10 }, this.scene), material(this.scene, 'hit-core-material', tint, 0.72));
    }
    this.addJobAccent(group, jobId, tint);
    this.active.push({ group, age: 0, duration: type === 'buff' ? 1.1 : 0.62, type });
  }

  addJobAccent(group, jobId, tint) {
    if (jobId === 'WHM') {
      const beamColor = color3('#ffdc8e');
      for (let index = -1; index <= 1; index += 1) {
        const beam = own(
          group,
          MeshBuilder.CreateCylinder(`whm-beam:${index}`, { height: 2.8, diameterTop: 0.09, diameterBottom: 0.32, tessellation: 8 }, this.scene),
          material(this.scene, `whm-beam-material:${index}`, beamColor, 0.46),
          new Vector3(0, 1.2 + Math.abs(index) * 0.4, 0),
        );
        beam.position.set(index * 0.48, 0.8, index * 0.18);
      }
    } else if (jobId === 'PCT') {
      ['#ffa8c6', '#8be4ef', '#f4d86b'].forEach((value, index) => {
        const angle = index * 2.1;
        const glyph = own(
          group,
          MeshBuilder.CreateTorus(`pct-glyph:${index}`, { diameter: 0.4, thickness: 0.055, tessellation: index === 1 ? 4 : 3 }, this.scene),
          material(this.scene, `pct-glyph-material:${index}`, color3(value), 0.92),
          new Vector3(Math.cos(angle) * 0.55, 0.9, Math.sin(angle) * 0.55),
        );
        glyph.rotation.x = Math.PI * 0.5;
        glyph.position.set(Math.cos(angle) * 0.78, 0.45 + index * 0.15, Math.sin(angle) * 0.78);
      });
    } else if (jobId === 'RPR') {
      const crescent = own(group, MeshBuilder.CreateTorus('rpr-crescent', { diameter: 2.24, thickness: 0.2, tessellation: 24, arc: 0.63 }, this.scene), material(this.scene, 'rpr-crescent-material', tint, 0.92), new Vector3(0, 0.22, 0));
      crescent.rotation.set(Math.PI * 0.5, 0, -0.65);
      crescent.position.y = 0.55;
    }
  }

  update(dt) {
    this.active = this.active.filter(effect => {
      effect.age += dt;
      const life = effect.age / effect.duration;
      for (const child of effect.group.getChildMeshes(false)) {
        const velocity = child.metadata?.velocity;
        if (velocity) child.position.addInPlace(velocity.scale(dt));
        child.rotation.y += dt * 3.4;
        if (child.material) child.material.alpha = Math.max(0, 1 - life);
      }
      const scale = 1 + life * (effect.type === 'hit' ? 1.6 : 0.9);
      effect.group.scaling.setAll(scale);
      if (life < 1) return true;
      this.remove(effect);
      return false;
    });
    for (const [id, field] of this.fields) {
      field.age += dt;
      const pulse = 0.82 + Math.sin(field.age * 3.2) * 0.14;
      field.ring.scaling.setAll(pulse);
      field.constellation.rotation.z += dt * 0.42;
      field.stars.forEach((star, index) => { star.position.y = 0.06 + Math.sin(field.age * 2.4 + index) * 0.05; });
      if (field.age >= field.duration) this.removeField(id);
    }
  }

  placeField(event = {}, origin = Vector3.Zero()) {
    const id = event.id || `field-${Date.now()}`;
    this.removeField(id);
    const radius = Math.max(0.5, Number(event.radius) || 5);
    const duration = Math.max(0.1, Number(event.duration) || 10);
    const tint = color3(event.color, '#ecd08d');
    const group = new TransformNode(`field:${id}`, this.scene);
    group.parent = this.root;
    group.position.set(origin.x, (origin.y || 0) + 0.07, origin.z);
    const ring = own(group, MeshBuilder.CreateTorus(`field-ring:${id}`, { diameter: radius * 2, thickness: 0.1, tessellation: 48 }, this.scene), material(this.scene, `field-ring-material:${id}`, tint, 0.8));
    ring.rotation.x = Math.PI * 0.5;
    const constellation = new TransformNode(`field-constellation:${id}`, this.scene);
    constellation.parent = group;
    const inner = own(constellation, MeshBuilder.CreateTorus(`field-inner:${id}`, { diameter: radius * 0.735, thickness: radius * 0.03, tessellation: 36 }, this.scene), material(this.scene, `field-inner-material:${id}`, tint, 0.45));
    inner.rotation.x = Math.PI * 0.5;
    inner.position.y = 0.012;
    const stars = [];
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI * 0.25;
      const star = own(constellation, MeshBuilder.CreatePolyhedron(`field-star:${id}:${index}`, { type: 1, size: 0.09 }, this.scene), material(this.scene, `field-star-material:${id}:${index}`, tint, 0.9));
      star.position.set(Math.cos(angle) * radius * 0.68, 0.06, Math.sin(angle) * radius * 0.68);
      stars.push(star);
    }
    this.fields.set(id, { id, radius, duration, age: 0, group, ring, constellation, stars });
  }

  activeFieldIdsAt(position) {
    return [...this.fields.values()]
      .filter(field => Math.hypot(position.x - field.group.position.x, position.z - field.group.position.z) <= field.radius)
      .map(field => field.id);
  }

  clearFields() {
    for (const id of [...this.fields.keys()]) this.removeField(id);
  }

  clear() {
    for (const effect of this.active) this.remove(effect);
    this.active = [];
    this.clearFields();
  }

  remove(effect) {
    disposeRoot(effect?.group);
  }

  removeField(id) {
    const field = this.fields.get(id);
    if (!field) return;
    disposeRoot(field.group);
    this.fields.delete(id);
  }

  dispose() {
    this.clear();
    this.root.dispose(false, true);
  }
}

export default EffectSystem;
