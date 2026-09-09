# Project workflow

- The coordinating agent must not read, load, display, or decode images. Pass image paths to a subagent for any image operation, including screenshots and visual verification. Subagents return text findings and artifact paths only, never images or base64.
- Keep runtime asset references relative. Verify the built application under `/ff14-web/`, including redirecting `/ff14-web` to its trailing-slash form.
- `site/` is the committed, ready-to-run build. After runtime changes, rebuild it and verify it without `node_modules` or an installed game client before pushing.
- `public/extracted/bundled/` contains the two deployment map snapshots. Keep raw client files, intermediate exports, old releases, credentials and `work/` out of Git.
- Use the existing combat, camera and map checks. Do not add redundant tests for trivial changes.
- Server-specific connection information belongs in ignored `work/deployment/`. Preserve other applications on the server and keep a previous deployment for rollback.
