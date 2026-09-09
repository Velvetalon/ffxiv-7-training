import * as THREE from 'three';
import { createCharacter } from './actors.js';
import { ActorAnimation } from './animation.js';
import { animateCrystals, animateWater, disposeObject } from './assets.js';
import { EffectSystem } from './effects.js';
import { EntityRegistry } from './entities.js';
import { InputController } from './input.js';
import { createRenderer, addLighting, setQuality } from './renderer.js';
import { SCENE_BUILDERS } from './scenes/index.js';
import { getLayout } from './terrain/layouts.js';
import { Navigation } from './terrain/Navigation.js';
import { loadExtractedScene } from './imported/ExtractedScene.js';
import { MeshNavigation } from './imported/MeshNavigation.js';
import { mountEncounter } from './imported/MountScene.js';
import { FollowCamera } from './camera/FollowCamera.js';

const contextTarget = new THREE.Vector3();
const contextPlayer = new THREE.Vector3();

export class World {
  constructor(canvas, { onTarget, onInteract, onMove, onLoading, onSceneReady } = {}) {
    this.canvas = canvas;
    this.callbacks = { onTarget, onInteract, onMove, onLoading, onSceneReady };
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 650);
    this.followCamera = new FollowCamera(this.camera);
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
      onLookStart: () => { this.player.rotation.y = this.azimuth + Math.PI; },
    });
    this.setScene(this.sceneId);
  }

  setScene(id) {
    if (this.loading && this.sceneId === id) return this.loadPromise;
    const builder = SCENE_BUILDERS[id];
    if (!builder) throw new Error(`Unknown world scene: ${id}`);
    this.clearScene();
    this.isImported = false;
    this.sceneId = id;
    this.sceneRoot = new THREE.Group();
    this.scene.add(this.sceneRoot);
    this.registry.clear();
    this.obstacles = [];
    this.water = [];
    this.crystals = [];
    this.paths = [];
    this.navigationRegions = [];
    this.layout = getLayout(id);
    this.navigation = new Navigation(this.layout);
    builder(this, this.sceneRoot);
    this.scene.background = new THREE.Color(this.fogColor);
    this.scene.fog = new THREE.Fog(this.fogColor, 65, 260);
    addLighting(this.sceneRoot, id);
    setQuality(this.renderer, this.sceneRoot, this.quality);
    this.player.position.copy(this.spawn);
    this.player.rotation.y = Math.PI;
    this.target = null;
    this.clearReturnGate();
    this.azimuth = 0.05;
    this.polar = 1.2;
    this.zoom = 16;
    this.introFocus = 1;
    this.targetNearest();
    this.followCamera.reset();
    this.updateCamera(0);
    this.loadPromise = this.loadClientScene(id);
    return this.loadPromise;
  }

  async loadClientScene(id) {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    this.loading = true; this.loadError = null;
    this.input.setEnabled(false);
    this.callbacks.onLoading?.(0);
    try {
      const loaded = await loadExtractedScene(id,progress=>{if(request===this.loadRequest)this.callbacks.onLoading?.(progress*0.9);});
      const collisionResponse = await fetch(`${loaded.base}collision.bin`);
      if(!collisionResponse.ok)throw new Error('未找到导出的原始碰撞数据');
      const bytes=await collisionResponse.arrayBuffer();
      if(request!==this.loadRequest){disposeObject(loaded.group);return;}
      const navigation=new MeshNavigation(new Float32Array(bytes));
      this.clearScene();
      this.navigation=navigation;
      this.sceneRoot=loaded.group;
      this.layout=mountEncounter(this,loaded,navigation);
      this.scene.add(this.sceneRoot);
      this.water=[];this.crystals=[];this.architecture=[];this.landmarkLabels=[];
      this.importedManifest=loaded.manifest;
      this.isImported=true;
      this.scene.background=new THREE.Color(id==='gridania'?'#afc8bb':'#aac4d0');
      this.scene.fog=new THREE.Fog(this.scene.background,180,650);
      addLighting(this.sceneRoot,id);
      this.azimuth=this.trainingAzimuth ?? 0.1;
      this.player.rotation.y=this.azimuth+Math.PI;
      this.introFocus=0;this.zoom=14;this.polar=1.17;
      this.followCamera.reset();
      this.targetNearest();
      if(this.jobId==='RPR')this.moveToDummy();
      this.loading=false;this.input.setEnabled(true);
      this.callbacks.onLoading?.(1);
      this.callbacks.onSceneReady?.(id);
    } catch(error) {
      if(request!==this.loadRequest)return;
      this.loading=false;this.loadError=error.message;
      this.input.setEnabled(true);
      this.callbacks.onLoading?.(null,error.message);
      console.error('Client map import:',error);
    }
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
    for (const building of this.architecture || []) if (building.userData.wheel) building.userData.wheel.rotation.z += elapsed * 0.18;
    for (const label of this.landmarkLabels || []) label.visible = label.position.distanceTo(this.player.position) < 36;
    this.registry.values().forEach((entity, index) => {
      if (entity.type === 'npc') entity.object.position.y = (entity.baseY || 0) + Math.sin(this.time * 1.65 + index * 1.7) * 0.025;
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
    const distance = Math.hypot(this.player.position.x - targetPosition.x, this.player.position.z - targetPosition.z);
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
      map: { ...this.layout },
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
    this.input.setEnabled(enabled && !this.loading);
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
      const floor=this.navigation.surfaceAt(destination.x,destination.z,destination.y);
      if (!floor) return { ok: false, reason: '返回点已被阻挡' };
      this.player.position.set(destination.x, floor.height, destination.z);
      if(this.isImported)this.navigation.height=floor.height;
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
    this.navigation.move(this.player.position,direction.x*requested,direction.z*requested);
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
    const rearAngle=target.object.rotation.y+Math.PI;
    const point = this.navigation.nearestWalkable(target.object.position.x+Math.sin(rearAngle)*2.4, target.object.position.z+Math.cos(rearAngle)*2.4,25,target.object.position.y);
    if(!point)return;
    this.player.position.set(point.x, point.y ?? this.navigation.surfaceAt(point.x, point.z)?.height ?? 0, point.z);
    if(this.isImported)this.navigation.height=this.player.position.y;
    this.player.rotation.y = target.object.rotation.y;
    this.followCamera.reset();
    this.selectTarget(target);
    this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
  }

  dispose() {
    this.loadRequest=(this.loadRequest||0)+1;
    this.navigation?.dispose?.();
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
    this.navigation?.dispose?.();
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
      const offset = direction.clone().multiplyScalar((sprint ? 8.5 : 5.4) * this.movementSpeed * dt);
      const y = this.player.position.y;
      this.navigation.move(this.player.position, offset.x, offset.z);
      if (this.jumpVelocity) this.player.position.y = y;
      this.player.rotation.y = this.input.isLooking ? this.azimuth + Math.PI : Math.atan2(direction.x, direction.z);
      this.introFocus = 0;
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    }
    const floor = this.navigation.surfaceAt(this.player.position.x, this.player.position.z)?.height ?? this.player.position.y;
    if (this.jumpVelocity || this.input.consumeJump()) {
      if (!this.jumpVelocity && this.player.position.y <= floor + 0.001) this.jumpVelocity = 6.2;
      this.jumpVelocity -= 18 * dt;
      this.player.position.y = Math.max(floor, this.player.position.y + this.jumpVelocity * dt);
      if (this.player.position.y === floor) this.jumpVelocity = 0;
    }
  }

  isBlocked(x, z) {
    if (this.navigation) return !this.navigation.isWalkable(x, z);
    if (Math.abs(x) > this.bounds || Math.abs(z) > this.bounds) return true;
    if (this.navigationRegions.length && !this.isWalkable(x, z)) return true;
    return this.obstacles.some((obstacle) => Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.48);
  }

  isWalkable(x, z) {
    if (this.navigation) return this.navigation.isWalkable(x, z);
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
    this.zoom = THREE.MathUtils.clamp(this.zoom + wheel * 0.012, 4.5, 45);
    this.introFocus = 0;
    if (this.input.isLooking) this.player.rotation.y = this.azimuth + Math.PI;
  }

  setControlMode(mode) { this.input.setControlMode(mode); }

  saveReturnGate(duration, color) {
    this.clearReturnGate();
    const group = new THREE.Group();
    group.position.set(this.player.position.x, this.player.position.y + 0.08, this.player.position.z);
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
    if (this.returnGate) {
      this.returnGate.group.rotation.y += dt * 1.7;
      if (this.returnGate.expiresAt && this.time >= this.returnGate.expiresAt) this.clearReturnGate();
    }
    const polar = this.cameraMode === 'follow' ? 1.12 : this.polar;
    const distance = this.cameraMode === 'follow' ? Math.min(this.zoom, 10.5) : this.zoom;
    this.followCamera.update(this.player, { azimuth: this.azimuth, polar, distance, navigation: this.isImported ? this.navigation : null }, dt);
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

  goToLandmark(id) {
    const landmark = this.layout.landmarks.find(item => item.id === id);
    if (!landmark) return false;
    const point = this.navigation.nearestWalkable(landmark.x, landmark.z + (landmark.d || 0) / 2 + 2,25,landmark.y);
    if (!point) return false;
    this.player.position.set(point.x, point.y ?? this.navigation.surfaceAt(point.x, point.z)?.height ?? 0, point.z);
    if(this.isImported)this.navigation.height=this.player.position.y;
    this.player.rotation.y = Math.PI;
    this.callbacks.onMove?.(point);
    return true;
  }
}
