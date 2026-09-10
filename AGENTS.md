# Project workflow

- The coordinating agent must not read, load, display, or decode images. Pass image paths to a subagent for any image operation, including screenshots and visual verification. Subagents return text findings and artifact paths only, never images or base64.
- Keep runtime asset references relative. Verify the built application under `/ff14-web/`, including redirecting `/ff14-web` to its trailing-slash form.
- `site/` is the committed, ready-to-run build. After runtime changes, rebuild it and verify it without `node_modules` or an installed game client before pushing.
- `public/extracted/world/` contains versioned full-world packages; `bundled/` retains the initial two cities. Keep raw client files, intermediate exports, old staging releases, credentials and `work/` out of Git.
- The full world catalog has 65 scenes and the source-derived graph currently has 145 directed connections. Verify full catalog coverage and endpoint provenance; do not use a partial-map check to claim world completion.
- Use the existing combat, camera and map checks. Do not add redundant tests for trivial changes.
- Server-specific connection information belongs in ignored `work/deployment/`. Preserve other applications on the server and keep a previous deployment for rollback.
