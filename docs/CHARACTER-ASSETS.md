# Character and mount assets

Status date: 2026-09-10

## Result

The sandbox contains a real FFXIV character model with native MDL skin weights, a merged base/face/hair SKLB skeleton, client textures, DAT-driven colors and facial shapes, plus real idle/walk/run/joy PAP clips. It also contains a real Company Chocobo model, skeleton, ground and flight clips, and a verified rider attachment bone.

Runtime inputs are in:

- `public/extracted/sandbox/manifest.character.partial.json`
- `public/extracted/sandbox/manifest.mount.partial.json`
- `public/extracted/sandbox/characters/`
- `public/extracted/sandbox/animations/`
- `public/extracted/sandbox/mounts/`

## Primary sources

- `imchillin/Anamnesis` commit `42ab166af9677439135e6273ffa03de47faeed73`, MIT: `DatCharacterFile.cs`, `ActorCustomizeMemory.cs`, `ColorData.cs`, `DataPathResolver.cs`, `HeightEditor.xaml.cs`.
- `xivdev/Penumbra` commit `fa825caa874161f0487fe7efcb3455b824ac3031`, GPL-3.0: `RspHeightHook.cs`, `RspTailHook.cs`, `RspBustHook.cs`, `MaterialExporter.cs`.
- `Ottermandias/Penumbra.GameData` commit `7f9878b29bb68f07203d6ab7702606550a807fc3`, GPL-3.0: `CmpData.cs`, `RspAttribute.cs`, `GamePaths.cs`.
- `0ceal0t/Dalamud-VFXEditor` commit `05f6eb0cce19a6a91ae275bce609299d573914b3`, MIT: TMB C063 sound path/index/position fields and SCD structures.
- `Meddle` commit `7ef61f44f82c6363465d46b46e963a054d431c16`, GPL-3.0: MDL vertex, bone table, weight, PBD and shape parsing.
- Animation decoding sources and commits are recorded in `docs/ANIMATION-DECODE.md`.

## DAT evidence

Source file: `C:\Users\v_whcnwwang\OneDrive\codex\FFXIV_CHARA_40.dat`, read-only.

| Evidence | Value |
| --- | --- |
| Size | 212 bytes (`0xD4`) |
| SHA-256 | `15620f24f8b47cea3d421aed5bb1b1aaff199142baff4edfcfa26e06fc7d2062` |
| Magic | `0x2013FF14` |
| Version | 5 |
| Customize bytes | offset `0x10`, 26 bytes |
| Voice | 99 |
| Timestamp | `2022-12-12T07:25:31Z` |
| Description | `我的猫` |

Confirmed customize values are Miqo'te (`4`), Seeker of the Sun (`7`), feminine (`1`), face `3`, hair option `151`, height `0`, tail type `5`, and the remaining values stored in `FFXIV_CHARA_40.appearance.json`. The resulting human model family is `c0801`.

Version 5's stored checksum is preserved but not claimed as validated. Anamnesis writes an older version and its documented XOR calculation does not reproduce this file's v5 checksum.

## Character mapping

Confirmed asset paths:

- base skeleton: `chara/human/c0801/skeleton/base/b0001/skl_c0801b0001.sklb`
- face model: `chara/human/c0801/obj/face/f0003/model/c0801f0003_fac.mdl`
- face partial skeleton: `chara/human/c0801/skeleton/face/f0002/skl_c0801f0002.sklb`
- hair model: `chara/human/c0801/obj/hair/h0151/model/c0801h0151_hir.mdl`
- hair partial skeleton required by that MDL: `chara/human/c0801/skeleton/hair/h0152/skl_c0801h0152.sklb`
- tail model: `chara/human/c0801/obj/tail/t0005/model/c0801t0005_til.mdl`

The merged skeleton has 187 unique bones. The model has 11 source SkinnedMeshes (9,723 source vertices) plus two skinned lip/face-paint overlays. Every MDL blend index is resolved through its mesh-local bone table to a named SKLB bone; Three.js reports no missing skin bones.

The face MDL supplies actual customization shapes. This DAT selects and bakes `shp_brw_a`, `shp_chk_b`, `shp_eye_c`, `shp_mth_c`, and `shp_nse_d`. These are the zero-based mappings of brow `0`, jaw `1`, eyes `2`, mouth `2`, and nose `3` within the face's enumerated `a..e`/`a..c` shape sets.

