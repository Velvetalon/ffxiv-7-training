# Ordered Resume Actions

Execute from `G:/UGit/ffxiv-7-training`. Do not deploy. Do not restart geometry; all 531 package states are complete.

## 1. Rebuild Local Preview Release

The historical federation/QA directories are absent locally. Use the installed client at `G:/WeGameApps/rail_apps/ffxiv(2000340)` and the regenerated `work/duty-build/analysis-active/active.json`.

- Regenerate `g3fb` and `n4gb` with the collision fallback fix, then rebuild the full runtime catalog and reference analysis.
- Finish the bundle planner with `--expected-maps 596 --expected-connections 145`; the correct run may reuse packs under `D:/ffxiv-duty-asset-pipeline/packed` via `--reuse-from`.
- Run preview/collision chunking only after the corrected catalog and analysis are stable. Keep D: outputs outside Git.

## 2. Rerun Shard-1 Gzip Failures

The fixed union federation server is the prerequisite; do not reuse the old v3 server process. Before the next capture, fix the shard-1 helper canvas counters by moving their declarations into the same browser-evaluated scope that increments them (around line 97 of the retry script), or replace the helper with the working v5 pattern.

Then run, one PowerShell process at a time:

```powershell
$env:npm_config_cache='E:/Code/ffxiv-7-training/work/npm-cache'
$env:QA_RETRY_PORT='4535'
$env:QA_SCENES='c1w1,c1w3,e3f1,e3f3,f1f2,h1m2'
node work/qa/visual-acceptance/run-v5/shard-1-retry/capture-retry-v5.mjs
```

Expected: six ready states/screenshots under `work/qa/visual-acceptance/run-v5/shard-1-retry/state`, with zero serious console/network errors. Treat any repeated gzip SyntaxError as a server-side failure, not a scene verdict.

The failed-default npm cache may be bypassed for this QA-only command with the `npm_config_cache` assignment shown above. Do not edit repo proxy or npm configuration.

## 3. Re-capture And Isolate g3fb

Run the corrected helper separately:

```powershell
$env:npm_config_cache='E:/Code/ffxiv-7-training/work/npm-cache'
$env:QA_RETRY_PORT='4536'
$env:QA_SCENES='g3fb'
$env:QA_REPEATS='2'
node work/qa/visual-acceptance/run-v5/shard-1-retry/capture-retry-v5.mjs
```

If both attempts still report `g3fb bootstrap produced no Babylon geometry`, diagnose in this order: inspect the g3fb map manifest under `D:/Cache/duty-asset-pipeline/union-596-v2`; compare its model/collision routes against a neighboring passing g3 scene; and use a bounded Playwright probe to log the first failed route and console stack. Do not rebuild all 531 scenes for one bootstrap failure.

## 4. Diagnose The Two Shard-2 Residuals

- n4f1: geometry and interaction capture are present, but movement did not change player position. Re-run n4f1 with the v5 interaction contract, then compare spawn/collision input and player coordinates with a passing public app scene such as limsa.
- n5r9: readiness timed out with no mesh evidence. Re-run n5r9 through the fixed server, then inspect its exact manifest/model routes in `routes.json` and loader failure samples before changing source data.

## 5. Score Existing Screenshots In Small Batches

Existing acceptable evidence includes shard-1 v3 53 screenshots, shard-2 v4 58 ready screenshots, and shard-3 v5 60 ready screenshots. Inspect in batches of at most 10 images. Pass image paths to an image-capable subagent; the coordinator must not load or decode images. Record per-image verdicts in a new text/JSON evidence file under `work/qa/visual-acceptance`, not in Git.

If direct-reference matching is revisited, distinguish 69 matched references from 111 `none` references and never count Xivapi banners as runtime screenshots. Keep metadata files read-only unless the matching script is explicitly rerun.

## 6. Close SC-004 Only After All Evidence Is Explicit

SC-004 can close only when every one of the 180 scene positions has an explicit accepted/source-backed-unavailable outcome:

1. six shard-1 gzip failures re-captured and accepted or root-caused;
2. g3fb accepted or root-caused;
3. n4f1 interaction accepted or root-caused;
4. n5r9 readiness accepted or root-caused;
5. all 180 captures scored in small batches, with 69/111 reference metadata treated as search metadata only.

Produce separate totals for accepted, source-backed unavailable, parser/tooling failure, and intentionally unimplemented work. Do not average away failures.

## 7. Selective Commit And Push Baseline

The delay snapshot update must be staged/committed by the explicitly whitelisted selective process. Future commits remain limited to source, compact catalogs/evidence, and delay documentation. Never stage `work/`, logs, screenshots, federation scripts, `D:/Cache`, node modules, or unrelated files. Do not force-push, reset, checkout, or discard work.

Before a future source commit, rerun:

```powershell
node --check scripts/assets/build-pipeline.mjs
node --check scripts/assets/bundle-planner.mjs
node --check preview/babylon/World.js
node tests/duties/runtime.test.mjs
node tests/audio/run.mjs
node tests/audio/public-entry.mjs
```

Run `npm run build:babylon` only when disk headroom and changed runtime surface justify it; set `npm_config_cache=E:/Code/ffxiv-7-training/work/npm-cache` if the default cache again fails.

Push using only the explicit per-command proxy:

```powershell
git -c http.proxy=http://127.0.0.1:7890 push origin master
```

If origin/master has advanced, stop and report the exact divergence. Do not rebase or overwrite. Deployment remains forbidden for this task.
