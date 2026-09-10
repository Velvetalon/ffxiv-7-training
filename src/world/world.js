import * as THREE from 'three';
import { createCharacter } from './actors.js';
import { animateCrystals, animateWater, disposeObject } from './assets.js';
import { EffectSystem } from './effects.js';
import { EntityRegistry } from './entities.js';
import { InputController } from './input.js';
import { createRenderer, setQuality } from './renderer.js';
import { SCENE_BUILDERS } from './scenes/index.js';
import { getLayout } from './terrain/layouts.js';
import { Navigation } from './terrain/Navigation.js';
import { loadExtractedScene } from './imported/ExtractedScene.js';
import { MeshNavigation } from './imported/MeshNavigation.js';
import { mountEncounter, prepareEncounter } from './imported/MountScene.js';
import { FollowCamera } from './camera/FollowCamera.js';
import { SCENES } from './scenes.js';
import { connectionDistance, findArrival, mountConnections, nearestConnection } from './imported/ZoneConnections.js';
import { loadCollision } from './imported/CollisionData.js';
import { GpuTimer } from '../assets/GpuTimer.js';
import { WorldTime, EnvironmentRuntime, createEnvironmentLights } from './environment/index.js';
import { CharacterRuntime } from '../character/CharacterRuntime.js';
import { MountRuntime } from '../character/MountRuntime.js';
import { ActionRuntime } from '../character/ActionRuntime.js';
import { SkillDefinitions } from '../character/SkillDefinitions.js';
import { ACTIONS } from '../combat/data.js';
import { mapAssetRuntime } from '../assets/MapAssets.js';
import { assetProfiler } from '../assets/AssetProfiler.js';

const contextTarget = new THREE.Vector3();
const contextPlayer = new THREE.Vector3();

export class World {
  constructor(canvas, { onTarget, onInteract, onMove, onLoading, onSceneReady, onConnection, initialScene = 'gridania' } = {}) {
    this.canvas = canvas;
    this.callbacks = { onTarget, onInteract, onMove, onLoading, onSceneReady, onConnection };
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 650);
    this.followCamera = new FollowCamera(this.camera);
    this.renderer = createRenderer(canvas);
    this.worldTime = new WorldTime({ hour: (Date.now() / 175000) % 24 });
    this.environment = new EnvironmentRuntime({ zoneId: initialScene });
    this.environmentLights = null;
    this.gpuTimer = new GpuTimer(this.renderer, timing => assetProfiler.resource('gpu-execution', timing));
    this.registry = new EntityRegistry();
    this.sceneRoot = new THREE.Group();
    this.effectsRoot = new THREE.Group();
    this.scene.add(this.sceneRoot, this.effectsRoot);
    this.effects = new EffectSystem(this.effectsRoot);
    this.characters = new Map();
    this.skillDefinitions = new SkillDefinitions(Object.values(ACTIONS).flat());
    this.character = this.createCharacterRuntime('player', createCharacter('WHM'));
    this.player = this.character.root;
    this.scene.add(this.player);
    this.mount = new MountRuntime(this.character);
    this.spawn = new THREE.Vector3();
    this.sceneId = initialScene;
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

  setScene(id, entry = {}) {
    if (this.loading) return this.requestedSceneId === id ? this.loadPromise : Promise.resolve(false);
    if (!SCENES.some(scene => scene.id === id)) throw new Error(`Unknown world scene: ${id}`);
    this.requestedSceneId = id;
    this.loadPromise = this.loadClientScene(id, entry);
    return this.loadPromise;
  }

  buildFallback(id) {
    const builder = SCENE_BUILDERS[id];
    if (!this.layout && builder) {
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
      this.mountEnvironment(id);
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
    }
  }

