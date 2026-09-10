# Developer Validation V3

The locally validated v2 source and Sandbox packs were frozen in commit
`1f4f6d52b4844012a8f78f0b3911a88ec86fb741`. This is a local baseline,
not a deployment or human visual approval. The previous production `site/`
artifact remains unchanged.

## Scope

This iteration adds inspection and direct runtime controls, a compact debug
overlay, content-coverage diagnostics, browser preferences and loading/retry
feedback. It reuses the current AssetRuntime, renderer, character, animation,
mount, audio and environment APIs.

Visual fidelity changes are out of scope until human feedback. Only confirmed
crashes, broken references, missing assets and invalid mappings justify a core
fix discovered during this iteration.

## Workstreams

| Workstream | Model | Ownership |
| --- | --- | --- |
| Local v2 baseline | Luna-Max | Git baseline only |
| Developer panel and debug overlay | Luna-Max | New developer UI and styles |
| Runtime bridge, session preferences, loading feedback | Luna-Max | New adapters around existing APIs |
| Coverage scanner and anomaly reports | Luna-Max | Deterministic offline scanning |
| Developer interaction and acceptance | Luna-Max | Focused UI checks and one Fast Validation run |
| Integration | Coordinator | Main entry points and adapter review |

No high-tier escalation is planned for the initial bounded tasks.

One confirmed lifecycle bug was fixed in the existing audio runtime:
stop now ends active SFX and invalidates pending SFX/BGM playback. This does
not change audio content, timing data, rendering or visual fidelity.

## Acceptance

Use the existing lightweight all-map smoke once, followed by focused developer
UI interaction and reload checks. Confirm direct map, character, animation,
skill, mount, audio and time controls; compact overlay; generated diagnostic
files; and persisted preferences. Do not rerun v2 visual fidelity experiments
or manufacture new rendering fixes.

Coverage counts describe imported and parsed project content, not all content
in the installed FFXIV client. Missing implementation coverage and broken
references must be reported separately. Normal resource entries stay out of
console summaries.

Human visual approval remains tracked separately in
`HUMAN-VISUAL-ACCEPTANCE.md`.

## Final Acceptance

- Baseline: `1f4f6d52b4844012a8f78f0b3911a88ec86fb741` (local v2 source and Sandbox freeze).
- Focused developer validation: `PASS`, 23/23 checks across Gridania and Limsa. This covered the seven-tab toolbar, Chinese map search and XYZ teleport, CharacterAppearanceData/reload/DAT import, preset and direct animation playback, direct skill presentation/audio, mount preview and ground/flight lifecycle, BGM/SFX and volume, environment time/pause/profile/parameters/reset, live overlay fields, same-origin preferences after reload, and a visible loading error with successful retry. Evidence: `work/v3-validation/report.json`.
- Fast Validation: the single authorized run passed all 65 smoke maps (`65/65`, zero fail/timeout) and all four fixed representatives (`4/4`, zero fail/timeout), with `154216 ms` wall time and zero agent exceptions. Evidence: `work/v3-fast-validation/result.json`.
- Coverage diagnostics: `work/diagnostics/summary.json` reports `errors: 0`, 65 parsed/static-resolvable maps, and 79 warning-only expected animation coverage gaps. The requested anomaly files are `missing_assets.json`, `invalid_mappings.json`, `position_outliers.json`, `animation_gaps.json`, and `mount_gaps.json`; `audio_gaps.json` is also emitted. Runtime evidence points to `work/v3-fast-validation/result.json`.
- Tool UI acceptance: the same V3 build passed desktop and mobile text-bound checks, panel close control, overlay toggle control, and nonblank canvas/runtime render checks. Evidence: `work/v3-validation/ui-acceptance.json`. This is a developer-tool UI check, not v2 visual-fidelity approval.
- Model usage: five Luna-Max bounded workstreams (baseline, panel/overlay, runtime bridge/preferences/feedback, coverage, validation); zero high-tier escalations.
- Local services: V3 is available at `http://127.0.0.1:61623/ff14-web/` in hidden background process PID `41252`. The prior v2 service remains preserved at `http://127.0.0.1:56515/ff14-web/` (PID `27204`).
