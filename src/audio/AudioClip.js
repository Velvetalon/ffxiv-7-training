/**
 * Clip data and the shared decode cache behind every voice.
 *
 * Encoded bytes stay owned by AssetRuntime; ClipStore keeps one retain per
 * decoded AudioBuffer and shares the immutable AudioClip between voices.
 */

const FLOAT32_BYTES = 4;

/** Immutable description of one decoded audio resource. */
export class AudioClip {
  constructor({
    logicalId,
    resourceId,
    hash,
    buffer = null,
    pcmBytes = 0,
    duration = 0,
    channels = 0,
    sampleRate = 0,
  }) {
    if (typeof logicalId !== 'string' || !logicalId) throw new TypeError('AudioClip requires a logicalId');
    if (typeof resourceId !== 'string' || !resourceId) throw new TypeError('AudioClip requires a resourceId');
    this.logicalId = logicalId;
    this.resourceId = resourceId;
    this.hash = hash != null ? String(hash) : 'raw:' + resourceId;
    this.buffer = buffer;
    this.pcmBytes = Math.max(0, Number(pcmBytes) || 0);
    this.duration = Math.max(0, Number(duration) || 0);
    this.channels = Math.max(0, Number(channels) || 0);
    this.sampleRate = Math.max(0, Number(sampleRate) || 0);
    this.lastUsed = 0;
    Object.freeze(this);
  }
}

function pcmBytesOf(buffer) {
  if (!buffer || !Number.isFinite(buffer.length) || !Number.isFinite(buffer.numberOfChannels)) return 0;
  return buffer.length * buffer.numberOfChannels * FLOAT32_BYTES;
}

/**
 * Logical id -> decoded clip cache keyed by content hash.
 * Decode concurrency is bounded and PCM memory is accounted and evictable.
 */
export class ClipStore {
  constructor({
    assetRuntime,
    resolveResourceId = id => id,
    decodeConcurrency = 2,
    memoryBudget = 64 * 1024 * 1024,
    now = () => performance.now(),
  } = {}) {
    if (!assetRuntime || typeof assetRuntime.load !== 'function') {
      throw new TypeError('ClipStore requires an assetRuntime with load()');
    }
    this.assetRuntime = assetRuntime;
    this.resolveResourceId = resolveResourceId;
    this.decodeConcurrency = Math.max(1, Number(decodeConcurrency) || 1);
    this.memoryBudget = Math.max(0, Number(memoryBudget) || 0);
    this.now = now;
    this.clips = new Map();
    this.byHash = new Map();
    this.refs = new Map();
    this.pending = new Map();
    this.pendingHashes = new Map();
    this.queue = [];
    this.inflight = 0;
    this.memoryBytes = 0;
  }

  /** Resolve a logical id to a shared AudioClip, decoding at most once. */
  load(logicalId, options = {}) {
    const key = String(logicalId);
    const cached = this.clips.get(key);
    if (cached) {
      cached.lastUsed = this.now();
      return Promise.resolve(cached);
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = this.#enqueue(key, options.priority);
    const wrapped = promise.finally(() => {
      if (this.pending.get(key) === wrapped) this.pending.delete(key);
    });
    this.pending.set(key, wrapped);
    return wrapped;
  }

  /** Reserve a decoded clip for a voice; prevents eviction while active. */
  retain(logicalId) {
    const key = String(logicalId);
    if (!this.clips.has(key)) return false;
    this.refs.set(key, (this.refs.get(key) || 0) + 1);
    return true;
  }

  /** Drop one voice reference and try to evict unreferenced clips. */
  release(logicalId) {
    const key = String(logicalId);
    const refs = this.refs.get(key) || 0;
    this.refs.set(key, Math.max(0, refs - 1));
    this.#evict();
  }

  get(logicalId) {
    return this.clips.get(String(logicalId)) || null;
  }

  stats() {
    let refs = 0;
    for (const count of this.refs.values()) refs += count;
    return {
      clips: this.byHash.size,
      logicalIds: this.clips.size,
      refs,
      memoryBytes: this.memoryBytes,
      memoryBudget: this.memoryBudget,
      inflight: this.inflight,
      queued: this.queue.length,
    };
  }

  /** Release every AssetRuntime retain this store owns. */
  dispose() {
    for (const job of this.queue.splice(0)) job.reject(new Error('ClipStore disposed'));
    for (const clip of new Set(this.byHash.values())) {
      try { this.assetRuntime.release?.(clip.resourceId); } catch { /* runtime may be gone */ }
    }
    this.clips.clear();
    this.byHash.clear();
    this.refs.clear();
    this.pending.clear();
    this.pendingHashes.clear();
    this.memoryBytes = 0;
  }

  #enqueue(logicalId, priority) {
    return new Promise((resolve, reject) => {
      this.queue.push({ logicalId, priority, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    while (this.inflight < this.decodeConcurrency && this.queue.length) {
      const job = this.queue.shift();
      this.inflight++;
      this.#decode(job.logicalId, job.priority).then(
        clip => {
          this.inflight--;
          job.resolve(clip);
          this.#drain();
        },
        error => {
          this.inflight--;
          job.reject(error);
          this.#drain();
        },
      );
    }
  }

  async #decode(logicalId, priority) {
    const resourceId = String(this.resolveResourceId(logicalId) ?? logicalId);
    const record = this.assetRuntime.registry?.get?.(resourceId);
    const hash = record?.hash != null ? String(record.hash) : 'raw:' + resourceId;
    const existing = this.byHash.get(hash) || this.pendingHashes.get(hash);
    if (existing) {
      const clip = await existing;
      this.#alias(logicalId, clip);
      return clip;
    }
    const work = this.#decodeNew(hash, resourceId, priority);
    this.pendingHashes.set(hash, work);
    try {
      const clip = await work;
      this.#alias(logicalId, clip);
      return clip;
    } finally {
      this.pendingHashes.delete(hash);
    }
  }

  async #decodeNew(hash, resourceId, priority) {
    const buffer = await this.assetRuntime.load(resourceId, { retain: true, priority });
    const clip = new AudioClip({
      logicalId: resourceId,
      resourceId,
      hash,
      buffer,
      pcmBytes: pcmBytesOf(buffer),
      duration: buffer?.duration ?? 0,
      channels: buffer?.numberOfChannels ?? 0,
      sampleRate: buffer?.sampleRate ?? 0,
    });
    clip.lastUsed = this.now();
    this.byHash.set(hash, clip);
    this.memoryBytes += clip.pcmBytes;
    this.#evict();
    return clip;
  }

  #alias(logicalId, clip) {
    if (!this.clips.has(logicalId)) this.clips.set(logicalId, clip);
    if (!this.refs.has(logicalId)) this.refs.set(logicalId, 0);
  }

  #evict() {
    while (this.memoryBytes > this.memoryBudget) {
      const usage = new Map();
      for (const [logicalId, clip] of this.clips) {
        const refs = this.refs.get(logicalId) || 0;
        usage.set(clip, (usage.get(clip) || 0) + refs);
      }
      const candidates = [...this.byHash.values()]
        .filter(clip => (usage.get(clip) || 0) === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      if (!candidates.length) break;
      const clip = candidates[0];
      this.memoryBytes = Math.max(0, this.memoryBytes - clip.pcmBytes);
      this.byHash.delete(clip.hash);
      for (const [logicalId, mapped] of [...this.clips]) {
        if (mapped === clip) { this.clips.delete(logicalId); this.refs.delete(logicalId); }
      }
      try { this.assetRuntime.release?.(clip.resourceId); } catch { /* runtime may be gone */ }
    }
  }
}
