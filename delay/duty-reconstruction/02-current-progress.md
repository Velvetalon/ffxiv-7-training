# Current Progress And Evidence

Snapshot time: 2026-09-20T07:51:29Z (2026-09-20 15:51:29 Asia/Shanghai).

## Git And Workspace

- Repository: G:/UGit/ffxiv-7-training
- Branch: master
- Current HEAD before this resume commit: 0f26a0de54cde47cfbd2d146166a600624801329
- Remote origin: https://github.com/Velvetalon/ffxiv-7-training.git
- At snapshot time HEAD matched origin/master. The intended uncommitted source/data changes were present; this snapshot records them before the selective staging/commit.
- `work/`, `site-babylon-preview/`, QA screenshots, federation helpers, and D:/Cache outputs are intentionally outside Git.
- The local resume coordinator completed all 129 previously missing packages. All 531 `work/duty-build/full/packed/<sceneId>/package-state.json` files have status `complete`.

## Settled Content Scope

- Existing public scenes: 65
- Old excluded territory records: 942
- Supplementary current-only territories: 130
- New resource roots/scenes: 531 / 531 package-complete
- Full runtime scenes after root merge: 596
- Duty records: 1,072
- Source-verified physical entrances: 18
- Entrance aliases: 18; unmatched entrances: 0
- Content Finder linked records: 799

Generated category totals remain: Alliance 24, Dungeon 168, Event 171, High end 44, Housing 12, Internal 41, Other instance 275, PvP 51, Raid 25, Trial 261. The authoritative source is `config/duties/catalog-summary.json`; do not hand-edit totals.

## Names

The tracked catalog reports 422 duty-title matches and 279 geography-title matches. `tools/map-tools/data/duties/wiki-names.json` contains 427 duty rows and 206 geography rows; the catalog tracked-match total can be lower than raw row count and must be regenerated from source rather than edited.

Eight current records still have no official place name: m5e1, k5e2, h1i1, h1i2, h1i3, h2i1, h2i2, h2i3. Their source rows have zero PlaceName/Map references. Do not invent formal titles.

## Geometry And Lighting

All 531 new-resource-root package states are complete. Their final runtime status is recorded in `config/duties/duty-lights.json`: 523 scenes parsed successfully and 8 are explicitly parser-unavailable. The parser-unavailable scene IDs are a2e2, a2fa, a2fd, o1a1, o1fa, r1e2, s1b7, and z1j1.

Lighting is per-scene routed and served. `preview/babylon/World.js` lazily fetches `extracted/duty-lights/<sceneId>.json`; the Vite server/build emits those files plus `manifest.json`. Missing or parser-unavailable payloads fall back to the existing environment system.

## Audio

- Source audio resources: 106 distinct files (89 OGG and 17 WAV; 133 manifest resources identify OGG MIME and 17 identify WAV MIME, including shared reuse).
- Runtime resource references: 150 `audio` entries in `public/sandbox/manifest.json`.
- Scene BGM mappings: 596.
- Additive sandbox output: 85 immutable packs in `public/sandbox/packs/*.aethpak`, 546,689,506 bytes total.
- New sandbox entry JSONs from this task: `public/sandbox/sandbox_397cfdd112141368d960caa46ad1a77c2a2c4a1eb38ad924aca4c5832e1a3fc1.json` and `public/sandbox/sandbox_fbfee4f9b21c2709bb1b6b5304a39cf726b816d173dbef250512559e3825d6c5.json`.
- Existing character, mount, skill, action SFX, and public-scene mappings are preserved in the additive release.

## Federated QA Release

The historical release at `D:/Cache/duty-asset-pipeline/union-596-v2` is not present on this machine. Local regeneration is possible from `G:/WeGameApps/rail_apps/ffxiv(2000340)`; reference analysis completed under `D:/ffxiv-duty-asset-pipeline/analysis`, while bundle output remains in progress under `D:/ffxiv-duty-asset-pipeline/packed-correct`.

