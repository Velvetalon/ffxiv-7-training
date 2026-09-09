# Offline FFXIV PAP/SKLB animation decode proof

Status date: 2026-09-09

## Result

A real installed-client PAP/SKLB pair was decoded fully offline, without loading or attaching to the game process and without a proprietary Havok SDK.

The proof decodes the PAP's `hkaSplineCompressedAnimation` into per-frame, per-track local translation/rotation/scale samples, applies its `hkaAnimationBinding.transformTrackToBoneIndices`, combines those tracks with the matching SKLB hierarchy/reference pose, writes an animation-only GLB, loads that GLB with Three.js `GLTFLoader`, and advances it with `Three.AnimationMixer`.

This proves the missing layer can be solved with open-source components. It does not prove support for every FFXIV Havok animation codec or every PAP/SKLB generation.

## Real client fixtures

Installed client, read-only:

`FFXIV_CLIENT` (the installed client used for the recorded proof; not required by the deployed site)

Client version:

`2026.09.01.0000.0000`

Extracted through the existing, unmodified `MapExtract.cmd raw` command:

| Virtual path | Local fixture | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `chara/human/c1101/skeleton/base/b0001/skl_c1101b0001.sklb` | `animation-lab/fixtures/skl_c1101b0001.sklb` | 24,554 | `EB9E6BC965BBFF3F961FE62E9CBEEF2EE0CC3E01EBEF7F13E4B7AA342DE3D410` |
| `chara/human/c1101/animation/a0001/bt_common/emote/joy.pap` | `animation-lab/fixtures/joy.pap` | 62,848 | `B55E6554FCAECFCA127C07C4D44F945874FA8ACB43DD8599FDFEBA958076E6FA` |

PAP wrapper evidence:

- version `0x00020001`;
- one animation named `cbem_joy`;
- human/model ID `1101`;
- Havok index `0`;
- embedded payload offset `0x42`, length 62,430 bytes;
- footer/timeline length 352 bytes.

SKLB wrapper evidence:

- version `0031`;
- embedded Havok payload offset `0x160`, length 24,202 bytes.

Both embedded payloads begin with Havok binary-tagfile magic `CAB00D1E D011FACE`.

## Open-source decode path

### Binary tagfile graph

`exyorha/hkxparse`, commit `7328d2ca732bc418d995528068b937cba065e3af`, dated 2020-07-24, MIT license.

Relevant implementation:

- `hkxparse/hkxparse/HKXTagfileParser.cpp`
- `hkxparse/include/hkxparse/TagfileTypes.h`
- `hkxparse/include/hkxparse/HKXTypes.h`

The parser recognizes the exact fixture magic and accepts binary tagfile versions 3 and 4. It successfully materialized the real object graphs, including references, arrays, skeleton reference-pose values, binding arrays, and the compressed animation byte array.

Generated evidence:

- `animation-lab/skeleton-dump.txt`
- `animation-lab/joy-dump.txt`
- `animation-lab/skeleton-c1101.json`

The direct animation skeleton contains 101 bones with matching parent, name, and reference-pose array lengths. Root bone 0 is `n_root`. The SKLB also contains mapper skeletons; the direct skeleton referenced by its `hkaAnimationContainer` is the 101-bone target used by this proof.

`hkxparse` labels the tagfile's 12-float reference-pose value as `Matrix3`. Semantically, the three vectors contain translation, quaternion rotation, and scale; this interpretation is validated by identity root values and plausible child reference transforms.

### Spline decompression

`PredatorCZ/HavokLib`, commit `ef5d5c6f5ab8d7f32cb4e8983300b8db61e4dc6b`, dated 2026-03-06, GPL-3.0 license.

Relevant implementation:

- `source/hka_spline_decompressor.cpp`
- `source/hka_spline_decompressor.hpp`
- `source/packfile/hka_animation_spline.cpp`
- `toolset/gltf/hk_to_gltf.cpp`

HavokLib implements the spline block masks, quantized vector/quaternion readers, NURBS spline evaluation, and local `hkQTransform` sampling. Its own loader explicitly does not support these old tagfiles, so the lab bridges `hkxparse`'s parsed fields and byte array into HavokLib's decompressor.

