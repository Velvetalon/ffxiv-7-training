/**
 * AudioEngine facade. Coordinates clip loading, profile resolution, scheduling,
 * voice ownership and music arbitration on a single Web Audio backend.
 */
import { ClipStore } from './ClipStore.js';
import { CueScheduler } from './CueScheduler.js';
import { VoiceManager } from './VoiceManager.js';
import { ProfileResolver } from './ProfileResolver.js';
import { MusicArbiter } from './MusicArbiter.js';

export class AudioEngine {
  constructor({ context, buses, runtime, limits } = {}) {
    if (!context || !buses) throw new TypeError('AudioEngine requires context and buses');
    this.context = context;
    this.buses = buses;
    this.clips = new ClipStore({ runtime, context });
    this.scheduler = new CueScheduler({ getContextTime: () => context.currentTime });
    this.voices = new VoiceManager({ limits });
    this.profiles = new ProfileResolver();
    this.music = new MusicArbiter();
    this.suppressions = new Set();
  }

  bindProfiles(entityRef, profileRefs) { return this.profiles.bindProfiles(entityRef, profileRefs); }
  unbind(handleOrRef) { return this.profiles.unbind(handleOrRef); }
  updateContext(handle, context) { return this.profiles.updateContext(handle, context); }

  suppressEvent(eventKey) { this.suppressions.add(String(eventKey)); }

  async emit(event, { priority = 0, cueOverride } = {}) {
    if (event.eventId && this.suppressions.has(String(event.eventId))) {
      return { ok: false, reason: 'suppressed-explicit', eventId: event.eventId };
    }
    const resolution = this.profiles.resolve(event, event.context || {});
    if (!resolution.layers.length) {
      return { ok: false, reason: 'no-compatible-rule', explain: resolution.explain, suppressed: resolution.suppressed.length > 0 };
    }
    const handles = [];
    for (const layer of resolution.layers) {
      const cue = cueOverride || layer.rule.cue;
      if (!cue?.clip) { handles.push({ ok: false, reason: 'cue-missing-clip', layer }); continue; }
      const clip = await this.clips.load(cue.clip, { priority: cue.priority ?? priority });
      const at = this.context.currentTime + Math.max(0, Number(cue.delaySeconds || 0));
      const scheduled = this.scheduler.schedule({ at, ownerId: event.ownerId, task: { cue, event, layer } });
      if (!scheduled.ok) { handles.push(scheduled); continue; }
      const voice = this.startVoice({ cue, clip, ownerId: event.ownerId, priority, slot: layer.slot });
      handles.push({ ...voice, scheduledId: scheduled.id, cueId: cue.id || cue.clip });
      this.scheduler.finish(scheduled.id);
    }
    const ok = handles.some(handle => handle.ok);
    return { ok, handles, explain: resolution.explain, conflicts: resolution.conflicts };
  }

  startVoice({ cue, clip, ownerId, priority, slot }) {
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = clip;
    source.loop = Boolean(cue.loop);
    if (Number.isFinite(cue.loopStart)) source.loopStart = cue.loopStart;
    if (Number.isFinite(cue.loopEnd) && cue.loopEnd > 0) source.loopEnd = cue.loopEnd;
    source.playbackRate.value = Math.max(0.25, Math.min(4, Number(cue.rate || 1)));
    const bus = this.buses[cue.bus || 'sfx'] || this.buses.sfx;
    const target = cue.bus === 'music' ? (this.buses.music || bus) : bus;
    gain.gain.value = Math.max(0, Math.min(4, Number(cue.gain ?? 1)));
    source.connect(gain);
    gain.connect(target);
    const voice = this.voices.start({ cueId: cue.id || cue.clip, ownerId, bus: cue.bus || 'sfx', priority, nodes: {
      stop: reason => {
        try { gain.gain.cancelScheduledValues(this.context.currentTime); gain.gain.setValueAtTime(0, this.context.currentTime); source.stop(); } catch { /* already ended */ }
        void reason;
      },
    } });
    if (!voice.ok) { try { source.stop(); } catch { /* noop */ } return voice; }
    source.onended = () => this.voices.stop(voice.id, 'ended');
    source.start();
    return { ok: true, voiceId: voice.id };
  }

  async setSceneAudio({ sceneId, trackId, loop = true, loopStart, loopEnd } = {}) {
    const request = this.music.request({ source: 'scene', trackId: trackId || null, priority: 10, meta: { sceneId } });
    if (!request.ok || !trackId) return request;
    if (request.reused) return request;
    return this.playMusicTrack({ trackId, loop, loopStart, loopEnd, ownerId: 'scene' });
  }

  async requestMountMusic({ trackId, loop = true, loopStart, loopEnd } = {}) {
    const request = this.music.request({ source: 'mount', trackId, priority: 20, meta: { mount: true } });
    if (!request.ok || !trackId) return request;
    if (request.reused) return request;
    return this.playMusicTrack({ trackId, loop, loopStart, loopEnd, ownerId: 'mount' });
  }

  async releaseMountMusic() {
    const result = this.music.release('mount');
    if (!result.changed) return result;
    const scene = this.music.current?.source === 'scene' ? this.music.current : null;
    if (scene?.trackId) return this.playMusicTrack({ trackId: scene.trackId, ownerId: 'scene', loop: true });
    await this.stopMusic();
    return result;
  }

  async playMusicTrack({ trackId, loop = true, loopStart, loopEnd, ownerId = 'scene' }) {
    const clip = await this.clips.load(trackId, { priority: 2 });
    this.voices.stopOwner(ownerId, 'music-switch');
    const voice = this.startVoice({ cue: { id: `music:${trackId}`, clip: trackId, loop, loopStart, loopEnd, bus: 'music', gain: 1 }, clip, ownerId, priority: 0, slot: 'music' });
    return { ...voice, trackId };
  }

  async stopMusic({ fadeMs = 0 } = {}) {
    void fadeMs;
    this.voices.stopOwner('scene', 'music-stop');
    this.voices.stopOwner('mount', 'music-stop');
    this.music.current = null;
    return { ok: true };
  }

  stopOwner(ownerId, reason) { this.voices.stopOwner(ownerId, reason); this.scheduler.cancelOwner(ownerId, reason); }

  explain(event) { return this.profiles.resolve(event, event.context || {}).explain; }

  stats() {
    return { voices: this.voices.stats(), clips: this.clips.stats(), scheduler: this.scheduler.stats(), music: this.music.stats() };
  }
}

export default AudioEngine;
