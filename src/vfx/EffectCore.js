import * as THREE from 'three';

/**
 * Modular VFX runtime (v5 goal contract).
 * Content (EffectDefinition JSON produced by tools/vfx) is data; this module owns
 * instance state only. Lifecycle: PREPARING -> READY -> RUNNING -> DRAINING ->
 * DISPOSED, plus FAILED/CANCELLED. drain() stops new emission; cancel() disposes now.
 */
export const STATE = Object.freeze({
  PREPARING: 'PREPARING',
  READY: 'READY',
  RUNNING: 'RUNNING',
  DRAINING: 'DRAINING',
  DISPOSED: 'DISPOSED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

function colorFromDef(def) {
  const c = def?.color;
  if (Array.isArray(c) && c.length >= 3) return new THREE.Color(c[0], c[1], c[2]);
  return new THREE.Color(0x88e7ff);
}
function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

class Emitter {
  constructor(plan, emitterPlan, anchor, root, seed) {
    this.plan = emitterPlan;
    this.anchor = anchor;
    this.root = root;
    this.seed = seed || 0x9e3779b9;
    this.group = new THREE.Group();
    this.particles = [];
    this.elapsed = 0;
    this.spawnAccumulator = 0;
    this.hasSpawned = false;
    this.life = finite(plan.lifeSeconds, 1.2);
    this.rate = finite(emitterPlan.emissionRate, 14) || 14;
    this.maxAlive = finite(emitterPlan.maxAlive, 24);
    this.duration = finite(plan.duration, Infinity);
    this.state = STATE.PREPARING;
    root.add(this.group);
    this.build();
    this.state = STATE.READY;
  }
  build() {
    const plan = this.plan;
    const color = colorFromDef(plan);
    for (let i = 0; i < this.maxAlive; i += 1) {
      let mesh;
      if (plan.mesh) {
        const geo = new THREE.OctahedronGeometry(finite(plan.size, 0.14), 0);
        mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
      } else {
        const size = finite(plan.size, 0.16);
        const geo = new THREE.PlaneGeometry(size, size);
        mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        mesh.userData.billboard = plan.billboard !== false;
      }
      mesh.visible = false;
      mesh.userData.particle = { age: 0, lifetime: 0, velocity: new THREE.Vector3() };
      this.group.add(mesh);
      this.particles.push(mesh);
    }
  }
  followAnchor() {
    if (!this.anchor) return;
    const position = typeof this.anchor === 'function' ? this.anchor() : this.anchor;
    if (position?.isVector3 || (position && Number.isFinite(position.x))) this.group.position.copy(position);
  }
  seededRandom() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }
  update(dt) {
    this.elapsed += dt;
    this.followAnchor();
    if (this.state === STATE.READY) this.state = STATE.RUNNING;
    if (this.state === STATE.RUNNING && this.elapsed >= this.duration) this.drain();
    if (this.state === STATE.RUNNING) {
      this.spawnAccumulator += dt * this.rate;
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1;
        this.spawnParticle();
      }
    }
    const gravity = finite(this.plan.gravity, -1.2);
    for (const particle of this.particles) {
      if (!particle.visible) continue;
      const state = particle.userData.particle;
      state.age += dt;
      const life = state.age / state.lifetime;
      if (life >= 1) { particle.visible = false; continue; }
      state.velocity.y += gravity * dt;
      particle.position.addScaledVector(state.velocity, dt);
      if (particle.userData.billboard) particle.quaternion.copy(this.group.quaternion);
      particle.scale.setScalar(1 - life * 0.6);
      particle.material.opacity = 0.9 * (1 - life);
    }
    if (this.state === STATE.DRAINING && !this.particles.some(p => p.visible)) this.state = STATE.DISPOSED;
  }
  spawnParticle() {
    const particle = this.particles.find(p => !p.visible);
    if (!particle) return;
    const plan = this.plan;
    particle.visible = true;
    this.hasSpawned = true;
    particle.position.set(0, 0, 0);
    particle.userData.particle.age = 0;
    particle.userData.particle.lifetime = this.life * (0.7 + this.seededRandom() * 0.6);
    const spread = finite(plan.spread, 2.2);
    const angle = this.seededRandom() * Math.PI * 2;
    const speed = spread * (0.55 + this.seededRandom() * 0.7);
    particle.userData.particle.velocity.set(Math.cos(angle) * speed, finite(plan.rise, 1.4) * (0.6 + this.seededRandom()), Math.sin(angle) * speed);
    if (plan.mesh) particle.rotation.set(this.seededRandom() * 2, this.seededRandom() * 2, this.seededRandom() * 2);
  }
  drain() { if (this.state === STATE.RUNNING || this.state === STATE.READY) this.state = STATE.DRAINING; }
  dispose() {
    this.state = STATE.DISPOSED;
    for (const particle of this.particles) {
      particle.visible = false;
      particle.geometry?.dispose();
      particle.material?.dispose();
    }
    this.root.remove(this.group);
  }
}

