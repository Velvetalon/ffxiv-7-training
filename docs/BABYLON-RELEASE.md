# Babylon All-Map Release

## Published Artifact

- Release: `maps-20260912T083528Z`
- Build time: September 12, 2026, 16:37:17 UTC+08:00
- Output: `site-babylon-preview/`, 66 files, 8,809,523 bytes
- Engine: Babylon.js 9.26.0; imported Three.js modules: 0
- Catalog: `20260909T124255Z-e3ea44`, 65 maps
- Runtime source SHA-256: `7da88993051e5b22d645e60b4c5c949718e69afa33edb30aa544120b09fcc02c`
- Archive SHA-256: `c234ada5fd7c6a1fad06c841bce569706e6d9c50f69aada2c1f3d6569cf56012`
- Implementation/evidence commits: `2e7f8b95d`, `3e1660ea7`, `7726a1415`, pushed to `origin/master`

This is not the old 59-file Kugane artifact. The new entry selects the full
client and supports the catalog's `?scene=<id>` routes. `?viewer=1` retains
the isolated map viewer used by the Kugane-specific checker.

## Content-Level Deployment Proof

Checked together by the release's content verifier:

| Endpoint | Content | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `/ff14-web-babylon-preview/` | `FFXIV · Babylon World Preview`, `assets/index-C18zmWc_.js` | 554 | `e6e46face7a607b28be1d22e9996db26fa32a6848a3503ffb96e44452d28bfa4` |
| `/ff14-web/` | `以太演武场 · Aetheryte`, `./assets/index-BM1nxa83.js` | 686 | `a60f02c6023302d751e8a2ec372ab600a8b5f4b66e40cfa02d83d98d2d7d3091` |
| `/api/healthz` | JSON `status: ok`; Flask, SQLite, data directory checks `ok` | 95 | `9b4814d30f33fc64ead577b2628a2a089b0f5b23271407a84461c064959a92bb` |

Final recheck: September 12, 2026, 17:09:44 UTC+08:00. The nonexistent control
path still returned the 537-byte `光影返图` catch-all, SHA-256
`a0e4daeaa91fa704da7ca13c41e17e782b6e22f54c22c474cf4d82489872952a`.
The preview is different content, not merely a successful status code.
Served entry JavaScript SHA-256:
`c65463a90dc3a34407c9fce51508195748b437252b1954c7e3641e73db479a16`.

The verifier also compared served application metadata, entry JavaScript and
LOD worker bytes against the local build. The preview differs from the
catch-all content. The main release pointer, mount, managed route and index
were checked by the cutover script and left unchanged.

## Runtime Coverage

The per-map runtime report is [BABYLON-MAP-COVERAGE.md](BABYLON-MAP-COVERAGE.md),
with **65/65 maps verified**. Catalog registration alone is not a passing
result: each passing row requires the requested map ID to match the actual
Babylon map, imported geometry, native rendering, navigation and a source
manifest/resource identity.

The corrected release's full pass produced 63 PASS, one transient network
failure (`n4f1`, HTTP/2 fetch error), and one 30-second timeout (`n4t2`).
Only those two were retried, sequentially with a 60-second limit. They passed
in 17.18s and 20.66s respectively. The table merges the full run with this
targeted retry; original outcomes remain in the JSON evidence.

The fixed representative set (`gridania`, `x6f2`, `y6f1`, `d2t1`) was 4/4
renderable. Automated movement was unconfirmed on three early-streaming views;
that warning is not hidden or counted as a visual sign-off.

The delegated visual check confirmed all four screenshots show populated
native Babylon worlds, terrain/structures, player, HUD and minimap; camera drag
worked in all four. It did not confirm headless KeyW/KeyS movement in that short
observation. The separate sandbox ground/flight/jump checks passed.
Screenshots and the text-only QA report are under `work/babylon-final-visual/`:

| Map | Instantiated Models / Meshes | Screenshot |
| --- | ---: | --- |
| `gridania` | 80 / 1,915 | `gridania.png` |
| `x6f2` | 50 / 4,621 | `x6f2.png` |
| `y6f1` | 63 / 5,051 | `y6f1.png` |
| `d2t1` | 167 / 4,688 | `d2t1.png` |

These are geometry/appearance sanity observations, not visual parity with
FFXIV. The representative images still have strong green/dark terrain casts;
lighting/material tuning remains a known limitation.

The same Gridania representative also passed a `390x844` mobile sanity check:
native map ready, populated canvas, HUD/controls inside the viewport without
incoherent overlap. `gridania-mobile-390x844-day12.png` and
`mobile-gridania-report.json` are in the same visual-evidence directory.
PNG sampling found 818 distinct RGB samples among 900 samples; this, together
with delegated screenshot inspection, establishes nonblank mobile output.

