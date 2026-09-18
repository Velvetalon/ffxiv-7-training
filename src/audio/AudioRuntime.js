/**
 * Shared browser audio runtime for scene music and semantic action sounds.
 *
 * Audio bytes are intentionally owned by AssetRuntime. This module only
 * registers an AudioBuffer decoder and creates/cleans Web Audio nodes.
 */
import { AudioEngine } from './AudioEngine.js';

export class AudioRuntime {
  constructor(assetRuntime, settings = {}, options = {}) {
    if (!assetRuntime || typeof assetRuntime.load !== 'function') {
      throw new TypeError('AudioRuntime requires an AssetRuntime');
    }
    this.assetRuntime = assetRuntime;
    this.settings = settings;
    this.options = options;
    this.context = null;
    this.master = null;
    this.bgmBus = null;
    this.sfxBus = null;
    this.bgm = null;
    this.sceneToken = 0;
    this.pendingScene = null;
    this.pendingActions = [];
    this.sfxSources = new Set();
    this.sfxGeneration = 0;
    this.engine = null;
    this.skills = null;
    this.unlockBound = false;
    this.unlocked = false;
    this.gestureHandler = () => { void this.unlock(); };
    this.installDecoder();
    this.bindUserGesture();
  }

  /** Provide skill-level audio metadata for source-mapped action cues. */
  setSkills(skills) {
    this.skills = skills || {};
  }

  /** Create (or refresh) the composed engine once a context exists. */
  ensureEngine() {
    if (!this.context) return this.engine;
    if (this.engine) return this.engine;
    this.engine = new AudioEngine({
      context: this.context,
      runtime: this.assetRuntime,
      buses: { master: this.master, music: this.bgmBus, sfx: this.sfxBus },
    });
    const skillRules = Object.values(this.skills || {})
      .filter(definition => definition.soundId)
      .map(definition => ({
        event: 'action.release',
        slot: 'primary',
        mode: 'replace',
        priority: 5,
        conditions: { actionId: definition.skillId },
        cue: { clip: definition.soundId, bus: 'sfx', gain: 1 },
      }));
    this.skillBinding = this.engine.bindProfiles('player', [{ id: 'skills', rules: skillRules }]);
    return this.engine;
  }

  /** Register the decoder against the supplied AssetRuntime exactly once. */
  installDecoder() {
    if (this.assetRuntime.__audioDecoderInstalled) return;
    this.assetRuntime.decoder('audio', async (bytes, record) => {
      const context = this.ensureContext();
      if (!context) throw new Error('Web Audio API is unavailable');
      // decodeAudioData may detach its input buffer, so never pass the
      // AssetRuntime-owned Uint8Array/ArrayBuffer directly.
      const copy = bytes instanceof ArrayBuffer
        ? bytes.slice(0)
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buffer = await context.decodeAudioData(copy);
      // AssetRuntime's encoded size is not a useful eviction estimate for a
      // decoded AudioBuffer; account for all PCM channel frames.
      if (record && buffer?.length && buffer.numberOfChannels) {
        record.runtimeBytes = buffer.length * buffer.numberOfChannels * 4;
      }
      return buffer;
    });
    this.assetRuntime.__audioDecoderInstalled = true;
  }

