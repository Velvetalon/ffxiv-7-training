# Content Coverage Scanner

`scripts/content-coverage.mjs` performs a deterministic, imported-only inventory of the current developer/runtime content. It reads the sandbox manifest, publish manifest, active world pointer, world catalog and Chinese names, existing `packed-all-final` map manifests, source combat definitions, and the extracted audio source manifests.

Run it with the workspace Node runtime or any modern Node 24 installation:

```powershell
npm run content:scan
node scripts/content-coverage.mjs --out work/diagnostics --console-examples 10
```

Useful overrides are `--dir PATH`, `--manifest PATH`, `--map-dir PATH`, `--runtime-smoke PATH`, and `--position-report PATH`. The CLI uses a structured parser and accepts either `--option value` or `--option=value`.

## Output

The default output directory is `work/diagnostics` (ignored by the repository). It contains:

- `summary.json`: compressed counts, scope, provenance and optional runtime evidence;
- `missing_assets.json`: confirmed missing resource IDs, local packs or dependencies;
- `invalid_mappings.json`: invalid aliases, IDs, ranges, sizes, manifest JSON or GLB JSON chunks;
- `position_outliers.json`: imported outliers from the existing all-map checker report;
- `animation_gaps.json`: expected combat presentation coverage gaps and any broken animation references;
- `mount_gaps.json`: confirmed mount model/skeleton/animation gaps;
- `audio_gaps.json`: confirmed BGM/SFX reference or bounded codec-header gaps.

Each anomaly item has the stable fields `severity`, `kind`, `resource`, `source`, `map`, and `recommendation`. Normal resources are never emitted as individual console records. `--console-examples N` prints at most 20 examples; without it, the console contains only compressed section counts and the diagnostics location.

## Interpretation

The map section reports only the imported 65-scene catalog and the 65 existing packed map manifests. `staticResolvable` means that the local manifest, explicit resource references, dependency IDs, pack ranges and local pack files were checked. It does **not** mean that a browser loaded the map. Runtime evidence is reported separately under `runtime.provenRuntimeSmoke` and is `not_run` when no dated smoke result was supplied or found.

The scanner validates explicit runtime references only. `.mdl`, `.mtrl`, `.tex`, SCD and PAP paths inside metadata are provenance and are not treated as browser resource IDs. GLB inspection reads the header and JSON chunk at its packed offset, counting materials, skins and animation clips without reading BIN/image bytes. Audio inspection is limited to local pack presence and OGG/WAV header checks; it does not decode audio.

The source combat table currently contains more actions than the four verified sandbox presentations. Those unmapped actions are classified as `warning` entries in `animation_gaps.json`; they are expected coverage gaps and do not make the scan fail. Explicitly null scene-BGM entries are recorded as source absence, not missing references. The process exits nonzero only for confirmed broken references, missing local packs/dependencies, malformed mappings, or invalid bounded binary/manifest data.

The position report is read from `work/map-position/check-map-position-all.json` when present. Its independent-reference fields and modification time are checked against the current imported inputs. A missing or stale report is reported as `not_run` or `unverified`, never as a silent zero-anomaly pass. The scanner does not rerun the position checker.

## Smoke fixtures

The built-in fixtures exercise the exit policy without a browser or a client export:

```powershell
node scripts/content-coverage.mjs --fixture missasset
node scripts/content-coverage.mjs --fixture invalidref
node scripts/content-coverage.mjs --fixture expectedgaps
```

The first two intentionally exit nonzero. The expected-gap fixture exits zero and records warning-only coverage diagnostics. Fixture files and reports stay under ignored `work/diagnostics`.
