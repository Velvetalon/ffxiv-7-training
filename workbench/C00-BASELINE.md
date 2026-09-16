# C00/C01 Baseline Report (root-executed after WS-001 429)

## Context

- Branch: `v7-customization-npc` at `65255c1d5` (+ this commit).
- Worktree: `D:/Code/ffxiv-7-training-v7` (created for this task; E: worktree attempt abandoned due to exec timeout + low disk).
- LunaMax (WS-001) errored with upstream `429 Too Many Requests`; per user fallback rule the coordinator executed the work directly. No other executor used.

## Existing entry-point map

- Normal user entry (Three.js app): `src/ui/SandboxPanel.js` (`data-appearance-file`) -> `src/main.js` `importAppearance` -> `parseFfxivCharaDat(WithPalette)` -> `reloadCharacter` -> `CharacterRuntime.loadDefinition`.
- Developer panel entry: `src/ui/developer/DeveloperPanel.js` (`data-dev-dat`) -> `DeveloperRuntime.run('character.import')` -> same `importAppearance`.
- Babylon preview uses `preview/babylon/character/**` adapters; the parser is shared from `src/character/appearance/FfxivCharaDat.js` (wrapper re-export).
- Only one character generator exists; no duplicate second generator found.

## Target DAT

- Path: `D:/OneDrive/codex/FFXIV_CHARA_40.dat` (read-only), 212 bytes.
- SHA-256: `15620f24f8b47cea3d421aed5bb1b1aaff199142baff4edfcfa26e06fc7d2062`, version 5, description `我的猫`.
- Parsed: Miqo'te Seeker of the Sun feminine, face 3 / hair 151 / skin 24 / eyes L105 R35 / hair color 91 / highlight 104, model family `c0801` (see `work/ws001/parsed-target-dat.json`).

## Defect classes found (ranked)

1. Fresh DAT imports resolved colors against a single pre-baked manifest palette; any palette index other than the baked one silently kept wrong skin/hair/eye colors. Fixed by `parseFfxivCharaDatWithPalette` + exact `human.cmp` palette resolution at parse time.
2. The Babylon appearance adapter preferred the indexed binding palette over the fresh palette, reintroducing wrong colors after import. Fixed by preferring the fresh DAT-resolved palette with the indexed table as compatibility fallback.
3. Sandbox manifest shipped only one character definition; imports of other race/body combinations could not resolve a model. Partially addressed: gate notes a second definition as an explicit gap; cross-body proof remains pending.
4. `human.cmp` was not exposed to the site; the browser fallback could not resolve palettes. Fixed by shipping `public/sandbox/human.cmp` and loading it via `SandboxAssets.loadCmp()`.
5. Local verification lacked a ticket-capable stand-in origin, blocking end-to-end import proof. Fixed in `scripts/workbench/local-origin.mjs` (ticket re-sign + asset route), enabling a reproducible gate replay.

## Gate evidence

- `validation/character/customization-gate.json` (status PASSED, replay VERIFIED with zero failed requests).
- Screenshot: `work/ws001/dat-import-replay.png` (post-import). Visual close-up review is pending and explicitly marked as a gap (image review belongs to a dedicated image subagent per repo policy).
- Repro: `node work/ws001/replay-dat-import.mjs` (see `work/ws001/replay-result.json`).

## Next

- C02 parameter capability table + edit policy (PLAYER_EDIT vs SOURCE_RECONSTRUCT).
- Add at least one cross-body definition sample before NPC batch build (gate gap).
