import * as THREE from 'three';
import { disposeObject, mesh } from './assets.js';
import { EffectRuntime } from '../vfx/EffectCore.js';


export class EffectSystem {
  constructor(root) {
    this.root = root;
    this.active = [];
    this.fields = new Map();
    // Client-derived AVFX content path: definitions are produced at build time by
    // tools/vfx and registered as data. Used only when a definition resolves for the
    // fired event; otherwise the hand-authored baseline below plays so the demo
    // always has feedback.
    this.vfxRuntime = new EffectRuntime();
    this.registerBuiltins();
  }

  registerBuiltins() {
    const catalog = {
      'RPR.hit': { schemaVersion: 1, effectId: 'RPR.hit', sourceStatus: 'APPROXIMATE', buildStatus: 'BUILT', runtimeStatus: 'NOT_TESTED', reviewStatus: 'PENDING', duration: 0.7, nodes: [{ kind: 'emitter', lifeSeconds: 0.7, emissionRate: 26, maxAlive: 26, size: 0.15, spread: 2.4, rise: 1.6, color: [0.85, 0.29, 0.47], gravity: -1.4 }] },
      'PCT.hit': { schemaVersion: 1, effectId: 'PCT.hit', sourceStatus: 'APPROXIMATE', buildStatus: 'BUILT', runtimeStatus: 'NOT_TESTED', reviewStatus: 'PENDING', duration: 0.7, nodes: [{ kind: 'emitter', lifeSeconds: 0.7, emissionRate: 26, maxAlive: 26, size: 0.15, spread: 2.4, rise: 1.6, color: [0.94, 0.66, 0.81], gravity: -1.4 }] },
      'WHM.hit': { schemaVersion: 1, effectId: 'WHM.hit', sourceStatus: 'APPROXIMATE', buildStatus: 'BUILT', runtimeStatus: 'NOT_TESTED', reviewStatus: 'PENDING', duration: 0.7, nodes: [{ kind: 'emitter', lifeSeconds: 0.7, emissionRate: 26, maxAlive: 26, size: 0.15, spread: 2.4, rise: 1.6, color: [1, 0.86, 0.55], gravity: -1.4 }] },
    };
    this.vfxRuntime.registerCatalog(catalog);
    // Client-derived catalog is fetched when deployed; when absent, the baseline
    // catalog above still exercises the runtime.
    fetch('/vfx/definitions/catalog.json')
      .then(response => (response.ok ? response.json() : null))
      .then(clientCatalog => { if (clientCatalog) this.vfxRuntime.registerCatalog(clientCatalog); })
      .catch(() => {});
  }

