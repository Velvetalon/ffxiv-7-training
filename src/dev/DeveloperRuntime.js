import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationRuntime } from '../character/AnimationRuntime.js';
import { disposeObject } from '../world/assets.js';
import { getEnvironmentProfile } from '../world/environment/EnvironmentProfiles.js';
const LIST_LIMIT = 256;
const AUDIO_LIMIT = 128;
const MANUAL_KEYS = ['time', 'pause', 'profile', 'parameters'];
const DEFAULT_ENV_PARAMS = Object.freeze({ sunMultiplier: 1, ambientMultiplier: 1, fogMultiplier: 1, exposureMultiplier: 1 });
export class DeveloperRuntime {
  constructor(options = {}) {
    const { world = null, assets = null, audio = null, scenes = [], preferences = null, changeMap = null, importAppearance = null, reloadCharacter = null, teleportPosition = null, retryLoad = null, getLoadingState = null, onAudioSettings = null } = options;
    this.world = world;
    this.assets = assets;
    this.assetRuntime = assets?.runtime?.load ? assets.runtime : assets?.load ? assets : null;
    this.audio = audio;
    this.scenes = Array.isArray(scenes) ? scenes : [];
    this.preferences = preferences;
    this.changeMap = changeMap;
    this.importAppearance = importAppearance;
    this.reloadCharacter = reloadCharacter;
    this.teleportPosition = teleportPosition;
    this.retryLoad = retryLoad;
    this.getLoadingState = getLoadingState;
    this.onAudioSettings = onAudioSettings;
    this.preview = null;
    this.previewGeneration = 0;
    this.animationPreview = null;
    this.lastCommand = null;
    this.environmentBase = null;
    this.parameterBase = null;
    this.parameterMultipliers = { ...DEFAULT_ENV_PARAMS };
    this.manualOverrides = Object.fromEntries(MANUAL_KEYS.map(key => [key, false]));
    this.listCache = { manifest: null, scenes: null, skills: null, mounts: null, audio: null };
    this.captureEnvironmentBase();
  }
  getSnapshot() {
    const world = this.world;
    const character = world?.character;
    const sceneId = world?.sceneId || world?.requestedSceneId || null;
    const scene = this.sceneList().find(item => item.id === sceneId) || (sceneId ? { id: sceneId } : null);
    const preferences = this.preferences?.snapshot?.() || {
      lastSceneId: this.preferences?.lastSceneId || null,
      recentSceneIds: this.preferences?.recentSceneIds || [],
      appearance: this.preferences?.appearance || null,
      camera: this.preferences?.camera || null,
      developer: this.preferences?.developer || {},
    };
    const loading = this.loadingState(sceneId);
    const environment = world?.environment;
    const worldTime = world?.worldTime?.snapshot?.() || world?.worldTime || null;
    return {
      scene: scene ? { id: scene.id, name: scene.name || scene.en || scene.id, region: scene.region || null } : null,
      maps: this.sceneList(),
      recent: Array.isArray(preferences.recentSceneIds) ? preferences.recentSceneIds.slice(0, 8) : [],
      character: this.characterSnapshot(character),
      mount: this.mountSnapshot(world?.mount),
      animations: this.animationList(character),
      skills: this.skillList(),
      mounts: this.mountList(),
      audio: this.audioSnapshot(),
      environment: {
        profile: profileSummary(environment?.profile, environment?.zoneId),
        profileId: environment?.zoneId || null,
        profiles: this.sceneList().map(scene => ({ id: scene.id, name: scene.name })).slice(0, LIST_LIMIT),
        params: { ...this.parameterMultipliers },
        time: compactTime(worldTime),
        manualOverrides: { ...this.manualOverrides },
      },
      debug: this.debugSnapshot(world),
      loading,
      developer: {
        ...(preferences.developer || {}),
        preferences: preferences.developer || {},
        lastCommand: this.lastCommand,
        preview: this.preview ? { kind: this.preview.kind, id: this.preview.id, state: this.preview.state } : null,
      },
    };
  }
  async run(command, args = {}) {
    if (command && typeof command === 'object') {
      args = command.args || command.payload || {};
      command = command.command || command.type || command.name;
    }
    const name = typeof command === 'string' ? command.trim().toLowerCase() : '';
    this.lastCommand = name || null;
    try {
      switch (name) {
        case 'map.switch': return await this.switchMap(args);
        case 'map.teleport': return await this.teleport(args);
        case 'character.reload': return this.invokeCharacterReload(args);
        case 'character.import': return this.invokeCharacterImport(args);
        case 'animation.play': return this.playAnimation(args);
        case 'skill.trigger': return this.triggerSkill(args);
        case 'mount.spawn': return await this.spawnMountPreview(args);
        case 'mount.mount': case 'mount': return await this.mount(args);
        case 'mount.dismount': case 'dismount': return this.dismount();
        case 'mount.takeoff': case 'takeoff': return this.takeoff();
        case 'mount.land': case 'land': return this.land();
        case 'mount.clear': case 'mount.clearpreview': case 'clear': return this.clearMount(args);
        case 'audio.bgm': return this.playBgm(args);
        case 'audio.bgm.play': return this.playBgm(args);
        case 'audio.bgm.stop': return this.stopAudio({ ...(isObject(args) ? args : {}), bgmOnly: true });
        case 'audio.sfx': return this.playSfx(args);
        case 'audio.sfx.play': return this.playSfx(args);
        case 'audio.sfx.stop': return this.stopAudio(args);
        case 'audio.stop': return this.stopAudio(args);
        case 'audio.settings': return this.setAudioSettings(args);
        case 'environment.time': return this.setEnvironmentTime(args);
        case 'environment.pause': return this.setEnvironmentPause(args);
        case 'environment.profile': return this.setEnvironmentProfile(args);
        case 'environment.parameters': return this.setEnvironmentParameters(args);
        case 'environment.reset': return this.resetEnvironment();
        case 'loading.retry': return this.retry(args);
        case 'developer.state':
          if (this.preferences?.setDeveloper) this.preferences.setDeveloper(args?.preferences || args);
          return { ok: true, state: this.getSnapshot() };
        default: return { ok: false, reason: `Unknown developer command: ${name || '(empty)'}` };
      }
    } catch (error) {
      return { ok: false, command: name, reason: error?.message || String(error), error };
    }
  }
  update(dt = 0) {
    const elapsed = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (this.preview?.animation) this.preview.animation.update(elapsed, this.preview.state || 'idle');
    const character = this.world?.character;
    const lock = this.animationPreview;
    if (lock && character?.animation) {
      if (lock.pending && character.animation.state === lock.state) lock.pending = false;
      if (character.animation.actionRemaining <= 0 && !lock.pending) {
        this.animationPreview = null;
      }
      if (lock.expiresAt < Date.now()) this.animationPreview = null;
    }
  }
  clearPreview() {
    this.previewGeneration++;
    const preview = this.preview;
    this.preview = null;
    if (!preview) return false;
    preview.animation?.dispose();
    preview.root?.removeFromParent?.();
    disposeObject(preview.root);
    for (const id of preview.resources || []) this.assetRuntime?.release?.(id);
    return true;
  }
  dispose() {
    this.clearPreview();
    this.animationPreview = null;
    this.listCache = { manifest: null, scenes: null, skills: null, mounts: null, audio: null };
  }
  async switchMap(args = {}) {
    const id = cleanId(typeof args === 'string' ? args : args.id || args.sceneId || args.mapId);
    if (!id) return { ok: false, reason: 'Map ID is required' };
    if (this.scenes.length && !this.sceneList().some(scene => scene.id === id)) return { ok: false, reason: `Unknown map: ${id}` };
    this.clearPreview();
    this.resetEnvironment();
    const callback = this.changeMap || ((sceneId, entry) => this.world?.setScene?.(sceneId, entry));
    if (typeof callback !== 'function') return { ok: false, reason: 'Map switch callback is unavailable' };
    const result = await callback(id, isObject(args) ? args.entry || args : {});
    if (result === false || result?.ok === false) return result || { ok: false, reason: 'Map switch failed' };
    this.preferences?.recordScene?.(id);
    this.captureEnvironmentBase();
    return { ok: true, mapId: id, result };
  }
  async teleport(args = {}) {
    const sceneId = isObject(args) ? args.sceneId || args.mapId : null;
    if (sceneId) return this.switchMap(args);
    const position = isObject(args) ? args.position || args : args;
    if (typeof this.teleportPosition === 'function') {
      const result = await this.teleportPosition(position);
      return result === false ? { ok: false, reason: 'Teleport failed' } : { ok: true, position, result };
    }
    const player = this.world?.player;
    if (!player || !position) return { ok: false, reason: 'Teleport position callback is unavailable' };
    player.position.set(Number(position.x) || 0, Number(position.y) || 0, Number(position.z) || 0);
    return { ok: true, position: { x: player.position.x, y: player.position.y, z: player.position.z } };
  }
  invokeCharacterReload(args = {}) {
    if (typeof this.reloadCharacter !== 'function') return { ok: false, reason: 'Character reload callback is unavailable' };
    return this.invokeCallback(this.reloadCharacter, args?.appearance);
  }
  invokeCharacterImport(args = {}) {
    const file = isFileLike(args) ? args : args?.file || args?.value;
    if (!file || typeof this.importAppearance !== 'function') return { ok: false, reason: 'Appearance file or import callback is unavailable' };
    return Promise.resolve(this.importAppearance(file)).then(result => {
      const appearance = result?.appearance || this.world?.character?.state?.appearance;
      if (appearance) this.preferences?.setAppearance?.(appearance);
      return { ok: true, appearance: summarizeAppearance(appearance), result };
    });
  }
  playAnimation(args = {}) {
    const character = this.world?.character;
    const animation = character?.animation;
    const id = cleanId(isObject(args) ? args.id || args.state || args.animationId || args.resourceId : args);
    if (!id || !animation) return { ok: false, reason: 'Character animation is unavailable' };
    const requestedId = id;
    const resolvedId = id === 'jump' && !animation.has?.('jump') && animation.has?.('jump-start') ? 'jump-start' : id;
    const loop = isObject(args) && args.loop === true;
    if (animation.has?.(resolvedId)) {
      const played = animation.play(resolvedId, { loop, restart: true, speed: Number(args.speed) || 1 });
      if (!played) return { ok: false, reason: `Animation is not playable: ${requestedId}` };
      this.animationPreview = loop ? null : { state: resolvedId, pending: false, expiresAt: Date.now() + 120000 };
      return { ok: true, id: requestedId, resolvedId, loop };
    }
    const resourceId = isObject(args) ? args.resourceId || id : id;
    if (!this.assetRuntime?.registry?.resources?.has(resourceId) || typeof character.playAction !== 'function') {
      return { ok: false, reason: `Animation is not registered: ${id}` };
    }
    const state = isObject(args) ? args.state || resolvedId : resolvedId;
    character.playAction({ id: `developer:${state}`, animationState: state, animationResourceId: resourceId }, { actionId: state, type: 'developer' });
    this.animationPreview = { state, pending: true, expiresAt: Date.now() + 120000 };
    return { ok: true, id: state, resourceId, pending: true, loop: false };
  }
  triggerSkill(args = {}) {
    const requested = isObject(args) ? args.definition || args.skill || args.id || args.skillId : args;
    const definition = this.resolveSkill(requested);
    const actionId = definition?.id ?? definition?.skillId ?? (typeof requested === 'string' || typeof requested === 'number' ? requested : null);
    if (actionId === null || actionId === undefined) return { ok: false, reason: 'Skill ID or definition is required' };
    const event = { ...(isObject(args?.event) ? args.event : {}), type: 'resolved', actionId };
    if (definition && this.world?.character?.actions?.trigger) {
      this.world.character.actions.trigger(event, definition, 'resolved');
    } else if (typeof this.world?.effect === 'function') {
      this.world.effect(event);
    } else return { ok: false, reason: 'Character action runtime is unavailable' };
    return { ok: true, skillId: actionId, animationId: definition?.animationId || definition?.animationResourceId || null, vfxId: definition?.vfxId || null, soundId: definition?.soundId || null };
  }
  async spawnMountPreview(args = {}) {
    const definition = this.resolveMount(isObject(args) ? args.definition || args.id || args.mountId : args);
    if (!definition?.model || !this.assetRuntime?.load) return { ok: false, reason: 'Mount preview resource is unavailable' };
    this.clearPreview();
    const generation = ++this.previewGeneration;
    const ids = [...new Set([definition.model, ...Object.values(definition.animations || {}), ...Object.values(definition.riderAnimations || {})].filter(id => typeof id === 'string' && id))];
    const loaded = new Map();
    try {
      const loads = await Promise.allSettled(ids.map(async id => { const value = await this.assetRuntime.load(id, { retain: true, priority: 0 }); loaded.set(id, value); return value; }));
      const failed = loads.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (generation !== this.previewGeneration) {
        ids.forEach(id => this.assetRuntime.release?.(id));
        return { ok: false, stale: true };
      }
      const source = loaded.get(definition.model);
      if (!source?.scene) throw new Error(`Mount model has no scene: ${definition.model}`);
      const model = cloneSkeleton(source.scene);
      model.traverse(node => { if (Array.isArray(node.material)) node.material = node.material.map(material => material.clone()); else if (node.material) node.material = node.material.clone(); if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; } });
      const scale = Number(definition.modelScales?.[this.world?.character?.state?.appearance?.modelFamily] ?? definition.scale ?? 1);
      if (Number.isFinite(scale) && scale > 0) model.scale.setScalar(scale);
      const root = new THREE.Group();
      root.name = 'developer-mount-preview';
      root.userData.developerPreview = true;
      root.add(model);
      const position = isObject(args) ? args.position : null;
      const player = this.world?.player;
      const hasPosition = Number.isFinite(Number(position?.x)) || Number.isFinite(Number(position?.z));
      const x = Number(position?.x ?? (player?.position.x ?? 0) + (hasPosition ? 0 : 3)) || 0, z = Number(position?.z ?? player?.position.z ?? 0) || 0;
      const floor = !Number.isFinite(Number(position?.y)) ? this.world?.navigation?.surfaceAt?.(x, z, player?.position.y, 5) : null, y = Number(position?.y ?? floor?.height ?? player?.position.y ?? 0) || 0;
      root.position.set(x, y, z);
      root.rotation.y = Number(position?.heading ?? args.heading ?? 0) || 0;
      const animation = new AnimationRuntime(model);
      for (const clip of source.animations || []) animation.register(clip.name, clip);
      for (const [state, id] of Object.entries(definition.animations || {})) animation.register(state, loaded.get(id)?.animations?.[0]);
      const state = cleanId(args.state || 'idle') || 'idle';
      animation.play(state, { loop: true, restart: true });
      this.world?.scene?.add(root);
      this.preview = { kind: 'mount', id: definition.id || definition.model, root, animation, resources: new Set(ids), state };
      return { ok: true, id: this.preview.id, state, preview: true };
    } catch (error) {
      for (const id of loaded.keys()) this.assetRuntime.release?.(id);
      return { ok: false, reason: error?.message || String(error) };
    }
  }
  async mount(args = {}) {
    const mount = this.world?.mount;
    const definition = this.resolveMount(isObject(args) ? args.definition || args.id || args.mountId : args);
    if (!mount?.mount || !definition) return { ok: false, reason: 'Mount runtime or definition is unavailable' };
    this.clearPreview();
    const result = await mount.mount(definition);
    return result === false ? { ok: false, reason: mount.state?.loadError || 'Mount failed' } : { ok: true, id: definition.id, result };
  }
  dismount() { const result = this.world?.mount?.dismount?.(); return result ? { ok: true, state: 'dismounted' } : { ok: false, reason: 'Dismount unavailable while airborne or not mounted' }; }
  takeoff() { const result = this.world?.mount?.takeoff?.(); return result ? { ok: true, state: 'takeoff' } : { ok: false, reason: 'Takeoff unavailable' }; }
  land() { const result = this.world?.mount?.land?.(); return result ? { ok: true, state: 'landing' } : { ok: false, reason: 'Landing unavailable' }; }
  clearMount(args = {}) { const preview = this.clearPreview(); const actual = args?.actual ? this.dismount() : null; return { ok: true, previewCleared: preview, actual }; }
  playBgm(args = {}) {
    const sceneId = isObject(args) ? args.sceneId || args.id : args;
    if (typeof this.audio?.playScene !== 'function') return { ok: false, reason: 'Audio runtime is unavailable' };
    return Promise.resolve(this.audio.playScene(sceneId || this.world?.sceneId));
  }
  playSfx(args = {}) {
    const id = isObject(args) ? args.id || args.soundId || args.resourceId : args;
    if (!id || typeof this.audio?.playAction !== 'function') return { ok: false, reason: 'Sound ID or audio runtime is unavailable' };
    const entry = this.listCache.audio?.sfx?.find(item => item.id === id);
    return Promise.resolve(this.audio.playAction(entry?.resourceId || id, isObject(args) ? args : {}));
  }
  stopAudio(args = {}) {
    if (args?.bgmOnly && this.audio?.stopBgm) return Promise.resolve(this.audio.stopBgm(args));
    this.audio?.stopAll?.(args || {});
    return { ok: true };
  }
  setAudioSettings(args = {}) {
    const settings = args?.settings && isObject(args.settings) ? args.settings : args;
    if (!this.audio?.setSettings) return { ok: false, reason: 'Audio runtime is unavailable' };
    this.audio.setSettings(settings || {});
    this.onAudioSettings?.(settings || {});
    return { ok: true, settings: pickAudioSettings(this.audio.settings || settings) };
  }
  setEnvironmentTime(args = {}) { const hour = Number(isObject(args) ? args.hour ?? args.value : args); if (!Number.isFinite(hour) || !this.world?.worldTime?.setHour) return { ok: false, reason: 'World time is unavailable' }; const result = this.world.worldTime.setHour(hour, args.day); this.manualOverrides.time = true; return { ok: true, time: compactTime(result) }; }
  setEnvironmentPause(args = {}) { const paused = Boolean(isObject(args) ? args.paused ?? args.value : args); if (!this.world?.worldTime?.setState) return { ok: false, reason: 'World time is unavailable' }; const result = this.world.worldTime.setState({ paused }); this.manualOverrides.pause = true; return { ok: true, time: compactTime(result) }; }
  setEnvironmentProfile(args = {}) {
    const environment = this.world?.environment;
    if (!environment?.setZone) return { ok: false, reason: 'Environment runtime is unavailable' };
    const requested = isObject(args) ? args.profile || args.id || args.zoneId : args;
    const profile = isObject(requested) ? copyProfile(requested) : copyProfile(getEnvironmentProfile(requested || environment.zoneId));
    const zoneId = cleanId(isObject(args) ? args.zoneId || profile.zoneId : requested) || environment.zoneId || 'default';
    environment.setZone(zoneId, profile);
    environment.setSourceSamples(copySamples(profile.samples || []));
    this.parameterBase = { profile: copyProfile(profile), samples: copySamples(profile.samples || []) };
    this.parameterMultipliers = { ...DEFAULT_ENV_PARAMS };
    this.manualOverrides.parameters = false;
    this.manualOverrides.profile = true;
    return { ok: true, profile: profileSummary(environment.profile, zoneId) };
  }
  setEnvironmentParameters(args = {}) {
    const environment = this.world?.environment;
    if (!environment?.setSourceSamples) return { ok: false, reason: 'Environment runtime is unavailable' };
    const parameterBase = this.parameterBase || { profile: copyProfile(environment.profile), samples: copySamples(environment.sourceSamples || []) };
    const source = copySamples(parameterBase.samples);
    const values = isObject(args?.parameters) ? args.parameters : args;
    const params = { ...this.parameterMultipliers };
    if (hasNumber(values.sunMultiplier ?? values.sunIntensity)) params.sunMultiplier = numberOr(values.sunMultiplier ?? values.sunIntensity, 1);
    if (hasNumber(values.ambientMultiplier ?? values.ambientScale ?? values.ambientIntensity)) params.ambientMultiplier = numberOr(values.ambientMultiplier ?? values.ambientScale ?? values.ambientIntensity, 1);
    if (hasNumber(values.fogMultiplier ?? values.fogIntensity)) params.fogMultiplier = numberOr(values.fogMultiplier ?? values.fogIntensity, 1);
    if (hasNumber(values.exposureMultiplier ?? values.exposure)) params.exposureMultiplier = numberOr(values.exposureMultiplier ?? values.exposure, 1);
    this.parameterMultipliers = params;
    const multipliers = { sunIntensity: params.sunMultiplier, ambientScale: params.ambientMultiplier, fogIntensity: params.fogMultiplier, exposure: params.exposureMultiplier };
    for (const sample of source) for (const [field, multiplier] of Object.entries(multipliers)) if (sample[field] !== undefined) sample[field] = Number(sample[field]) * multiplier;
    const profile = copyProfile(parameterBase.profile);
    profile.baseline.exposure = Number(profile.baseline.exposure || 1) * multipliers.exposure;
    environment.setZone(environment.zoneId, profile);
    environment.setSourceSamples(source);
    this.manualOverrides.parameters = true;
    return { ok: true, samples: source.length, multipliers };
  }
  resetEnvironment() {
    const base = this.environmentBase;
    const environment = this.world?.environment;
    if (base && environment?.setZone) {
      environment.setZone(base.zoneId, copyProfile(base.profile));
      environment.setSourceSamples(copySamples(base.samples));
      this.parameterBase = { profile: copyProfile(base.profile), samples: copySamples(base.samples) };
    }
    const time = this.world?.worldTime;
    if (base?.time && time?.setState) time.setState(base.time);
    this.parameterMultipliers = { ...DEFAULT_ENV_PARAMS };
    this.manualOverrides = Object.fromEntries(MANUAL_KEYS.map(key => [key, false]));
    return { ok: true };
  }
  async retry(args = {}) {
    if (typeof this.retryLoad !== 'function') return { ok: false, reason: 'Retry callback is unavailable' };
    const result = await this.retryLoad(args?.mapId || this.world?.sceneId, args);
    return result === false ? { ok: false, reason: 'Retry failed' } : { ok: true, result };
  }
  captureEnvironmentBase() {
    const environment = this.world?.environment;
    if (!environment) return;
    this.environmentBase = { zoneId: environment.zoneId, profile: copyProfile(environment.profile), samples: copySamples(environment.sourceSamples || environment.profile?.samples || []), time: this.world?.worldTime?.snapshot?.() || null };
    this.parameterBase = { profile: copyProfile(environment.profile), samples: copySamples(environment.sourceSamples || environment.profile?.samples || []) };
    this.parameterMultipliers = { ...DEFAULT_ENV_PARAMS };
    this.manualOverrides = Object.fromEntries(MANUAL_KEYS.map(key => [key, false]));
  }
  sceneList() {
    const signature = this.scenes.slice(0, LIST_LIMIT).map(scene => scene.id).join('|');
    if (this.listCache.scenes && this.listCache.sceneSignature === signature) return this.listCache.scenes;
    this.listCache.sceneSignature = signature;
    this.listCache.scenes = this.scenes.slice(0, LIST_LIMIT).map(scene => ({ id: scene.id, name: scene.name || scene.en || scene.id, en: scene.en || null, region: scene.region || null }));
    return this.listCache.scenes;
  }
  mountList() {
    const source = this.assets?.manifest?.mounts || this.manifest().mounts || null;
    const values = source ? Object.values(source) : (Array.isArray(this.assets?.mounts) ? this.assets.mounts : []);
    if (this.listCache.mounts && this.listCache.mountSource === source) return this.listCache.mounts;
    this.listCache.mountSource = source;
    this.listCache.mounts = values.slice(0, LIST_LIMIT).map(mount => ({ id: mount.id, name: mount.name || mount.id, model: mount.model || null, canFly: Boolean(mount.canFly) }));
    return this.listCache.mounts;
  }
  skillList() {
    const map = this.world?.skillDefinitions?.definitions;
    const values = map instanceof Map && map.size ? [...map.values()] : Object.values(this.assets?.skills || this.manifest().skills || {});
    const signature = values.slice(0, LIST_LIMIT).map(skill => `${skill.id ?? skill.skillId}:${skill.animationId || skill.animationResourceId || ''}:${skill.soundId || ''}`).join('|');
    if (this.listCache.skills && this.listCache.skillSource === map && this.listCache.skillSignature === signature) return this.listCache.skills;
    this.listCache.skillSource = map;
    this.listCache.skillSignature = signature;
    this.listCache.skills = values.slice(0, LIST_LIMIT).map(skill => ({ id: skill.id ?? skill.skillId, skillId: skill.skillId ?? null, animationId: skill.animationId || skill.animationResourceId || null, vfxId: skill.vfxId || null, soundId: skill.soundId || null, name: skill.name || null }));
    return this.listCache.skills;
  }
  animationList(character) {
    const values = character?.animation?.clips instanceof Map ? [...character.animation.clips.keys()] : [];
    return { current: character?.animation?.state || null, total: values.length, ids: values.slice(0, LIST_LIMIT) };
  }
  mountSnapshot(mount) { const state = mount?.state, definition = mount?.definition; return state ? { ...state, id: state.mountId || definition?.id || null, name: definition?.name || null, model: definition?.model || null, state: state.isMounted ? state.movementMode : 'dismounted' } : null; }
  characterSnapshot(character) {
    const model = character?.model;
    const materialIDs = new Set();
    model?.traverse?.(node => { const materials = Array.isArray(node.material) ? node.material : [node.material]; for (const material of materials) { const id = material?.userData?.materialId || material?.userData?.id || material?.name; if (id && materialIDs.size < 64) materialIDs.add(String(id)); } });
    const appearance = character?.state?.appearance || character?.appearance?.serialize?.();
    return {
      id: character?.id || null,
      source: character?.source || null,
      modelId: character?.definition?.model || character?.definition?.id || character?.model?.name || null,
      appearance: summarizeAppearance(appearance),
      currentPresetID: appearance?.currentPresetID ?? appearance?.currentPresetId ?? null,
      materialIDs: [...materialIDs],
      position: vectorSnapshot(character?.root?.position),
      actionId: character?.state?.actionId || null,
      movement: character?.state?.movement || null,
      mount: character?.state?.mount ? { ...character.state.mount } : null,
    };
  }
  audioSnapshot() {
    const manifest = this.manifest();
    const bgm = manifest.sceneBgm || manifest.audio?.sceneBgm || {};
    const sfx = manifest.actionSfx || manifest.skillSfx || manifest.audio?.actionSfx || {};
    const skills = manifest.skills || this.assets?.skills || {};
    const audioSource = { bgm, sfx, skills };
    const skillSignature = audioSignature(skills);
    if (!this.listCache.audio || this.listCache.audioSource?.bgm !== bgm || this.listCache.audioSource?.sfx !== sfx || this.listCache.audioSource?.skills !== skills || this.listCache.audioSkillSignature !== skillSignature) {
      this.listCache.audioSource = audioSource;
      this.listCache.audioSkillSignature = skillSignature;
      this.listCache.audio = { bgm: audioEntries(bgm, this.assetRuntime), sfx: audioEntries(sfx, this.assetRuntime, skills) };
    }
    return {
      currentBgm: this.audio?.bgm ? resourceInfo(this.audio.bgm.resourceId, this.assetRuntime) : null,
      bgm: this.listCache.audio.bgm,
      sfx: this.listCache.audio.sfx,
      settings: pickAudioSettings(this.audio?.settings),
    };
  }
  debugSnapshot(world) {
    const stats = this.assetRuntime?.stats?.() || null;
    const lod = world?.assetScene?.lod;
    return {
      playerPosition: vectorSnapshot(world?.player?.position),
      cameraPosition: vectorSnapshot(world?.camera?.position),
      camera: { azimuth: finite(world?.azimuth), polar: finite(world?.polar), distance: finite(world?.zoom), mode: world?.input?.controlMode || world?.cameraMode || null },
      lod: lod ? { enabled: lod.enabled ?? null, stats: lod.stats || null } : null,
      cache: stats ? { resources: stats.resources, inflightResources: stats.inflightResources, decodedBytes: stats.decodedBytes, queuedFetches: stats.queuedFetches, activeFetches: stats.activeFetches } : null,
    };
  }
  loadingState(sceneId) {
    const external = typeof this.getLoadingState === 'function' ? this.getLoadingState() : null;
    const state = external && typeof external.then !== 'function' && typeof external === 'object' ? { ...external } : {};
    return { mapId: sceneId, active: Boolean(this.world?.loading), error: this.world?.loadError || state.error || null, ...state };
  }
  manifest() {
    return this.assets?.manifest || this.assetRuntime?.manifest || {};
  }
  resolveMount(value) {
    if (value && typeof value === 'object') return value;
    return this.mountDefinitionList().find(item => item.id === value) || null;
  }
  mountDefinitionList() {
    return Array.isArray(this.assets?.mounts) ? this.assets.mounts : Object.values(this.manifest().mounts || {});
  }
  resolveSkill(value) {
    if (value && typeof value === 'object') return value.id ? value : { ...value, id: value.skillId };
    return this.world?.skillDefinitions?.get?.(value) || this.world?.skillDefinitions?.get?.(String(value)) || (value !== undefined ? (this.assets?.skills?.[value] || this.manifest().skills?.[value]) : null);
  }
  invokeCallback(callback, args) {
    return Promise.resolve(callback(args)).then(result => result === false ? { ok: false, reason: 'Character operation failed' } : { ok: true, result });
  }
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isFileLike(value) { return value && typeof value === 'object' && typeof value.arrayBuffer === 'function'; }
function cleanId(value) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, 160) : null; }
function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
function hasNumber(value) { return value !== undefined && value !== null && Number.isFinite(Number(value)); }
function numberOr(value, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, number) : fallback; }
function vectorSnapshot(value) { return value ? { x: finite(value.x), y: finite(value.y), z: finite(value.z) } : null; }
function resourceIdOf(value) { return typeof value === 'object' && value ? value.id || value.resourceId || value.soundId || null : value ?? null; }
function resourceInfo(id, runtime) { const record = id && runtime?.registry?.resources?.get?.(id); return record ? { id: record.id, type: record.type || null, size: record.size || 0, hash: record.hash || null } : id ? { id } : null; }
function audioEntries(table, runtime, skills = null) {
  const result = [], seen = new Set();
  const add = (id, value, skillId = null) => { const resourceId = resourceIdOf(value); if (!resourceId) return; const key = `${id}:${resourceId}`; if (seen.has(key) || result.length >= AUDIO_LIMIT) return; seen.add(key); result.push({ id, skillId, resourceId, resource: resourceInfo(resourceId, runtime) }); };
  for (const [id, value] of Object.entries(table || {})) add(id, value);
  for (const [skillId, skill] of Object.entries(skills || {})) { add(skillId, skill?.soundId, skillId); for (const [index, cue] of (skill?.soundEvents || []).entries()) add(`${skillId}:${index}`, cue?.resourceId || cue?.soundId, skillId); }
  return result;
}
function audioSignature(skills) { return Object.entries(skills || {}).slice(0, LIST_LIMIT).map(([id, skill]) => `${id}:${skill?.soundId || ''}:${(skill?.soundEvents || []).length}`).join('|'); }
function pickAudioSettings(settings) { return settings ? { sound: settings.sound, volume: settings.volume, bgmVolume: settings.bgmVolume, sfxVolume: settings.sfxVolume } : null; }
function summarizeAppearance(appearance) { if (!appearance || typeof appearance !== 'object') return null; const fields = ['schemaVersion', 'race', 'raceName', 'tribe', 'tribeName', 'sex', 'sexName', 'ageId', 'height', 'face', 'hair', 'highlightsEnabled', 'skinColor', 'rightEyeColor', 'hairColor', 'highlightColor', 'facialFeatures', 'facialFeatureColor', 'eyebrows', 'leftEyeColor', 'eyes', 'smallIris', 'nose', 'jaw', 'mouth', 'lipColorEnabled', 'lipColor', 'tailEarSize', 'tailEarType', 'bust', 'facePaint', 'facePaintColor', 'modelFamily', 'currentPresetID', 'currentPresetId']; const result = {}; for (const field of fields) if (appearance[field] !== undefined) result[field] = appearance[field]; const source = appearance.source; if (source && typeof source === 'object') result.source = { format: source.format || null, formatVersion: source.formatVersion ?? null, storedChecksum: source.storedChecksum ?? null, timestampUtc: source.timestampUtc || null, description: source.description || null, rawCustomize: Array.isArray(source.rawCustomize) ? source.rawCustomize.slice(0, 64) : undefined }; if (appearance.palette && typeof appearance.palette === 'object') result.palette = Object.fromEntries(Object.entries(appearance.palette).slice(0, 8).map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, 4) : value])); return Object.keys(result).length ? result : null; }
function compactTime(time) { return time && typeof time === 'object' ? { day: finite(time.day) ?? 0, hour: finite(time.hour) ?? 0, paused: Boolean(time.paused) } : null; }
function profileSummary(profile, zoneId) { if (!profile) return { zoneId: zoneId || null }; const baseline = profile.baseline || {}; const source = profile.source && typeof profile.source === 'object' ? profile.source : null; return { zoneId: zoneId || profile.zoneId || null, evidence: profile.evidence || source?.evidence || null, baseline: { background: baseline.background || null, fog: baseline.fog || null, directionalIntensity: baseline.directionalIntensity ?? null, ambientIntensity: baseline.ambientIntensity ?? null, exposure: baseline.exposure ?? null }, source: source ? { clientVersion: source.clientVersion || null, territoryId: source.territoryId ?? null, envbPath: source.envbPath || null } : null }; }
function copySamples(samples) { return Array.isArray(samples) ? samples.slice(0, 256).map(sample => ({ ...sample })) : []; }
function copyProfile(profile = {}) { return { zoneId: profile.zoneId, baseline: { ...(profile.baseline || {}) }, samples: copySamples(profile.samples || []), evidence: profile.evidence, source: profile.source }; }
export default DeveloperRuntime;