export class EffectRuntime {
  constructor(assetRuntime) {
    this.assetRuntime = assetRuntime || null;
    this.definitions = new Map();
    this.instances = new Map();
    this.nextHandle = 1;
  }
  registerCatalog(definitions) {
    if (!definitions) return;
    for (const [id, definition] of Object.entries(definitions)) this.definitions.set(id, definition);
  }
  resolve(event) {
    const definition = this.definitions.get(event.effectId);
    if (!definition) return { status: 'unresolved', reason: 'unknown-effect' };
    return { status: 'resolved', definition, plan: this.buildPlan(definition) };
  }
  buildPlan(definition) {
    const nodes = definition.nodes || [];
    const emitters = nodes.filter(n => n.kind === 'emitter').map(node => ({
      emissionRate: finite(node.emissionRate, 14),
      maxAlive: finite(node.maxAlive, 24),
      size: finite(node.size, 0.16),
      spread: finite(node.spread, 2.2),
      rise: finite(node.rise, 1.4),
      gravity: node.gravity,
      color: node.color,
      billboard: node.billboard,
      mesh: node.mesh === true,
    }));
    return { effectId: definition.effectId, emitters, lifeSeconds: finite(definition.duration, 1.2), duration: finite(definition.duration, 1.2) };
  }
  spawn(plan, ownerScope, anchor) {
    if (!plan || !plan.emitters?.length) return null;
    const handle = this.nextHandle++;
    const root = ownerScope?.root || ownerScope;
    if (!root?.add) throw new TypeError('ownerScope.root must be a THREE.Object3D');
    const seed = (handle * 2654435761) >>> 0;
    const emitters = plan.emitters.map(emitterPlan => new Emitter(plan, emitterPlan, anchor, root, seed));
    this.instances.set(handle, { handle, plan, ownerScope, anchor, root, emitters, state: STATE.RUNNING });
    return handle;
  }
  play(event, ownerScope, anchor) {
    const resolved = this.resolve(event);
    if (resolved.status !== 'resolved') return null;
    return this.spawn(resolved.plan, ownerScope, anchor);
  }
  update(dt) {
    for (const [handle, instance] of [...this.instances]) {
      for (const emitter of instance.emitters) emitter.update(dt);
      const alive = instance.emitters.some(e => e.particles.some(p => p.visible));
      const started = instance.emitters.some(e => e.hasSpawned);
      if (!alive && started) this.dispose(handle);
    }
  }
  drain(handle) {
    const instance = this.instances.get(handle);
    if (!instance) return;
    for (const emitter of instance.emitters) emitter.drain();
    instance.state = STATE.DRAINING;
  }
  cancel(handle) {
    const instance = this.instances.get(handle);
    if (!instance) return;
    for (const emitter of instance.emitters) emitter.dispose();
    this.instances.delete(handle);
  }
  dispose(handle) {
    const instance = this.instances.get(handle);
    if (!instance) return;
    for (const emitter of instance.emitters) emitter.dispose();
    this.instances.delete(handle);
  }
  stopOwner(ownerScope) {
    for (const [handle, instance] of [...this.instances]) {
      if (instance.ownerScope === ownerScope) this.cancel(handle);
    }
  }
  inspect(handle) {
    const instance = this.instances.get(handle);
    if (!instance) return null;
    return {
      handle,
      state: instance.state,
      effectId: instance.plan.effectId,
      emitters: instance.emitters.map(e => ({ state: e.state, alive: e.particles.filter(p => p.visible).length })),
    };
  }
  get activeCount() { return this.instances.size; }
}





