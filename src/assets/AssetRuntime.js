import { FetchScheduler } from './FetchScheduler.js';
import { AssetCache } from './AssetCache.js';
import { ResourceRegistry } from './ResourceRegistry.js';
import { GpuUploadQueue } from './GpuUploadQueue.js';

export class AssetRuntime {
  constructor({ concurrency = 6, memoryBudget = 256 * 1024 * 1024, diskBudget, onTrace = () => {} } = {}) {
    this.registry = new ResourceRegistry();
    this.scheduler = new FetchScheduler({ concurrency });
    this.cache = new AssetCache({ budget: diskBudget });
    this.gpu = new GpuUploadQueue();
    this.entries = new Map();
    this.inflight = new Map();
    this.bundles = new Map();
    this.bundleInflight = new Map();
    this.decoders = new Map();
    this.memoryBudget = memoryBudget;
    this.memoryBytes = 0;
    this.trace = [];
    this.onTrace = onTrace;
    this.manifest = null;
    this.bundleRecords = {};
    this.resolveUrl = url => Promise.resolve(url);
    this.rangeBundles = new Set();
  }

  configure(manifest, base, resolveUrl) {
    if (manifest.schemaVersion !== 1) throw new Error('Unsupported asset manifest');
    const resolvedBase = new URL(base, globalThis.location?.href || 'http://localhost/').href;
    const resources = Object.fromEntries(Object.entries(manifest.resources).map(([id, record]) => [
      id, record.url ? { ...record, url: new URL(record.url, resolvedBase).href } : record,
    ]));
    const bundles = Object.fromEntries(Object.entries(manifest.bundles || {}).map(([id, bundle]) => [
      id, { ...bundle, url: new URL(bundle.url, resolvedBase).href },
    ]));
    this.registry.addManifest({ ...manifest, resources });
    this.manifest = manifest;
    Object.assign(this.bundleRecords, bundles);
    this.base = resolvedBase;
    if (resolveUrl) this.resolveUrl = resolveUrl;
  }

  decoder(type, decode, dispose = () => {}) {
    this.decoders.set(type, { decode, dispose });
  }

  event(detail) {
    const event = { time: performance.now(), ...detail };
    this.trace.push(event);
    if (this.trace.length > 30000) this.trace.splice(0, 5000);
    this.onTrace(event);
  }

  get(id) {
    return this.entries.get(this.registry.get(id).id)?.value;
  }

  stats() {
    return {
      resources: this.entries.size,
      inflightResources: this.inflight.size,
      decodedBytes: this.memoryBytes,
      decodedBudget: this.memoryBudget,
      pinnedBytes: [...this.entries.values()].filter(entry => entry.refs > 0).reduce((sum, entry) => sum + entry.bytes, 0),
      encodedBytes: [...this.bundles.values()].reduce((sum, entry) => sum + entry.bytes.byteLength, 0),
      pendingCacheWrites: this.cache.pendingWrites.size,
      queuedFetches: this.scheduler.queue.length,
      activeFetches: this.scheduler.running,
    };
  }

  async load(id, options = {}) {
    const record = this.registry.get(id);
    id = record.id;
    options.signal?.throwIfAborted();
    const cached = this.entries.get(id);
    if (cached) {
      cached.refs += options.retain === false ? 0 : 1;
      cached.used = performance.now();
      this.event({ event: 'resource-ready', resourceId: id, mapId: options.mapId, cacheHit: 'runtime', bytes: 0, priority: options.priority });
      return cached.value;
    }
    let work = this.inflight.get(id);
    if (work && options.priority !== undefined) {
      this.scheduler.promote(record.bundle ? `bundle:${record.bundle}` : record.id, options.priority);
      this.scheduler.promote(`range:${record.id}`, options.priority);
    }
    if (!work) {
      work = { controller: new AbortController(), clients: 0, settled: false };
      this.inflight.set(id, work);
      work.promise = this.prepare(record, { ...options, signal: work.controller.signal }).then(
        entry => { work.settled = true; return entry; },
        error => { work.settled = true; throw error; },
      );
    }
    work.clients++;
    try {
      const entry = await abortable(work.promise, options.signal);
      options.signal?.throwIfAborted();
      entry.refs += options.retain === false ? 0 : 1;
      entry.used = performance.now();
      return entry.value;
    } finally {
      work.clients--;
      if (!work.clients && this.inflight.get(id) === work) {
        // A resolved decoder is still in flight until its consumers own their
        // references; another completion must not evict it between microtasks.
        if (!work.settled) work.controller.abort();
        this.inflight.delete(id);
      }
      this.evict();
    }
  }

