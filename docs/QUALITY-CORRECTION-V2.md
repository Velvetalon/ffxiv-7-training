# Quality Correction V2

Baseline: `63d356aa8cb236844eaac36c72e2bdfd62e3f014`.

This iteration fixes the existing Sandbox. It preserves AssetRuntime,
content-addressed packs, COS/CDN delivery, and Fast Validation. No multiplayer
server, remote-player controller, account system, or networking is introduced.

## Work Plan

| Priority | Scope | Owner / model | State |
| --- | --- | --- | --- |
| P0 | DAT appearance, skin/face materials, hands/feet/eyes completeness | v2_character / Luna-Max | Integrated; source/runtime proof and visual closeup pass |
| P0/P1 | Mount delivery and controls, camera pitch, jump, several skill animations/SFX | v2_gameplay / Luna-Max | Integrated; native UI and fixed-sample proof pass |
| P0/P2 | Source-backed position comparison, compact anomaly reports, Chinese names | v2_map_audit / Luna-Max | Integrated; source position and Chinese DOM checks pass |
| P1/P2 | Environment data application, texture instability, distance mesh LOD | Coordinator + v2_render_check / Luna-Max | Integrated; current fixed-four observation pass, scoped LOD proof retained |
| P1 | Nighttime readability and source-light adapter correction | v2_environment_correct / Terra-High | Integrated; current fixed-four readability observation pass |

Each owner records confirmed causes separately from hypotheses. A prior local
PASS does not invalidate the newly reported failures. Delivery-path bugs must
be checked with the same manifest/ticket semantics as the shipped application.

## Integration Rules

- Workers write separate partial asset manifests; one final assembly merges
  them through the existing packer.
- The coordinator owns `main.js`, `world.js`, shared asset infrastructure and
  final integration. Workers request changes to those files.
- Character model conversion and gameplay animation conversion have separate
  output directories. Existing verified packages are not overwritten.
- Large deterministic scans run in scripts. Only failures, unavailable source
  references and significant outliers appear in the coordinator summary.
- Position comparison must use independent source-backed transforms, including
  parent composition. Comparing a manifest with itself is not validation.
- The coordinator never reads images. Workers inspect scoped screenshots and
  return text findings.

## Acceptance

After integration, run one existing Fast Validation full-map smoke pass, then
the fixed representatives and the changed feature loops. Do not rerun every
map for a local asset correction. Check the reported user workflows through
normal controls, not only through synthetic internal API calls.

Required checks: complete DAT character; several skills with real animations
and sound; jump; mount/move/dismount and flight; improved continuous environment;
stable textures while orbiting; near/far mesh LOD; all-Chinese teleport names;
normal vertical camera; executable position checker with compressed anomalies.

## Model Usage

Initial delegation: three Luna-Max workers. Escalations and their specific
reason will be recorded here, followed by a final per-tier summary.

- Added `v2_render_check`, Luna-Max, for the bounded LOD/environment/orbit
  observation. Actual LOD reduced measured triangles by 10.47% near and 22.21%
  far without losing the 1,459 managed source instances.
- Escalated the environment correction to Terra-High after that check showed
  nearly black nighttime output. This needs renderer-unit/source-data judgment,
  not more exhaustive visual testing. Other work remains on Luna-Max.
- Escalated the P0 character correction to Terra-High for the source glove
  fallback and iris occlusion shader evidence. The resolution uses source
  geometry/material provenance and keeps normal depth testing; it is not a
  `depthTest=false` workaround.

## Confirmed Findings

- The original character omitted cross-race equipment fallback. The final
  source fallback includes 604 hand-region vertices and 20 weighted finger
  bones, plus 726 foot-region vertices with 422 weighted toe vertices. The
  client iris material is depth-tested and the source occlusion pass remains
  shader-owned; no `depthTest=false` workaround is used.
- The final native mount UI loop succeeded with no failed browser requests,
  covering ground movement, takeoff, ascent, descent, landing, and dismount.
- The previously bound Misery action needs three blood lilies. Three additional
  readily triggered actions now have real source animation/SFX partials:
  Presence of Mind, Assize and Temperance. Real jump start/airborne/landing
  clips are also available.
- Atomic material upgrades prevent rendering a new diffuse map with preview
  normals/emission. The settled orbit probe found stable texture identities
  and no partial sampler transitions; the final fixed-four orbit observation
  remained visually populated and readable.
- The source position scan passed all 65 maps, but inherited visibility,
  rotation and aetheryte conventions are explicit limits. This is not a claim
  that every in-game placement discrepancy has been disproved.

## Final Proof

Final sandbox assembly: `sandbox-f39ee137fb16cfb8`, built from the ordered
character, mount, audio, skill, corrected-character, and gameplay partials.
All evidence below is local; no deployment or push was performed.
The runtime manifest contains one character and one mount, keeps Afflatus
Misery, adds Presence of Mind, Assize, Temperance, and includes real
`jump-start`, `jump-airborne`, and `jump-land` clips. The selected character
model is `glb:sha256:7fee31949fd5feffbfba8c7bf02cb880887514ab6245b777324dccab92a79c0d`
(3,839,492 bytes). Source evidence records 604 hand vertices with 20
weighted finger bones, 726 foot-region vertices including 422 weighted toe
vertices, and client iris geometry;
the runtime iris material had `depthTest !== false`.

Validation evidence:

- Fast Validation: 65/65 smoke maps and 4/4 representatives passed, with zero
  failures, timeouts, or exceptions (`work/quality-v2-fast-validation/result.json`).
- Native Gridania feature loop: 15/15 checks passed through the UI, including
  DAT import, jump restoration, three skill buttons with playable clips and
  three real audio buffer starts, mount ground/flight/dismount, camera
  direction/wheel, and Chinese teleport/map labels
  (`work/quality-v2-validation-final/report.json`).
- Current fixed-four visual and interaction observation used the final code and
  final pack for all four maps. Gridania front/face/orbit frames reviewed
  face/iris, hands, feet, and clipping; `x6f2`, `y6f1`, and `d2t1` each had
  populated scenes, movement (2.079-2.484 units), camera drag and wheel
  response, and zero browser errors. Evidence is in
  `work/quality-v2-validation-final/fixed4-three-observation.json` and its
  three `fixed4-*-final.png` frames.

Model usage for this phase: five Luna-Max workers and two Terra-High workers;
no Sol or Astra workers were used.