- Release ID: duty-full-20260918T205414Z
- Maps: 596 (531 hidden plus 65 public)
- Publish files/routes: 21,805
- Catalog: `D:/Cache/duty-asset-pipeline/union-596-v2/catalog_merged.json`
- Static preview root: `D:/Cache/duty-asset-pipeline/union-preview-v2`
- The release summary records full SHA-256/size verification of every published file, exact catalog-to-manifest checks, and no ID/path/hash conflicts.

## Visual QA Evidence

The runtime evidence is not a linear 180-scene completion. It spans corrected runs and must be interpreted from per-run state/summary files, not from banners.

- Shard 1 v3: 53/60 actual runtime screenshots and 7 failures. Failures were c1w1, c1w3, e3f1, e3f3, f1f2, h1m2, and g3fb. Six c1/e3/f1/h1 failures showed gzip payload misparse before the fixed federation server was used; g3fb reported `bootstrap produced no Babylon geometry`.
- Shard 2 v4: 60/60 captures with 58 ready, n4f1 interaction-unconfirmed, and n5r9 bootstrap/readiness timeout. Evidence: `work/qa/visual-acceptance/run-v4/shard-2/batch-log.txt`.
- Shard 3 v5: complete, 60/60 runtime-ready states and screenshots, using the fixed union federation server on port 4533. Evidence: `work/qa/visual-acceptance/run-v5/shard-3/summary.json` and `shots/`.
- The later shard-1 retry in `work/qa/visual-acceptance/run-v5/shard-1-retry` used the fixed server, but its own canvas-evaluation helper had an out-of-scope-variable bug (initially `sampledNonblack`, later `sampledNonzeroAlpha`); it therefore did not upgrade shard-1 evidence. Its g3fb attempts reproduced no geometry in both repeats. Resume with the corrected helper.
- Direct reference metadata covers 180 files: 69 matches and 111 with reference status `none`. Xivapi duty banners are name-matched art, not runtime screenshots, and do not satisfy image scoring.
- The historical `work/qa/visual-acceptance` screenshots/scripts are not present locally. Rebuild focused QA from the installed client and regenerated local release before closing SC-004.
- Local focused browser validation passed for public scene `e3t1` with bundled Node 24: map imported, navigation ready, FFXIV character/NPC runtime state ready.

## Commit/Push Validation

Before selective staging, these checks passed in the working tree:

1. `node --check scripts/assets/build-pipeline.mjs`
2. `node --check scripts/assets/bundle-planner.mjs`
3. `node --check preview/babylon/World.js`
4. `node tests/duties/runtime.test.mjs`
5. `node tests/audio/run.mjs` (5 tests passed)
6. `node tests/audio/public-entry.mjs` (5 tests passed)
7. `npm run build:babylon` completed in 2m10s after redirecting npm cache to `work/npm-cache`; the default C:\ cache failed with UNKNOWN mkdir errno -4094.

Deployed to the main site /ff14-web/ on 2026-09-20 by explicit user authorization.

- Release: 20260920T091500Z-9f9e6929, previous releases/20260910T230855Z-v3.
- Archive SHA-256: b62ec0ce3a2f6379af4e84b64d73be501d1e4eb468500ac871f30e14f4fac838.
- Code commits: 624ff1032 (main-site duty entrances, BASE_URL VFX catalog, duties build copy) and 9f9e69291 (ticket sidecar readiness wait).
- Fast Validation before release: PASS, smoke 65/65, representatives 4/4.
- COS: 35 sandbox objects all already present (35 skipped, 0 uploaded); current.json untouched.
- Post-deploy content checks: index 200 with title Aetheryte; /ff14-web 308; /api/healthz 200; /ff14-assets/healthz 200; ticket bootstrap 200.
- Post-deploy live browser check: app imported e3t1, FFXIV character/NPC runtime ready, zero page errors.
- Live duty menu renders 1072 entries in 9 categories with 21 enterable public-scene duties. The 531 hidden maps are NOT published to the CDN, so their duties remain non-enterable online.

