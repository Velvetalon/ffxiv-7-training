# Chinese Scene Names

`tools/map-tools/data/world-names-zh.json` and
`tools/map-tools/data/world-regions-zh.json` are the display mappings used by
`src/world/sceneCatalog.js` and therefore by the teleport destination list.
They contain all 65 published territory IDs; the UI does not transliterate
English IDs or fall back to an invented Chinese spelling when a territory
mapping exists.

## Source

The values were read from the installed Chinese client through Lumina's raw
Excel API using `Language.ChineseSimplified`:

- Client: `G:\\WeGameApps\\rail_apps\\ffxiv(2000340)`
- Sheet `Map`, column `TerritoryType` (column 16) selects each territory and
  column `PlaceNameRegion` (column 10) gives the region row ID while column
  `PlaceName` (column 11) gives the map-name row ID.
- Sheet `PlaceName`, column `Name` (column 0) supplies the Chinese display
  strings for both map names and regions.
- The matching client version is `2026.09.01.0000.0000`.

The reproducible probe is
`tools/map-tools/export-chinese-scene-names.ps1`. It validates the live raw
sheet headers before writing the two compact mappings and the provenance
metadata file `world-scene-names-zh.json`.

The typed Lumina row classes are intentionally not used for this extraction:
the installed client has a newer column hash than the pinned generated classes,
while the raw sheet columns remain readable and preserve the client data.

`loadSceneCatalog()` applies both mappings by `territoryId` before exposing
`SCENES`; search/filter and teleport labels consequently use the same Chinese
name and region values everywhere.
