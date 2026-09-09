# Browser, animation, and portable-deployment acceptance

Date: 2026-09-09

Status: PASS, with one non-blocking Gridania visual observation below.

## Active map content

- Source active run: `20260909T105118Z-43c2c6`.
- Client version: `2026.09.01.0000.0000`.
- The final source pointer uses `bundled/gridania/` and `bundled/limsa/` for that run. Their manifest SHA-256 values are unchanged from the prior active pointer.
- Final `site/extracted/active.json` correctly contains deployment-relative `gridania/` and `limsa/` bases. `site/extracted/` contains exactly those two map directories and no legacy `releases/` directory.

## Current development browser acceptance (`http://127.0.0.1:5173/`)

- Player pivot stayed centered at NDC `(approximately 0, 0)` initially, after movement, after target selection, after the explicit “return to dummy” control, and across Gridania -> Limsa -> Gridania.
- Gridania loaded 1,790 instanced meshes with both diffuse and normal maps; Limsa loaded 2,853 with both map types.
- Target selection remained valid and return-to-dummy restored a close target distance (2.4 world units in the captured run).
- Existing control regression also passed: traditional mode, RMB pointer capture/release, camera/player alignment, no rotation while unheld, blur cleanup, settings persistence, and no browser errors.

## Animation history proof

The local animation lab verifier passed without modifications to the lab:

- 1 animation clip (`cbem_joy`), duration 3.833333 s.
- 101 scene nodes and 276 keyframe tracks.
- `AnimationMixer` changed 85 nodes at one second.

## Final portable build and `/ff14-web` deployment acceptance

- Command: modern Node `node_modules/vite/bin/vite.js build --outDir site`.
- Build passed: 1,658 modules transformed; final site tree had 2,404 files.
- Vite emitted only its non-fatal >500 kB chunk advisory (`three-*.js`, 575.20 kB); it did not fail the build.
- A fresh independent temporary copy of only `site/` plus `scripts/serve.mjs` was used. It contained no `node_modules` and was served with `--port 5187 --base /ff14-web`.
- `GET /ff14-web` returned `308` with `Location: /ff14-web/`.
- All same-origin browser requests stayed under `/ff14-web/`; there were no same-origin 4xx/5xx responses and no console/page exceptions.
- Both real client maps loaded from the copied build: Gridania 1,790 textured/normal-mapped meshes; Limsa 2,853.
- Camera movement, target selection, return-to-dummy, and Gridania -> Limsa -> Gridania round trip all kept the player pivot centered.
- Basic visible damage skills executed successfully: WHM “闪耀” (330 potency), PCT “火炎之红” (440), RPR “勾刃” (300).

## Visual review (images retained locally only)

The following captures were downscaled to 960x600 before review. No image data is included in this report.

- `work/subpath-gridania-review.png`
- `work/subpath-limsa-review.png`

Limsa was visually healthy: stone paving, metal trim, ornamental details, map UI, character, and skill icons were clear, with no conspicuous missing texture or UV stretch.

Gridania loaded its materials (no checkerboard, transparent holes, or obvious UV stretching), but its central timber stairs/bridge and some surrounding vegetation were markedly darker than Limsa. This is an exposure/material-readability observation rather than a resource-load failure; it should be reviewed if brighter Gridania presentation is a release requirement.

## Font-script portability change

Only the authorized scripts were changed:

- `scripts/preview-skill-icons.py`
- `scripts/trace-overlay.py`

Both now accept `--font <TTF/TTC/OTF>` and otherwise discover common system font directories. The Windows Fonts directory is considered only when `WINDIR` is set; neither script retains a fixed `C:/Windows/...` font path. Both scripts ran successfully using discovered fonts on this machine.

## Machine-readable artifacts

- `work/browser-resume-check.json`
- `work/subpath-deploy-check.json`