  async loadClientScene(id, entry = {}) {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    assetProfiler.begin(id, { request, entry });
    this.loading = true; this.loadError = null;
    this.input.setEnabled(false);
    this.callbacks.onLoading?.(0);
    let loaded, navigation, navigationTask;
    try {
      loaded = await loadExtractedScene(id,progress=>{
        if(request===this.loadRequest && this.loading)this.callbacks.onLoading?.(progress*0.9);
      }, {
        entry, renderer: this.renderer,
        onManifest: (base, manifest) => {
          navigationTask = (async () => {
            assetProfiler.mark('collision:load:start', { sceneId: id });
            const collision = await loadCollision(base, manifest);
            assetProfiler.mark('collision:load:complete', { sceneId: id, bytes: manifest.collisionBytes });
            assetProfiler.mark('bvh:start', { sceneId: id });
            const result = await MeshNavigation.create(collision);
            assetProfiler.mark('bvh:complete', { sceneId: id });
            return result;
          })();
          // Observe failures immediately even while models are still in flight.
          navigationTask.catch(() => {});
        },
      });
      navigationTask = loaded.navigationTask || navigationTask;
      navigation = await navigationTask;
      if(request!==this.loadRequest){
        disposeObject(loaded.group);
        loaded.release?.();
        if (!navigation.assetRuntimeOwned) navigation.dispose();
        return false;
      }
      const encounter=prepareEncounter(loaded.manifest,navigation);
      const arrival=findArrival(loaded.manifest,navigation,entry);
      this.clearReturnGate();
      assetProfiler.mark('instantiate:start', { sceneId: id, meshes: loaded.group.children.length });
      this.clearScene();
      this.assetScene = loaded.release ? loaded : null;
      this.sceneId=id;
      this.navigation=navigation;
      this.sceneRoot=loaded.group;
      this.layout=mountEncounter(this,loaded,navigation,encounter);
      loaded.layout = this.layout;
      mountConnections(this.sceneRoot,loaded.manifest.connections || []);
      this.scene.add(this.sceneRoot);
      this.water=[];this.crystals=[];this.architecture=[];this.landmarkLabels=[];
      this.importedManifest=loaded.manifest;
      this.preferredConnectionId=entry.arrivalConnection || null;
      this.isImported=true;
      this.scene.background=new THREE.Color(id==='gridania'?'#afc8bb':'#aac4d0');
      this.scene.fog=new THREE.Fog(this.scene.background,180,650);
      this.camera.far=Math.max(650,navigation.bounds.getSize(new THREE.Vector3()).length());
      this.camera.updateProjectionMatrix();
      this.mountEnvironment(id);
      setQuality(this.renderer,this.sceneRoot,this.quality);
      this.azimuth=this.trainingAzimuth ?? 0.1;
      this.player.rotation.y=this.azimuth+Math.PI;
      this.introFocus=0;this.zoom=14;this.polar=1.17;
      this.followCamera.reset();
      this.target=null;
      this.targetNearest();
      if(arrival) {
        this.player.position.set(arrival.x,arrival.y,arrival.z);
        this.navigation.height=arrival.y;
        const endpoint=loaded.manifest.connections?.find(connection=>connection.id===entry.arrivalConnection);
        const outwardHeading=endpoint?.source?.playerRunningDirection;
        if(Number.isFinite(outwardHeading)) {
          this.azimuth=outwardHeading;
          this.player.rotation.y=outwardHeading+Math.PI;
        }
        this.followCamera.reset();
      } else if(this.jobId==='RPR')this.moveToDummy();
      this.jumpVelocity=0;
      if (this.mount.state.isMounted) this.mount.state.movementMode = 'ground';
      this.loading=false;this.input.setEnabled(true);
      this.requestedSceneId=null;
      this.callbacks.onLoading?.(1);
      this.callbacks.onSceneReady?.(id);
      assetProfiler.mark('input:enabled', { sceneId: id });
      loaded.startStreaming?.(this.renderer);
      if (!loaded.startStreaming) assetProfiler.mark('fully-loaded', { sceneId: id });
      return true;
    } catch(error) {
      loaded?.release?.();
      if (navigationTask && !navigation) navigationTask.then(value => { if (!value.assetRuntimeOwned) value.dispose(); }).catch(() => {});
      if(loaded && loaded.group!==this.sceneRoot)disposeObject(loaded.group);
      if(navigation && navigation!==this.navigation && !navigation.assetRuntimeOwned)navigation.dispose();
      if(request!==this.loadRequest)return false;
      this.loading=false;this.loadError=error.message;
      if (!this.layout) this.buildFallback(id);
      this.requestedSceneId=null;
      this.input.setEnabled(Boolean(this.navigation));
      this.callbacks.onLoading?.(null,error.message);
      console.error('Client map import:',error);
      return false;
    }
  }