## Resume Update 2026-09-20

- `build_full_runtime_catalog.py` generated 596 scenes and refreshed `duty-catalog.json` to 842 hidden built records plus 230 public-scene records carrying the older `planned` marker; this is a status-label gap, not missing geometry.
- Fixed runtime-catalog bases to use `os.path.relpath`, so custom output locations cannot point public scenes at `work/public`.
- Fixed no-collision fallback spawn generation to use model instance translations when layout translations are absent; `g3fb` and `n4gb` must be regenerated and re-analyzed before accepting bootstrap coverage.
- Local reference analysis completed: 596 scenes, 277,566 resources, 51,447 materials, 55,299,744,787 resource bytes, 35 material-without-sampler warnings.
- Bundle planner was first stopped after an invalid `--expected-connections 0` attempt; the correct 145-connection reuse run is incomplete. Keep all D: outputs out of Git.

## Full 596-Scene Release 2026-09-21

The main site `/ff14-web/` now serves the native Babylon client for all 596 scenes. Three.js is no longer the main entry.

Release: `20260920T194027Z-55619b7f`; previous `releases/20260920T091500Z-9f9e6929`.

* Code freeze: `c9198082a8227794af015caa1f5e4a0b4c780c24` (pushed to origin/master).
* Archive: 5,924,122 bytes, SHA-256 `bae61c84799237b8d23a66bc9144b36c8f50c8a36c449de154963ce3e49679fa`.
* World release: `duty-full-20260920T052743Z`, 23,039 objects (22,442 packs + 596 map manifests + 1 catalog), from `D:/ffxiv-duty-asset-pipeline/collision-596`.
* Sandbox release: `sandbox-fbfee4f9b21c2709`, 85 objects, 84 bundles, 596 scene BGM mappings.
* Ticket manifest: 23,124 objects. `MAX_MANIFEST_ASSETS` raised from 20,000 to 50,000.
* COS: 20,969 objects uploaded (50,690,597,044 bytes), 2,155 skipped (6,720,268,465 bytes), zero failures; `current.json` untouched.

### Verification evidence

* Fast Validation (Babylon, 596 scenes): smoke 596/596 PASS, representatives 4/4 PASS, status PASS.
* Eleven risk scenes re-tested individually and all PASS: a2e2, a2fa, a2fd, g3fb, n4gb, o1a1, o1fa, r1e2, s1b7, x6f2, z1j1.
* Live `/ff14-web/build-info.json`: engine Babylon.js 9.26.0, mapCount 596, threeModules 0, appBase /ff14-web/.
* Live `/ff14-web/extracted/active.json`: 596 scenes, runId duty-full-20260920T052743Z, ticket mode.
* Live `/ff14-web/duties/catalog.json` 1072 entries, entrances 18, VFX definitions 20, duty-lights manifest 531 scenes (523 complete + 8 parser-unavailable).
* Live `/ff14-web` 308, `/api/healthz` 200, `/` 200, `/ff14-assets/healthz` 200, `/ff14-assets/ticket?mode=batch` 200.
* Live Babylon browser check on hidden duty scenes: a2d1 (1714 meshes, 390 placements), x6f2 (4621 meshes, 4419 placements), n4gb (1880 meshes, 473 placements) all isImported=true, navigation=true, zero page/console errors.
* Live duty menu renders 1072 entries across 22 pages.

### Known limitations carried forward

* Babylon `SOURCE_LIGHT_BUDGET = 4` admits only the four brightest source lights per scene out of ~325 average; per-scene source lighting is therefore partial by design, not complete.
* The Three.js runtime never received per-scene LGB local lights; that gap is now moot for the main site but the old Three.js path is retained in source.
* 8 hidden scenes remain lighting parser-unavailable and fall back to the existing environment system.
* 20 AVFX definitions are runtimeStatus NOT_TESTED / reviewStatus PENDING; only runtime lifecycle is tested.