The decoded PAP reports:

| Field | Value |
| --- | ---: |
| Class | `hkaSplineCompressedAnimation` |
| Duration | 3.833333 seconds |
| Frames | 116 |
| Transform tracks | 92 |
| Blocks | 5 |
| Maximum frames/block | 24 |
| Frame duration | 0.033333 seconds |
| Binding skeleton | `c1101_0:mdl:n_root` |
| Binding entries | 92 |

Proof output:

- `animation-lab/joy-tracks.csv`
- 10,672 local TRS samples: 116 frames × 92 tracks;
- SHA-256: `0A0F359AA0A3495C93ACBCCE970684B4897659C8B954B18A2BF129E368B277C4`;
- zero non-finite components;
- raw decompressed quaternion norm range `0.999157..1.0`, consistent with quantized quaternion data.

The GLB writer normalizes quaternion outputs before storage.

## Three.js-playable artifact

`animation-lab/cbem_joy.animation.glb`

- 557,968 bytes;
- SHA-256: `B4C9C7F7C5914746F716F5261C79A239DEC8BFA78D9ED84C4EB5A12DB34151CF`;
- 101-node skeleton hierarchy;
- one clip named `cbem_joy`;
- duration `3.8333330154418945` seconds;
- 276 Three.js keyframe tracks: position, quaternion, and scale for each of 92 mapped bones;
- 116 keys per track.

Validation used the already installed Three.js 0.180.0 package read-only through `animation-lab/verify_three.mjs`. `GLTFLoader` loaded the file successfully. `AnimationMixer.setTime(1)` changed 85 node transforms relative to time zero, proving the clip binds and evaluates rather than merely parsing as metadata.

The GLB is intentionally animation-only: it contains nodes and real animation channels but no mesh or `skin`. To animate a separately exported model directly, its node names/hierarchy/rest pose must match, or a subsequent packaging/retargeting step must copy these channels onto that model's node indices and skin.

## Build/runtime prerequisites used

- Windows x64;
- Visual Studio 2019 C++ compiler 14.29 already installed locally;
- Python 3.10.5;
- Node.js 16.14.2 for the Three.js load/mixer check;
- no Havok SDK;
- no FBX SDK;
- no live game hooks or process injection.

Lab programs:

- `inspect_fixtures.py`: validates wrappers and writes embedded tagfiles;
- `hkx_dump.cpp` / `hkx_dump.exe`: minimal `hkxparse` object dumper;
- `spline_probe.cpp` / `spline_probe.exe`: tagfile-to-HavokLib bridge and local-TRS sampler;
- `build_animation_glb.py`: skeleton extraction and animation-only GLB writer;
- `verify_three.mjs`: Three.js loader and mixer validation.

## Proprietary route intentionally rejected

`ilmheg/MultiAssist`, commit `2533413589f8e3e5ef39b500afb2ac95fb8529ff`, dated 2022-04-27, accurately documents the PAP/SKLB wrapper-stripping and animation/binding selection process. Its `animassist.exe` build requires Havok SDK 2014 and the VS2012 toolset. That route was not built or used, and no proprietary SDK or redistributed Havok executable was downloaded.

## Boundary and next engineering step

The former blocker was not the spline codec itself. It was the absence of a single open library connecting FFXIV's old self-describing binary tagfile to an open spline sampler. The lab bridge closes that gap for this real human animation.

Before treating this as a production extractor:

1. validate more human PAPs, especially multi-animation, facial, additive, and root-motion cases;
2. classify and dispatch other possible animation classes rather than assuming spline compression;
3. preserve or interpret `blendHint`, extracted motion, annotations, and PAP footer timeline events;
4. package channels with an actual Meddle skinned character export and verify bind/rest-space agreement;
5. test monster and demi-human native skeletons independently;
6. retain GPL-3.0 compliance if HavokLib-derived code is distributed.

Environment/VFX animation remains a separate pipeline and is not proven by this PAP/SKLB result.


## Repository scope

This report preserves the verified result of the local `animation-lab/` research workspace. The running application still uses its own character models. The prototype does not yet provide production character skinning, retargeting, or full monster animation support.