  getConnections() { return this.isImported ? this.importedManifest?.connections || [] : []; }

  getNearbyConnection() {
    if (this.loading) return null;
    const preferred=this.getConnections().find(connection=>connection.id===this.preferredConnectionId);
    if(preferred && connectionDistance(preferred,this.player.position)<=(preferred.radius || 3))return preferred;
    this.preferredConnectionId=null;
    return nearestConnection(this.getConnections(), this.player.position);
  }

  canUseConnection(id) {
    const connection=this.getConnections().find(connection=>connection.id===id);
    return !this.loading && !!connection && connectionDistance(connection,this.player.position)<=(connection.radius || 3);
  }

  setJob(id) {
    if (this.character.source === 'procedural' && !this.mount.state.isMounted) this.character.setModel(createCharacter(id));
    this.character.applyState({ jobId: id });
    this.jobId = id;
    this.clearReturnGate();
    this.clearFields();
  }

  update(dt) {
    const elapsed = Math.min(Math.max(dt || 0, 0), 0.08);
    this.time += elapsed;
    this.updateMovement(elapsed);
    if (!this.mount.state.isMounted && !this.character.state.airborne &&
        !['jump-start', 'jump-land'].includes(this.character.state.movement)) {
      this.character.state.movement = this.moving ? this.input.axes().sprint ? 'run' : 'walk' : 'idle';
    }
    for (const character of this.characters.values()) {
      character.update(elapsed, this.time);
      character.actions.update(elapsed);
    }
    animateWater(this.water, this.time);
    animateCrystals(this.crystals, this.time, elapsed);
    for (const building of this.architecture || []) if (building.userData.wheel) building.userData.wheel.rotation.z += elapsed * 0.18;
    for (const label of this.landmarkLabels || []) label.visible = label.position.distanceTo(this.player.position) < 36;
    this.effects.update(elapsed);
    this.worldTime.advance(dt);
    if (this.environmentLights) {
      const environment = this.environment.apply(this.scene, this.renderer, this.environmentLights, this.worldTime.snapshot());
      const sun = this.environmentLights.sun;
      sun.target.position.copy(this.player.position);
      sun.position.copy(this.player.position).addScaledVector(environment.sunDirection, 80);
      sun.target.updateMatrixWorld(true);
      const moon = this.environmentLights.moon;
      moon.target.position.copy(this.player.position);
      moon.position.copy(this.player.position).addScaledVector(environment.moonDirection, 80);
      moon.target.updateMatrixWorld(true);
    }
    this.updateCamera(elapsed);
    this.assetScene?.lod?.update(elapsed, this.camera);
    const cpuSubmitStartedAt = performance.now();
    const firstImportedFrame = this.isImported && !this.loading && !assetProfiler.active?.firstRender && assetProfiler.active?.sceneId === this.sceneId;
    const gpuToken = firstImportedFrame ? this.gpuTimer.begin({ sceneId: this.sceneId, phase: 'first-imported-render' }) : null;
    this.renderer.render(this.scene, this.camera);
    this.gpuTimer.end(gpuToken);
    this.gpuTimer.poll();
    if (firstImportedFrame) {
      assetProfiler.resource('gpu-timer-capability', { available: Boolean(this.gpuTimer.extension) });
      assetProfiler.cpuSubmit({ sceneId: this.sceneId, durationMs: performance.now() - cpuSubmitStartedAt });
      assetProfiler.firstRendered({ sceneId: this.sceneId, calls: this.renderer.info.render.calls });
      assetProfiler.mark('engine-interactive', { sceneId: this.sceneId, source: 'imported-frame-submitted-input-enabled' });
    }
  }

