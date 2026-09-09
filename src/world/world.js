import * as THREE from 'three';
import { createCharacter } from './actors.js';
import { ActorAnimation } from './animation.js';
import { animateCrystals, animateWater, disposeObject } from './assets.js';
import { EffectSystem } from './effects.js';
import { EntityRegistry } from './entities.js';
import { InputController } from './input.js';
import { createRenderer, addLighting, setQuality } from './renderer.js';
import { SCENE_BUILDERS } from './scenes/index.js';

const contextTarget = new THREE.Vector3();
const contextPlayer = new THREE.Vector3();
const cameraFocus = new THREE.Vector3();
const cameraLook = new THREE.Vector3();

export class World {
  constructor(canvas, { onTarget, onInteract, onMove } = {}) {
    this.canvas = canvas;
    this.callbacks = { onTarget, onInteract, onMove };
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(56, 1, 0.1, 220);
    this.renderer = createRenderer(canvas);
    this.registry = new EntityRegistry();
    this.sceneRoot = new THREE.Group();
    this.effectsRoot = new THREE.Group();
    this.scene.add(this.sceneRoot, this.effectsRoot);
    this.effects = new EffectSystem(this.effectsRoot);
    this.player = createCharacter('WHM');
    this.scene.add(this.player);
    this.actorAnimation = new ActorAnimation(this.player);
    this.spawn = new THREE.Vector3();
    this.sceneId = 'gridania';
    this.jobId = 'WHM';
    this.target = null;
    this.obstacles = [];
    this.water = [];
    this.crystals = [];
    this.paths = [];
    this.navigationRegions = [];
    this.bounds = 54;
    this.fogColor = 0x9ec1ad;
    this.time = 0;
    this.moving = false;
    this.jumpVelocity = 0;
    this.azimuth = 0.05;
    this.polar = 1.2;
    this.zoom = 18.5;
    this.cameraMode = 'orbit';
    this.introFocus = 1;
    this.quality = 'high';
    this.movementSpeed = 1;
    this.returnGate = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.input = new InputController(canvas, {
      onOrbit: (dx, dy, wheel) => this.adjustCamera(dx, dy, wheel),
      onClick: (type, event) => (type === 'nearest' ? this.targetNearest() : this.pick(event)),
    });
    this.setScene(this.sceneId);
  }

  setScene(id) {
    const builder = SCENE_BUILDERS[id];
    if (!builder) throw new Error(`Unknown world scene: ${id}`);
    this.clearScene();
    this.sceneId = id;
    this.sceneRoot = new THREE.Group();
    this.scene.add(this.sceneRoot);
    this.registry.clear();
    this.obstacles = [];
    this.water = [];
    this.crystals = [];
    this.paths = [];
    this.navigationRegions = [];
    builder(this, this.sceneRoot);
    this.scene.background = new THREE.Color(this.fogColor);
    this.scene.fog = new THREE.Fog(this.fogColor, 35, 115);
    addLighting(this.sceneRoot, id);
    setQuality(this.renderer, this.sceneRoot, this.quality);
    this.player.position.copy(this.spawn);
    this.player.rotation.y = Math.PI;
    this.target = null;
    this.clearReturnGate();
    this.azimuth = 0.05;
    this.polar = 1.2;
    this.zoom = 18.5;
    this.introFocus = 1;
    this.targetNearest();
    this.updateCamera(0);
  }

  setJob(id) {
    const position = this.player.position.clone();
    const rotation = this.player.rotation.y;
    this.scene.remove(this.player);
    disposeObject(this.player);
    this.player = createCharacter(id);
    this.player.position.copy(position);
    this.player.rotation.y = rotation;
    this.scene.add(this.player);
    this.actorAnimation.setPlayer(this.player);
    this.jobId = id;
    this.clearReturnGate();
    this.clearFields();
  }

  update(dt) {
    const elapsed = Math.min(Math.max(dt || 0, 0), 0.08);
    this.time += elapsed;
    this.updateMovement(elapsed);
    this.actorAnimation.update(elapsed, this.moving, this.time);
    animateWater(this.water, this.time);
    animateCrystals(this.crystals, this.time, elapsed);
    this.registry.values().forEach((entity, index) => {
      if (entity.type === 'npc') entity.object.position.y = Math.sin(this.time * 1.65 + index * 1.7) * 0.035;
    });
    this.effects.update(elapsed);
    this.updateCamera(elapsed);
    this.renderer.render(this.scene, this.camera);
  }

