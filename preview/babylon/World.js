import {
  Color3,
  Engine,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core';
import BabylonAssets from './AssetBridge.js';
import EnvironmentAdapter from './EnvironmentAdapter.js';
import MaterialAdapter from './MaterialAdapter.js';
import { DebugRenderMode } from './DebugRenderMode.js';
import { createBabylonMapLoader } from './SceneLoader.js';
import { Navigation, createFallbackNavigation } from './Navigation.js';
import { EffectSystem } from './Effects.js';
import {
  EntityRegistry,
  connectionDistance,
  findArrival,
  mountConnections,
  mountEncounter,
  nearestConnection,
  prepareEncounter,
} from './Encounter.js';
import { mountDutyEntranceGates } from '../../src/world/duties/entranceGateMeshes.js';
import {
  ActionRuntime,
  CharacterRuntime,
  MountRuntime,
  createCharacter,
  createDummy,
  createNpc,
} from './character/index.js';
import { sandboxAssetRuntime } from './SandboxAssets.js';
import { InputController } from '../../src/world/input.js';
import { WorldTime } from '../../src/world/environment/WorldTime.js';
import { SkillDefinitions } from '../../src/character/SkillDefinitions.js';
import { ACTIONS } from '../../src/combat/data.js';
import { assetProfiler } from '../../src/assets/AssetProfiler.js';
import { SCENES } from '../../src/world/scenes.js';

const CONTEXT_TARGET = new Vector3();
const CONTEXT_PLAYER = new Vector3();
const FORWARD = new Vector3();
const FULL_TEXTURE_UPGRADE_CONCURRENCY = 4;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function drawCalls(engine) {
  return engine?._drawCalls?.current ?? engine?._drawCalls?.count ?? engine?.getDrawCalls?.() ?? 0;
}

function absolutePosition(node, target = new Vector3()) {
  if (node?.getAbsolutePosition) return target.copyFrom(node.getAbsolutePosition());
  return target.copyFrom(node?.position || Vector3.Zero());
}

class DutyLightsLoader {
  static TIMEOUT_MS = 5000;

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
  }

  /** Returns cached payload or fetches it; null on 404/timeout/abort/bad JSON. */
  async load(sceneId, signal) {
    if (this.cache.has(sceneId)) return this.cache.get(sceneId);
    const pending = this.inflight.get(sceneId);
    if (pending) return pending;
    const controller = new AbortController();
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const timeout = AbortSignal.timeout(DutyLightsLoader.TIMEOUT_MS);
    timeout.addEventListener('abort', () => controller.abort(timeout.reason), { once: true });
    const request = fetch(`${import.meta.env.BASE_URL}extracted/duty-lights/${sceneId}.json`, {
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) return null;
      try { return await response.json(); } catch { return null; }
    }).catch(() => null);
    this.inflight.set(sceneId, request);
    const payload = await request;
    this.inflight.delete(sceneId);
    if (payload && !signal?.aborted) this.cache.set(sceneId, payload);
    return payload;
  }
}

const dutyLightsLoader = new DutyLightsLoader();

async function upgradeSceneMaterials(adapter, scene) {
  if (!adapter?.upgradeMaterial) return { requested: 0, upgraded: 0, rejected: [] };
  const materials = [...new Set(scene.materials || [])].filter(material => material?.metadata?.ffxiv?.preview);
  const rejected = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < materials.length) {
      const material = materials[cursor++];
      try { await adapter.upgradeMaterial(material, { priority: 20 }); }
      catch (error) { rejected.push({ material: material.name, message: error?.message || String(error) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FULL_TEXTURE_UPGRADE_CONCURRENCY, Math.max(1, materials.length)) }, worker));
  return { requested: materials.length, upgraded: materials.length - rejected.length, rejected };
}

class FollowCamera {
  constructor(camera) {
    this.camera = camera;
    this.pivot = new Vector3();
    this.offset = new Vector3();
    this.desiredPosition = new Vector3();
    this.lastPlayerPosition = new Vector3();
    this.currentDistance = null;
    this.zoomDistance = null;
    this.ready = false;
  }

  reset() {
    this.currentDistance = null;
    this.zoomDistance = null;
    this.ready = false;
  }

  update(player, { azimuth, polar, distance, navigation, focusHeight = 1.45 }, dt) {
    absolutePosition(player, this.pivot);
    const jumped = !this.ready || Vector3.DistanceSquared(this.pivot, this.lastPlayerPosition) > 36;
    this.lastPlayerPosition.copyFrom(this.pivot);
    this.pivot.y += focusHeight;
    if (jumped || this.zoomDistance === null) this.zoomDistance = distance;
    else this.zoomDistance += (distance - this.zoomDistance) * (dt > 0 ? 1 - Math.exp(-10 * dt) : 1);
    const horizontal = Math.sin(polar);
    this.offset.set(Math.sin(azimuth) * horizontal, Math.cos(polar), Math.cos(azimuth) * horizontal);
    this.desiredPosition.copyFrom(this.pivot).addInPlace(this.offset.scale(this.zoomDistance));
    const hit = navigation?.cameraHit?.(this.pivot, this.desiredPosition);
    const safeDistance = hit ? Math.max(0.3, Math.min(this.zoomDistance, hit.distance - 0.25)) : this.zoomDistance;
    if (jumped || this.currentDistance === null || safeDistance < this.currentDistance) this.currentDistance = safeDistance;
    else this.currentDistance += (safeDistance - this.currentDistance) * (dt > 0 ? 1 - Math.exp(-12 * dt) : 1);
    this.camera.position.copyFrom(this.pivot).addInPlace(this.offset.scale(this.currentDistance));
    this.camera.setTarget(this.pivot);
    this.ready = true;
  }
}

