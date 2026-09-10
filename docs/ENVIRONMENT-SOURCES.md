# Environment Sources and Confidence

This document records what the browser environment runtime is allowed to claim. It separates the FFXIV client evidence from compatibility defaults, so an attractive render is not mistaken for a decoded game setting.

## Quality Correction V2

The previous adapter discarded decoded moonlight, ambient saturation,
attenuation, additional ambient color/weight and fog color intensity. All 65
profiles now preserve these named fields. In Gridania, the source night sample
has blue moonlight at intensity `0.4`, ambient attenuation `2`, and saturation
`0.7`; daytime attenuation is `0`. These values are not newly tuned constants.

The renderer now has a separate source-colored moon light and uses the source
fog color/intensity for the background instead of a static zone tint.
Environment fill treats decoded `ambientScale` as a multiplier on the existing
browser hemisphere irradiance; it does not reinterpret that multiplier as an
absolute Three.js light intensity. The hemisphere is tinted from the active
decoded sun or moon color, with decoded saturation, and accepts the decoded
additional ambient color/weight. Fog remains a background and fog input, not
an invented source of ambient light energy. `ambientAttenuation` is retained in
the sampled runtime state but is not divided into browser lighting because no
source establishes that equation. Likewise, the decoded tone-mapping time does
not establish a browser exposure scalar, so source-driven frames retain the
zone's display exposure rather than stacking a generic night reduction.
The hemisphere approximation and half-energy ground bounce are **browser
adapter choices**, not confirmed FFXIV shader equations. Sun/moon direction
and exposure remain browser approximations. No claim of complete proprietary
sky, weather, tone-mapping or subsurface parity is made.

Numeric validation confirms the source fields reach the live light rig.
Visual comparison is still required for the v2 release; numeric changes alone
are not sufficient evidence of improved appearance.

## Confirmed

