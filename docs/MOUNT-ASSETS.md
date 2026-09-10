# Mount assets

Status date: 2026-09-10

## Company Chocobo

`company-chocobo` is Mount row 1, `ModelChara` row 1 (`type=2`, `model=1`,
`base=1`, `variant=1`). The installed client's Chinese Mount sheet confirms
`IsFlying=1`, MountCustomize row 1, Miqo'te female scale `85`, and camera
height `100`. The scale is exported as `modelScales.c0801 = 0.85`; the camera
height value is retained without guessing its browser-world unit.

Confirmed client sources:

- model: `chara/demihuman/d0001/obj/equipment/e0001/model/d0001e0001_top.mdl`
- skeleton: `chara/demihuman/d0001/skeleton/base/b0001/skl_d0001b0001.sklb`
- mount PAP: `chara/demihuman/d0001/animation/a0001/bt_common/resident/mount.pap`
- human rider PAP: `chara/human/c0101/animation/a0001/mt_d0001/resident/mount.pap`

The 86-bone mount skeleton's `n_mount` is bone 84 with local translation
`[0.085, -0.25, 0]` and quaternion
`[-0.706138, 0.037007, -0.706138, -0.037007]`. The verified browser binding
parents the rider root directly to `n_mount` with zero additional transform.
The exported GLB hierarchy already carries the source-space basis: adding an
inverse local quaternion flips the rider, so no invented Euler or quaternion
offset is emitted.

## Animations

The model and all listed clips are read-only extractions from the installed
client and are registered in `manifest.mount.partial.json` by SHA-256.

| Subject | State | Native clip | Duration |
| --- | --- | --- | ---: |
| mount | idle | `cbnm_id0` | 2.333333 s |
| mount | run | `cbnm_02f_lp0` | 0.733333 s |
| mount | fly | `cbnm_fmt_glide_lp` | 2.000000 s |
| rider | ground idle | `cbnm_mt_id0` | 2.333333 s |
| rider | flying idle | `cbnm_fmt_id0` | 2.466667 s |

The dedicated rider source is a c0101 shared-human PAP, as proven by the
client path above. Its 97 transform tracks are rebound by matching bone names
to the c0801 base skeleton (106 nodes). Offline Three.js checks report 291
keyframe tracks and 96 changed rider nodes for each exported rider GLB.

The final partial manifest is not empty for the rider: `riderAnimations.idle`
points to `glb:sha256:ac674810986f00818017db1e8b337b89847235152f07c9f216a16a144d12c768`
and `riderAnimations.flying` points to
`glb:sha256:39590ae1e71506fb24f2b96eb61a1061a464d5c045caf57998c9c0f9af144b2e`.
These are the actual browser-bound idle/flying rider GLBs from the PAP source
above.

## Confidence

Confirmed: Mount/ModelChara/MountCustomize fields, model and skeleton paths,
all named mount and rider PAP clips, `n_mount` local transform, extracted GLB
hashes, and c0801 named-bone playback.

Inference: none used for the manifest's mount model, animation, or rider
binding.

Unknown: the MountCustomize camera-height conversion to the demo's world
units. It remains a recorded source value rather than a fabricated conversion.