class NativeEnvironmentRuntime {
  constructor(adapter, profiles, zoneId, worldTime) {
    this.adapter = adapter;
    this.profiles = profiles || {};
    this.worldTime = worldTime;
    this.zoneId = zoneId;
    this.profile = adapter.profile;
    this.sourceSamples = [...(adapter.samples || [])];
    this.lastAppliedHour = null;
  }

  setZone(zoneId, profile = this.profiles?.[zoneId] || this.profile) {
    this.zoneId = zoneId || this.zoneId;
    this.profile = profile || { samples: [], source: { evidence: 'missing-profile' } };
    this.sourceSamples = [...(this.profile.samples || [])];
    this.adapter.profile = this.profile;
    this.adapter.samples = this.sourceSamples;
    this.apply(true);
    return this.profile;
  }

  setSourceSamples(samples = []) {
    this.sourceSamples = Array.isArray(samples) ? [...samples] : [];
    this.adapter.samples = this.sourceSamples;
    this.apply(true);
    return this.sourceSamples;
  }

  apply(force = false) {
    const hour = this.worldTime.hour;
    if (!force && this.lastAppliedHour !== null && Math.abs(hour - this.lastAppliedHour) < 0.02) return this.adapter.state;
    this.lastAppliedHour = hour;
    return this.adapter.setTime(hour, { apply: true });
  }

  diagnostics() {
    return { zoneId: this.zoneId, ...this.adapter.diagnostics() };
  }
}

function createRendererFacade(engine, canvas) {
  return {
    engine,
    domElement: canvas,
    info: { render: { calls: 0, triangles: 0 } },
    getContext: () => engine._gl,
    getPixelRatio: () => engine.getHardwareScalingLevel() ? 1 / engine.getHardwareScalingLevel() : 1,
    setPixelRatio: ratio => engine.setHardwareScalingLevel(1 / Math.max(0.25, Number(ratio) || 1)),
    setSize: (width, height) => engine.setSize(width, height),
    dispose: () => engine.dispose(),
  };
}

