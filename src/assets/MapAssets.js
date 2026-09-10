import { AssetRuntime } from './AssetRuntime.js';
import { assetDelivery } from './AssetDelivery.js';
import { installThreeDecoders } from './ThreeDecoders.js';
import { assetProfiler } from './AssetProfiler.js';

let initializing;
let delivery;
const mapManifests = new Map();
export const mapAssetRuntime = new AssetRuntime({
  memoryBudget: 768 * 1024 * 1024,
  diskBudget: 1024 * 1024 * 1024,
  onTrace: event => assetProfiler.resource(event.event, event),
});
installThreeDecoders(mapAssetRuntime);
globalThis.__ASSET_RUNTIME__ = mapAssetRuntime;

export async function initializeMapAssets(active, root, id) {
  if (!active.assetPipeline) return null;
  mapAssetRuntime.rangePolicy = active.assetPipeline.rangePolicy || {};
  if (!initializing) initializing = (async () => {
    delivery = await assetDelivery(active.assetPipeline, new URL(root, location.href).href);
    assetProfiler.mark('registry:start');
    const response = await fetch(delivery.manifestUrl);
    if (!response.ok) throw new Error(`Asset manifest HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.resources) mapAssetRuntime.configure(manifest, delivery.base, delivery.resolveUrl);
    return manifest;
  })().catch(error => { initializing = null; throw error; });
  const catalog = await initializing;
  if (catalog.resources) return catalog;
  const entry = catalog.maps[id];
  if (!entry) return null;
  if (!mapManifests.has(id)) mapManifests.set(id, (async () => {
    const url = await delivery.resolveUrl(new URL(entry.manifest, delivery.base).href);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Map registry HTTP ${response.status}`);
    const manifest = await response.json();
    mapAssetRuntime.configure(manifest, delivery.base, delivery.resolveUrl);
    if (delivery.authorize) await delivery.authorize(Object.values(manifest.bundles).map(bundle => new URL(bundle.url, delivery.base).href));
    assetProfiler.mark('registry:ready', { resources: Object.keys(manifest.resources).length });
    return manifest;
  })().catch(error => { mapManifests.delete(id); throw error; }));
  return mapManifests.get(id);
}
