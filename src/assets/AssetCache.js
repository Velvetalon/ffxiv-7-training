export class AssetCache {
  constructor({ name = 'aetheryte-packs-v1', budget = 512 * 1024 * 1024 } = {}) {
    this.name = name;
    this.budget = budget;
    this.disabled = false;
    this.writes = Promise.resolve();
    this.pendingWrites = new Map();
  }

  async open() {
    if (this.disabled || !globalThis.caches) return null;
    try { return await caches.open(this.name); }
    catch { this.disabled = true; return null; }
  }

  async get(key) {
    // A just-evicted memory pack may still be queued for persistence. Wait for that
    // exact write instead of treating the temporary absence as a network miss.
    await this.pendingWrites.get(key)?.catch(() => {});
    const cache = await this.open();
    if (!cache) return null;
    try {
      const response = await cache.match(key);
      return response ? await response.arrayBuffer() : null;
    } catch { return null; }
  }

  put(key, bytes) {
    if (bytes.byteLength > this.budget) return Promise.resolve();
    if (this.pendingWrites.has(key)) return this.pendingWrites.get(key);
    // Serialize only disk cache writes/evictions, never network fetches.
    this.writes = this.writes.catch(() => {}).then(async () => {
      const cache = await this.open();
      if (!cache) return;
      try {
        await cache.delete(key);
        let total = 0;
        const entries = [];
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const size = Number(response.headers.get('X-Asset-Bytes')) || 0;
          total += size;
          entries.push({ request, size });
        }
        for (const entry of entries) {
          if (total + bytes.byteLength <= this.budget) break;
          await cache.delete(entry.request);
          total -= entry.size;
        }
        await cache.put(key, new Response(bytes, {
          headers: { 'Content-Type': 'application/octet-stream', 'X-Asset-Bytes': String(bytes.byteLength) },
        }));
      } catch {
        // Cache eviction or quota failure must not prevent playing a downloaded map.
      }
    });
    const task = this.writes.finally(() => {
      if (this.pendingWrites.get(key) === task) this.pendingWrites.delete(key);
    });
    this.pendingWrites.set(key, task);
    return task;
  }
}
