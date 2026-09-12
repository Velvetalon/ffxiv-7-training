# Babylon Color Audit: Decision A Accepted

Date: September 12, 2026.
Status: user-selected A has finished with an explicitly unverified visual
result. No further confirmation is requested. One PushPlus help message was
previously sent successfully (`code: 200`); no additional notification was sent.

## Blocker

The shared material/SH defects have quantitative source/code evidence, but the
automated two-model rendered comparison has failed repeatedly in its diagnostic
tooling. The candidate fix is local only and has not been published.

Completed evidence:

- Packed background `_s` textures are incorrectly used as RGB reflectivity;
  measured soil/grass masks are strongly yellow/green.
- Source vertex RGB is grayscale, and hardware-sRGB behavior rules out a second
  albedo gamma conversion in the checked path.
- Sampled profile RGB mapping is exact. SH irradiance was uniformly pi times
  the Babylon normalization reference; the local candidate now matches 1.0.
- Valid full/neutral scene frames and all numeric audits are preserved under
  `work/color-audit/`.

## Attempts

1. Chrome RGB PNG was rejected by the initial statistics reader; RGB/RGBA
   support was corrected.
2. Repeated debug-state application stalled Full-to-Neutral capture. A stable
   state guard and harness one-shot capture guard were implemented.
3. A 96-unit sampling request loaded an unnecessarily broad neighborhood.
   Source bounds now give deterministic centers selecting one building model
   and two overlapping ground models at radius 0.01.
4. The controlled narrow capture then hit a stale variable name
   (`bounds` versus `instanceBounds`). It was corrected and syntax-checked,
   but no further retry has been launched.

## Options

- **A (recommended):** run a static scope check, then one targeted two-model
  capture; if successful, finish the four-map before/after comparison.
- **B:** user-assisted capture using the existing diagnostic UI.
- **C:** pause this task and preserve the local candidate and evidence.

Recommendation: A. The remaining problem is a corrected capture-tool defect,
not a need to relax the color-validation standard or tune colors blindly.

Authorized next steps: static scope check, one targeted two-model capture, then
the four-map before/after comparison if successful. If the targeted capture
fails, at most one tool correction and retry is allowed. A second failure ends
the run with an explicitly unverified conclusion rather than another wait.
Publication remains forbidden until valid visual/pixel evidence passes.

## Decision A Result

- Static scope check passed. One initial tool-path correction/retry was used.
- The targeted retry produced zero foreground pixels in both building Full
  and Neutral masks, so those color statistics are invalid.
- No ground ladder, candidate after capture or four-map comparison followed.
- The user-authorized retry budget is exhausted. Capture stopped without
  further retry or publication.
- Final evidence and candidate limitations: `docs/BABYLON-COLOR-AUDIT.md`.

Local immutable before viewer:
`http://127.0.0.1:5210/ff14-web-babylon-preview/?viewer=1&scene=e3t1`

Local candidate after viewer:
`http://127.0.0.1:5211/ff14-web-babylon-preview/?viewer=1&scene=e3t1`
