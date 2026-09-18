import { AssetRuntime } from '../../src/assets/AssetRuntime.js';
import { assetProfiler } from '../../src/assets/AssetProfiler.js';
import { assetDelivery } from '../../src/assets/AssetDelivery.js';
import { loadPreviewConfig } from './config.js';

export const sandboxAssetRuntime = new AssetRuntime({
  memoryBudget: 512 * 1024 * 1024,
  diskBudget: 1024 * 1024 * 1024,
  onTrace: event => assetProfiler.resource(event.event, event),
});
sandboxAssetRuntime.cache.name = 'ff14-babylon-sandbox-packs-v1';

// The published sandbox manifest and hashed packs are shared unchanged with
// the main application. GPU decoding belongs to the native Babylon actors.
export class SandboxAssets {
  constructor(runtime = sandboxAssetRuntime) {
    this.runtime = runtime;
    this.manifest = null;
    this.promise = null;
  }

  async initialize(url) {
    if (!this.promise) this.promise = (async () => {
      const config = await loadPreviewConfig();
      url ||= config.sandboxManifestUrl || '/ff14-web/sandbox/manifest.json';
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Sandbox asset manifest HTTP ${response.status}`);
      const manifest = await response.json();
      if (manifest.schemaVersion !== 1 || !manifest.resources) throw new Error('Invalid sandbox resource manifest');
      const base = new URL('./', new URL(url, location.href));
      const cdnOrigin = new URL(config.assetBaseUrl).origin;
      const cdnUrls = [...Object.values(manifest.bundles || {}), ...Object.values(manifest.resources)]
        .filter(record => record.url)
        .map(record => new URL(record.url, base).href)
        .filter(value => new URL(value).origin === cdnOrigin);
      let resolveUrl = value => Promise.resolve(value);
      if (cdnUrls.length) {
        const delivery = await assetDelivery({ ticket: '/ff14-assets/ticket', base: config.assetBaseUrl }, location.href);
        await delivery.authorize([...new Set(cdnUrls)]);
        resolveUrl = (value, options) => new URL(value).origin === cdnOrigin
          ? delivery.resolveUrl(value, options) : Promise.resolve(value);
      }
      this.runtime.configure(manifest, base, resolveUrl);
      this.manifest = manifest;
      return manifest;
    })().catch(error => { this.promise = null; throw error; });
    return this.promise;
  }

  getCharacter(appearance) {
    return Object.values(this.manifest?.characters || {}).find(character => {
      if (!appearance) return true;
      const match = character.appearanceMatch || character.appearance;
      return match?.race === appearance.race && match?.tribe === appearance.tribe && match?.sex === appearance.sex
        && (match.face === undefined || match.face === appearance.face)
        && (match.hair === undefined || match.hair === appearance.hair);
    }) || null;
  }

  get mounts() { return Object.values(this.manifest?.mounts || {}); }
  get skills() { return this.manifest?.skills || {}; }
  get sceneBgm() { return this.manifest?.sceneBgm || {}; }

  async loadCmp() {
    try {
      const config = await loadPreviewConfig();
      const url = config.sandboxManifestUrl
        ? new URL('human.cmp', new URL(config.sandboxManifestUrl, location.href)).href
        : null;
      if (!url) return null;
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch { return null; }
  }
}
