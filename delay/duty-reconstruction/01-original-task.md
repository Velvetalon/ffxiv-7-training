# Original Task Package

## Original User Instruction

> 重新执行副本重建任务，把所有副本/未公开地图接入地图。已有的光照、音效等等系统同时建立。在大地图上有明确入口的地图需要创建对应的传送点。且在传送菜单内的副本列表中展示所有副本地图。

## Follow-up Requirement That Changed The Investigation

The user challenged the first interpretation after seeing that 942 territories were excluded:

> 不对。至少有一批提交是重建了所有副本地图，没有么？

The user then asked what the exclusion meant, whether those territories had teleport lists, and required the reconstruction to be repeated with all duties and non-public maps.

## Later Official-name Requirement

> ff14有个灰机wiki，有全地图的中英文对照。去那上面查正式译名

Names must be sourced from Huiji Wiki structured/evidence pages or the client's official localized source tables. Do not invent translations. Wiki Instance IDs are not ContentFinderCondition IDs.

## Settled Scope Correction

The initial interpretation that 942 excluded TerritoryType records meant 942 new scenes was wrong. The authoritative interpretation is:

- Existing public world scenes: 65.
- Old world-catalog excluded TerritoryType records: 942.
- Current-client-only non-public territories on new resource roots: 130.
- Duty/hidden territory records represented in the menu: 1072.
- Unique new resource roots to rebuild: 531.
- Final runtime scene count after merging roots: 596.
- Fifteen current-only variants already share public roots and are not duplicated as new duty scenes.

This correction is encoded in config/duties/catalog-summary.json and supersedes the old checkpoint template criterion that mentioned 1007 scenes.

## Non-negotiable Boundaries

- Preserve the existing 65 public maps and their immutable manifests/assets.
- Do not modify or deploy the main site at /ff14-web/.
- Preview remains isolated at /ff14-web-babylon-preview/.
- Never fabricate entrance coordinates, lighting values, collision geometry, or playable audio.
- BGM_Null and source-confirmed empty BGM situations are valid no-playback outcomes, not extraction failures.
- Keep generated raw/stage/packed assets and other large work/ outputs out of Git.
- Do not overwrite or delete shared COS/CDN objects. New assets must be additive and immutable.
- Online verification must be content-level; HTTP 200 alone is not evidence because the host has a catch-all route.