`human.cmp` confirms the female Seeker height scale range `0.96..1.04`; height `0` applies `0.96` to the model root (149.7 cm in Anamnesis' physical-height table). Tail size `100` maps the confirmed `0.60..1.00` range to `1.00`. Bust `100` maps to `[1.08, 1.20, 1.184]` on `j_mune_l` and `j_mune_r`.

The DAT does not store equipment. The included `c0801/e0001` top and down models are real client display equipment, explicitly labelled as such in the manifest.

## Materials

Five actual client base textures are embedded for face skin, iris, exposed body skin, top and down equipment. Hair, face hair, and tail textures are baked from their native normal/mask TEX files using DAT hair/highlight palette values and Penumbra's documented `hair.shpk` baseline.

The glTF color factors and eye vertex colors use squared RGB, matching `FFXIVClientStructs.FFXIV.Shader.CustomizeParameter`. Left and right eye colors are assigned by eye-mesh position. The real face-paint 14 BC4 decal is extracted as `characters/facepaint-14.png` and embedded as an alpha overlay on the face model's second UV set, which the FFXIV shader metadata identifies as UV2/decal UV.

Lip color 169 is embedded as a separate UV0 overlay using the face normal texture's alpha channel. The Dawntrail shader reference identifies FACE-mode normal alpha as the lip mask, while `FFXIVClientStructs` identifies `LipColor.W` as opacity. The lip and face-paint layers are offset 0.1/0.2 mm along face normals to avoid depth fighting in Three.js.

## Animation proof

All character clips use the `c0801` direct skeleton and 97 transform tracks (291 Three.js keyframe tracks):

| State | PAP clip | Duration |
| --- | --- | ---: |
| idle | `cbnm_id0` | 2.666667 s |
| walk | `cbnm_01f_lp0` | 1.0 s |
| run | `cbnm_02f_lp0` | 0.666667 s |
| joy | `cbem_joy` | 2.666667 s |

Attaching each independent GLB clip to the skinned model by bone name changed 73, 87, 87 and 89 model bones respectively in an offline Three.js `AnimationMixer` check.

The appearance/runtime numeric proof is repeatable with `tools/character-tools/verify_character_runtime.mjs`. At idle time 1.0 it verifies effective model height remains `0.96` (no double application) and both `j_mune_l`/`j_mune_r` retain the exact `[1.08,1.20,1.184]` multiplier after the animation mixer samples its scale tracks.

## Skill animation proof

The sandbox includes one source-traced job action rather than reusing an emote. Action row 16535 (`Afflatus Misery`) references ActionTimeline row 7127, whose client key is `ability/cnj_white/abl016`. The matching real asset is `chara/human/c0101/animation/a0001/bt_common/ability/cnj_white/abl016.pap`, containing clip `cbbm_abl235`.

FFXIV stores this common job animation in the `c0101` family. Its 2.833333-second, 291-track GLB binds by bone name to the target `c0801` model and changes 89 target bones at time 1.0. `manifest.character.partial.json` publishes the resource and `skillPresentations.whm-afflatus-misery` provenance chain.

The same ActionTimeline key resolves to `chara/action/ability/cnj_white/abl016.tmb`. Its confirmed C063 entries play `SE_VFX_Abi_Whm_LilyRange_c.scd` sound 0 at TMB frame 0 and `SE_VFX_Abi_Whm_LilyRange_mt.scd` sound 0 at frame 9, alongside the caster/target AVFX entries. Lumina resolves both SCD sound records to mono MS-ADPCM audio 0. `manifest.skill-sfx.partial.json` publishes the caster cue as the SkillDefinition `soundId` and preserves the target cue as a second event at 0.3 seconds.

## Mount proof

Lumina's installed-client sheets confirm Mount row 1 (`专属陆行鸟`) has `IsFlying=1`, ModelChara row 1 (`type=2, model=1, base=1, variant=1`) and MountCustomize row 1. Its Miqo'te female scale is 85%, which is applied to the exported mount root.

Confirmed source assets:

- model: `chara/demihuman/d0001/obj/equipment/e0001/model/d0001e0001_top.mdl`
- skeleton: `chara/demihuman/d0001/skeleton/base/b0001/skl_d0001b0001.sklb`
- animations: `chara/demihuman/d0001/animation/a0001/bt_common/resident/mount.pap`

The 86-bone SKLB contains `n_mount` and `n_mount_second`. The primary rider bone's local translation is `[0.085,-0.25,0]` and quaternion is `[-0.706138,0.037007,-0.706138,-0.037007]`. Reparenting the rider to `n_mount` with zero additional offset therefore consumes the actual attach transform.

Real mount states are `cbnm_id0`, `cbnm_02f_lp0`, `cbnm_fmt_glide_lp`, `cbnm_fmt_id0`, `cbnm_fmt_takeoff`, and `cbnm_fmt_up`. Three.js binding checks changed 41-67 mount bones per clip.

## Confidence ledger

Confirmed:

- DAT byte layout and all 26 customize values.
- `c0801` family, face/hair/tail models, base and partial skeletons.
- MDL bone tables, weights, face shapes, CMP colors and RSP scaling values.
- Character and Chocobo PAP clip names, indices, durations and browser binding.
- Chocobo Mount/ModelChara/MountCustomize sheet fields and `n_mount` transform.

High-confidence inference:

- Zero-based face option to alphabetic MDL shape mapping. It is supported by the option ranges and complete ordered shape sets, but no official Square Enix symbol names this mapping.

Unknown / incomplete:

- Version 5 DAT checksum algorithm.
- Exact reproduction of the remaining proprietary skin lighting and subsurface-scattering behavior.
- Other mounted human variants beyond the confirmed c0101 shared-human rider PAP and its two exported idle/flying GLBs; see [`MOUNT-ASSETS.md`](MOUNT-ASSETS.md) for the source path and binding proof.
- Codecs other than the proven spline-compressed PAP class.