  resize(width, height) {
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  mountEnvironment(id) {
    this.environment.setZone(id);
    this.environment.setSourceSamples(this.environment.profile.samples || []);
    this.environmentLights = createEnvironmentLights(this.environment.profile);
    this.sceneRoot.add(this.environmentLights.rig);
  }

  createCharacterRuntime(id, model, name = '') {
    const character = new CharacterRuntime({ id, name, model, assetRuntime: mapAssetRuntime });
    character.actions = new ActionRuntime(character, {
      definitions: this.skillDefinitions,
      effects: this.effects,
      audio: this.audio,
      targetPosition: () => this.registry.get(character.state.targetId)?.object.position || character.root.position,
    });
    this.characters.set(id, character);
    if (this.npcDefinition) {
      character.loadDefinition(this.npcDefinition, this.npcDefinition.appearance).catch(error => {
        if (this.characters.get(id) === character) console.warn('NPC character resource:', error.message);
      });
    }
    return character;
  }

  setNpcDefinition(definition) {
    this.npcDefinition = definition;
    return Promise.all([...this.characters.values()].filter(character => character !== this.character).map(character =>
      character.loadDefinition(definition, definition.appearance)));
  }

  setAudioRuntime(audio) {
    this.audio = audio;
    for (const character of this.characters.values()) character.actions.audio = audio;
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
    this.input.setEnabled(enabled && !this.loading && Boolean(this.navigation));
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
    if (this.assetScene?.streaming && !this.assetScene.canMoveTo(origin.clone().addScaledVector(direction, requested))) {
      return { ok: false, moved: 0, reason: '前方地区仍在载入' };
    }
    this.navigation.move(this.player.position,direction.x*requested,direction.z*requested);
    const moved = origin.distanceTo(this.player.position);
    if (moved > 0.02) this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    return { ok: moved > 0.02, moved: Number(moved.toFixed(2)), position: { x: Number(this.player.position.x.toFixed(2)), z: Number(this.player.position.z.toFixed(2)) } };
  }

  effect(event) {
    if (event?.type === 'field') {
      this.effects.placeField(event, this.player.position);
      this.character.actions.apply(event);
      return;
    }
    this.character.state.targetId = this.target?.id || null;
    this.character.actions.apply(event);
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
    if (!this.navigation?.assetRuntimeOwned) this.navigation?.dispose?.();
    this.input.dispose();
    this.effects.clear();
    this.clearReturnGate();
    this.scene.remove(this.sceneRoot, this.player);
    disposeObject(this.sceneRoot);
    this.assetScene?.release();
    this.assetScene = null;
    this.mount.dispose();
    for (const character of this.characters.values()) character.dispose();
    this.characters.clear();
    this.gpuTimer.dispose();
    this.renderer.dispose();
  }

  selectTarget(target) {
    this.target = target;
    this.registry.setTargetVisual(target);
    this.callbacks.onTarget?.({ id: target.id, name: target.name, hp: target.hp, level: target.level });
  }

  clearScene() {
    this.effects.clear();
    for (const [id, character] of this.characters) {
      if (character === this.character) continue;
      character.dispose();
      this.characters.delete(id);
    }
    if (!this.navigation?.assetRuntimeOwned) this.navigation?.dispose?.();
    if (!this.sceneRoot) return;
    this.scene.remove(this.sceneRoot);
    disposeObject(this.sceneRoot);
    this.assetScene?.release();
    this.assetScene = null;
  }

  updateMovement(dt) {
    if (!this.input.enabled || !this.navigation) {
      this.moving = false;
      return;
    }
    const { forward, right, sprint, ascend, descend } = this.input.axes();
    const direction = new THREE.Vector3(
      -Math.sin(this.azimuth) * forward + Math.cos(this.azimuth) * right,
      0,
      -Math.cos(this.azimuth) * forward - Math.sin(this.azimuth) * right,
    ).normalize();
    this.moving = Boolean(forward || right);
    if (this.mount.state.isMounted) {
      this.mount.step(dt, { direction, ascend, descend }, this.navigation);
      if (this.moving) this.player.rotation.y = this.input.isLooking ? this.azimuth + Math.PI : Math.atan2(direction.x, direction.z);
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
      return;
    }
    const result = this.character.movement.step({
      direction, sprint, jump: this.input.consumeJump(),
      heading: this.input.isLooking ? this.azimuth + Math.PI : undefined,
    }, this.navigation, dt, {
      speedMultiplier: this.movementSpeed,
      isReady: point => !this.assetScene?.streaming || this.assetScene.canMoveTo(point),
    });
    this.moving = result.moving;
    if (result.changed) {
      this.introFocus = 0;
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    }
  }

  get jumpVelocity() { return this.character.movement.verticalVelocity; }
  set jumpVelocity(value) { this.character.movement.verticalVelocity = value; }

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
    this.polar = THREE.MathUtils.clamp(this.polar - dy * 0.006, 0.05, Math.PI - 0.05);
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(wheel * 0.0015), 2, 60);
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
    const head = this.mount.state.isMounted && this.character.model?.getObjectByName('j_kao');
    const focusHeight = head
      ? Math.max(0.3, head.getWorldPosition(new THREE.Vector3()).y - this.player.position.y)
      : this.mount.state.isMounted ? this.mount.definition.cameraHeightWorld || 2.5 : 1.45;
    this.followCamera.update(this.player, { azimuth: this.azimuth, polar: this.polar, distance: this.zoom, focusHeight, navigation: this.isImported ? this.navigation : null }, dt);
  }

  pick(event) {
    if (this.loading) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const portals = this.sceneRoot.children.filter(node => node.userData.connection);
    const portalHit = this.raycaster.intersectObjects(portals, true)[0];
    if (portalHit) {
      this.callbacks.onConnection?.(portalHit.object.userData.connection);
      return;
    }
    const hit = this.raycaster.intersectObjects(this.registry.pickRoots(), true).find((value) => value.object.userData.entityId);
    if (!hit) return;
    const entity = this.registry.get(hit.object.userData.entityId);
    if (!entity) return;
    if (entity.type === 'dummy' || entity.type === 'monster') this.selectTarget(entity);
    else this.callbacks.onInteract?.({ id: entity.id, name: entity.name, dialogue: entity.dialogue });
  }

  goToLandmark(id) {
    if (this.loading) return false;
    const landmark = this.layout.landmarks.find(item => item.id === id);
    if (!landmark) return false;
    if (this.assetScene?.streaming && !this.assetScene.canMoveTo(new THREE.Vector3(landmark.x, landmark.y || 0, landmark.z))) {
      const scene = this.assetScene;
      const restore = this.input.enabled;
      this.input.setEnabled(false);
      return scene.prepareLocation({ x: landmark.x, y: landmark.y || 0, z: landmark.z }).then(() => {
        if (this.assetScene !== scene) return false;
        return this.goToLandmark(id);
      }).finally(() => {
        if (this.assetScene === scene) this.setInputEnabled(restore);
      });
    }
    const point = this.navigation.nearestWalkable(landmark.x, landmark.z + (landmark.type==='connection' ? 0 : (landmark.d || 0) / 2 + 2),25,landmark.y);
    if (!point) return false;
    this.player.position.set(point.x, point.y ?? this.navigation.surfaceAt(point.x, point.z)?.height ?? 0, point.z);
    if(this.isImported)this.navigation.height=this.player.position.y;
    this.preferredConnectionId=landmark.type==='connection' ? id.slice('connection:'.length) : null;
    this.player.rotation.y = Math.PI;
    this.followCamera.reset();
    this.callbacks.onMove?.(point);
    return true;
  }
}