- The catalog identifies each selectable zone root from versioned 7.0 CSV inputs. For example, `gridania` resolves to `bg/ffxiv/fst_f1/twn/f1t1`; see `tools/map-tools/world-catalog.json`.
- `tools/map-tools/MapExtract/Program.cs` opens the installed client's SqPack through Meddle and its `raw` command writes the original `RawData` bytes to a caller-selected destination. It does not alter the client.
- The currently committed scene export is geometry-oriented. Its manifest explicitly says raw material and texture data are retained and GLB output is geometry-only; therefore it cannot establish a browser material, sky, fog, exposure, or lighting mapping.
- The map tool is pinned to Meddle commit `7ef61f44f82c6363465d46b46e963a054d431c16`. Meddle's own [source README](https://raw.githubusercontent.com/PassiveModding/Meddle/7ef61f44f82c6363465d46b46e963a054d431c16/README.md) identifies environment export as a supported use and credits Lumina for file structures. [Lumina's source README](https://raw.githubusercontent.com/NotAdam/Lumina/master/README.md) identifies it as a library for interacting with FFXIV game data. These are implementation-primary sources, not claims about individual Envb fields.
- `G:\WeGameApps\rail_apps\ffxiv(2000340)` was supplied explicitly and read read-only. Its `game/ffxivgame.ver` is `2026.09.01.0000.0000`. `MapExtract.cmd raw` extracted the level seeds and the printable environment references for Limsa Lower Decks (`limsa`), New Gridania (`gridania`) and Central Shroud (`f1f1`).
- `xivdev/file-formats` commit `ac1a01571fa7152d521e5d5f8af8e694915466a8`, [imhex/env.hexpat](https://github.com/xivdev/file-formats/blob/ac1a01571fa7152d521e5d5f8af8e694915466a8/imhex/env.hexpat), defines the ENVB/ENVS container and names the decoded channels/fields used below: `GlobalLighting`, `VerticalFog`, `ToneMapping`, `PackedColorIntensity`, `fogStartDistance`, and `fogFadeDistance`. The browser parser mirrors those offsets in `tools/map-tools/environment/parse_envb.py`.
- The committed source profiles contain 13 owner `1` keyframes per zone. Their global ENVB hashes are: Limsa `4b06c34073f48c3ded35837f91fdc8b3ee85d49bdfc4933449b58203ba5c6eff` (22,687 bytes), Gridania `4f24bd9334084ee0053f9dd48271cf1eb8bf07249f5790429cd79f8d5a4426e3` (22,879 bytes), and Central Shroud `a3447fe8c4d9b20155328bfe1ab59ab7eee6bcf8b1affe67ca8c569fb026af02` (30,659 bytes). The raw files remain outside Git.
- The decoded owner `1` profiles preserve the client solar color/intensity curve and vertical fog colors/distances. Limsa's owner-1 `fogDensityPercent` is `0.5`; Gridania and Central Shroud are `0.1`. This is a client-byte difference, not a hand-tuned visual value.
- `tools/map-tools/environment/batch_probe.py` completed a 65-scene reference scan against the same installed client: 65/65 scenes succeeded and 391 environment candidate references were exported. The external run manifest is `G:\FFXIV-MapTools\research\environment-probe-all-20260910\batch-manifest.json`.
- The subsequent `build_world_profiles.py` pass found one unambiguous global ENVB for every scene and decoded 65 runtime profiles, containing 6–17 source keyframes each. `src/world/environment/source-profiles.json` stores those samples, virtual source paths, hashes and raw owner IDs; `getEnvironmentProfile` now selects this data for all 65 scenes. This proves the named light/fog channel coverage, not parity for unknown sky, weather, exposure or shadow semantics.

## High-confidence inference

- A zone's level files are the appropriate evidence start point because the catalog gives the zone root and MapExtract already reads the `level/*.lvb`, `level/bg.lgb`, and `level/planmap.lgb` seeds for that root.
- `tools/map-tools/environment/probe_environment.py` extracts those exact files through the existing SqPack reader, scans only their printable `bg`/`bgcommon` references, and exports candidates containing environment-oriented terms. Its `manifest.json` means only "this path was referenced and raw-exported".
- `tools/map-tools/environment/parse_envb.py` verifies the `ENVB` magic and file size, walks `ENVS` sections and envsets using the documented relative offsets, and decodes the named keyframe fields. `tools/map-tools/environment/build_profiles.py` selects owner `1` without renaming that raw id to an unverified weather label.
- `GlobalLighting.sunlightColor`/`PackedColorIntensity.intensity`, `VerticalFog.fogColor`, `VerticalFog.fogStartDistance`, and `VerticalFog.fogFadeDistance` are carried into runtime samples. `GlobalLighting.ambientLightScale` is exposed as `ambientScale`, preserving that it is a source multiplier rather than a final Three.js light energy. `fogFar` is only an explicit adapter derivation (`fogStartDistance + fogFadeDistance`).
- Runtime `hour` is the documented keyframe `time_seconds / 3600`, wrapped to 24 hours; the original seconds value remains in each sample as `sourceTimeSeconds`.
- The generated profile samples are exposed by `getEnvironmentProfile(zoneId).samples`; the runtime may interpolate them continuously by world hour. Every sample retains `sourceTimeSeconds`, and the profile retains the client version, zone root, virtual ENVB path and SHA-256.
- Browser material response should remain Three `MeshStandardMaterial` lighting plus the existing sRGB output and ACES Filmic renderer setting until FFXIV `.mtrl`, texture, shader package, and Envb fields are separately decoded. The runtime does not mislabel the current geometry-only material output as FFXIV material parity.

## Hypotheses and deliberate non-claims

- `Envb` has now been decoded according to the cited `env.hexpat` field definitions. That does **not** prove every field's renderer meaning: packed color transfer (sRGB versus linear), sun direction, sky cubemap response, weather owner labels, material response, and shadow settings remain unknown.
- `src/world/environment/EnvironmentProfiles.js` carries the old browser fallback colors and intensities only as **project-baseline** compatibility values. They are not extracted FFXIV parameters.
- The profile's `ambientScale` is the documented `ambientLightScale` multiplier; it is not a proof of the Three.js HemisphereLight ground/sky split or final light energy. The runtime should apply it to its continuous ambient curve rather than replacing that curve. Ambient sky/ground, background sky texture and renderer exposure are intentionally left at the compatibility baseline. `ToneMapping` is retained by the parser but is not mislabeled as `exposure`.
- `EnvironmentRuntime` still derives a smooth sun direction from independent `WorldTime`. The extracted samples provide light colors/intensities and fog values; they do not establish the game's exact sun-direction curve.

## Extraction Procedure

Build the existing toolchain, then run the probe against an explicitly supplied installed client. It writes only outside the client; the suggested ignored output is under `public/extracted/sandbox/environment`.

```powershell
tools/map-tools/build.ps1
py -3 tools/map-tools/environment/probe_environment.py `
  --client 'G:\WeGameApps\rail_apps\ffxiv(2000340)' `
  --scene gridania `
  --extractor 'G:\FFXIV-MapTools\MapExtract.cmd' `
  --catalog tools/map-tools/world-catalog.json `
  --output public/extracted/sandbox/environment

py -3 tools/map-tools/environment/batch_probe.py `
  --client 'G:\WeGameApps\rail_apps\ffxiv(2000340)' `
  --extractor 'G:\FFXIV-MapTools\MapExtract.cmd' `
  --catalog tools/map-tools/world-catalog.json `
  --output 'G:\FFXIV-MapTools\research\environment-probe-all-20260910'
```

After a raw candidate is decoded with a field-level source and validation evidence, create a source-sample JSON with explicit `hour` and only proven runtime fields. Pass those samples to `EnvironmentRuntime.setSourceSamples`; the adapter interpolates them cyclically and retains `source-sample-adapter` evidence in the resulting state. The committed profiles are generated from the standalone parser; the browser does not parse binary ENVB at runtime.

The current parser/profile proof can be repeated without the installed client files in Git:

```powershell
py -3 tools/map-tools/environment/parse_envb.py `
  .\outside\genv_s1t2.envb `
  --output .\outside\genv_s1t2.json
py -3 tools/map-tools/environment/build_profiles.py `
  --scene limsa `
  --zone-root bg/ffxiv/sea_s1/twn/s1t2 `
  --territory-id 129 `
  --client-version 2026.09.01.0000.0000 `
  --envb .\outside\genv_s1t2.envb `
  --output .\outside\limsa-profile.json
```

Generate all source-backed runtime profiles from an existing reference extraction:

```powershell
python tools/map-tools/environment/build_world_profiles.py `
  --batch '<reference-extraction>/batch-manifest.json' `
  --client-version 2026.09.01.0000.0000 `
  --output src/world/environment/source-profiles.json
```
