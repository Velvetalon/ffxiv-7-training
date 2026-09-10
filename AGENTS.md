# Project workflow

- The coordinating agent must not read, load, display, or decode images. Pass image paths to a subagent for any image operation, including screenshots and visual verification. Subagents return text findings and artifact paths only, never images or base64.
- Keep runtime asset references relative. Verify the built application under `/ff14-web/`, including redirecting `/ff14-web` to its trailing-slash form.
- `site/` is the committed, ready-to-run build. After runtime changes, rebuild it and verify it without `node_modules` or an installed game client before pushing.
- `public/extracted/world/` contains versioned full-world packages; `bundled/` retains the initial two cities. Keep raw client files, intermediate exports, old staging releases, credentials and `work/` out of Git.
- The full world catalog has 65 scenes and the source-derived graph currently has 145 directed connections. Verify full catalog coverage and endpoint provenance; do not use a partial-map check to claim world completion.
- Use the existing combat, camera and map checks. Do not add redundant tests for trivial changes.
- Follow `docs/REGRESSION-VALIDATION-STRATEGY.md` for every change. Ordinary changes run automatically selected impacted maps plus the fixed representative smoke set; major Asset/Renderer/shared-runtime changes run smoke plus automated full regression; releases and major milestones run automated full regression.
- Calculate impacted maps from the asset dependency graph, code dependencies, and changed files, including deleted/renamed resources and shared dependencies. Unknown impact must be reported and conservatively expanded; do not silently omit maps.
- Full-map validation is a script job, never a coordinating-agent walkthrough. Do not have the main agent load, observe, or analyze every successful map, or poll after each map. Native scripts write detailed logs and progress locally; the main agent receives only completion/failure summaries, regressions, outliers, and failed-map IDs.
- Investigate detailed logs/screenshots only for failures or outliers. Keep all image operations with subagents as required above. Successful map details stay on disk and must not be pasted into model context.
- Keep a stable, documented 5–10 map representative smoke set in `config/map-regression.json`. Record load success, visible first render, TTI, missing assets, JS/runtime/GPU errors, sampled memory peak, and key resource counts. Generate screenshot/image-diff evidence only when relevant.
- Compare performance only against a compatible, identified baseline; distinguish unmeasured metrics and incomplete coverage from passes. Cache state, artifact fingerprints, device/browser and concurrency must be recorded. Parallel functional runs are not comparable performance baselines.
- Server-specific connection information belongs in ignored `work/deployment/`. Preserve other applications on the server and keep a previous deployment for rollback.
