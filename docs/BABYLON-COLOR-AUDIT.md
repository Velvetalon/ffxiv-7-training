# Babylon Color Audit: Candidate, Not Visually Accepted

## Outcome

Decision A was executed on September 12, 2026: static scope inspection passed,
then the targeted two-model capture was attempted. One tool-path correction
was used. The controlled retry failed the unchanged foreground-mask criterion:
both captured building masks contained **zero selected pixels**.

Following the user's retry limit, no further capture retry, after capture or
four-map comparison was started. The candidate is committed for inspection,
**not published and not declared visually fixed**. Main `/ff14-web/` and the
currently published Babylon release are unchanged.

## Confirmed Findings

These are source/code/numerical facts, not successful pixel acceptance.

| Finding | Evidence | Conclusion |
| --- | --- | --- |
| Packed background `_s` is used as RGB reflectivity in the baseline | Baseline `MaterialAdapter.js` binds it to `reflectivityTexture`; Babylon 9.26 `ShadersInclude/pbrBlockReflectivity.js` multiplies specular RGB by sampled RGB | Independent mask channels inject yellow/green into the specular term |
| Actual `_s` samples have little blue | Soil mean RGB `[196.25,199.01,0.70]`; grass `[26.25,194.32,0.006]`; building wood `[214.71,200.05,1.56]`; alpha 255 | They cannot be interpreted as neutral RGB reflectance |
| Sampled vertex RGB is grayscale | Building sample approximately `[0.5003,0.5003,0.5003]`; ground approximately `[0.445,0.445,0.445]` | It can dim the result but does not explain hue shift in these samples |
| No duplicated albedo gamma conversion in the checked path | Hardware sRGB texture storage makes Babylon's `gammaSpace` getter false for shader-side conversion | This candidate cause was ruled out for the audited path |
| Raw profile RGB mapping is exact at 12:00 | e3t1, limsa, gridania and d2t1 raw-to-native diffuse/fog/clear deltas are zero; repeated apply deltas are zero | No RGB/BGR swap, 0-255 leak or repeat multiplication was found there |
| SH energy differs from the native reference | Before uploaded coefficients/reference = pi; candidate = 1.0 within `1e-9` for each nonzero component | Uniform energy error confirmed; it is not a green-only error |

Source data and reproducible numeric probes:

- `work/color-audit/material-audit.mjs`
- `work/color-audit/material-evidence.json`
- `work/color-audit/material-audit.md`
- `work/color-audit/environment-nullengine-audit.mjs`
- `work/color-audit/environment-nullengine-audit.json`
- `work/color-audit/environment-findings.md`
- `work/color-audit/environment-after-nullengine-audit.json`
- `work/color-audit/environment-after-findings.md`

The environment probe's `NullEngine` allocation limitation is documented.
Light/fog/clear/image state was inspected on native objects; SH helper output
was compared numerically. It is not presented as a GPU image comparison.

## Candidate Implementation

Changes are in the shared Babylon layer, with no per-map/model recoloring:

- `preview/babylon/MaterialAdapter.js`: for `bg.shpk`, use the existing linear
  `_s` texture's G channel as roughness, neutral native dielectric reflectance
  and metallic 0. Disable RGB reflectivity, alpha gloss, red AO and blue
  metallic interpretations. Albedo, normal, UV and source vertex-color rules
  remain unchanged. R/B specular-mask behavior is explicitly unmodeled.
- `preview/babylon/EnvironmentAdapter.js`: apply incident-radiance to
  irradiance to Lambertian-radiance normalization, then create the spherical
  polynomial. Let Babylon perform its rendering pre-scale.
- `DebugRenderMode.js`, `DebugRenderPanel.js`, `debug-render.css`: reversible
  Full, Neutral, Albedo, Albedo+Normal and PBR-without-environment modes;
  actual vertex-color/AO/extra-color controls; parameter dump. Stable-state
  guarding avoids repeated PBR shader-definition churn.
- `World.js`, `app.js`, `client.js`: preview-only diagnostic integration.
- Existing `validate-babylon.mjs` gains a scoped color-audit branch backed by
  `scripts/validation/color-audit.mjs`.

No exposure adjustment, reverse color filter, new asset conversion, changed
source profile, changed COS object or whole-map regression was used.

Candidate build: `work/color-audit/after-site/`.
Runtime source SHA-256:
`30d4ccacc9959a31c030d1d660c0a355eccf25cf4481b8f6377a5292cd9bc962`.
It was rebuilt successfully, with zero imported Three modules. Native API
checks passed for the G-only mask flags, unchanged albedo/normal level and
full-resolution texture upgrades. This does not establish visual acceptance.

