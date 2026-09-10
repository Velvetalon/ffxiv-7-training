# Audio Sources

This document records the source and confidence of audio data used by the
browser audio runtime. The extractor is offline and read-only: it calls the
existing `tools/map-tools/MapExtract.cmd raw` command for client files and
does not scan an installation or copy client files into Git.

## Confirmed Client

The source client was the character-agent verified installation:

- client version: `2026.09.01.0000.0000`;
- client path: `G:\WeGameApps\rail_apps\ffxiv(2000340)` (not embedded in publish manifests);
- raw boundary: `G:\FFXIV-MapTools\MapExtract.cmd raw`;
- SCD parser: local Lumina checkout, version `2.4.2`.

The territory lookup was verified against the installed client's EXH/EXD
rows by the extractor's typed raw-sheet probe. `TerritoryType.BGM` is a
`BGMSituation` row, not a direct BGM row. The daytime chain is:

| Scene | TerritoryType | BGMSituation | BGM row | Client SCD | State |
| --- | ---: | ---: | ---: | --- | --- |
| `gridania` | 132 | 1003 | 6 | `music/ffxiv/BGM_Town_Gri_Day.scd` | Confirmed, HCA decoded by VGAudio |
| `limsa` | 129 | 1020 | 25 | `music/ffxiv/BGM_Town_Lim_Day.scd` | Confirmed, OGG emitted |
| `w1t1` | 130 | 1035 | 44 | `music/ffxiv/BGM_Town_Uru_Day.scd` | Confirmed, OGG emitted |

The territory IDs and scene roots are also recorded in
`tools/map-tools/data/TerritoryType-7.0.csv` and
`tools/map-tools/world-catalog.json`. The BGM/BGMSituation column layout is
cross-checked with the source-derived `xivapi/ffxiv-datamining` tables; the
installed-client raw rows remain authoritative for the current version.

The Limsa extraction produced this playable asset:

- resource: `audio.scd.music_ffxiv_bgm_town_lim_day_scd.a0`;
- file: `public/sandbox/audio/a5a3963263e1b3c8f57979d4c7600651b99bcce20595fe33368d4ea38dbe2562.ogg`;
- SHA-256: `a5a3963263e1b3c8f57979d4c7600651b99bcce20595fe33368d4ea38dbe2562`;
- source loop: 2.595736961451247 to 169.4064172335601 seconds;
- source format: Ogg Vorbis, 2 channels, 44.1 kHz.

The same run produced the other two city BGM assets:

- Gridania: `public/sandbox/audio/9d76ca0f463403d5baef05283e98c586fcb190a620ba94d41bf0b04deffd7cc1.ogg`, HCA decoded by VFXEditor's `VGAudioCli` and encoded with `oggenc2`, loop 29.35 to 311.22 seconds.
- Ul'dah: `public/sandbox/audio/2c086be7c1180be458ea8f41ecaed5d67ec6f8f66d42b7bdd138e9aae653e61a.ogg`, Ogg Vorbis, loop 2.37 to 145.51 seconds.

The complete extraction manifest is
`public/sandbox/audio/audio-source-manifest.json`. It includes source SCD
path, sound/audio indices, hash, MIME, channel/rate and loop metadata.

The one-pass EXD-only catalog for all 65 scenes is
`public/sandbox/audio/scene-bgm-catalog.json`. It is a mapping/provenance
artifact. The native daytime batch resolves all 65 scenes to 46 unique
published daytime BGM resources; the resolver follows BGMSwitch subrows and
can chain a switch target back through BGMSituation before looking up BGM.
The current batch resolves all 65 scenes to 46 unique daytime SCD resources;
17 scenes intentionally resolve to `BGM_Null` (confirmed no playback), not
failures.

For the representative `f1f1` (Central Shroud) `BGM_Null` case, a raw
`sound.lgb` plus its three `bgcommon/env/sound/.../*.essb` files were checked.
They reference weather/wind/water `bgcommon/sound/.../*.scd` ambience only; no
`music/ffxiv/BGM_*` override is present in those source paths. The default-null
classification therefore remains explicit and is not silently replaced by an
ambient loop.

## SCD Sound Effects

The city `sound.lgb` files resolve to real `bgcommon/sound/.../*.scd`
environment sources. Lumina decodes Ogg Vorbis payloads and the extractor
wraps MS-ADPCM payloads in a valid RIFF/WAVE fmt chunk, preserving their
source encoding rather than synthesizing replacement tones.

The extractor also accepts direct action/VFX SCD paths. The extraction run
used the known client path `sound/vfx/ability/se_vfx_abi_berserk_c.scd` as a
converter smoke fixture and emitted a real MS-ADPCM WAV. This fixture is not
claimed as a mapping for a local demo action.

`Action -> SkillDefinition -> SoundID` mappings remain Unknown until an
Action EXD/EXH row and its SCD source are verified together. UI labels,
keyboard bindings and guessed filename patterns are intentionally not used as
sound IDs. The runtime already accepts the future `manifest.actionSfx` table
and `playAction(skillDefinition)` / `playSfx(soundId)` calls.

`tools/audio-tools/probe-actions.ps1` reads the installed Action EXD (Chinese
Simplified locale for this client) and writes
`public/sandbox/audio/action-source-manifest.json`. It records verified numeric
Action IDs, localized names, action category, cast timeline, cast VFX, hit
timeline and explicit Unknown provenance for SoundID and asset paths. The
current generated candidate set matched 365 rows across all semantic actions
in `src/combat/data.js`; duplicate localized rows are retained because the same
name can have multiple historical/variant Action IDs.

## HCA Current Music

The installed Gridania music uses `dataType=26`, the HCA codec with `comp`,
`loop` and `ciph` chunks. The open-source VFXEditor SCD parser documents the
HCA block cipher and its bundled `VGAudioCli.exe` decodes the resulting HCA
stream to WAV. The extractor requires `-VGAudio` for this path and records the
converter in the resource metadata; it never publishes raw ciphertext.

## Research References

- [Meddle](https://github.com/PassiveModding/Meddle): existing raw map/client extraction boundary.
- [Lumina](https://github.com/NotAdam/Lumina): community SCD parser and Ogg Vorbis decryption implementation.
- [Dalamud VFXEditor](https://github.com/0ceal0t/Dalamud-VFXEditor): open-source SCD HCA parser/cipher handling and VGAudio conversion path.
- [FFXIV datamining](https://github.com/xivapi/ffxiv-datamining/tree/1b6d74360fcb3665dd5ab2f62129144112caf0f8/csv): BGM and BGMSituation table layout used for cross-checking.
- [FFXIV Explorer SCD research](https://github.com/xivapi/ffxiv-datamining/blob/master/research/explorer_scd_files): historical SCD OGG/XOR and MS-ADPCM container notes.

These references are research inputs only; no remote audio is downloaded into
the project. Published assets must be generated from a client path supplied to
`tools/audio-tools/extract-audio.ps1` and then packed by the existing asset
pipeline.