  resize(width, height) {
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  getContext() {
    const fields = this.effects.activeFieldIdsAt(this.player.position);
    if (!this.target) return { moving: this.moving, distance: 99, positional: 'rear', target: false, targets: 0, fields };
    const targetPosition = this.target.object.getWorldPosition(contextTarget);
    const distance = this.player.position.distanceTo(targetPosition);
    const direction = contextPlayer.copy(this.player.position).sub(targetPosition).setY(0).normalize();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.target.object.quaternion);
    const dot = forward.dot(direction);
    const cross = forward.x * direction.z - forward.z * direction.x;
    return {
      moving: this.moving,
      distance: Number(distance.toFixed(2)),
      positional: dot < -0.5 ? 'rear' : Math.abs(cross) > 0.48 ? 'flank' : 'front',
      target: true,
      targets: 1,
      fields,
    };
  }

  getInfo() {
    return {
      position: { x: Number(this.player.position.x.toFixed(2)), z: Number(this.player.position.z.toFixed(2)) },
      sceneId: this.sceneId,
      target: this.target ? { id: this.target.id, name: this.target.name, hp: this.target.hp, level: this.target.level } : null,
      entities: this.registry.getInfo(),
      cameraAngle: Number(this.azimuth.toFixed(3)),
      map: { paths: this.paths.map((path) => ({ ...path })) },
    };
  }

  targetNearest() {
    const target = this.registry.nearestTarget(this.player.position);
    if (target) this.selectTarget(target);
  }

  clearTarget() {
    this.target = null;
    this.registry.setTargetVisual(null);
    this.callbacks.onTarget?.(null);
  }

  setInputEnabled(enabled) {
    this.input.setEnabled(enabled);
    if (!enabled) this.moving = false;
  }

  setQuality(quality) {
    this.quality = quality === 'low' ? 'low' : 'high';
    setQuality(this.renderer, this.sceneRoot, this.quality);
  }

  setCameraMode(mode) {
    this.cameraMode = mode === 'follow' ? 'follow' : 'orbit';
  }

  setMovementSpeed(multiplier = 1) {
    this.movementSpeed = THREE.MathUtils.clamp(Number(multiplier) || 1, 0.1, 3);
  }

  moveSkill({ kind = 'forward', distance = 15, saveReturn = false, gateDuration = 0, gateColor = 0x8f5cff } = {}) {
    if (kind === 'return') {
      if (!this.returnGate) return { ok: false, reason: '没有可返回的空间印记' };
      const destination = this.returnGate.position;
      if (this.isBlocked(destination.x, destination.z)) return { ok: false, reason: '返回点已被阻挡' };
      this.player.position.set(destination.x, 0, destination.z);
      this.clearReturnGate();
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
      return { ok: true, moved: 0, returned: true, position: { x: this.player.position.x, z: this.player.position.z } };
    }
    const requested = THREE.MathUtils.clamp(Number(distance) || 0, 0, 30);
    if (!requested) return { ok: false, reason: '位移距离无效' };
    if (saveReturn) this.saveReturnGate(gateDuration, gateColor);
    const direction = new THREE.Vector3(Math.sin(this.player.rotation.y), 0, Math.cos(this.player.rotation.y));
    if (kind === 'backward') direction.negate();
    const origin = this.player.position.clone();
    const stepSize = 0.35;
    for (let moved = 0; moved < requested; moved += stepSize) {
      const candidate = this.player.position.clone().addScaledVector(direction, Math.min(stepSize, requested - moved));
      if (this.isBlocked(candidate.x, candidate.z)) break;
      this.player.position.copy(candidate);
    }
    const moved = origin.distanceTo(this.player.position);
    if (moved > 0.02) this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    return { ok: moved > 0.02, moved: Number(moved.toFixed(2)), position: { x: Number(this.player.position.x.toFixed(2)), z: Number(this.player.position.z.toFixed(2)) } };
  }

  effect(event) {
    if (event?.type === 'field') {
      this.effects.placeField(event, this.player.position);
      this.actorAnimation.trigger(event, this.jobId);
      return;
    }
    this.effects.play(event, this.target?.object.position || this.player.position, this.jobId);
    this.actorAnimation.trigger(event, this.jobId);
  }

  clearFields() {
    this.effects.clearFields();
  }

  moveToDummy() {
    const target = this.registry.nearestTarget(this.player.position);
    if (!target) return;
    this.player.position.set(target.object.position.x, 0, target.object.position.z + 2.4);
    this.player.rotation.y = Math.PI;
    this.selectTarget(target);
    this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
  }

  dispose() {
    this.input.dispose();
    this.effects.clear();
    this.clearReturnGate();
    this.scene.remove(this.sceneRoot, this.player);
    disposeObject(this.sceneRoot);
    disposeObject(this.player);
    this.renderer.dispose();
  }

  selectTarget(target) {
    this.target = target;
    this.registry.setTargetVisual(target);
    this.callbacks.onTarget?.({ id: target.id, name: target.name, hp: target.hp, level: target.level });
  }

  clearScene() {
    this.effects.clear();
    if (!this.sceneRoot) return;
    this.scene.remove(this.sceneRoot);
    disposeObject(this.sceneRoot);
  }

