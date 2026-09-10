import namesByTerritory from '../../tools/map-tools/data/world-names-zh.json' with { type: 'json' };
import regionsByTerritory from '../../tools/map-tools/data/world-regions-zh.json' with { type: 'json' };

export const SCENE_NAME_SOURCE = 'installed-cn-client:Map.PlaceName->PlaceName.Name';
export const SCENE_REGION_SOURCE = 'installed-cn-client:Map.PlaceNameRegion->PlaceName.Name';

export function sceneDisplayName(record, fallback = '') {
  const territoryId = record?.territoryId;
  return (territoryId !== undefined && namesByTerritory[String(territoryId)]) || record?.name || fallback;
}

export function sceneNameSource(record) {
  return record?.territoryId !== undefined && namesByTerritory[String(record.territoryId)]
    ? SCENE_NAME_SOURCE
    : 'manifest-or-catalog-fallback';
}

export function sceneDisplayRegion(record, fallback = '') {
  const territoryId = record?.territoryId;
  return (territoryId !== undefined && regionsByTerritory[String(territoryId)]) || record?.region || fallback;
}

export function sceneRegionSource(record) {
  return record?.territoryId !== undefined && regionsByTerritory[String(record.territoryId)]
    ? SCENE_REGION_SOURCE
    : 'manifest-or-catalog-fallback';
}
