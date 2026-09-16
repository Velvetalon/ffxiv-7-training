/**
 * Shared decoded-clip cache. One AudioBuffer per content hash, many voices.
 */
export class ClipStore {
  constructor({ runtime, context, maxDecodedBytes = 192 * 1024 * 1024, decodeConcurrency = 2 } = {}) {
    if (!runtime || typeof runtime.load !== 'function') throw new TypeError('ClipStore requires an AssetRuntime');
    this.runtime = runtime;
    this.context = context;
    this.maxDecodedBytes = maxDecodedBytes;
    this.decodeConcurrency = decodeConcurrency;
    this.entries = new Map();
    this.inflight = new Map();
    this.queue = [];
    this.running = 0;
    this.decodedBytes = 0;
  }

  async load(resourceId, { priority = 5 } = {}) {
    const id = String(resourceId);
    const entry = this.entries.get(id);
    if (entry) {
      entry.usedAt = this.now();
      return entry.buffer;
    }
    const pending = this.inflight.get(id);
    if (pending) return pending.promise;
    let resolvePromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = { resolve, reject }; });
    const task = { id, priority, promise, resolve: resolvePromise.resolve, reject: resolvePromise.reject };
    this.inflight.set(id, task);
    this.queue.push(task);
    this.pump();
    return promise;
  }

  pump() {
    while (this.running < this.decodeConcurrency && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const task = this.queue.shift();
      this.running = (this.running || 0) + 1;
      void this.decode(task);
    }
  }

  async decode(task) {
    let buffer = null;
    try {
      buffer = await this.runtime.load(task.id, { retain: true, priority: task.priority });
      this.entries.set(task.id, { buffer, usedAt: this.now() });
      if (buffer?.length && buffer.numberOfChannels) this.decodedBytes += buffer.length * buffer.numberOfChannels * 4;
      this.evict();
      task.resolve(buffer);
    } catch (error) {
      task.reject(error);
    } finally {
      this.inflight.delete(task.id);
      this.running = Math.max(0, (this.running || 1) - 1);
      this.pump();
    }
  }

  evict() {
    while (this.decodedBytes > this.maxDecodedBytes) {
      let oldest = null;
      for (const [id, entry] of this.entries) {
        if (!oldest || entry.usedAt < this.entries.get(oldest).usedAt) oldest = id;
      }
      if (oldest === null) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (entry.buffer?.length && entry.buffer.numberOfChannels) {
        this.decodedBytes = Math.max(0, this.decodedBytes - entry.buffer.length * entry.buffer.numberOfChannels * 4);
      }
      this.runtime.release?.(oldest);
    }
  }

  now() { return this.context?.currentTime ?? 0; }

  stats() {
    return { clips: this.entries.size, inflight: this.inflight.size, decodedBytes: this.decodedBytes, budget: this.maxDecodedBytes };
  }
}

export default ClipStore;
