# Babylon Color Closed-Loop Validation

Published to the isolated preview as `v5-color-closure-20260912T1622Z`;
74/74 deployment content checks passed and the main-site hash is unchanged.
Two source models and three whole-map views meet the color criterion.
Limsa's whole-frame improvement is 26.2050% and remains an explicit failed
metric, not a fourth passing result.

## Scope And Acceptance

This closes the color candidate in `e4e37fb7d`, not the earlier 65-map migration.
Only the isolated Babylon preview and its diagnostic tools are in scope.
No main-site build, shared-resource publication, ticket-service change, CDN
flush, or whole-catalog regression is part of this work.

The criteria were recorded before the repaired results in
`work/color-audit/closure-acceptance.md`:

- Strict white geometry masks: RGB >=250, at least 512 pixels; building and
  ground must have distinct masks. No relaxed threshold.
- Fixed camera, 1280x720/DPR1, noon paused, matching geometry and full-resolution
  albedo resources. Identical masks are preferred; otherwise IoU >=0.995.
- Neutral/base-color mean RGB drift <=1 per channel on the 0-255 scale.
- For a demonstrably biased target, at least 50% reduction of the magnitude
  of its Full-minus-Neutral normalized green deviation.
- Actual Full frames must remain textured, lit native PBR, not white masks or
  an unlit substitute. Image operations and inspection are delegated.

The immutable local before build reproduces the old material/environment
treatment with diagnostic instrumentation; it is not byte-identical to the
uninstrumented production bundle. Runtime source fingerprints:

| Build | Source SHA-256 |
| --- | --- |
| Before, port 5210 | `4520e98a46f7b43ce7a256f7d8234bcb67a72ca447c74d87fbaa86bb9ea5b908` |
| Candidate, port 5211 | `30d4ccacc9959a31c030d1d660c0a355eccf25cf4481b8f6377a5292cd9bc962` |

## Confirmed Corrections

The existing shared-layer runtime corrections were retained without
per-map recoloring, exposure compensation, or an inverse filter:

1. `MaterialAdapter.js`: background `bg.shpk` packed `_s` RGB is no longer used
   as reflectivity color. The supported G roughness channel uses a native PBR
   dielectric with metallic 0. R/B specular-mask detail remains unmodeled.
2. `EnvironmentAdapter.js`: missing Lambertian `1/pi` normalization is restored.
   Uploaded SH coefficients match the native reference within `1e-9`, rather
   than being uniformly pi times that reference.

The earlier source/numerical audit remains applicable: sampled vertex RGB is
grayscale, checked albedo hardware-sRGB storage is not double-linearized, and
raw profile RGB-to-light/fog/clear mappings have zero error at noon. These facts
do not establish perfect source-game shading or an exact procedural cubemap.
Detailed provenance is in `BABYLON-MATERIALS.md` and the historical
`BABYLON-COLOR-AUDIT.md`.

## Capture Repair

The old zero mask was a tool defect. Geometry existed, but vertex gray around
0.5 modulated the in-place PBR "white" mask to roughly RGB186. The unchanged
RGB>=250 selector rejected it. The repaired tool assigns a separate unlit white
`StandardMaterial`, disables vertex-color/plugin contributions for that pass,
and restores the source owners, meshes, lights and scene afterward.

`pairs-v2` is retained but rejected: preview-texture upgrades and stale PBR
effects invalidated Neutral equality. The formal `pairs-v3` freezes a
source-derived bootstrap set, upgrades its measured materials, disables LOD
equally, compiles measured effects, disables shader hot-swapping for capture,
and records geometry/texture signatures. This freezes only the test, not
production streaming.

**Neutral is an explicit capture-only base-color control:** native
`StandardMaterial`, original primary albedo/color and vertex RGB, white lights,
zero specular, no fog/IBL/image effects. It does not claim equivalence to the
shipping PBR debug mode or special secondary-diffuse/emissive/alpha-cutout
effects. Albedo and Albedo+Normal remain separate diagnostic stages;
Full and PBR-without-environment use actual source-adapted PBR materials.
The white masks are geometric silhouettes, not alpha-coverage truth.

## Four-Map Measurements

Formal evidence: `work/color-audit/closure/pairs-v3/{before,after}/`.
Every frame has a PNG, white-mask PNG and JSON parameter dump. JSON includes
camera, profile raw/applied state, light/fog/image settings, texture provenance,
mean RGB and hashes. For a map and mode, paths are:

```text
work/color-audit/closure/pairs-v3/before/<map>/before-<mode>.png
work/color-audit/closure/pairs-v3/after/<map>/after-<mode>.png
```

Replace `.png` with `.mask.png` for its mask and `.json` for its parameters.
`mode` is `neutral` or `full`.

For the mean foreground RGB, `g = G/(R+G+B)` and
`e = (G-(R+B)/2)/(R+G+B)`. These brightness-normalized statistics are not a
perceptual color-difference metric. The reported reduction is
`1 - abs(gFullAfter-gNeutralAfter)/abs(gFullBefore-gNeutralBefore)`;
using magnitude prevents an opposite tint from counting as unlimited success.

| Map / Mode | RGB Before -> After | g Before -> After | e Before -> After | Mask Pixels Before / After |
| --- | --- | --- | --- | ---: |
| e3t1 Neutral | 76.2478,71.8618,66.6652 -> 76.2477,71.8618,66.6652 | .33459140 -> .33459142 | .00188710 -> .00188713 | 669241 / 669241 |
| e3t1 Full | 100.1018,118.8365,45.5525 -> 80.2205,78.3148,73.3301 | .44930296 -> .33775984 | .17395444 -> .00663976 | 669241 / 669241 |
| limsa Neutral | 81.0101,82.0282,78.1420 -> same | .34011162 -> same | .01016743 -> same | 921600 / 921600 |
| limsa Full | 82.7767,108.6039,88.6994 -> 83.5650,106.0844,93.0360 | .38776014 -> .37527384 | .08164022 -> .06291076 | 921600 / 921600 |
| gridania Neutral | 39.2682,26.8145,16.6122 -> same | .32425861 -> same | -.01361209 -> same | 909989 / 909989 |
| gridania Full | 84.6293,104.1210,41.0167 -> 80.7249,71.7893,60.0169 | .45315916 -> .33778271 | .17973873 -> .00667407 | 909989 / 909989 |
| d2t1 Neutral | 55.6278,44.6888,27.1078 -> same | .35070820 -> .35070819 | .02606230 -> .02606228 | 560242 / 560242 |
| d2t1 Full | 93.5730,95.9305,58.8741 -> 91.0691,86.2888,72.8046 | .38622849 -> .34493109 | .07934274 -> .01739664 | 560242 / 560242 |

Each map's **four** masks (before/after x Neutral/Full) has the identical
selected-pixel bitset SHA-256 below, hence IoU=1. The PNG-file hashes are
separately recorded in each frame JSON; these bitset hashes are not PNG hashes.
Full/Neutral albedo resource signatures also match between builds.

| Map | Shared Mask Bitset SHA-256 | Full Materials | Green-Deviation Reduction |
| --- | --- | ---: | ---: |
| e3t1 | `1e2528329d56bd6ec6bfe552e6831848624749b1fb1711549c97850252caa2fd` | 63 | 97.2379% |
| limsa | `232b3c7c123b8981abf423a8b3b87bf44264694b88002b5402f18d29601dba47` | 72 | **26.2050%, fails whole-frame 50% criterion** |
| gridania | `6c26919b6f1e74e621e6aa1b5562dc4ae88b81514a2c0bf8e89bd1134f2c1b83` | 74 | 89.5081% |
| d2t1 | `dc582faf6838a00247cb0559084d785405722ae4d59fa2314f73a14a58e7abe3` | 111 | 83.7358% |

Neutral maximum per-channel mean drift is 0.0001/255. Limsa's original
whole-frame failure is retained, not relabeled as a pass: its camera is within
near foliage, filling much of the frame with naturally green leaves. A
source-identified non-foliage check at this same camera is the follow-up,
not a changed viewpoint selected for a better score.

## Two Source Models

| Sample | Identity | Foreground Pixels |
| --- | --- | ---: |
| Building | 290/0, `e3t1_b3_hou3a.mdl`, GLB `8921a545492ab13574207ac9b8182047eb41a86d7c26e88feb1ff2583196c86b` | 77373 |
| Ground | 659/0, `bgplate/0000.mdl`, GLB `a4192b66658583efbeebde8713a99f0f9172c8ed84c380d23839306b296ceb1a` | 41977 |