  bindUserGesture() {
    if (this.unlockBound || typeof document === 'undefined') return;
    this.unlockBound = true;
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      document.addEventListener(type, this.gestureHandler, { capture: true, passive: true });
    }
  }

  unbindUserGesture() {
    if (!this.unlockBound || typeof document === 'undefined') return;
    this.unlockBound = false;
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      document.removeEventListener(type, this.gestureHandler, true);
    }
  }

  ensureContext() {
    if (this.context) return this.context;
    const Context = this.options.AudioContext
      || globalThis.AudioContext
      || globalThis.webkitAudioContext;
    if (!Context) return null;
    this.context = this.options.audioContext || new Context();
    this.master = this.context.createGain();
    this.bgmBus = this.context.createGain();
    this.sfxBus = this.context.createGain();
    this.bgmBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.context.destination);
    this.applyVolumes();
    return this.context;
  }

  async unlock() {
    const context = this.ensureContext();
    if (!context) return { ok: false, reason: 'audio-api-unavailable' };
    try {
      if (context.state === 'suspended') await context.resume();
      this.unlocked = context.state === 'running' || context.state === 'interactive';
    } catch (error) {
      return { ok: false, reason: 'audio-context-locked', error };
    }
    if (!this.unlocked) return { ok: false, reason: 'audio-context-locked' };
    this.unbindUserGesture();
    const pendingScene = this.pendingScene;
    this.pendingScene = null;
    if (pendingScene) void this._playScene(pendingScene.sceneId, pendingScene.options, pendingScene.token);
    const actions = this.pendingActions.splice(0);
    for (const action of actions) void this._playAction(action.soundId, action.options);
    return { ok: true };
  }

  setSettings(next = {}) {
    Object.assign(this.settings, next);
    this.applyVolumes();
    if (!this.settings.sound) this.stopAll({ fadeMs: 80 });
    return this;
  }

  applyVolumes() {
    if (!this.master) return;
    const base = level(this.settings.volume, 1);
    const bgm = level(this.settings.bgmVolume, 1);
    const sfx = level(this.settings.sfxVolume, 1);
    const now = this.context?.currentTime || 0;
    this.master.gain.setValueAtTime(base, now);
    this.bgmBus.gain.setValueAtTime(bgm, now);
    this.sfxBus.gain.setValueAtTime(sfx, now);
  }

  manifest() {
    const manifest = typeof this.options.getManifest === 'function'
      ? this.options.getManifest()
      : this.options.manifest || this.assetRuntime.manifest;
    return manifest || {};
  }

  sceneEntry(sceneId) {
    const table = this.manifest().sceneBgm || this.manifest().audio?.sceneBgm || {};
    return table[sceneId] ?? null;
  }

  actionEntry(soundId) {
    const table = this.manifest().actionSfx
      || this.manifest().skillSfx
      || this.manifest().audio?.actionSfx
      || {};
    return table[soundId] ?? null;
  }

  /** Resolve a runtime-level cue alias (e.g. remapped actionSfx entries). */
  resolveActionCue(soundId) {
    const table = this.manifest().actionSfx || {};
    const entry = table[soundId];
    return entry?.id || soundId;
  }

  /** Start or transition to the BGM selected by a scene/zone id. */
  async playScene(sceneId, options = {}) {
    const token = ++this.sceneToken;
    const context = this.ensureContext();
    if (!this.settings.sound) return { ok: false, reason: 'sound-disabled', sceneId };
    if (!context) return { ok: false, reason: 'audio-api-unavailable', sceneId };
    if (!this.isUnlocked()) {
      this.pendingScene = { sceneId, options, token };
      return { ok: false, pending: 'user-gesture', sceneId };
    }
    return this._playScene(sceneId, options, token);
  }

  async _playScene(sceneId, options, token) {
    const entry = this.sceneEntry(sceneId);
    const resourceId = resourceIdOf(entry);
    if (!resourceId) {
      await this.stopBgm({ fadeMs: options.fadeMs });
      this.engine?.dropMusicSource('scene');
      return { ok: false, reason: 'scene-bgm-unknown', sceneId };
    }
    if (token !== this.sceneToken) return { ok: false, stale: true, sceneId };
    const engine = this.ensureEngine();
    // A mount cycle can leave the scene track as an engine-owned voice.
    engine?.stopOwner('scene', 'scene-switch');
    if (engine?.isMusicOwner('mount')) {
      // Mount owns music: register the request, defer raw scene playback.
      engine.registerSceneMusic({
        sceneId,
        trackId: resourceId,
        loop: options.loop ?? entry?.loop ?? true,
        loopStart: options.loopStart ?? entry?.loopStart,
        loopEnd: options.loopEnd ?? entry?.loopEnd,
      });
      return { ok: true, sceneId, resourceId, suppressedBy: 'mount' };
    }
    if (this.bgm?.resourceId === resourceId && !this.bgm.stopped) return { ok: true, reused: true, sceneId, resourceId };
    let buffer;
    try {
      buffer = await this.assetRuntime.load(resourceId, { retain: true, priority: options.priority });
    } catch (error) {
      return { ok: false, reason: 'scene-bgm-load-failed', sceneId, resourceId, error };
    }
    if (token !== this.sceneToken) {
      this.assetRuntime.release?.(resourceId);
      return { ok: false, stale: true, sceneId, resourceId };
    }
    const context = this.ensureContext();
    if (!context || !this.isUnlocked()) {
      this.assetRuntime.release?.(resourceId);
      this.pendingScene = { sceneId, options, token };
      return { ok: false, pending: 'user-gesture', sceneId, resourceId };
    }
    engine?.registerSceneMusic({
      sceneId,
      trackId: resourceId,
      loop: options.loop ?? entry?.loop ?? true,
      loopStart: options.loopStart ?? entry?.loopStart,
      loopEnd: options.loopEnd ?? entry?.loopEnd,
    });
    const track = this.createBgmTrack(buffer, resourceId, entry, options);
    const old = this.bgm;
    this.bgm = track;
    if (old) this.stopTrack(old, options.fadeMs ?? this.options.fadeMs ?? 650);
    const now = context.currentTime;
    const fadeSeconds = Math.max(0, Number(options.fadeMs ?? this.options.fadeMs ?? 650)) / 1000;
    track.gain.gain.setValueAtTime(fadeSeconds ? 0 : this.bgmLevel(), now);
    if (fadeSeconds) track.gain.gain.linearRampToValueAtTime(this.bgmLevel(), now + fadeSeconds);
    track.source.start(now);
    return { ok: true, sceneId, resourceId };
  }

  createBgmTrack(buffer, resourceId, entry, options) {
    const context = this.context;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = options.loop ?? entry?.loop ?? true;
    const loopStart = options.loopStart ?? entry?.loopStart;
    const loopEnd = options.loopEnd ?? entry?.loopEnd;
    if (Number.isFinite(loopStart)) source.loopStart = Math.max(0, loopStart);
    if (Number.isFinite(loopEnd) && loopEnd > 0) source.loopEnd = loopEnd;
    source.connect(gain);
    gain.connect(this.bgmBus);
    return { source, gain, resourceId, stopped: false };
  }

  /** Play an action/skill sound by semantic SoundID, never by keyboard input. */
  async playAction(skillDefinitionOrSoundId, options = {}) {
    const soundId = typeof skillDefinitionOrSoundId === 'object'
      ? skillDefinitionOrSoundId?.soundId
      : skillDefinitionOrSoundId;
    if (soundId === undefined || soundId === null || soundId === '') return { ok: false, reason: 'sound-id-unknown' };
    const context = this.ensureContext();
    if (!this.settings.sound) return { ok: false, reason: 'sound-disabled', soundId };
    if (!context) return { ok: false, reason: 'audio-api-unavailable', soundId };
    if (!this.isUnlocked()) {
      this.pendingActions.push({ soundId, options, queuedAt: Date.now() });
      if (this.pendingActions.length > 8) this.pendingActions.shift();
      return { ok: false, pending: 'user-gesture', soundId };
    }
    return this._playAction(soundId, options);
  }

  /** Compatibility name for ActionRuntime; the argument remains a SoundID. */
  playSfx(skillDefinitionOrSoundId, options = {}) {
    return this.playAction(skillDefinitionOrSoundId, options);
  }

  /** Compatibility name for World scene injection. */
  setScene(sceneId, options = {}) {
    return this.playScene(sceneId, options);
  }

  /** Mount music request routed through the MusicArbiter (mount wins over scene). */
  async requestMountMusic(trackId, options = {}) {
    if (!this.settings.sound) return { ok: false, reason: 'sound-disabled', trackId };
    const engine = this.ensureEngine();
    if (!engine) return { ok: false, reason: 'engine-unavailable', trackId };
    const entry = this.manifest().resources?.[trackId] || { id: trackId };
    const resourceId = entry?.id || trackId;
    if (resourceId == null || resourceId === '') return { ok: false, reason: 'mount-track-unknown', trackId };
    const meta = entry?.metadata || {};
    // The live scene track must stop before the mount voice starts, and a
    // failed request must unregister itself so release() cannot replay it.
    await this.stopBgm({ fadeMs: options.fadeMs ?? 0 });
    let result;
    try {
      result = await engine.requestMountMusic({ trackId: resourceId, loop: options.loop ?? true, loopStart: meta.loopStart, loopEnd: meta.loopEnd });
    } catch (error) {
      result = { ok: false, reason: 'mount-music-failed', trackId: resourceId, error };
    }
    if (result.ok) return result;
    engine.dropMusicSource('mount');
    const scene = engine.music.sources.get('scene');
    if (scene?.meta?.sceneId) return this._playScene(scene.meta.sceneId, {}, ++this.sceneToken);
    return result;
  }

  /** Release mount music and restore the scene's active track. */
  async releaseMountMusic() {
    const engine = this.engine;
    if (!engine) return { ok: false, reason: 'engine-unavailable' };
    return engine.releaseMountMusic();
  }

  async _playAction(soundId, options) {
    const generation = this.sfxGeneration;
    soundId = this.resolveActionCue(soundId);
    const skillDefinition = this.skills ? Object.values(this.skills).find(definition =>
      definition.soundId === soundId
      || (definition.soundEvents || []).some(cue => cue.resourceId === soundId)) : null;
    const engine = this.ensureEngine();
    if (engine && skillDefinition) {
      const skillId = skillDefinition.skillId;
      const delaySeconds = Number(options.delaySeconds ?? 0);
      const cues = skillDefinition.soundEvents?.length ? skillDefinition.soundEvents : [{ resourceId: skillDefinition.soundId, delaySeconds }];
      const handles = [];
      for (const cue of cues) {
        const cueDelay = Number(cue.delaySeconds ?? cueDelayDefault(skillDefinition) ?? 0);
        const clipId = cue.resourceId || skillDefinition.soundId;
        const result = await engine.emit({
          type: 'action.release',
          ownerId: 'player',
          eventId: 'action:' + skillId + ':' + clipId,
          context: { actionId: skillId },
        }, { priority: 0, cueOverride: { id: clipId, clip: clipId, bus: 'sfx', gain: Number(options.volume ?? 1), delaySeconds: cueDelay } });
        handles.push(result);
      }
      if (generation !== this.sfxGeneration) return { ok: false, stale: true, soundId };
      if (handles.some(handle => handle.ok)) return { ok: true, soundId, skillId, via: 'engine' };
      if (handles.length && handles.every(handle => handle.reason === 'suppressed-explicit')) {
        return { ok: false, reason: 'suppressed-explicit', soundId };
      }
    }
    const entry = this.actionEntry(soundId) || (this.manifest().resources?.[soundId]?.type === 'audio' ? { id: soundId } : null);
    const resourceId = resourceIdOf(entry);
    if (!resourceId) return { ok: false, reason: 'action-sfx-unknown', soundId };
    const requestedStart = this.context.currentTime + Math.max(0, Number(options.delaySeconds || 0));
    let buffer;
    try {
      buffer = await this.assetRuntime.load(resourceId, { retain: false, priority: options.priority });
    } catch (error) {
      return { ok: false, reason: 'action-sfx-load-failed', soundId, resourceId, error };
    }
    if (generation !== this.sfxGeneration) return { ok: false, stale: true, soundId, resourceId };
    if (!this.isUnlocked() || !this.context) return { ok: false, pending: 'user-gesture', soundId, resourceId };
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.loop = false;
    source.connect(gain);
    gain.connect(this.sfxBus);
    const now = this.context.currentTime;
    const volume = Math.max(0, Math.min(1, Number(options.volume ?? entry?.volume ?? 1)));
    gain.gain.setValueAtTime(volume, now);
    source.onended = () => { this.sfxSources.delete(source); source.disconnect(); gain.disconnect(); };
    source.start(Math.max(now, requestedStart), Math.max(0, Number(options.offset ?? 0)));
    this.sfxSources.add(source);
    return { ok: true, soundId, resourceId };
  }

  isUnlocked() {
    return this.unlocked || this.context?.state === 'running' || this.context?.state === 'interactive';
  }

  bgmLevel() {
    // BGM volume belongs to bgmBus. Track gain only handles fades, otherwise
    // a user setting such as 0.5 would be applied twice (0.25 output).
    return 1;
  }

  async stopBgm({ fadeMs = this.options.fadeMs ?? 650 } = {}) {
    this.sceneToken++;
    this.pendingScene = null;
    this.engine?.stopOwner('scene', 'bgm-stop');
    const track = this.bgm;
    this.bgm = null;
    if (!track) return { ok: true, stopped: false };
    this.stopTrack(track, fadeMs);
    return { ok: true, stopped: true };
  }

  stopTrack(track, fadeMs = 0) {
    if (!track || track.stopped) return;
    track.stopped = true;
    const context = this.context;
    const seconds = Math.max(0, Number(fadeMs) || 0) / 1000;
    const now = context?.currentTime || 0;
    try {
      track.gain.gain.cancelScheduledValues(now);
      const current = Math.max(0, Number(track.gain.gain.value) || 0);
      track.gain.gain.setValueAtTime(current, now);
      if (seconds) track.gain.gain.linearRampToValueAtTime(0, now + seconds);
      else track.gain.gain.setValueAtTime(0, now);
      track.source.stop(now + seconds + 0.02);
    } catch { /* A source can already have ended during a scene race. */ }
    const release = () => {
      try { track.source.disconnect(); track.gain.disconnect(); } catch { /* noop */ }
      this.assetRuntime.release?.(track.resourceId);
    };
    track.source.onended = release;
    if (!seconds) release();
  }

  stopAll(options = {}) {
    this.sfxGeneration++;
    this.pendingScene = null;
    this.pendingActions.length = 0;
    for (const source of this.sfxSources) source.stop();
    this.sfxSources.clear();
    this.engine?.stopMusic({ fadeMs: 0 });
    this.engine?.stopAllVoices('stop-all');
    void this.stopBgm(options);
  }

  async close() {
    this.stopAll({ fadeMs: 0 });
    this.unbindUserGesture();
    await this.context?.close?.();
    this.context = null;
    this.unlocked = false;
  }
}

export function initialize(assetRuntime, settings = {}, options = {}) {
  return new AudioRuntime(assetRuntime, settings, options);
}

function resourceIdOf(entry) {
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (!entry || typeof entry !== 'object') return null;
  return entry.id ?? entry.resourceId ?? entry.soundId ?? null;
}

function level(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric));
}

function cueDelayDefault(definition) {
  return Number(definition?.timing?.soundDelaySeconds || 0);
}

export default initialize;
