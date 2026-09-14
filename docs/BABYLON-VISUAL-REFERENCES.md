# Babylon Visual Reference Harness

The fixed manifest at `config/visual-references.json` defines the current
Babylon visual regression scope: one view each for `e3t1`, `gridania`, and
`limsa`. Each record stores the map id, view id, camera position and target,
Babylon FOV (radians), 1280x720/DPR1 capture settings, world time, weather
status/provenance, tracked reference path, reference kind, and SHA-256.

Run the harness against a local Babylon preview:

```text
npm run dev:babylon -- --host 127.0.0.1
npm run validate:visual-references -- --url=http://127.0.0.1:5173/ff14-web-babylon-preview/
```

The validator always waits for both `ready` and `fullyLoaded` before capture,
applies the exact manifest camera/time/FOV, and always disables LOD for the
canonical capture. Passing `--disable-lod=false` or
`--wait-full-load=false` is rejected because either would be non-canonical
evidence. It records before/requested/final view state, loader counts/failures,
captures the Babylon canvas, and compares the reference and capture in-page
through canvas image decoding. PNG and JPEG references are supported. Full
details are written under `work/visual-references/`; the terminal output is a
compact JSON summary with the top differences.

Metrics include RGB mean and bias, luminance mean/error/RMSE, RGB MAE/RMSE,
per-channel histograms and chi-square, luminance SSIM, Sobel edge difference,
and nonblank/unique-color sanity checks. The diagnostic score is higher when
images differ and is weighted as RGB MAE 0.35, luminance MAE 0.20, absolute
per-channel mean bias 0.15, SSIM loss 0.15, and Sobel edge difference 0.15.
It is a ranking aid, not a claim of pixel parity or visual sign-off.

Reference images are stretched to the 1280x720 capture size only when their
aspect ratio is within the manifest tolerance (`0.005`). Canvas smoothing is
enabled at high quality; the summary records original dimensions and the
resampling policy. A larger aspect-ratio mismatch fails validation.

`e3t1` uses a tracked current-build Babylon baseline. Refresh the tracked
Babylon baselines and update their manifest SHA-256/provenance with:

```text
npm run validate:visual-references -- --update-baseline
```

With no `--views` selection, `--update-baseline` automatically scopes the
operation to `babylon-baseline` entries. If `--views` explicitly selects a
`source-screenshot`, the update is rejected; missing or mismatched source
references also fail validation, so the Gridania and Limsa source images are
never overwritten. Babylon baseline provenance records the capture URL,
resolution, full-load/LOD policy, timestamp, and served `build-info.json`
producer evidence when available, including source, engine, map-count, and
visual-reference hashes. Source screenshot camera alignment is approximate
because those images do not carry Babylon camera metadata. Weather is
explicitly `unsupported` because the current runtime has no weather contract;
the harness never fakes weather.

## 2026-09-14 Local Acceptance

The canonical independent run used the local-asset dev server at
`http://127.0.0.1:5173/ff14-web-babylon-preview/` and produced
`work/v5/root-acceptance-summary.json`:

| View | Result | Diagnostic score | Meaning |
| --- | --- | ---: | --- |
| `e3t1/kugane-castle` | compared, full load, zero loader failures | 0.016529 | Blocking reproducibility baseline for this slice. |
| `gridania/new-gridania-aetheryte` | compared, full load, zero loader failures | 31.626431 | Non-blocking source comparison; camera/content alignment is approximate. |
| `limsa/limsa-octant` | compared, full load, zero loader failures | 37.896084 | Non-blocking source comparison; camera/content alignment is approximate. |

All three views reported `ready=true`, `fullyLoaded=true`, final camera/time/FOV
matching the manifest, and LOD disabled. Luna reviewed the three capture/reference
pairs. Kugane matched its tracked current-build baseline and showed no residual
global green/yellow cast. The Gridania and Limsa source pairs show different
camera framing and content, so their higher scores are useful ranking evidence
but are not proof of a renderer regression and are not visual sign-off. Future
work should calibrate those cameras or acquire source references with known
camera, time, and weather metadata.

The built bundle was also tested from a static preview server. Static assets
served correctly, but runtime initialization then failed on the existing shared
CDN endpoint: normal Chrome reported a certificate without the
`img.yuluo.site` SAN, and bypassing certificate verification exposed a CORS
failure. The local dev validator succeeds because it uses the same-origin local
asset mode. This shared CDN certificate/CORS condition is outside the isolated
preview scope and must not be worked around in the Babylon client.

## 2026-09-14 Deployment Record

Release `v5-visual-reference-harness-20260914T144939Z` was published only to
the isolated preview route. The prepared archive contains 69 files / 8,831,583
bytes and has SHA-256
`c7733937718be6851ebb4697870bd0bcf4ce216b747ab06194b339698020b76b`.
The deployed preview HTML is 554 bytes with SHA-256
`9b54437d950c342b976acb9bcf668774063219e0e44168d9834bdb240c9ec3b3`, title
`FFXIV · Babylon World Preview`, and entry
`/ff14-web-babylon-preview/assets/index-bx3p5Y4J.js`.
`scripts/verify-babylon-deployment.mjs` passed all 74 content checks at
`https://yuluo.site/ff14-web-babylon-preview/`, including the build metadata
and dynamic artifacts. The main entry remained `以太演武场 · Aetheryte` with
SHA-256 `a60f02c6023302d751e8a2ec372ab600a8b5f4b66e40cfa02d83d98d2d7d3091`,
and `/api/healthz` returned `status: ok`.

An online open-and-refresh probe loaded the new title and entry on both loads,
but map import failed both times at the shared catalog URL with
`net::ERR_CERT_COMMON_NAME_INVALID`. Evidence is stored in
`work/v5/online-open-refresh.json`. This is the pre-existing shared CDN
certificate condition described above; the isolated preview deployment itself
is content-verified.