  async prepare(record, options) {
    const begin = performance.now();
    const dependencies = [];
    try {
      // The scheduler bounds actual fetches; dependency loading shares inflight work.
      const dependencyResults = await Promise.allSettled(record.dependencies.map(async id => {
        await this.load(id, { ...options, retain: true });
        dependencies.push(id);
      }));
      const failedDependency = dependencyResults.find(result => result.status === 'rejected');
      if (failedDependency) throw failedDependency.reason;
      const bytes = record.virtual ? null : await this.bytes(record, options);
      options.signal?.throwIfAborted();
      const decodeStart = performance.now();
      const decoder = this.decoders.get(record.type);
      const value = decoder ? await decoder.decode(bytes, record, this, options) : bytes;
      const entry = { value, refs: 0, used: performance.now(), bytes: record.runtimeBytes || record.size || 0, dependencies, dispose: decoder?.dispose };
      if (options.signal?.aborted) {
        entry.dispose?.(value);
        options.signal.throwIfAborted();
      }
      this.entries.set(record.id, entry);
      this.memoryBytes += entry.bytes;
      this.event({
        event: 'resource-ready', resourceId: record.id, mapId: options.mapId,
        requestTime: begin, readyTime: performance.now(), decodeMs: performance.now() - decodeStart,
        cacheHit: false, bytes: record.size, priority: options.priority,
      });
      return entry;
    } catch (error) {
      dependencies.forEach(id => this.release(id));
      throw error;
    }
  }

  release(id) {
    const entry = this.entries.get(this.registry.get(id).id);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    entry.used = performance.now();
    this.evict();
  }

  evict() {
    while (this.memoryBytes > this.memoryBudget) {
      const candidates = [...this.entries].filter(([id, entry]) => entry.refs === 0 && !this.inflight.has(id));
      candidates.sort((a, b) => a[1].used - b[1].used);
      if (!candidates.length) break;
      const [id, entry] = candidates[0];
      this.entries.delete(id);
      this.memoryBytes -= entry.bytes;
      entry.dispose?.(entry.value);
      for (const dependency of entry.dependencies) {
        const child = this.entries.get(dependency);
        if (child) child.refs = Math.max(0, child.refs - 1);
      }
    }
  }