  updateMovement(dt) {
    if (!this.input.enabled) {
      this.moving = false;
      return;
    }
    const { forward, right, sprint } = this.input.axes();
    this.moving = Boolean(forward || right);
    if (this.moving) {
      const direction = new THREE.Vector3(
        -Math.sin(this.azimuth) * forward + Math.cos(this.azimuth) * right,
        0,
        -Math.cos(this.azimuth) * forward - Math.sin(this.azimuth) * right,
      ).normalize();
      const candidate = this.player.position.clone().addScaledVector(direction, (sprint ? 8.5 : 5.4) * this.movementSpeed * dt);
      if (!this.isBlocked(candidate.x, candidate.z)) this.player.position.copy(candidate);
      this.player.rotation.y = Math.atan2(direction.x, direction.z);
      this.introFocus = 0;
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    }
    if (this.jumpVelocity || this.input.consumeJump()) {
      if (!this.jumpVelocity && this.player.position.y <= 0.001) this.jumpVelocity = 6.2;
      this.jumpVelocity -= 18 * dt;
      this.player.position.y = Math.max(0, this.player.position.y + this.jumpVelocity * dt);
      if (this.player.position.y === 0) this.jumpVelocity = 0;
    }
  }

  isBlocked(x, z) {
    if (Math.abs(x) > this.bounds || Math.abs(z) > this.bounds) return true;
    if (this.navigationRegions.length && !this.isWalkable(x, z)) return true;
    return this.obstacles.some((obstacle) => Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.48);
  }

  isWalkable(x, z) {
    return this.navigationRegions.some((region) => {
      if (region.type === 'circle') return Math.hypot(x - region.x, z - region.z) <= region.radius;
      const rotation = region.rotation || 0;
      const dx = x - region.x;
      const dz = z - region.z;
      const cosine = Math.cos(-rotation);
      const sine = Math.sin(-rotation);
      const localX = dx * cosine - dz * sine;
      const localZ = dx * sine + dz * cosine;
      return Math.abs(localX) <= region.w * 0.5 && Math.abs(localZ) <= region.d * 0.5;
    });
  }

  adjustCamera(dx, dy, wheel = 0) {
    this.azimuth -= dx * 0.007;
    this.polar = THREE.MathUtils.clamp(this.polar + dy * 0.006, 0.56, 1.42);
    this.zoom = THREE.MathUtils.clamp(this.zoom + wheel * 0.012, 6.5, 25);
    this.introFocus = 0;
  }

  saveReturnGate(duration, color) {
    this.clearReturnGate();
    const group = new THREE.Group();
    group.position.set(this.player.position.x, 0.08, this.player.position.z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.055, 8, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    ring.rotation.x = Math.PI * 0.5;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.27, 2.1, 8, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, side: THREE.DoubleSide }));
    beam.position.y = 1.05;
    group.add(ring, beam);
    this.sceneRoot.add(group);
    this.returnGate = { position: this.player.position.clone(), group, expiresAt: duration > 0 ? this.time + duration : 0 };
  }

  clearReturnGate() {
    if (!this.returnGate) return;
    this.sceneRoot.remove(this.returnGate.group);
    disposeObject(this.returnGate.group);
    this.returnGate = null;
  }

  updateCamera(dt) {
    this.introFocus = Math.max(0, this.introFocus - dt * 0.12);
    if (this.returnGate) {
      this.returnGate.group.rotation.y += dt * 1.7;
      if (this.returnGate.expiresAt && this.time >= this.returnGate.expiresAt) this.clearReturnGate();
    }
    cameraFocus.copy(this.player.position).add(new THREE.Vector3(0, 1.45, -8 * this.introFocus));
    const polar = this.cameraMode === 'follow' ? 1.12 : this.polar;
    const distance = this.cameraMode === 'follow' ? Math.min(this.zoom, 10.5) : this.zoom;
    const horizontal = Math.sin(polar) * distance;
    this.camera.position.set(cameraFocus.x + Math.sin(this.azimuth) * horizontal, cameraFocus.y + Math.cos(polar) * distance, cameraFocus.z + Math.cos(this.azimuth) * horizontal);
    cameraLook.copy(cameraFocus);
    if (this.target && this.cameraMode === 'orbit') cameraLook.lerp(this.target.object.position.clone().add(new THREE.Vector3(0, 1.2, 0)), 0.2);
    this.camera.lookAt(cameraLook);
  }

  pick(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.registry.pickRoots(), true).find((value) => value.object.userData.entityId);
    if (!hit) return;
    const entity = this.registry.get(hit.object.userData.entityId);
    if (!entity) return;
    if (entity.type === 'dummy' || entity.type === 'monster') this.selectTarget(entity);
    else this.callbacks.onInteract?.({ id: entity.id, name: entity.name, dialogue: entity.dialogue });
  }
}
