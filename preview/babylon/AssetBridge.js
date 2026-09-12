import { AssetRuntime } from '../../src/assets/AssetRuntime.js';
import { assetDelivery } from '../../src/assets/AssetDelivery.js';
import { assetProfiler } from '../../src/assets/AssetProfiler.js';
import { CACHE_NAME, MAP_ID, loadPreviewConfig } from './config.js';

let activeBridge;
export const browserAssetRuntime = new AssetRuntime({
  concurrency: 6, memoryBudget: 768 * 1024 * 1024, diskBudget: 1024 * 1024 * 1024,
  onTrace: event => activeBridge?.recordTrace(event),
});
browserAssetRuntime.cache.name = CACHE_NAME;

// Reuse CPU bytes across map changes; Babylon owns and disposes GPU objects.
export class BabylonAssets {
  constructor({ onEvent = () => {}, mapId = MAP_ID } = {}) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.profiler = assetProfiler;
    this.mapId = mapId;
    this.profiler.begin(mapId);
    this.errors = new Map();
    this.counters = { requestCount: 0, downloadedBytes: 0, cacheHits: 0 };
    this.fullyLoadedMs = null;
    this.onEvent = onEvent;
    this.runtime = browserAssetRuntime;
    this.startedAt = performance.now();
    this.phase = 'manifest';
  }

  recordTrace(event) {
    if (event.event === 'fetch' || event.event === 'fetch-range') {
      this.counters.requestCount++;
      this.counters.downloadedBytes += event.bytes || 0;
    }
    if (event.cacheHit) this.counters.cacheHits++;
    this.profiler.resource(event.event, event);
    this.onEvent(event);
  }

  async initializeForMap(mapId) {
    const config = await loadPreviewConfig();
    return this.initialize({ ...config, mapId, map: config.maps?.[mapId], profile: config.profiles?.[mapId] });
  }

  async initialize(config) {
    activeBridge = this;
    globalThis.__ASSET_RUNTIME__ = this.runtime;
    this.config = config || await loadPreviewConfig();
    this.mapId = this.config.mapId || this.mapId;
    this.scene = this.config.maps?.[this.mapId] || this.config.map || null;
    if (!this.scene) throw new Error(`Unknown Babylon preview map: ${this.mapId}`);
    this.profiler.begin(this.mapId, { territoryId: this.scene.territoryId, name: this.scene.name });
    this.profile = this.config.profiles?.[this.mapId] || this.config.profile;
    this.profiler.mark('discovery:start');
    this.delivery = await assetDelivery(this.config.assetPointer, location.href);
    const catalogUrl = this.config.catalogEntry
      ? await this.delivery.resolveUrl(new URL(this.config.catalogEntry, this.delivery.base).href)
      : this.delivery.manifestUrl;
    const catalog = await this.fetchJson(catalogUrl);
    this.catalog = catalog;
    const entry = catalog.maps?.[this.mapId];
    if (!entry?.manifest) throw new Error(`Asset catalog has no manifest for ${this.mapId}`);
    this.manifest = await this.fetchJson(await this.delivery.resolveUrl(new URL(entry.manifest, this.delivery.base).href));
    this.manifestPath = entry.manifest;
    this.config.assetVersion = catalog.releaseId || this.manifest.releaseId || this.config.assetVersion;
    this.runtime.configure(this.manifest, this.delivery.base, this.delivery.resolveUrl);
    this.map = this.manifest.maps?.[this.mapId];
    if (!this.map?.legacyManifest) throw new Error(`Map metadata is unavailable for ${this.mapId}`);
    this.legacy = this.map.legacyManifest;
    this.runtime.rangePolicy = this.config.rangePolicy || {};
    if (this.delivery.authorize) {
      await this.delivery.authorize(Object.values(this.manifest.bundles || {}).map(bundle => new URL(bundle.url, this.delivery.base).href));
    }
    this.profiler.mark('registry:ready', { resources: Object.keys(this.manifest.resources).length });
    this.phase = 'geometry';
    return this;
  }

  async fetchJson(url) {
    const response = await fetch(url, { signal: this.signal });
    if (!response.ok) throw new Error(`Asset metadata HTTP ${response.status}`);
    return response.json();
  }

  async load(resourceId, options = {}) {
    try {
      return await this.runtime.load(resourceId, { retain: false, mapId: this.mapId, signal: this.signal, ...options });
    } catch (error) {
      if (!this.signal.aborted) this.errors.set(resourceId, error.message);
      throw error;
    }
  }

  async texture(path, { preview = true, priority = 0 } = {}) {
    if (!path) return null;
    const fullResourceId = this.map.paths[path];
    if (!fullResourceId) {
      this.errors.set(path, 'Texture path absent from the shared Resource Registry');
      throw new Error(`Missing texture reference: ${path}`);
    }
    const record = this.runtime.registry.get(fullResourceId);
    const resourceId = preview && record.metadata?.preview ? record.metadata.preview : fullResourceId;
    const bytes = await this.load(resourceId, { priority });
    const selected = this.runtime.registry.get(resourceId);
    return { bytes, resourceId, fullResourceId, mimeType: selected.mimeType || selected.metadata?.mime || selected.metadata?.mimeType || 'image/png' };
  }

  plan(resourceIds) {
    this.runtime.planResources(resourceIds, this.runtime.rangePolicy);
  }

  release(resourceId) { this.runtime.release(resourceId); }

  mark(name, detail = {}) {
    if (name === 'first-render') this.profiler.firstRendered(detail);
    else if (name === 'interactive') this.profiler.interactive(detail);
    else this.profiler.mark(name, detail);
    if (name === 'fully-loaded') {
      this.phase = 'ready';
      this.fullyLoadedMs = performance.now() - this.startedAt;
    }
  }

  diagnostics() {
    return {
      mapId: this.mapId, territoryId: this.scene?.territoryId ?? this.legacy?.territoryId ?? null,
      mapName: this.scene?.name || this.scene?.fullSceneName || this.mapId,
      assetVersion: this.config?.assetVersion, mapManifest: this.manifestPath || null, cacheName: CACHE_NAME,
      phase: this.phase, elapsedMs: performance.now() - this.startedAt,
      firstRenderMs: this.profiler.active?.firstRender?.elapsedMs ?? null,
      interactiveMs: this.profiler.active?.interactive?.elapsedMs ?? null,
      fullyLoadedMs: this.fullyLoadedMs, ...this.counters,
      errors: [...this.errors].map(([resourceId, message]) => ({ resourceId, message })),
      cache: this.runtime.stats(),
    };
  }

  dispose() {
    this.controller.abort();
    if (activeBridge === this) activeBridge = null;
  }
}

export default BabylonAssets;
