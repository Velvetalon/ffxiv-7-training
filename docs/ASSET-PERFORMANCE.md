# Asset performance verification

This document records the asset-load acceptance method and the September 10, 2026 measurements. It distinguishes a renderer submission from a user-visible first render so an internally ready scene is not reported as user-ready while the loading overlay still blocks input.

## Reusable benchmark

Use [benchmark-assets.mjs](../scripts/benchmark-assets.mjs):

```sh
npm install -D playwright
node scripts/benchmark-assets.mjs --url=https://example.test/ff14-web/ --out=work/asset-performance/result.json --scenes=gridania,limsa
```

If Playwright is supplied by an external runtime rather than the project dependency, pass `--playwright-module-path=/absolute/path/to/playwright/package.json`. `--browser-path` selects a browser executable. `--cold-only` omits warm reload and Gridania → Limsa → Gridania (ABA) reuse checks.

The benchmark updates the cumulative report after every finished case, appends `<out>.progress.jsonl` at route, renderer, visible-interactive, full-load, heartbeat, completion, and incomplete-case transitions, and retains a DOM state diagnostic for failed cases. All HTTP(S) resources in the fresh isolated browser context are counted, including CDN origins; signed-query strings are stripped in artifacts.

## Acceptance definitions

| Metric | Requirement | Definition |
| --- | ---: | --- |
| Cold first render | `<10s` | `first-visible-render`: imported renderer frame after `#loading` is hidden/non-intercepting and input is enabled. |
| Cold TTI | `<30s` | Profiler `interactive` mark after the same UI gate. |
| Warm TTI | `<5s` | Same profiler/UI gate after a reload in the same browser context. |
| Full scene | Required | `streaming=false`, no stream error, expected model completion, plus full-completion material audit. |

`rendererFirstRenderMs` remains available as a technical rendering measurement, but it is not the user-visible first-render metric. `previewVariants=0` in the full-completion material audit means final full-texture upgrades succeeded; it does not imply that bootstrap did not use preview textures. Aggregated decode durations are sums of concurrent resource events, not elapsed CPU wall time.

## Evidence summary

The former public legacy Gridania baseline was 239.147 seconds. The first public v3 UI-gated cold Gridania diagnosis reached user-visible first render/TTI at 22.478 seconds, so it passed the cold-TTI requirement but not the `<10s` first-render requirement. Its CDN diagnostic showed 4.187 seconds to registry readiness and 14.579 seconds in bootstrap; the source-confirmed cause was original textures at or below 128 px being omitted from preview tiers and causing full-pack work.

Public v4 preview used HTML SHA-256 `c3804c70e434d6ce32068aae4c49a99e855ce1020cb1fda44a0e8911b2d9d391`. The portable benchmark report is `work/asset-performance/public-v4-ui.json`:

| Case | Visible first render | TTI | Result |
| --- | ---: | ---: | --- |
| Cold Gridania | 12.811s | 12.811s | First render **fails** `<10s`; TTI passes `<30s`. |
| Cold Limsa | 12.214s | 12.214s | First render **fails** `<10s`; TTI passes `<30s`. |
| Warm Gridania | 1.746s | 1.746s | Passes warm TTI `<5s`. |
| Warm Limsa | 1.839s | 1.839s | Passes warm TTI `<5s`. |
| ABA Gridania → Limsa | 5.525s | 5.525s | Informational reuse measurement. |
| ABA Limsa → Gridania | 2.014s | 2.014s | Informational revisit measurement. |

The v4 public cold Gridania profiler recorded registry readiness at 2.704 seconds and bootstrap duration of 5.947 seconds; Limsa recorded 2.841 seconds and 7.248 seconds respectively. This is substantially below v3's bootstrap wall time, but the cold first-render target remains open. No further optimization is implied by this document.

## UI completeness evidence

`work/asset-performance/optimized-v4-local-overlay-qa.json` verifies Limsa while it is still streaming (88/771 models): the loading overlay is hidden, transparent, non-intercepting, canvas pointer input and `KeyW` are accepted, and streaming subsequently completes at 771 models without error. The local v4 Gridania report records a 4.199-second visible first render and 4.199-second TTI; public delivery adds network latency and is the acceptance source for deployment measurements.
