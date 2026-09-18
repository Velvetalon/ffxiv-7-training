/**
 * Voice ownership + budgets. Voices are unique playback instances; clips are shared.
 */
export class VoiceManager {
  constructor({ limits = {} } = {}) {
    this.limits = { perCue: limits.perCue ?? 8, perEntity: limits.perEntity ?? 16, global: limits.global ?? 48 };
    this.voices = new Map();
    this.nextId = 1;
  }

  start({ cueId, ownerId, bus = 'sfx', priority = 0, nodes }) {
    this.preempt({ cueId, ownerId, priority });
    if (this.voices.size >= this.limits.global) {
      this.preemptOldest({ lowerPriorityThan: priority });
      if (this.voices.size >= this.limits.global) return { ok: false, reason: 'voice-budget-exhausted' };
    }
    const id = this.nextId++;
    this.voices.set(id, { id, cueId, ownerId, bus, priority, nodes, startedAt: performance?.now?.() ?? 0 });
    return { ok: true, id };
  }

  stop(id, reason = 'stopped') {
    const voice = this.voices.get(id);
    if (!voice) return false;
    this.voices.delete(id);
    voice.nodes?.stop?.(reason);
    return true;
  }

  stopOwner(ownerId, reason = 'stopped') {
    for (const [id, voice] of [...this.voices]) {
      if (voice.ownerId === ownerId) this.stop(id, reason);
    }
  }

  stopAll(reason = 'stopped') {
    for (const [id] of [...this.voices]) this.stop(id, reason);
  }

  preempt({ cueId, ownerId, priority }) {
    let same = 0;
    for (const [id, voice] of this.voices) {
      if (voice.cueId === cueId && voice.ownerId === ownerId) {
        same++;
        if (same >= this.limits.perCue) this.stop(id, 'per-cue-limit');
      }
    }
    let entity = 0;
    for (const [id, voice] of this.voices) {
      if (voice.ownerId === ownerId) {
        entity++;
        if (entity >= this.limits.perEntity) this.stop(id, 'per-entity-limit');
      }
    }
  }

  preemptOldest() {
    let oldest = null;
    for (const voice of this.voices.values()) if (!oldest || voice.startedAt < oldest.startedAt) oldest = voice;
    if (oldest) this.stop(oldest.id, 'global-budget');
  }

  count(ownerId) {
    let n = 0;
    for (const voice of this.voices.values()) if (!ownerId || voice.ownerId === ownerId) n++;
    return n;
  }

  stats() {
    const byBus = {};
    for (const voice of this.voices.values()) byBus[voice.bus] = (byBus[voice.bus] || 0) + 1;
    return { active: this.voices.size, byBus };
  }
}

export default VoiceManager;
