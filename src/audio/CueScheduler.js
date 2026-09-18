/**
 * Web-Audio-clock cue scheduler with stale-event drop and owner cancellation.
 */
export class CueScheduler {
  constructor({ getContextTime, staleWindowSeconds = 0.75 } = {}) {
    this.getContextTime = getContextTime;
    this.staleWindowSeconds = staleWindowSeconds;
    this.tasks = new Map();
    this.nextId = 1;
  }

  schedule({ at, task, ownerId }) {
    const now = this.getContextTime();
    if (Number.isFinite(at) && at < now - this.staleWindowSeconds) {
      return { ok: false, reason: 'stale-dropped', at, now, id: null };
    }
    const id = this.nextId++;
    const record = { id, at: Number.isFinite(at) ? at : now, task, ownerId, state: 'scheduled' };
    this.tasks.set(id, record);
    if (!Number.isFinite(at) || at <= now) this.run(id);
    return { ok: true, id, at: record.at };
  }

  run(id) {
    const record = this.tasks.get(id);
    if (!record || record.state !== 'scheduled') return null;
    record.state = 'running';
    return record.task;
  }

  cancelOwner(ownerId, reason = 'cancelled') {
    const cancelled = [];
    for (const record of this.tasks.values()) {
      if (record.ownerId === ownerId && record.state === 'scheduled') {
        record.state = 'cancelled';
        record.reason = reason;
        cancelled.push(record);
      }
    }
    return cancelled;
  }

  finish(id) {
    const record = this.tasks.get(id);
    if (record) this.tasks.delete(id);
    return record || null;
  }

  pendingFor(ownerId) {
    const result = [];
    for (const record of this.tasks.values()) if (record.ownerId === ownerId && record.state === 'scheduled') result.push(record);
    return result;
  }

  stats() { return { scheduled: this.tasks.size }; }
}

export default CueScheduler;
