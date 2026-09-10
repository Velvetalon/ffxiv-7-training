# Map Position Checker

`scripts/check-map-position.mjs` compares the runtime scene package with an
independent, source-backed layout export. It reads manifests plus raw LGB/SGB
layout files only; it does not load GLB geometry, images, browser sessions or
per-map logs.

## Reference paths

- Source tree: `G:\\FFXIV-MapTools\\exports`
- Installed source client: `G:\\WeGameApps\\rail_apps\\ffxiv(2000340)`
- Source client version: `2026.09.01.0000.0000`
- Runtime pointer: `public/extracted/active.json`
- Runtime release: `public/extracted/world/20260909T124255Z-e3ea44/`
- Source provenance: raw `level/bg.lgb`, nested `.sgb` files, terrain layout,
  source `manifest.json`, and source model export from the independent
  `FFXIV-MapTools` tree.

The checker rejects a source/runtime manifest that resolves to the same file
and reports `reference-unavailable` rather than claiming `PASS` when the raw
source tree is missing.

This proves export consistency with the selected raw layout, not complete
in-game placement/visibility parity. Euler XYZ, festival-layer filtering and
the generic aetheryte visual follow the current export conventions. Shared
mistakes in those conventions, game-state-dependent visibility, shader vertex
displacement and a missing renderer parent transform require separate evidence.

## Commands

```powershell
node scripts/check-map-position.mjs gridania --focus=abnormal-only
node scripts/check-map-position.mjs all --focus=abnormal-only
node scripts/check-map-position.mjs all --coordinate-threshold=0.05 --rotation-threshold=0.002 --scale-threshold=0.002
```

Default output is a compact JSON report at
`work/map-position/check-map-position-<scene>.json`. Use `--out=FILE` when
the workspace volume is full or when a CI job owns a separate artifact
directory.

The optional `--runtime-state=FILE` input accepts a runtime mesh snapshot:

```json
{
  "meshes": [
    {
      "sourceAsset": "bg/.../model.mdl",
      "sourceInstanceIndices": [0, 4],
      "matrices": [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 0, 4, 1], [ ... ]]
    }
  ]
}
```

For LOD meshes, `sourceAsset` and `sourceInstanceIndices` are the identity
contract. The checker never treats a transient LOD slot or browser instance
index as the source instance ID. Without a runtime snapshot it compares the
published scene manifest matrices in source order.
Multiple primitives for the same source instance are deduplicated; disagreeing
transforms are reported. A missing explicitly requested snapshot never falls
back to the manifest. Runtime snapshots are scoped to one map.

## Classification

- `coordinate`: world-position delta exceeds the coordinate threshold.
- `parent`: the expected placement is nested and the runtime transform is
  close to the child-local transform rather than the composed source transform.
- `rotation`: rotation delta exceeds the radians threshold.
- `scale`: per-axis scale delta exceeds the scale threshold.
- `resource`: source/runtime asset or placement counts differ.
- `invalid-transform`: a matrix is not 16 finite numeric elements.
- `conflicting-transform`: primitives for one source instance disagree.

Normal placements are counted but omitted from the report. Each anomaly keeps
the source asset, source index/instance ID, source file and parent chain,
expected/actual position, and measured deltas for a targeted follow-up.
Console output is capped at 20 example anomalies and includes the total and
detail path. `--focus=abnormal-only` also omits passing maps from the detail file.

## Verification evidence

The current installed source set covers all 65 catalog scenes. The full scan
completed successfully with 65 checked maps, zero reference gaps, zero runtime
gaps and zero anomalies. A synthetic runtime-state test moved one Gridania
placement by 5 units and produced exactly one `coordinate` anomaly; the source
reference remained unchanged.
