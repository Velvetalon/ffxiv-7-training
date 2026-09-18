# Current Progress And Evidence

Snapshot time: 2026-09-18 05:29:55 UTC, or 13:29:55 Asia/Shanghai.

## Git And Workspace

- Repository: G:/UGit/ffxiv-7-training
- Branch: master
- Starting HEAD for this delayed work: 48f25c16baab9522dd4b407e30412b1096936162
- Remote: https://github.com/Velvetalon/ffxiv-7-training.git
- The worktree contains the in-progress duty catalog, rebuild tools, runtime integration, lighting/audio tooling, tests, and package metadata.
- work/ is ignored and holds generated evidence and packages. It is not part of Git.

## Catalog And Names

Authoritative summary: config/duties/catalog-summary.json.

- Existing public scenes: 65
- Old excluded territory records: 942
- Supplementary current-only territories: 130
- Unique new resource roots/scenes: 531
- Full runtime scenes: 596
- Duty records: 1072
- Source-verified physical entrances: 18
- Entrance aliases mapped to canonical target scenes: 18
- Content Finder linked records: 799

Category counts:

- Alliance: 24
- Dungeon: 168
- Event: 171
- High end: 44
- Housing: 12
- Internal: 41
- Other instance: 275
- PvP: 51
- Raid: 25
- Trial: 261

Current tracked Huiji evidence in tools/map-tools/data/duties/wiki-names.json contributes 421 duty-title matches and 279 geography-title matches. Remaining records use the official localized TerritoryType/PlaceName source tables.

An additional structured Huiji fetch completed after this tracked catalog was generated:

- Evidence: work/wiki/huiji-instance-data-current.json
- Data:Instance/*.json pages fetched: 427
- Parsed entries: 427
- Missing or invalid pages: 0
- The payload uses Chinese field names such as 中文名, 日文名, 英文名, 地点, and MapID.
- This newer structured evidence has not yet been merged into wiki-names.json or the generated duty catalog. Normalize and merge it later without restarting the active geometry coordinator.

Eight current records still have no official place name:

- m5e1, k5e2
- h1i1, h1i2, h1i3
- h2i1, h2i2, h2i3

Their source rows have PlaceName and Map references to zero. Keep them identifiable by territory key and do not invent a formal map title.

## Geometry Rebuild

Coordinator command still in use:

py -3 tools/map-tools/rebuild_hidden_maps.py --client G:/WeGameApps/rail_apps/ffxiv(2000340) --work work/duty-build/full --state work/duty-build/full/rebuild-state.json --workers 4 --chunk-size 12 --package-workers 2

At snapshot time, coordinator PID 275824 was still running. Always check for an existing coordinator before invoking it again. The script skips completed package states and resumes the remainder.

State-file snapshot:

- Scene records: 531
- State complete: 176
- State failed: 18
- State queued: 337
- Package-state files on disk at the later 2026- UTC check: complete 197

The state file can lag package completion. The authoritative per-scene completion signal is work/duty-build/full/packed/<sceneId>/package-state.json containing status complete.

Early failures include chunk-cascade failures and must not be treated as final scene verdicts.

Completed probes and fixes:

- Initial smoke rebuilds passed for f1d1 and f1d4.
- Four-map parallel trial passed for a2d1, a2d2, a2d3, and a2d4.
- a2e4 passed end to end without terrain collision input because six instanced collision models supplied 1,904 source triangles.
- Terrain collision extraction is skipped when the raw root has no collision/list.pcb.
- Missing map textures are fetched even when --skip-extract is used.
- A navigation ground-plane fallback can be emitted only when neither source terrain nor instanced collision triangles exist, and it remains explicitly marked.

## Lighting

Probe outputs:

- work/duty-build/source-lights.hidden.json
- work/duty-build/source-lights-state.json
- work/duty-build/environment-probe/

Results:

- Parsed successfully: 523 / 531 scenes
- Lights: 69,207
- EnvSets: 4,887
- EnvLocations: 1,618
- Source-confirmed zero-light scenes: 23
- Explicit parser failures: 8

Parser-unavailable scenes:

- a2e2
- a2fa
- a2fd
- o1a1
- o1fa
- r1e2
- s1b7
- z1j1

Consult source-lights-state.json before classifying any remaining scene; do not derive the final unavailable list only from arithmetic.

Do not concatenate the 15.2 MB hidden-light aggregate into app-config.json. Emit per-scene lighting JSON and lazy-load only the active scene. Missing or parser-unavailable data falls back to the existing environment system and must be disclosed.

## Audio

Extraction evidence:

- work/duty-build/audio-hidden/
- work/duty-build/audio-hidden-stage/
- work/duty-build/scene-bgm-hidden.json
- work/duty-build/audio-hidden/audio-source-manifest.json

Results:

- Source chains resolved: 531 / 531
- Unique non-empty DayPaths: 91
- Extracted SCDs: 90
- Extraction errors: 0
- Scenes with playable resources: 173
- Music resources: 89
- Audio files: 88
- Audio bytes: approximately 272 MB
- BGM_Null scenes: 345
- Unknown/no-playback scenes: 13

Of the 13 Unknown cases, 12 have an empty DayPath because both source BGM IDs are zero. One points to music/ex1/BGM_EX1_Null.scd, which exists but contains zero audio tracks.

Remaining audio work is packaging and runtime integration. Do not re-extract unless the client version or catalog changes.

## Runtime Integration

Modified major files include:

- src/main.js
- src/ui/Dialogs.js
- src/core/TeleportController.js
- src/world/duties/
- preview/babylon/World.js
- preview/babylon/AssetBridge.js
- vite.babylon.config.js

Implemented or partially implemented:

- Teleport modal world/duties tabs
- Duty categories, search, and 50-item pagination
- Duty enter/leave and return stack through DutyTransport
- Duty spawn placement from scene manifest
- 18 physical entrance markers and Babylon gate meshes
- Catalog build-time emission and runtime fetch
- Teleport entry propagation
- Duty gate click and F-key handling

The previously suspected wrong gate import has been corrected in preview/babylon/World.js to import from ../../src/world/duties/entranceGateMeshes.js.

Not yet validated as a final runtime:

- Full Babylon production build
- Menu lists all 1072 records
- All built duty scenes enterable
- Planned and failed entries visible but disabled with reason
- Representative hidden-map browser loading
- Lighting and audio integration through the full asset release