  play(event = {}, origin, jobId) {
    const effectId = event.effectId || (jobId ? jobId + '.' + (event.type || 'hit') : null);
    if (effectId && this.vfxRuntime.definitions.has(effectId)) {
      const anchor = origin.clone ? origin.clone() : origin;
      const handle = this.vfxRuntime.play({ effectId }, { root: this.root }, anchor);
      if (handle) return;
    }
    if (this.active.length > 42) this.remove(this.active.shift());
    const color = new THREE.Color(event.color || (jobId === 'RPR' ? 0xd94c79 : jobId === 'PCT' ? 0xf0a8cf : 0x88e7ff));
    const group = new THREE.Group();
    group.position.copy(origin);
    group.position.y += event.type === 'heal' ? 1.1 : 1.4;
    const type = event.type || 'hit';
    if (type === 'cast' || type === 'buff') {
      const ring = mesh(new THREE.TorusGeometry(0.7, 0.055, 8, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }), 0, 0.04, 0, false);
      ring.rotation.x = Math.PI * 0.5;
      group.add(ring);
      for (let i = 0; i < 5; i += 1) group.add(mesh(new THREE.OctahedronGeometry(0.13, 0), new THREE.MeshBasicMaterial({ color }), Math.cos(i * 1.256) * 0.84, 0.15, Math.sin(i * 1.256) * 0.84, false));
    } else {
      for (let i = 0; i < 8; i += 1) {
        const shard = mesh(new THREE.TetrahedronGeometry(0.14 + (i % 3) * 0.045), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }), 0, 0, 0, false);
        shard.userData.velocity = new THREE.Vector3(Math.cos(i * 0.785) * (1.6 + (i % 2) * 0.6), 1 + (i % 3) * 0.45, Math.sin(i * 0.785) * (1.6 + (i % 2) * 0.6));
        group.add(shard);
      }
      group.add(mesh(new THREE.SphereGeometry(0.32, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72 }), 0, 0, 0, false));
    }
    if (jobId === 'WHM') {
      for (let i = -1; i <= 1; i += 1) {
        const beam = mesh(new THREE.CylinderGeometry(0.045, 0.16, 2.8, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xffdc8e, transparent: true, opacity: 0.46, side: THREE.DoubleSide }), i * 0.48, 0.8, i * 0.18, false);
        beam.userData.velocity = new THREE.Vector3(0, 1.2 + Math.abs(i) * 0.4, 0);
        group.add(beam);
      }
    } else if (jobId === 'PCT') {
      const colors = [0xffa8c6, 0x8be4ef, 0xf4d86b];
      for (let i = 0; i < 3; i += 1) {
        const glyph = mesh(new THREE.RingGeometry(0.16, 0.21, i === 1 ? 4 : 3), new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.92, side: THREE.DoubleSide }), Math.cos(i * 2.1) * 0.78, 0.45 + i * 0.15, Math.sin(i * 2.1) * 0.78, false);
        glyph.rotation.x = Math.PI * 0.5;
        glyph.userData.velocity = new THREE.Vector3(Math.cos(i * 2.1) * 0.55, 0.9, Math.sin(i * 2.1) * 0.55);
        group.add(glyph);
      }
    } else if (jobId === 'RPR') {
      const crescent = mesh(new THREE.TorusGeometry(1.12, 0.1, 7, 24, Math.PI * 1.25), new THREE.MeshBasicMaterial({ color: 0xe9557b, transparent: true, opacity: 0.92 }), 0, 0.55, 0, false);
      crescent.rotation.set(Math.PI * 0.5, 0, -0.65);
      crescent.userData.velocity = new THREE.Vector3(0, 0.22, 0);
      group.add(crescent);
    }
    this.root.add(group);
    this.active.push({ group, age: 0, duration: type === 'buff' ? 1.1 : 0.62, type });
  }

  update(dt) {
    this.active = this.active.filter((effect) => {
      effect.age += dt;
      const life = effect.age / effect.duration;
      effect.group.children.forEach((child) => {
        if (child.userData.velocity) child.position.addScaledVector(child.userData.velocity, dt);
        child.rotation.y += dt * 3.4;
        if (typeof child.material?.opacity === 'number') child.material.opacity = Math.max(0, 1 - life);
      });
      effect.group.scale.setScalar(1 + life * (effect.type === 'hit' ? 1.6 : 0.9));
      if (life < 1) return true;
      this.remove(effect);
      return false;
    });
    this.fields.forEach((field, id) => {
      field.age += dt;
      const pulse = 0.82 + Math.sin(field.age * 3.2) * 0.14;
      field.ring.scale.setScalar(pulse);
      field.constellation.rotation.z += dt * 0.42;
      field.constellation.children.forEach((star, index) => {
        star.position.y = 0.06 + Math.sin(field.age * 2.4 + index) * 0.05;
      });
      if (field.age < field.duration) return;
      this.removeField(id);
    });
  }

  placeField(event = {}, origin) {
    const id = event.id || `field-${Date.now()}`;
    this.removeField(id);
    const radius = Math.max(0.5, Number(event.radius) || 5);
    const duration = Math.max(0.1, Number(event.duration) || 10);
    const color = new THREE.Color(event.color || '#ecd08d');
    const group = new THREE.Group();
    group.position.set(origin.x, (origin.y || 0) + 0.07, origin.z);
    const ring = mesh(new THREE.TorusGeometry(radius, 0.05, 8, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }), 0, 0, 0, false);
    ring.rotation.x = Math.PI * 0.5;
    const constellation = new THREE.Group();
    const inner = mesh(new THREE.RingGeometry(radius * 0.36, radius * 0.375, 36), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }), 0, 0.012, 0, false);
    inner.rotation.x = -Math.PI * 0.5;
    constellation.add(inner);
    for (let i = 0; i < 8; i += 1) {
      const angle = i * Math.PI * 0.25;
      const star = mesh(new THREE.OctahedronGeometry(0.09, 0), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }), Math.cos(angle) * radius * 0.68, 0.06, Math.sin(angle) * radius * 0.68, false);
      constellation.add(star);
    }
    group.add(ring, constellation);
    this.root.add(group);
    this.fields.set(id, { id, radius, duration, age: 0, group, ring, constellation });
  }

  activeFieldIdsAt(position) {
    return [...this.fields.values()]
      .filter((field) => Math.hypot(position.x - field.group.position.x, position.z - field.group.position.z) <= field.radius)
      .map((field) => field.id);
  }

  clearFields() {
    [...this.fields.keys()].forEach((id) => this.removeField(id));
  }

  clear() {
    this.active.forEach((effect) => this.remove(effect));
    this.active = [];
    this.clearFields();
  }

  remove(effect) {
    this.root.remove(effect.group);
    disposeObject(effect.group);
  }

  removeField(id) {
    const field = this.fields.get(id);
    if (!field) return;
    this.root.remove(field.group);
    disposeObject(field.group);
    this.fields.delete(id);
  }
}