Shared before/after mask bitset hashes for the two models:

- Building: `9e3079f1f1f2a4ed83572166a77bdb64ba32250351b6d9a6df25309c51435c85`.
- Ground: `5c54aba486d43f6b9455336cc7767a8e00583db3bebcddcc844b952b20085177`.

Paths append `e3t1/samples/building-290-placement-0/` or
`e3t1/samples/ground-659-placement-0/` under each label in the formal evidence.
Albedo and Albedo+Normal mean RGB are exactly identical between builds.

| Sample / Stage | g Before -> After | Finding |
| --- | --- | --- |
| Building Albedo | .31912384 -> .31912384 | Unchanged base |
| Building Albedo+Normal | .31680198 -> .31680198 | Unchanged normal stage |
| Building PBR No Environment | .31278765 -> .31990212 | No large green increase |
| Building Full | .46179974 -> .32010975 | Large excess appears with old full environment, removed by candidate |
| Ground Albedo | .35277315 -> .35277315 | Some source green exists |
| Ground Albedo+Normal | .36278893 -> .36278893 | Source/normal stage unchanged |
| Ground PBR No Environment | .37903340 -> .37337581 | Smaller residual source/direct-light green |
| Ground Full | .42872241 -> .34022488 | Extra full-environment green is reduced |

Both models locate the major unwanted increment at Full/IBL, consistent with
packed RGB entering the reflection term. This is not evidence that all green
originates in IBL: the ground already has some albedo/direct-light green.

The original sequential `*-full-no-reflectivity` ablation in `pairs-v3` is
**not accepted as isolated causal evidence**: even the candidate's no-op
ablation changed RGB after earlier debug modes. Its mask remained stable, but
cross-mode GPU state was not a valid constant. It must not be used to
overstate a causal percentage.

## Closure Status

**Accepted for preview release with an explicit Limsa whole-frame exception.**
The two source models and three whole-map views meet the predefined 50%
criterion. All four map pairs pass the mask/content/base-invariance checks.
Delegated inspection confirms that candidate Full frames remain textured and
lit; no white-mask/unlit state leaked into them. The dominant original
yellow-green veil is removed in e3t1, gridania and d2t1.

This is **not** a claim of 4/4 whole-frame color-threshold success, complete
Limsa color restoration, or game-reference parity. Limsa's 26.2050% result
remains a failed metric. The release decision accepts the demonstrated shared
correction with this residual limitation; it does not lower the 50% criterion,
replace the fixed view, or desaturate natural foliage to obtain a pass.

The same-camera Limsa source control is model 701/0,
`bg/ffxiv/sea_s1/twn/s1t2/bgplate/0014.mdl`, material
`bg/ffxiv/sea_s1/twn/common/material/s1t0_t1_wall2a.mtrl`. It was identified
by native picking at (900,600) and (1000,600), not by pixel color. Source IDs:

- GLB: `66cee9d455deae59f5b68f4356813aff67765b5a2ef85621d230691eebe207ec`.
- Albedo: `1459405075f4ab406b7670aa6b8910729ebdcce4122df9bf9325cf83c3f43241`.
- All six Full/Neutral/Albedo masks: 124226 pixels, bitset SHA-256
  `1f453214ef1963823c6644217bdd4361e59e3cdfef0517a81ee5b41f7bae1321`.
- Neutral RGB: 92.5431,89.7686,85.2112 -> 92.5431,89.7686,85.2113.
- Albedo RGB is invariant: 122.4273,119.2190,109.0823.
- Full g: .33965782 -> .33991813; original Neutral g: .33555476.

This surface was not strongly green-biased before the fix and therefore
cannot establish success for the failed whole-frame criterion. It verifies
source stability and bounds the claim, rather than replacing the failure.
Evidence is `work/color-audit/closure/limsa-source-target-v2/`.

Human-style image findings are recorded in
`work/color-audit/closure/final-visual-findings.md`. Small visual summaries:

- `work/color-audit/closure/full-scenes-contact-sheet.png`
- `work/color-audit/closure/limsa-source-target-contact-sheet.png`

The coordinator read text/JSON only; the capture agent performed image
generation and inspection.

### Residual And Unverified Items