## Samples And Layer Status

| Sample | Identity | Valid Layered Pixel Result |
| --- | --- | --- |
| Building | model 290, placement 0, `e3t1_b3_hou3a.mdl`; `glb:sha256:8921a545492ab13574207ac9b8182047eb41a86d7c26e88feb1ff2583196c86b` | Not obtained |
| Ground | model 659, placement 0, `bgplate/0000.mdl`; `glb:sha256:a4192b66658583efbeebde8713a99f0f9172c8ed84c380d23839306b296ceb1a` | Not obtained |

The planned ladder was Albedo -> Albedo+Normal -> PBR without environment ->
Full, with an RGB-reflectivity-binding ablation. Because the selected geometry
mask was empty, **which rendered step first turns green is not pixel-verified**.
The confirmed shader/data mismatch must not be confused with a completed
causal screenshot ladder.

The source-derived centers and radius 0.01 were retained: building
`[45.9998665,8.423463,27.5594925]` selects one model; ground
`[32,10.7642485,-276]` selects two overlapping models. Material resources,
matrices, viewport `1280x720`, FOV `0.82` and time `12:00` were recorded.

## Four-Map Comparison

| Map | Raw/Applied Parameter Audit | Before/After Neutral/Full Pixel Acceptance |
| --- | --- | --- |
| Kugane `e3t1` | Verified numerical mapping/normalization | **Unverified**: targeted foreground masks were empty |
| Limsa `limsa` | Verified numerical mapping/normalization | **Not executed after targeted failure** |
| Gridania `gridania` | Verified numerical mapping/normalization | **Not executed after targeted failure** |
| Foundation `d2t1` | Verified numerical mapping/normalization | **Not executed after targeted failure** |

Partial files from the approved run are under
`work/color-audit/decision-a/before/e3t1/`, including whole-view Full/Neutral
PNGs/JSON and building sample frames in
`samples/building-290-placement-0/`.
The authoritative stopped-run record is
`work/color-audit/decision-a/progress.json`.

Both building masks had count 0 and mask SHA-256
`d8b443032200e143b1c49820b6d78c32d519553a3f63a38f48e8bc31da084f0a`.
Consequently the recorded zero chroma statistics are **invalid empty-sample
values**, not evidence that green was removed. No before/after improvement
percentage is claimed.

## Reproduction And Remaining Work

The existing scoped entry is:

```powershell
node scripts/validate-babylon.mjs --color-audit `
  --url=http://127.0.0.1:5210/ff14-web-babylon-preview/ `
  --label=before --maps=e3t1 --out=work/color-audit
```

The recorded run also uses an explicit local Playwright module and browser
path. Do not run the full 65-map migration workflow for this issue.

Remaining work, **not performed in this capped run**:

1. Correct selected-instance isolation/white-mask rendering so the building and
   ground produce nonempty, matching foreground masks.
2. Finish the two-model layer/ablation comparison and all four matched
   Neutral/Full before/after pairs, using normalized chroma as well as RGB.
3. Only if those checks pass, publish the candidate and recheck preview content,
   the unchanged main-site hash and API health.

Further material refinement may still be needed for R/B specular masks,
secondary normals, non-background shaders and the approximate environment
cube. The cube transfer-space hypothesis remains unverified and was not
changed to compensate for green.

## Production Remained Unchanged

Read-only content verification at `2026-09-12T13:56:12.108Z` passed against the
previously published build, not this candidate:

| Endpoint | Content | SHA-256 |
| --- | --- | --- |
| Babylon preview | `FFXIV · Babylon World Preview`, 554 bytes, `index-C18zmWc_.js` | `e6e46face7a607b28be1d22e9996db26fa32a6848a3503ffb96e44452d28bfa4` |
| Main `/ff14-web/` | `以太演武场 · Aetheryte`, 686 bytes, `index-BM1nxa83.js` | `a60f02c6023302d751e8a2ec372ab600a8b5f4b66e40cfa02d83d98d2d7d3091` |
| `/api/healthz` | HTTP 200 and JSON `status: ok`, 95 bytes | `9b4814d30f33fc64ead577b2628a2a089b0f5b23271407a84461c064959a92bb` |

Evidence: `work/color-audit/decision-a/production-unchanged.json`.
No release helper, CDN refresh or asset publication was executed for this
color candidate.
