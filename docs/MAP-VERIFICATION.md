# Map tools verification summary — 2026-09-09

## Final active resource set

- Source full-batch run: `20260909T105118Z-43c2c6`; client version `2026.09.01.0000.0000`.
- The full run rebuilt both maps from the installed client, then completed staged verification and publication: Gridania 699 models / 2,452 placements / 147 materials / 0 errors; Limsa 771 models / 7,024 placements / 253 materials / 0 errors.
- Active pointer now retains that run ID and points to `bundled/gridania/` and `bundled/limsa/`. Its SHA-256 is `eb667135cb1bdb5bb1256760d333822e8c21470c91c91a2fce1967f4c24cc06e`.
- No old release directory was deleted. Bundles contain only `map.png`, `scene.json`, `collision.bin`, `collision-report.json`, `models/`, and `textures/`.

| Scene | Files | Bytes | `scene.json` SHA-256 | Largest file |
| --- | ---: | ---: | --- | --- |
| Gridania | 996 | 151,981,323 | `ee394f7b052bf7168b0ff31101a68442e9eacedbd24b361a408d3308401d7af4` | `collision.bin`, 3,546,648 bytes |
| Limsa | 1,275 | 248,163,445 | `d46d2807f2566133034a6871c03eff24c567eceb16de196f8038856235cfc672` | `collision.bin`, 8,174,952 bytes |
| Total | 2,271 | 400,144,768 | — | Limsa `collision.bin`, 8,174,952 bytes |

All runtime paths in the active pointer and bundled metadata are relative. No manifest rewriting was required because neither active `scene.json` nor `collision-report.json` contained absolute paths; runtime model and texture URLs were already relative. The copied manifest bytes retain the hashes above.

`scripts/verify-extracted.mjs` passed through the final bundled active pointer: Gridania 1,862 primitives / 651,983 vertices / 98,518 collision triangles; Limsa 2,871 primitives / 1,243,532 vertices / 227,082 collision triangles.

## Pipeline behavior

- Selection and no-publish: source entry `batch_rebuild.py --scenes gridania --skip-extract --no-publish` passed in a disposable external project (`20260909T114136Z-1ac2f7`). It rebuilt and validated 699 models / 2,452 placements / 147 materials / 0 errors and did not change that project's `active.json`.
- Failure retention: an intentionally failing staged verifier (`20260909T114228Z-72c2eb`) failed after build, conversion, assembly and collision baking. Its independent stage was retained, its report state was `failed`, and the pre-existing `active.json` hash was unchanged.
- The isolated `verification-scratch/` test directory remains local because the environment blocked its cleanup operation; it is ignored and is explicitly excluded from the source-package list.
- Toolchain resolution: without `--node`, the batch selected Codex Node `v24.19.0`; fallback is PATH Node 20+. .NET selects `dotnet/dotnet.exe` when present, otherwise a PATH .NET 10+ SDK. Missing both `--client` and `FFXIV_CLIENT` is rejected before any project output is created.

## Independent raw-source audit

`verify_source_data.py` independently parses LGB/SGB layouts, builds `Rx * Ry * Rz * Scale` transforms, expands shared groups, and compares against the active source release. It does not import the assembler.

- Gridania: 699 assets, 2,452 placements; maximum matrix absolute error `8.881784197001252e-16`; all 699 release GLBs are byte-identical to their raw exported GLBs.
- Limsa: 771 assets, 7,024 placements; maximum matrix absolute error `2.220446049250313e-16`; all 771 release GLBs are byte-identical to their raw exported GLBs.
- Gridania UV/color coverage: `TEXCOORD_0` 1,862 primitives / 651,983 vertices; `TEXCOORD_1` 1,793 / 651,205; `TEXCOORD_2` and `_3` 5 / 487 each; `COLOR_0` 677 / 84,410.
- Limsa UV/color coverage: `TEXCOORD_0` 2,871 primitives / 1,243,532 vertices; `TEXCOORD_1` 2,858 / 1,232,318; `TEXCOORD_2` and `_3` 6 / 1,007 each; `COLOR_0` 1,037 / 320,314.

## Portable source package

Copy these source files/directories into `tools/map-tools`:

```text
MapExtract/
assemble_scene.py
batch_rebuild.py
bootstrap-map-tools.ps1
build.ps1
collision_mesh.py
MapExtract.cmd
run-mapextract.ps1
toolchain.ps1
rebuild-client-maps.ps1
requirements.txt
verify_source_data.py
README.md
THIRD-PARTY.md
LICENSE-Meddle.txt
.gitignore
```

Do not copy `Meddle/`, `dotnet/`, `bin/`, `nuget/`, `exports/`, `logs/`, `assembled/`, client assets, or research/reference checkouts. Run `bootstrap-map-tools.ps1` after checkout: it fetches the exact Meddle commit `7ef61f44f82c6363465d46b46e963a054d431c16`, checks it out detached, and builds with locked NuGet restore. Meddle licensing and the exact dependency policy are recorded in `THIRD-PARTY.md`.

Final source build: passed with .NET SDK 10.0.401 and locked restore; upstream Meddle emitted two existing nullable/unused-local warnings, with 0 errors. `MapExtract.cmd help`, Python syntax compilation and batch CLI help all passed.

Python requirement: Windows Python launcher command `py -3` must resolve to Python 3.10+ (verified with 3.10.5); install `requirements.txt` with `py -3 -m pip install -r requirements.txt`. The sole Python package is `Pillow==12.0.0`.