- Limsa's whole-frame color criterion is not met. Natural foliage dominates
  that fixed view, but the residual cannot be quantitatively assigned entirely
  to foliage. Further source-material/environment fitting remains warranted.
- Background R/B specular masks, secondary normals, special water/crystal
  behavior and the procedural environment cube remain approximations.
- Canonical Neutral is a base-layer instrument, not full source-shader parity.
  Alpha-cutout/secondary/emissive precision is outside its equality claim.
- No original-game pixel match, full-catalog color coverage, browser matrix,
  or performance improvement is claimed by this scoped investigation.

## Fresh Ablation

The independent `work/color-audit/closure/fresh-ablation/` run captures Full and
its ablation before cycling through the other modes. For both candidate
models, RGB is **exactly unchanged**, as expected when `reflectivityTexture`
is already absent. This validates the no-op control without reusing the
invalid sequential evidence.

| Original Model | Full g | RGB-Map-Unbound g |
| --- | ---: | ---: |
| Building | .46179974 | .36570122 |
| Ground | .42872241 | .46096162 |

The original ground is a counterexample to a simplistic "unbinding always
removes green" claim. Unbinding a specular map while retaining full white
reflectivity changes energy partition as well as color. Therefore the
ablation is not a quantitative separation of mask semantics from irradiance,
roughness and diffuse/specular energy. The before/after evidence validates
the **combined** shared-layer correction; it does not assign all improvement
to one coefficient or claim exact FF14 shader fidelity.

## Reproduction And Cost

The formal captures use the existing scoped tool:

```powershell
node scripts/validate-babylon.mjs --color-audit `
  --url=http://127.0.0.1:5210/ff14-web-babylon-preview/?viewer=1 `
  --label=before --maps=e3t1,limsa,gridania,d2t1 `
  --out=work/color-audit/closure/reproduction `
  --timeout=300000 --settle-ms=1000 `
  --browser-path="C:/Program Files/Google/Chrome/Application/chrome.exe" `
  --playwright-module-path=G:/UGit/threejs-ai-survival/node_modules/playwright/package.json
```

Repeat with port 5211 and `--label=after`. For an isolated fresh Full/ablation
probe, the lower-level entry `scripts/validation/color-audit.mjs` accepts
`--maps=e3t1 --modes=full`; it does not request the full catalog.

Formal before duration: 29.29 minutes; after: 13.15 minutes, run concurrently.
Both completed 4 maps without reported capture exceptions. These are
investigation timings dominated by material compilation, **not** map-load
benchmarks or production FPS comparisons. This slow diagnostic ladder is
opt-in, not a new default Fast Validation requirement.

## Deployed Preview

Release: **`v5-color-closure-20260912T1622Z`**.
URL: `https://yuluo.site/ff14-web-babylon-preview/`.

- Fresh Vite build completed in 1m42s. `index.html` and `build-info.json` mtime:
  `2026-09-12T16:22:04Z`. Runtime source fingerprint equals the accepted
  candidate exactly; native Babylon 9.26.0, zero imported Three modules.
- Build: 69 files, 8,828,060 bytes.
- Archive: 1,819,208 bytes, SHA-256
  `1632ccd7acd809c3ff7ebc8395be581e4ed9ee18e8b2688671a4198f15f6ac69`.
- Local package and release record:
  `work/deployment/babylon-preview-release-v5-color-closure-20260912T1622Z/`.
- Existing `prepare --apply`, then `deploy` dry run, then `deploy --apply`
  completed successfully. No human GO was requested.
- Previous preview retained: `releases/maps-20260912T083528Z`.
- Caddy rollback snapshot:
  `/opt/ff14-web-babylon-preview/backups/Caddyfile-v5-color-closure-20260912T1622Z`.
- Main current pointer remains `releases/20260910T230855Z-v3`; the remote script
  also verified the main route block, mount, command and index unchanged.
- No shared resource/COS object, ticket service, CDN cache, main release
  pointer, or legacy preview sidecar was changed.

The existing verifier was extended to hash all built JS/CSS/WASM assets,
including dynamic chunks, with bounded concurrency and compressed stdout.
At `2026-09-12T16:24:57.238Z`: **74/74 checks passed**, covering 68 deployed
artifacts plus entry/isolation/main/API checks.