## Validation Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `validate-fast --engine=babylon --url=...` | Initial exit 1: 63/65 PASS; fixed representatives 4/4 PASS | `fast/result.json`, `fast/smoke.json` |
| `validate-smoke --scenes=n4f1,n4t2 --timeout-ms=60000` | Exit 0: 2/2 PASS; combined coverage 65/65 | `fast/smoke-retry.json` |
| `validate-smoke --scenes=e3t1` | Exit 0: 1/1 PASS | `smoke-subset.json` |
| `validate-map e3t1` | Exit 0: renderable; early movement observation warning | `map-e3t1.json` |
| `validate-sandbox` | Retry exit 0: 15/15 checks PASS, no errors | `sandbox-retry/report.json` |
| `validate-developer` | Final retry exit 0: PASS; no page, console or request errors | `developer-final/report.json` |
| `validate-babylon` | Exit 0; geometry, source transforms, materials, controls and open/refresh checks passed. Initial full-background wait exceeded 180s before later completion | `kugane.json`, `map-position.json` |
| `verify-babylon-deployment.mjs` | Exit 0, final content/hash checks PASS | `deployment-proof-final.json` |

All relative evidence paths above are under
`work/babylon-closeout-maps-20260912T083528Z/`. The source-position comparison
reported zero anomalies. Validation used Windows, installed Chrome
153.0.8010.37 and the actual HTTPS preview/CDN; CDN cache state is not claimed
to be cold or known. No renderer-speedup claim is derived from these runs.

The first actual full-map pass found 5 passing maps, 44 failures and 16 timeouts.
Those results were not relabeled as success. The common migration faults were
fixed before the next release: gzip collision chunks needed decompression,
Windows module-path normalization was required to avoid duplicate Sandbox
registries, and the native collision octree subdivision caused excessive
construction time. Goldenport retained all 151,794 collision triangles while
its measured index construction changed from 39.61s to 1.52s. This measurement
is a collision-adapter check, not an end-to-end TTI claim.

Validator compatibility corrections did not change deployed runtime code:
Babylon animation duration uses `AnimationGroup.getLength()`, asynchronous
sound/teleport observations wait for their actual result, and persistence
checks read the deliberately isolated `aetheryte-babylon-settings` key.
The complete developer retry passed after these corrections.

## Scope

All renderer changes are under `preview/babylon/` and its independent Vite
configuration. `src/main.js`, `src/world/`, the main `site/`, shared COS objects
and shared manifests were not changed. Source bytes, registries, scheduling
and cache implementation are reused; Babylon owns native GPU objects.

The earlier native-client adapters for character, mount, audio integration,
combat UI and developer tools are retained because the full entry uses them.
Their presence is not evidence that every original-game effect is reproduced.

No separate main-site map-performance work was added. The native map loader
retains progressive loading, LOD and bounded collision residency required by
the migration; the current-map idempotence guard lives only in
`preview/babylon/World.js`. The collision-index parameter correction is confined
to `preview/babylon/Navigation.js`. No P0 performance-target claim is made here.

Environment cubemaps are source-tinted approximations. Water/river and crystal
effects, secondary normal blending and other unsupported shader branches are
listed in `BABYLON-MATERIALS.md`. Basic per-map runnable coverage is not
full-scene visual parity or certification of every background texture.

## Change Scope

| Files | Responsibility |
| --- | --- |
| `preview/babylon/World.js`, `WorldIndex.js`, `Encounter.js` | Native map lifecycle, map selection, navigation integration, targeting, source landmarks and map image |
| `preview/babylon/SceneLoader.js`, `Navigation.js`, `LodBuilder.js` | Native geometry/instances, source matrices, collision decoding/index and existing LOD rules |
| `preview/babylon/AssetBridge.js`, `SandboxAssets.js` | Existing ResourceID/manifest/bundle/cache/ticket integration without old GPU objects |
| `preview/babylon/MaterialAdapter.js`, `EnvironmentAdapter.js` | Native material and environment adaptation; limitations retained explicitly |
| `preview/babylon/Controls.js`, `viewpoints.js`, `app.js`, `style.css` | Retained standalone map-viewer mode |
| `preview/babylon/client.js`, `index.html`, `config.js`, `vite.babylon.config.js` | Isolated entry, 65-map metadata, native module resolution and build identity |
| `preview/babylon/character/*`, `DeveloperRuntime.js`, `Effects.js` | Previously implemented native client support retained by the full map entry |
| `scripts/validate-*.mjs`, `scripts/validation/browser.mjs` | Babylon-aware versions of existing acceptance checks and compact runtime evidence |
| `scripts/summarize-babylon-coverage.mjs` | One evidence row per catalog map |
| `scripts/closeout-babylon.mjs`, `scripts/verify-babylon-deployment.mjs`, `deploy/babylon-preview-release.py`, `deploy/deploy-babylon-preview.sh` | Logged build/release workflow and content-level deployment verification |
| `.gitignore`, `package.json`, `docs/BABYLON-*.md` | Independent output exclusions, pinned packages, commands and delivery documentation |

The pre-existing user `pnpm-lock.yaml` and `pnpm-workspace.yaml` were not changed
or committed. Generated builds, raw assets, credentials and run logs remain
outside Git.

## Recovery And Evidence

The bounded runner is `scripts/closeout-babylon.mjs`. It writes a PID, stage,
exit codes and command logs to
`work/babylon-closeout-maps-20260912T083528Z/`.
Check its live PID and `state.json` before restarting anything.
The publish operation has completed; remaining verification must not cause
an unnecessary rebuild or duplicate whole-map run.