  async preload(ids, options = {}) {
    let cursor = 0;
    const values = new Map();
    const worker = async () => {
      while (cursor < ids.length) {
        options.signal?.throwIfAborted();
        const id = ids[cursor++];
        values.set(id, await this.load(id, { ...options, retain: false }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return values;
  }

  async bytes(record, options) {
    if (record.bundle) {
      if (this.rangeBundles.has(record.bundle) && !this.bundles.has(record.bundle)) return this.range(record, options);
      const bytes = await this.bundle(record.bundle, options);
      return bytes.slice(record.offset, record.offset + record.length);
    }
    const canonical = new URL(record.url, this.base).href;
    return (await this.scheduler.request(record.id, attempt => this.resolveUrl(canonical, { refresh: attempt > 0 }), {
      ...options,
      onResponse: result => this.event({ event: 'fetch', resourceId: record.id, mapId: options.mapId, bytes: result.bytes.byteLength, fetchMs: result.fetchMs }),
    })).bytes;
  }

  planResources(ids, { rangeThreshold = 0, minimumSavedBytes = 0 } = {}) {
    // Range is opt-in until a benchmark supplies a threshold. Full-pack remains the default.
    const demands = new Map(), visited = new Set();
    const visit = id => {
      const record = this.registry.get(id);
      if (visited.has(record.id)) return;
      visited.add(record.id);
      if (record.bundle) demands.set(record.bundle, (demands.get(record.bundle) || 0) + record.length);
      record.dependencies.forEach(visit);
    };
    ids.forEach(visit);
    for (const [id, bytes] of demands) {
      const size = this.bundleRecords[id].size;
      if (bytes / size < rangeThreshold && size - bytes >= minimumSavedBytes) this.rangeBundles.add(id);
      else this.rangeBundles.delete(id);
    }
  }

  async range(record, options) {
    const bundle = this.bundleRecords[record.bundle];
    const key = new URL(`__asset_cache__/resource/${record.hash}`, globalThis.location?.origin || 'http://localhost/').href;
    let bytes = await this.cache.get(key);
    let cacheHit = 'disk';
    if (!bytes) {
      const canonical = new URL(bundle.url, this.base).href;
      const result = await this.scheduler.request(`range:${record.id}`, attempt => this.resolveUrl(canonical, { refresh: attempt > 0 }), {
        ...options, headers: { Range: `bytes=${record.offset}-${record.offset + record.length - 1}` },
      });
      if (result.status === 206) {
        const expected = `bytes ${record.offset}-${record.offset + record.length - 1}/${bundle.size}`;
        if (result.headers.get('content-range') !== expected) throw new Error(`Invalid asset Content-Range: ${record.id}`);
        bytes = result.bytes;
      } else if (result.status === 200 && result.bytes.byteLength === bundle.size) {
        // An origin that ignores Range still yields valid data; remember the complete pack.
        this.bundles.set(record.bundle, { bytes: result.bytes, used: performance.now() });
        this.rangeBundles.delete(record.bundle);
        bytes = result.bytes.slice(record.offset, record.offset + record.length);
      } else throw new Error(`Invalid asset range response: ${record.id}`);
      cacheHit = false;
      this.event({ event: 'fetch-range', resourceId: record.id, mapId: options.mapId, bytes: result.bytes.byteLength, fetchMs: result.fetchMs, priority: options.priority });
    }
    if (bytes.byteLength !== record.length) throw new Error(`Asset range length mismatch: ${record.id}`);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (digest !== record.hash) throw new Error(`Asset range hash mismatch: ${record.id}`);
    if (!cacheHit) void this.cache.put(key, bytes);
    this.event({ event: 'range', resourceId: record.id, mapId: options.mapId, cacheHit, bytes: bytes.byteLength });
    return bytes;
  }

  async bundle(id, options) {
    const bundle = this.bundleRecords[id];
    if (!bundle) throw new Error(`Unknown bundle: ${id}`);
    const cached = this.bundles.get(id);
    if (cached) {
      cached.used = performance.now();
      this.event({ event: 'bundle', bundleId: id, cacheHit: 'memory', bytes: 0 });
      return cached.bytes;
    }
    let task = this.bundleInflight.get(id);
    if (!task) {
      task = { controller: new AbortController(), clients: 0 };
      this.bundleInflight.set(id, task);
      task.promise = this.readBundle(id, bundle, { ...options, signal: task.controller.signal }).finally(() => {
        if (this.bundleInflight.get(id) === task) this.bundleInflight.delete(id);
      });
    }
    task.clients++;
    try { return await abortable(task.promise, options.signal); }
    finally {
      task.clients--;
      if (!task.clients && this.bundleInflight.get(id) === task) {
        task.controller.abort();
        this.bundleInflight.delete(id);
      }
    }
  }

  async readBundle(id, bundle, options) {
    const canonical = new URL(bundle.url, this.base).href;
    const cacheKey = new URL(`__asset_cache__/${bundle.hash}`, globalThis.location?.origin || 'http://localhost/').href;
    let bytes = await this.cache.get(cacheKey);
    let cacheHit = 'disk';
    if (!bytes) {
      const result = await this.scheduler.request(`bundle:${id}`, attempt => this.resolveUrl(canonical, { refresh: attempt > 0 }), options);
      bytes = result.bytes;
      cacheHit = false;
      this.event({ event: 'fetch', bundleId: id, mapId: options.mapId, bytes: bytes.byteLength, fetchMs: result.fetchMs, queueMs: result.queueMs, attempt: result.attempt, priority: options.priority });
    }
    if (bytes.byteLength !== bundle.size) throw new Error(`Bundle length mismatch: ${id}`);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (digest !== bundle.hash) throw new Error(`Bundle hash mismatch: ${id}`);
    if (!cacheHit) void this.cache.put(cacheKey, bytes);
    this.bundles.set(id, { bytes, used: performance.now() });
    // Encoded bundle cache has a separate budget from decoded CPU/GPU resources.
    let size = [...this.bundles.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
    for (const [key, item] of [...this.bundles].sort((a, b) => a[1].used - b[1].used)) {
      if (size <= 96 * 1024 * 1024) break;
      if (key !== id) { this.bundles.delete(key); size -= item.bytes.byteLength; }
    }
    this.event({ event: 'bundle', bundleId: id, mapId: options.mapId, cacheHit, bytes: bytes.byteLength });
    return bytes;
  }
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