| Content | Bytes | Identity / SHA-256 |
| --- | ---: | --- |
| Preview HTML | 554 | title `FFXIV · Babylon World Preview`; `b5ccfaee2af7c382309e0b30b5562f81851089a1f49603bb8893da961a8b0a72` |
| Preview entry | 1629 | `assets/index-Dp5KLqnK.js`; `90e14f1e9e5bb87f1e900f5042d2b17eb427dbba527b664f5cbaf2765a5a1edb` |
| Native engine/adapter chunk | 7239339 | `assets/DebugRenderMode-DyxfsZPg.js`; `3d65b8a8bfb57297ebd296067b47a21bfb651def85f56aa1ae2e7b18ade0d1f8` |
| Build metadata | 200 | `11849aa8488ebbff6761d3ea7cc98b61b2af3927d18a8511920ca166f36866a5` |
| App config, unchanged | 504796 | `1fa784e4c5b6ede846b45f5ebe855dbfc8c0fb3f77351ce87ba882b9e6687565` |
| Main HTML, unchanged | 686 | title `以太演武场 · Aetheryte`; `a60f02c6023302d751e8a2ec372ab600a8b5f4b66e40cfa02d83d98d2d7d3091` |
| Unknown-path catch-all | 537 | title `光影返图`; `a0e4daeaa91fa704da7ca13c41e17e782b6e22f54c22c474cf4d82489872952a` |
| API health | 95 | HTTP 200 **and** JSON `status: ok`; `9b4814d30f33fc64ead577b2628a2a089b0f5b23271407a84461c064959a92bb` |

Main SHA-256 is identical in the pre/post records, not inferred from status
codes. Preview bytes differ from both main and catch-all. Evidence:

- `work/color-audit/closure/production-before-deep.json`
- `work/color-audit/closure/production-after.json`
- `work/color-audit/closure/build.log`
- `work/color-audit/closure/deploy.log`

### Online Browser Verification

At `2026-09-12T16:33:00.613Z`, open and reload of
`/ff14-web-babylon-preview/?viewer=1&scene=e3t1` both reached native
`preview.ready`: 48 instantiated models, 1232 meshes, Babylon 9.26.0/WebGL2,
dynamic title `Kugane · Babylon World Preview`, and
`background-packed-mask-dielectric` materials.

Same-origin page fetch of `build-info.json` confirmed the expected source
fingerprint. The runtime API itself does not expose that field, so its null
field is retained rather than invented. Captured fatal error count: 0.

The 1280x720 Full screenshot is textured/lit and contains actual construction,
stone, vegetation and sky, with no white-mask or unlit-state leakage. Pixel
mean RGB: 77.1746,89.6969,99.8340; standard deviation:
37.9868,50.2892,68.4324; sampled unique colors: 3222. This is a nonblank
deployment smoke, not a new color score or load benchmark.

- JSON: `work/color-audit/closure/online-browser/online-browser-check.json`.
- Image: `work/color-audit/closure/online-browser/e3t1-online-full.png`.
- PNG SHA-256: `ce621caa1c3849f950bb19b6ed60e673b7d0314a5da53838c807b5d8a2603d4f`.
- Limitation: this check awaited basic readiness, not full background
  streaming; `isFullyLoaded` was false. Full-texture color equality was
  verified separately in the controlled local pairs.

Final script syntax checks and `git diff --check` passed. There is still a
Vite large-chunk warning; it was not hidden by raising its threshold, and no
production performance claim is based on this run.

## Commit Scope

Runtime corrections remain the already-pushed `e4e37fb7d` source. The closure
commit contains only:

| File | Change |
| --- | --- |
| `scripts/validation/color-audit.mjs` | Actual white masks, source-identity isolation, stable full-texture/canonical captures, signatures and immediate Full ablation |
| `scripts/verify-babylon-deployment.mjs` | Content hashes for all dynamic JS/CSS/WASM chunks, bounded requests and compressed result |
| `docs/BABYLON-COLOR-CLOSURE.md` | Acceptance, exact paired measurements, failures/limits, screenshots and deployment evidence |
| `docs/BABYLON-COLOR-AUDIT.md` | Mark previous capped attempt historical and link the closure |
| `docs/BABYLON-MATERIALS.md` | Replace stale candidate status with the qualified closure result |

Build/evidence directories remain ignored. The pre-existing untracked
`pnpm-lock.yaml` and `pnpm-workspace.yaml` are neither edited nor committed.
