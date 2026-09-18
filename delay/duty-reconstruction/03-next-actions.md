# Ordered Resume Actions

Execute in this order. Do not skip ahead to asset publication while geometry rebuild is still progressing.

## 1. Protect The Running Rebuild

Check for an existing coordinator with:

Get-CimInstance Win32_Process -Filter "name = 'python.exe'" | Where-Object { $_.CommandLine -match 'rebuild_hidden_maps.py' } | Select-Object ProcessId,CommandLine

If a coordinator exists, monitor it. If none exists, inspect failed chunks/logs and rerun the exact command in 02-current-progress.md. Completed package states are skipped.

Stop retrying only when all 531 package-state files are complete, or every remaining failure has a source-backed terminal reason and evidence.

## 2. Merge Structured Huiji Names

Normalize the Chinese-keyed fields in work/wiki/huiji-instance-data-current.json and merge them into the tracked Huiji name catalog. Preserve Chinese, Japanese, and English titles. Preserve the Huiji Instance ID only as page/InstanceContent-style evidence.

Never join that ID to ContentFinderCondition. Join duty titles by exact official Chinese title. Regenerate the catalog when safe, then verify:

- All 1072 records remain present.
- No formal translation is invented for the eight unnamed territories.
- Existing entrance mappings remain unchanged.
- Name and category totals are recomputed rather than hand-edited.

## 3. Build The Full Runtime Catalog

After geometry reaches a terminal state, run:

py -3 tools/map-tools/build_full_runtime_catalog.py

Expected outputs are work/duty-build/analysis-active/active.json and updated duty statuses/spawn points. Verify all 531 hidden package states and all 596 merged runtime entries. Preserve old public scene bases relative to the analysis-active file.

## 4. Integrate Lighting Lazily

Emit one source-light JSON file per scene under environment/source-lights/, then load only the active scene. Missing or parser-unavailable files return null and use the existing fallback. Keep the aggregate JSON out of the application bundle.

## 5. Package And Publish Audio Additively

Merge hidden audio into the sandbox/audio asset release while preserving public scene mappings, character/mount/skill audio, and existing object names. Publish only new immutable objects. Do not overwrite or delete shared assets.

## 6. Run The Full Asset Pipeline

Inspect current options first. Intended form:

node scripts/assets/build-pipeline.mjs --active work/duty-build/analysis-active/active.json --out work/duty-build/asset-pipeline --reuse-from work/asset-performance/packed-all-final --collision-chunks

If scripts/assets/build-pipeline.mjs lacks an --active option, add pass-through support to reference-analyzer.mjs rather than copying over the old active catalog.

## 7. Finish Runtime Integration And Local Validation

Required checks:

- Node syntax checks for changed JavaScript modules
- npm run test:duties
- npm run build:babylon
- Default-entry browser validation
- Representative hidden maps, including one no-terrain-collision case and at least one parser-unavailable lighting case such as o1fa
- Duty menu count, pagination, search, enter/leave, and return position
- All 18 entrance gates only on their canonical source scene
- Main project entry smoke once

Do not run all-map visual inspection. Fast Validation and focused samples are sufficient for this stage.

## 8. Publish Preview Additively

Publish new immutable assets first, then the isolated preview application. Never touch:

- /opt/ff14-web/current
- /ff14-web/
- shared ticket secrets
- shared COS objects
- unrelated CDN caches
- the old preview sidecar

Content-level online evidence must include preview title/build hashes/catalog counts, unchanged main-site title/hash, /api/healthz status JSON, and a random-path catch-all control.

## 9. Close The Task

Produce separate lists for verified complete, source-backed unavailable, parser/tooling failure, and intentionally unimplemented work.

Commit only source, tests, compact catalogs/evidence, and documentation. Generated packages stay in ignored work/. Push the final commit to origin/master.
