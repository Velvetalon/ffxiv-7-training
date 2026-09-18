/**
 * Single active music track ownership. Scene/mount/preview requests arbitrate;
 * same-track re-requests reuse the current voice unless restart is explicit.
 */
export class MusicArbiter {
  constructor() {
    this.token = 0;
    this.current = null;
    this.sources = new Map();
  }

  request({ source, trackId, priority = 0, restart = false, meta = {} }) {
    const id = ++this.token;
    this.sources.set(source, { trackId, priority, meta, token: id });
    this.sources.set('__last__', this.sources.get(source));
    const active = [...this.sources.entries()]
      .filter(([name]) => name !== '__last__')
      .sort((a, b) => (b[1].priority - a[1].priority) || (b[1].token - a[1].token))[0];
    if (!active) return { ok: false, reason: 'no-sources', token: id };
    const [, entry] = active;
    if (this.current?.trackId === entry.trackId && !restart) {
      return { ok: true, reused: true, trackId: entry.trackId, token: id };
    }
    this.current = { trackId: entry.trackId, token: id, source: active[0], meta: entry.meta };
    return { ok: true, reused: false, trackId: entry.trackId, token: id, source: active[0] };
  }

  release(source, { onlyIfOwner = true } = {}) {
    this.sources.delete(source);
    if (onlyIfOwner && this.current?.source !== source) return { ok: true, changed: false };
    const active = [...this.sources.entries()]
      .filter(([name]) => name !== '__last__')
      .sort((a, b) => (b[1].priority - a[1].priority) || (b[1].token - a[1].token))[0];
    if (!active) { this.current = null; return { ok: true, changed: true, stopped: true }; }
    this.current = { trackId: active[1].trackId, token: ++this.token, source: active[0], meta: active[1].meta };
    return { ok: true, changed: true, trackId: this.current.trackId };
  }

  stats() { return { sources: this.sources.size - 1, current: this.current?.trackId || null }; }
}

export default MusicArbiter;
