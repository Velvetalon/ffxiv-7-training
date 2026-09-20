export const APP_BASE_PATH = '/ff14-web/';
export const DEFAULT_MAP_ID = 'e3t1';
// Kept as a compatibility export for existing preview checks.
export const MAP_ID = 'e3t1';
export const CACHE_NAME = 'ff14-babylon-main-packs-v2';

export function requestedMapId(config, locationHref = location.href) {
  const requested = new URL(locationHref).searchParams.get('scene');
  const maps = config.maps || {};
  if (requested && maps[requested]) return requested;
  if (config.defaultMapId && maps[config.defaultMapId]) return config.defaultMapId;
  if (maps[DEFAULT_MAP_ID]) return DEFAULT_MAP_ID;
  return Object.keys(maps)[0] || DEFAULT_MAP_ID;
}

export async function loadPreviewConfig() {
  const url = new URL('app-config.json', new URL(import.meta.env.BASE_URL, location.href));
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Preview configuration HTTP ${response.status}`);
  const config = await response.json();
  const mapId = requestedMapId(config);
  const map = config.maps?.[mapId];
  if (!map) throw new Error('Preview configuration contains no selectable maps');
  return {
    ...config,
    mapId,
    map,
    profile: config.profiles?.[mapId] || config.profile || { samples: [], source: { evidence: 'missing-profile' } },
  };
}