export class World {
  constructor(canvas, { onTarget, onInteract, onMove, onLoading, onSceneReady, onConnection, onDutyEntrance, initialScene = 'gridania' } = {}) {
    this.canvas = canvas;
    this.callbacks = { onTarget, onInteract, onMove, onLoading, onSceneReady, onConnection, onDutyEntrance };
    this.engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, disableWebGL2Support: false });
    this.renderer = createRendererFacade(this.engine, canvas);
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.collisionsEnabled = false;
    this.scene.skipPointerMovePicking = true;
    this.camera = new UniversalCamera('WorldCamera', new Vector3(0, 5, 12), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 3500;
    this.camera.fov = 52 * Math.PI / 180;
    this.camera.inputs.clear();
    this.scene.activeCamera = this.camera;
    this.followCamera = new FollowCamera(this.camera);
    this.worldTime = new WorldTime({ hour: (Date.now() / 175000) % 24 });
    this.registry = new EntityRegistry();
    this.sceneRoot = new TransformNode('WorldSceneRoot', this.scene);
    this.effects = new EffectSystem(this.scene);
    this.characters = new Map();
    this.skillDefinitions = new SkillDefinitions(Object.values(ACTIONS).flat());
    this.character = this.createCharacterRuntime('player', createCharacter('WHM', this.scene));
    this.player = this.character.root;
    this.mount = new MountRuntime(this.character);
    this.spawn = new Vector3();
    this.sceneId = initialScene;
    this.jobId = 'WHM';
    this.target = null;
    this.layout = null;
    this.navigation = null;
    this.mapLoader = null;
    this.assetScene = null;
    this.importedManifest = null;
    this.environment = null;
    this.environmentAdapter = null;
    this.renderDebug = null;
    this.time = 0;
    this.moving = false;
    this.azimuth = 0.05;
    this.polar = 1.2;
    this.zoom = 18.5;
    this.cameraMode = 'orbit';
    this.introFocus = 1;
    this.quality = 'high';
    this.movementSpeed = 1;
    this.returnGate = null;
    this.dutyEntrances = [];
    this.dutyEntrancesRoot = null;
    this.isImported = false;
    this.loading = false;
    this.loadError = null;
    this.input = new InputController(canvas, {
      onOrbit: (dx, dy, wheel) => this.adjustCamera(dx, dy, wheel),
      onClick: (type, event) => (type === 'nearest' ? this.targetNearest() : this.pick(event)),
      onLookStart: () => { this.player.rotation.y = this.azimuth + Math.PI; },
    });
    this.setScene(initialScene);
  }

  setScene(id, entry = {}) {
    if (this.loading) return this.requestedSceneId === id ? this.loadPromise : Promise.resolve(false);
    if (!SCENES.some(scene => scene.id === id)) throw new Error(`Unknown world scene: ${id}`);
    const explicitReload = Boolean(
      entry?.force || entry?.reload || entry?.arrival || entry?.arrivalConnection || entry?.entryFrom,
    );
    if (id === this.sceneId && this.isImported && !this.loadError && !this.assetScene?.streamError && !explicitReload) {
      return Promise.resolve(true);
    }
    this.requestedSceneId = id;
    this.loadPromise = this.loadClientScene(id, entry);
    return this.loadPromise;
  }

  async loadClientScene(id, entry = {}) {
    const request = this.loadRequest = (this.loadRequest || 0) + 1;
    assetProfiler.begin(id, { request, entry, renderer: 'babylon-native' });
    this.loading = true;
    this.loadError = null;
    this.input.setEnabled(false);
    this.callbacks.onLoading?.(0);
    const draft = {};
    try {
      draft.assets = await new BabylonAssets({ mapId: id }).initializeForMap(id);
      if (request !== this.loadRequest) { draft.assets.dispose(); return false; }
      draft.materials = new MaterialAdapter({ scene: this.scene, assets: draft.assets, map: draft.assets.map });
      const buildTimeLights = draft.assets.config?.lightingObjects?.[id]
        || draft.assets.lightingObjects
        || null;
      // Duty/hidden scenes are not in the build-time bundle; fetch the
      // per-scene payload on demand so the runtime avoids a 531-scene blob.
      const lightsRequest = new AbortController();
      const lightsSignal = lightsRequest.signal;
      const currentRequest = request;
      const lightingObjects = buildTimeLights || await dutyLightsLoader.load(id, lightsSignal)
        .then(payload => {
          if (currentRequest !== this.loadRequest || lightsSignal.aborted) return null;
          return payload;
        });
      if (currentRequest !== this.loadRequest) {
        lightsRequest.abort();
        draft.assets.dispose();
        return false;
      }
      draft.environmentAdapter = new EnvironmentAdapter({
        scene: this.scene,
        profile: draft.assets.profile,
        lightingObjects,
      });
      draft.environment = new NativeEnvironmentRuntime(
        draft.environmentAdapter,
        draft.assets.config?.profiles,
        id,
        this.worldTime,
      );
      draft.environment.apply(true);
      draft.sceneRoot = new TransformNode(`WorldSceneRoot:${id}`, this.scene);
      draft.loader = createBabylonMapLoader({
        scene: this.scene,
        root: draft.sceneRoot,
        assets: draft.assets,
        materialAdapter: draft.materials,
        environmentAdapter: draft.environmentAdapter,
        gpuQueue: draft.assets.runtime?.gpu,
        onProgress: progress => {
          if (request !== this.loadRequest || !this.loading) return;
          const total = Math.max(1, progress.totalModels || 1);
          const ratio = Math.min(0.9, 0.08 + (progress.instantiatedModels || 0) / total * 0.82);
          this.callbacks.onLoading?.(ratio);
        },
      });
      const collisionTask = Navigation.load(draft.assets, draft.assets.legacy?.training?.spawn);
      const bootstrapTask = draft.loader.loadBootstrap();
      [draft.navigation] = await Promise.all([collisionTask, bootstrapTask]);
      if (request !== this.loadRequest) { this.disposeDraft(draft); return false; }
      this.validateBootstrap(draft.loader, id);
      let encounter;
      try {
        encounter = prepareEncounter(draft.assets.legacy, draft.navigation);
      } catch (error) {
        const source = draft.assets.legacy?.spawn || draft.assets.map?.spawn?.point;
        if (!source) throw error;
        draft.navigation?.dispose?.();
        draft.navigation = createFallbackNavigation(source);
        encounter = prepareEncounter(draft.assets.legacy, draft.navigation);
        console.warn(`Babylon collision fallback for ${id}: ${error.message}`);
      }
      const arrivalConnection = entry.arrivalConnection
        ? draft.assets.legacy.connections?.find(connection => connection.id === entry.arrivalConnection)
        : null;
      const arrivalSource = entry.arrival || arrivalConnection?.spawn || arrivalConnection?.position;
      if (arrivalSource) await draft.navigation.ensure?.(arrivalSource, 48, -20);
      const arrival = findArrival(draft.assets.legacy, draft.navigation, entry);
      this.clearReturnGate();
      this.clearScene();
      this.sceneId = id;
      this.sceneRoot = draft.sceneRoot;
      this.navigation = draft.navigation;
      this.mapLoader = draft.loader;
      this.environmentAdapter = draft.environmentAdapter;
      this.environment = draft.environment;
      this.environment.apply(true);
      this.renderDebug = new DebugRenderMode({ scene: this.scene, environmentAdapter: this.environmentAdapter });
      this.importedManifest = draft.assets.legacy;
      this.isImported = true;
      this.preferredConnectionId = entry.arrivalConnection || null;
      const mounted = mountEncounter(this, draft.assets, this.navigation, encounter, { createDummy, createNpc });
      mounted.root.parent = this.sceneRoot;
      this.layout = mounted.layout;
      this.connectionsRoot = mountConnections(this.scene, this.getConnections());
      this.connectionsRoot.parent = this.sceneRoot;
      this.mountDutyEntranceGates(draft.sceneRoot);
      this.assetScene = this.createAssetScene(draft);
      draft.committed = true;
      this.camera.maxZ = Math.max(650, this.navigation.bounds.getSize(new Vector3()).length());
      this.azimuth = this.trainingAzimuth ?? 0.1;
      this.player.rotation.y = this.azimuth + Math.PI;
      this.introFocus = 0;
      this.zoom = 14;
      this.polar = 1.17;
      this.followCamera.reset();
      this.target = null;
      this.targetNearest();
      if (arrival) {
        this.player.position.set(arrival.x, arrival.y, arrival.z);
        this.navigation.height = arrival.y;
        const endpoint = this.getConnections().find(connection => connection.id === entry.arrivalConnection);
        const outwardHeading = endpoint?.source?.playerRunningDirection;
        if (Number.isFinite(outwardHeading)) {
          this.azimuth = outwardHeading;
          this.player.rotation.y = outwardHeading + Math.PI;
        }
      } else if (this.jobId === 'RPR') this.moveToDummy();
      this.jumpVelocity = 0;
      if (this.mount.state.isMounted) this.mount.state.movementMode = 'ground';
      this.setQuality(this.quality);
      this.followCamera.reset();
      this.updateCamera(0);
      this.loading = false;
      this.requestedSceneId = null;
      this.input.setEnabled(true);
      this.callbacks.onLoading?.(1);
      this.callbacks.onSceneReady?.(id);
      assetProfiler.mark('input:enabled', { sceneId: id, renderer: 'babylon-native' });
      this.assetScene.startStreaming().catch(error => {
        if (error?.name !== 'AbortError') console.warn('Babylon background streaming:', error.message);
      });
      return true;
    } catch (error) {
      if (!draft.committed) this.disposeDraft(draft);
      if (request !== this.loadRequest) return false;
      this.loading = false;
      this.isImported = false;
      this.loadError = error?.message || String(error);
      this.requestedSceneId = null;
      this.input.setEnabled(Boolean(this.navigation));
      this.callbacks.onLoading?.(null, this.loadError);
      console.error('Babylon client map import:', error);
      return false;
    }
  }

  createAssetScene(draft) {
    const state = {
      assets: draft.assets,
      loader: draft.loader,
      materials: draft.materials,
      environment: draft.environmentAdapter,
      navigation: draft.navigation,
      streaming: false,
      streamPromise: null,
      streamError: null,
      failures: [...(draft.loader.state.bootstrapFailures || [])],
      layout: this.layout,
      mapImageUrl: null,
      mapImageError: null,
      released: false,
    };
    const mapImageId = state.assets.map.paths?.['map.png'];
    if (mapImageId) {
      void state.assets.load(mapImageId, { priority: 5 }).then(bytes => {
        if (state.released) return;
        state.mapImageUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
        state.layout.image = state.mapImageUrl;
      }).catch(error => {
        if (error?.name !== 'AbortError') state.mapImageError = error.message;
      });
    }
    const facade = {
      assets: state.assets,
      loader: state.loader,
      get streaming() { return state.streaming; },
      get streamError() { return state.streamError; },
      get failures() { return state.failures.slice(); },
      lod: {
        get enabled() { return state.loader.state.lod.enabled; },
        get stats() { return { ...state.loader.state.lod }; },
        setEnabled: enabled => state.loader.setLodEnabled(enabled),
      },
      canMoveTo: point => state.navigation.isReady?.(point, 24) !== false && state.loader.isLocationReady(point, 48),
      prepareLocation: async point => {
        state.loader.setCameraPosition(point);
        await Promise.all([
          state.navigation.ensure?.(point, 96, -15),
          state.loader.ensureLocation(point, 64),
        ]);
        return facade.canMoveTo(point);
      },
      startStreaming: () => {
        if (state.streamPromise) return state.streamPromise;
        state.streaming = true;
        const geometry = state.loader.loadRemaining().then(async result => {
          if (state.released) throw new DOMException('Babylon asset scene released', 'AbortError');
          const textures = await upgradeSceneMaterials(state.materials, this.scene);
          return { result, textures };
        });
        state.streamPromise = geometry
          .then(completed => {
            if (state.released) throw new DOMException('Babylon asset scene released', 'AbortError');
            const { result, textures } = completed;
            const materialDiagnostics = state.materials.diagnostics();
            const missingTextures = Object.entries(materialDiagnostics.missing?.textures || {})
              .map(([resource, count]) => ({ type: 'texture-missing', resource, count }));
            state.failures = [
              ...(state.loader.state.failures || []).map(failure => ({ type: 'geometry', ...failure })),
              ...(textures.rejected || []).map(failure => ({ type: 'texture-upgrade', ...failure })),
              ...missingTextures,
            ];
            if (state.failures.length) {
              state.streamError = `Background stream completed with ${state.failures.length} resource failure(s)`;
              state.assets.phase = 'complete-with-errors';
              state.assets.mark('stream-complete-with-errors', {
                sceneId: state.assets.mapId,
                failures: state.failures,
              });
            } else {
              state.assets.mark('fully-loaded', { sceneId: state.assets.mapId, textures });
            }
            return result;
          })
          .catch(error => {
            if (error?.name !== 'AbortError') {
              state.streamError = error?.message || String(error);
              state.failures.push({ type: 'stream', message: state.streamError });
              state.assets.phase = 'complete-with-errors';
            }
            throw error;
          })
          .finally(() => { state.streaming = false; });
        return state.streamPromise;
      },
      diagnostics: options => ({
        loader: state.loader.diagnostics(options),
        materials: state.materials.diagnostics(),
        assets: state.assets.diagnostics(),
        streaming: state.streaming,
        streamError: state.streamError,
        mapImageError: state.mapImageError,
        failures: state.failures.slice(),
      }),
      release: () => {
        if (state.released) return;
        state.released = true;
        if (state.mapImageUrl) URL.revokeObjectURL(state.mapImageUrl);
        state.assets.dispose();
        state.loader.dispose();
        state.materials.dispose();
      },
    };
    return facade;
  }

  validateBootstrap(loader, sceneId) {
    const state = loader?.state;
    const failures = state?.bootstrapFailures || [];
    if ((state?.instantiatedModels || 0) > 0 && (state?.meshCount || 0) > 0) return true;
    const detail = failures.length
      ? `: ${failures.slice(0, 3).map(failure => failure.message || `model ${failure.index}`).join('; ')}`
      : '';
    throw new Error(`${sceneId}: Babylon bootstrap produced no renderable map geometry${detail}`);
  }

  disposeDraft(draft) {
    draft.assets?.dispose?.();
    draft.navigation?.dispose?.();
    draft.loader?.dispose?.();
    draft.materials?.dispose?.();
    draft.environmentAdapter?.dispose?.();
    draft.sceneRoot?.dispose?.(false, true);
  }

  getConnections() { return this.isImported ? this.importedManifest?.connections || [] : []; }

  setDutyEntrances(entrances) {
    this.dutyEntrances = Array.isArray(entrances) ? entrances : [];
    this.mountDutyEntranceGates();
  }

  mountDutyEntranceGates(parent = this.sceneRoot) {
    this.dutyEntrancesRoot?.dispose(false, true);
    this.dutyEntrancesRoot = null;
    if (!this.scene || this.loading || !this.isImported) return;
    const gates = this.getDutyEntrances();
    if (!gates.length) return;
    this.dutyEntrancesRoot = mountDutyEntranceGates(this.scene, gates, parent).root;
  }

  getDutyEntrances() {
    return this.isImported ? this.dutyEntrances.filter(gate => gate.fromSceneId === this.sceneId) : [];
  }

  getNearbyDutyEntrance() {
    if (this.loading) return null;
    for (const gate of this.getDutyEntrances()) {
      const distance = Math.hypot(
        this.player.position.x - gate.position.x,
        this.player.position.z - gate.position.z,
      );
      if (distance <= (gate.radius || 4) && Math.abs(this.player.position.y - gate.position.y) <= 10) return gate;
    }
    return null;
  }

  canUseDutyEntrance(dutyKey) {
    const gate = this.getDutyEntrances().find(item => item.dutyKey === dutyKey);
    return Boolean(gate) && this.getNearbyDutyEntrance()?.dutyKey === dutyKey;
  }

  getNearbyConnection() {
    if (this.loading) return null;
    const preferred = this.getConnections().find(connection => connection.id === this.preferredConnectionId);
    if (preferred && connectionDistance(preferred, this.player.position) <= (preferred.radius || 3)) return preferred;
    this.preferredConnectionId = null;
    return nearestConnection(this.getConnections(), this.player.position);
  }

  canUseConnection(id) {
    const connection = this.getConnections().find(item => item.id === id);
    return !this.loading && Boolean(connection) && connectionDistance(connection, this.player.position) <= (connection.radius || 3);
  }

  setJob(id) {
    if (this.character.source === 'procedural' && !this.mount.state.isMounted) this.character.setModel(createCharacter(id, this.scene));
    this.character.applyState({ jobId: id });
    this.jobId = id;
    this.clearReturnGate();
    this.clearFields();
  }

  update(dt) {
    const elapsed = clamp(dt || 0, 0, 0.08);
    this.time += elapsed;
    this.updateMovement(elapsed);
    if (!this.mount.state.isMounted && !this.character.state.airborne && !['jump-start', 'jump-land'].includes(this.character.state.movement)) {
      this.character.state.movement = this.moving ? this.input.axes().sprint ? 'run' : 'walk' : 'idle';
    }
    for (const character of this.characters.values()) {
      character.update(elapsed, this.time);
      character.actions?.update(elapsed);
    }
    this.effects.update(elapsed);
    this.worldTime.advance(dt);
    this.environment?.apply();
    this.updateCamera(elapsed);
    this.mapLoader?.setCameraPosition(this.camera.position);
    if (this.navigation && !this.navigation.isReady?.(this.player.position, 48)) {
      this.navigation.ensure?.(this.player.position, 96, -15).catch(error => {
        if (error?.name !== 'AbortError') console.warn('Collision streaming:', error.message);
      });
    }
    const firstImportedFrame = this.isImported && !this.loading && !assetProfiler.active?.firstRender && assetProfiler.active?.sceneId === this.sceneId;
    this.engine.beginFrame();
    try {
      this.renderDebug?.apply();
      this.scene.render();
    } finally {
      this.engine.endFrame();
    }
    this.renderer.info.render.calls = drawCalls(this.engine);
    this.renderer.info.render.triangles = Math.floor((this.scene.getActiveIndices?.() || 0) / 3);
    if (firstImportedFrame) {
      assetProfiler.firstRendered({ sceneId: this.sceneId, calls: this.renderer.info.render.calls, renderer: 'babylon-native' });
      assetProfiler.mark('engine-interactive', { sceneId: this.sceneId, source: 'babylon-frame-submitted-input-enabled' });
    }
  }

  resize(width, height) {
    if (!width || !height) return;
    this.engine.setSize(width, height);
  }

  createCharacterRuntime(id, model, name = '') {
    const character = new CharacterRuntime({ id, name, model, assetRuntime: sandboxAssetRuntime, scene: this.scene });
    character.actions = new ActionRuntime(character, {
      definitions: this.skillDefinitions,
      effects: this.effects,
      audio: this.audio,
      targetPosition: () => this.registry.get(character.state.targetId)?.object.position || character.root.position,
    });
    this.characters.set(id, character);
    if (this.npcDefinition && character !== this.character) {
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
    for (const character of this.characters.values()) if (character.actions) character.actions.audio = audio;
  }

  getContext() {
    const fields = this.effects.activeFieldIdsAt(this.player.position);
    if (!this.target) return { moving: this.moving, distance: 99, positional: 'rear', target: false, targets: 0, fields };
    absolutePosition(this.target.object, CONTEXT_TARGET);
    const distance = Math.hypot(this.player.position.x - CONTEXT_TARGET.x, this.player.position.z - CONTEXT_TARGET.z);
    CONTEXT_PLAYER.copyFrom(this.player.position).subtractInPlace(CONTEXT_TARGET);
    CONTEXT_PLAYER.y = 0;
    CONTEXT_PLAYER.normalize();
    FORWARD.set(Math.sin(this.target.object.rotation.y), 0, Math.cos(this.target.object.rotation.y));
    const dot = Vector3.Dot(FORWARD, CONTEXT_PLAYER);
    const cross = FORWARD.x * CONTEXT_PLAYER.z - FORWARD.z * CONTEXT_PLAYER.x;
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
      map: this.layout ? { ...this.layout } : null,
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
    this.engine.setHardwareScalingLevel(this.quality === 'low' ? 1.35 : 1);
    this.mapLoader?.setLodEnabled(true);
  }

  setCameraMode(mode) { this.cameraMode = mode === 'follow' ? 'follow' : 'orbit'; }
  setMovementSpeed(multiplier = 1) { this.movementSpeed = clamp(multiplier || 1, 0.1, 3); }

  moveSkill({ kind = 'forward', distance = 15, saveReturn = false, gateDuration = 0, gateColor = 0x8f5cff } = {}) {
    if (kind === 'return') {
      if (!this.returnGate) return { ok: false, reason: '没有可返回的空间印记' };
      const destination = this.returnGate.position;
      const floor = this.navigation.surfaceAt(destination.x, destination.z, destination.y);
      if (!floor) return { ok: false, reason: '返回点已被阻挡' };
      this.player.position.set(destination.x, floor.height, destination.z);
      this.navigation.height = floor.height;
      this.character.syncTransform();
      this.clearReturnGate();
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
      return { ok: true, moved: 0, returned: true, position: { x: this.player.position.x, z: this.player.position.z } };
    }
    const requested = clamp(distance, 0, 30);
    if (!requested) return { ok: false, reason: '位移距离无效' };
    if (saveReturn) this.saveReturnGate(gateDuration, gateColor);
    const direction = new Vector3(Math.sin(this.player.rotation.y), 0, Math.cos(this.player.rotation.y));
    if (kind === 'backward') direction.negateInPlace();
    const origin = this.player.position.clone();
    const destination = origin.add(direction.scale(requested));
    if (this.assetScene && !this.assetScene.canMoveTo(destination)) {
      this.assetScene.prepareLocation(destination).catch(() => {});
      return { ok: false, moved: 0, reason: '前方地区仍在载入' };
    }
    this.navigation.move(this.player.position, direction.x * requested, direction.z * requested);
    this.character.syncTransform();
    const moved = Vector3.Distance(origin, this.player.position);
    if (moved > 0.02) this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    return { ok: moved > 0.02, moved: Number(moved.toFixed(2)), position: { x: Number(this.player.position.x.toFixed(2)), z: Number(this.player.position.z.toFixed(2)) } };
  }

  effect(event) {
    if (event?.type === 'field') {
      this.effects.placeField(event, this.player.position);
      this.character.actions?.apply(event);
      return;
    }
    this.character.state.targetId = this.target?.id || null;
    this.character.actions?.apply(event);
  }

  clearFields() { this.effects.clearFields(); }

  moveToDummy() {
    const target = this.registry.nearestTarget(this.player.position);
    if (!target || !this.navigation) return;
    const rearAngle = target.object.rotation.y + Math.PI;
    const point = this.navigation.nearestWalkable(
      target.object.position.x + Math.sin(rearAngle) * 2.4,
      target.object.position.z + Math.cos(rearAngle) * 2.4,
      25,
      target.object.position.y,
    );
    if (!point) return;
    this.player.position.set(point.x, point.y, point.z);
    this.navigation.height = point.y;
    this.player.rotation.y = target.object.rotation.y;
    this.character.syncTransform();
    this.followCamera.reset();
    this.selectTarget(target);
    this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
  }

  selectTarget(target) {
    this.target = target;
    this.registry.setTargetVisual(target);
    this.callbacks.onTarget?.({ id: target.id, name: target.name, hp: target.hp, level: target.level });
  }

  clearScene() {
    this.renderDebug?.dispose();
    this.renderDebug = null;
    this.effects.clear();
    for (const [id, character] of [...this.characters]) {
      if (character === this.character) continue;
      character.dispose();
      this.characters.delete(id);
    }
    this.navigation?.dispose?.();
    this.navigation = null;
    this.environmentAdapter?.dispose?.();
    this.environmentAdapter = null;
    this.environment = null;
    this.sceneRoot?.dispose(false, true);
    this.assetScene?.release?.();
    this.assetScene = null;
    this.mapLoader = null;
    this.registry.clear();
    this.layout = null;
    this.dutyEntrancesRoot?.dispose(false, true);
    this.dutyEntrancesRoot = null;
  }

  updateMovement(dt) {
    if (!this.input.enabled || !this.navigation) { this.moving = false; return; }
    const { forward, right, sprint, ascend, descend } = this.input.axes();
    const direction = new Vector3(
      -Math.sin(this.azimuth) * forward + Math.cos(this.azimuth) * right,
      0,
      -Math.cos(this.azimuth) * forward - Math.sin(this.azimuth) * right,
    );
    if (direction.lengthSquared()) direction.normalize();
    this.moving = Boolean(forward || right);
    if (this.mount.state.isMounted) {
      this.mount.step(dt, { direction, ascend, descend }, this.navigation);
      if (this.moving) this.player.rotation.y = this.input.isLooking ? this.azimuth + Math.PI : Math.atan2(direction.x, direction.z);
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
      return;
    }
    const result = this.character.movement.step({
      direction,
      sprint,
      jump: this.input.consumeJump(),
      heading: this.input.isLooking ? this.azimuth + Math.PI : undefined,
    }, this.navigation, dt, {
      speedMultiplier: this.movementSpeed,
      isReady: point => {
        const ready = !this.assetScene || this.assetScene.canMoveTo(point);
        if (!ready) this.assetScene.prepareLocation(point).catch(() => {});
        return ready;
      },
    });
    this.moving = result.moving;
    if (result.changed) {
      this.introFocus = 0;
      this.callbacks.onMove?.({ x: this.player.position.x, z: this.player.position.z });
    }
  }

  get jumpVelocity() { return this.character.movement.verticalVelocity; }
  set jumpVelocity(value) { this.character.movement.verticalVelocity = value; }
  isBlocked(x, z) { return this.navigation ? !this.navigation.isWalkable(x, z) : true; }
  isWalkable(x, z) { return this.navigation ? this.navigation.isWalkable(x, z) : false; }

  adjustCamera(dx, dy, wheel = 0) {
    this.azimuth -= dx * 0.007;
    this.polar = clamp(this.polar - dy * 0.006, 0.05, Math.PI - 0.05);
    this.zoom = clamp(this.zoom * Math.exp(wheel * 0.0015), 2, 60);
    this.introFocus = 0;
    if (this.input.isLooking) this.player.rotation.y = this.azimuth + Math.PI;
  }

  setControlMode(mode) { this.input.setControlMode(mode); }

  saveReturnGate(duration, color) {
    this.clearReturnGate();
    const root = new TransformNode('ReturnGate', this.scene);
    root.parent = this.sceneRoot;
    root.position.set(this.player.position.x, this.player.position.y + 0.08, this.player.position.z);
    const tint = typeof color === 'number'
      ? Color3.FromInts((color >> 16) & 255, (color >> 8) & 255, color & 255)
      : Color3.FromHexString(color || '#8f5cff');
    const mat = new StandardMaterial('ReturnGateMaterial', this.scene);
    mat.emissiveColor = tint;
    mat.diffuseColor = tint.scale(0.1);
    mat.alpha = 0.75;
    mat.disableLighting = true;
    const ring = MeshBuilder.CreateTorus('ReturnGateRing', { diameter: 1.56, thickness: 0.11, tessellation: 28 }, this.scene);
    ring.parent = root;
    ring.rotation.x = Math.PI * 0.5;
    ring.material = mat;
    ring.isPickable = false;
    const beam = MeshBuilder.CreateCylinder('ReturnGateBeam', { height: 2.1, diameterTop: 0.22, diameterBottom: 0.54, tessellation: 8 }, this.scene);
    beam.parent = root;
    beam.position.y = 1.05;
    beam.material = mat;
    beam.visibility = 0.28;
    beam.isPickable = false;
    this.returnGate = { position: this.player.position.clone(), group: root, expiresAt: duration > 0 ? this.time + duration : 0 };
  }

  clearReturnGate() {
    if (!this.returnGate) return;
    this.returnGate.group.dispose(false, true);
    this.returnGate = null;
  }

  updateCamera(dt) {
    if (this.returnGate) {
      this.returnGate.group.rotation.y += dt * 1.7;
      if (this.returnGate.expiresAt && this.time >= this.returnGate.expiresAt) this.clearReturnGate();
    }
    const focusHeight = this.mount.state.isMounted ? this.mount.definition?.cameraHeightWorld || 2.5 : 1.45;
    this.followCamera.update(this.player, {
      azimuth: this.azimuth,
      polar: this.polar,
      distance: this.zoom,
      focusHeight,
      navigation: this.navigation,
    }, dt);
  }

  pick(event) {
    if (this.loading) return;
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.scene.pick(event.clientX - rect.left, event.clientY - rect.top, mesh => Boolean(mesh.metadata?.connection || mesh.metadata?.dutyEntrance || mesh.metadata?.entityId), false, this.camera);
    if (!hit?.hit) return;
    const dutyGate = hit.pickedMesh?.metadata?.dutyEntrance;
    if (dutyGate) { this.callbacks.onDutyEntrance?.(dutyGate); return; }
    const connection = hit.pickedMesh?.metadata?.connection;
    if (connection) { this.callbacks.onConnection?.(connection); return; }
    const entity = this.registry.get(hit.pickedMesh?.metadata?.entityId);
    if (!entity) return;
    if (entity.type === 'dummy' || entity.type === 'monster') this.selectTarget(entity);
    else this.callbacks.onInteract?.({ id: entity.id, name: entity.name, dialogue: entity.dialogue });
  }

  goToLandmark(id) {
    if (this.loading || !this.layout || !this.navigation) return false;
    const landmark = this.layout.landmarks.find(item => item.id === id);
    if (!landmark) return false;
    const destination = new Vector3(landmark.x, landmark.y || this.player.position.y, landmark.z);
    if (this.assetScene && !this.assetScene.canMoveTo(destination)) {
      return this.assetScene.prepareLocation(destination).then(() => this.goToLandmark(id));
    }
    const point = this.navigation.nearestWalkable(
      landmark.x,
      landmark.z + (landmark.type === 'connection' ? 0 : (landmark.d || 0) / 2 + 2),
      25,
      landmark.y,
    );
    if (!point) return false;
    this.player.position.set(point.x, point.y, point.z);
    this.navigation.height = point.y;
    this.preferredConnectionId = landmark.type === 'connection' ? id.slice('connection:'.length) : null;
    this.player.rotation.y = Math.PI;
    this.character.syncTransform();
    this.followCamera.reset();
    this.callbacks.onMove?.(point);
    return true;
  }

  diagnostics(options = {}) {
    return {
      renderer: 'babylon-native',
      sceneId: this.sceneId,
      requestedSceneId: this.requestedSceneId || null,
      loading: this.loading,
      loadError: this.loadError,
      isImported: this.isImported,
      inputEnabled: this.input.enabled,
      engine: {
        webGLVersion: this.engine.webGLVersion,
        fps: this.engine.getFps(),
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      },
      scene: {
        meshes: this.scene.meshes.length,
        materials: this.scene.materials.length,
        activeMeshes: this.scene.getActiveMeshes().length,
        worldChildren: this.sceneRoot?.getChildren?.().length || 0,
      },
      navigation: this.navigation?.diagnostics?.() || null,
      map: this.assetScene?.diagnostics?.(options) || null,
      sourceTotals: this.mapLoader ? {
        triangles: this.mapLoader.state.triangleCount,
        meshes: this.mapLoader.state.meshCount,
        instances: this.mapLoader.state.instanceCount,
      } : null,
      environment: this.environment?.diagnostics?.() || null,
      entities: this.registry.getInfo(),
      player: { position: this.player.position.asArray(), movement: this.character.state.movement },
    };
  }

  getDiagnostics(options = {}) { return this.diagnostics(options); }

  dispose() {
    this.loadRequest = (this.loadRequest || 0) + 1;
    this.input.dispose();
    this.clearReturnGate();
    this.clearScene();
    this.effects.dispose();
    this.mount.dispose();
    for (const character of this.characters.values()) character.dispose();
    this.characters.clear();
    this.scene.dispose();
    this.engine.dispose();
  }
}

export default World;
