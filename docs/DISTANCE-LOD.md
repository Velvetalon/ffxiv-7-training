# Distance Mesh LOD

The first version reduces static-map triangles at runtime without rebuilding
or republishing the existing map packs. It does not claim reduced downloads:
the original source geometry is still loaded through AssetRuntime.

## Operation

- `DistanceLod` attaches to the progressive scene, not to the character or mount.
- Meshoptimizer 1.2.0 generates two index-only variants in one Web Worker.
  Targets are 55% and 25% of original indices, constrained by topology, locked
  borders, attribute error and positional error. Actual reductions may be smaller.
- Original positions, normals, UV sets, vertex colors and blend weights remain
  shared. Material bindings never change when the index buffer changes.
- Instances are partitioned into three meshes by distance to their transformed
  bounding sphere, with thresholds 65/150 and 12% hysteresis by default.
- Small meshes, transparent surfaces and skinned geometry remain unchanged.
  Nearby map instances retain full geometry and cast shadows.
- Worker preparation is bounded to two requests per 250 ms update and begins
  after the world is updating. Failed simplification retains the original mesh.

The source GLB owns the cached derived geometry. AssetRuntime releases it with
the source; a scene keeps only its instance partition and its existing resource
references. `sourceInstanceIndices` retains the original manifest instance ID
for position diagnostics after partitioning.

## Diagnostics

`world.assetScene.lod.stats` reports managed instance counts, source/rendered
triangles, counts per distance level, and simplification errors. Set
`world.assetScene.lod.enabled = false` for a local full-detail comparison.
This is a diagnostic switch, not a new settings screen.

Numeric checks cover reduction and hysteresis. Release acceptance also requires
one actual near/far camera observation and an unchanged instance total; numeric
counts alone do not prove an acceptable visual transition.

## Extension

Distance thresholds are constructor options. The same per-instance partition
can later consume prebuilt, content-addressed LOD resources when the packer
provides them. No second fetch/cache/decoder hierarchy is introduced.
