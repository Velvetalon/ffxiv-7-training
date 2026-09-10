# Character / World Sandbox

This phase reuses the map AssetRuntime, content-addressed packs, COS/CDN publisher and Fast Validation. It does not add a multiplayer server, account system, replication, remote-player controller or network protocol.

## Runtime boundaries

```text
InputController → movement intent → CharacterRuntime / MovementRuntime
Combat events → SkillDefinitions → ActionRuntime → Animation / VFX / Audio
DAT parser → CharacterAppearanceData → AppearanceRuntime → skinned model
Mount state → MountRuntime → mount animation / rider attachment / flight
WorldTime → EnvironmentRuntime → renderer lights / sky / fog / exposure
Gameplay snapshots → HUD; HudLayoutRuntime owns layout only
```

`CharacterRuntime` owns a stable scene root, serializable semantic state, one model view and its animation player. Player and guide NPC instances use this same class. A state source can call `applyState` without keyboard input; no remote state source is implemented in this phase.

`AnimationRuntime` selects named movement states and one-shot actions through `AnimationMixer`. Source clips are separate AssetRuntime resources. The procedural actor remains a loading/error compatibility view, not evidence that a real client model or animation has loaded.

`SkillDefinitions` keeps demo action IDs separate from source game IDs and presentation resource references. Effects and sounds are triggered by resolved combat events, not key codes. Unresolved source presentation IDs are explicit; source-specific mappings are supplied by converted data.

## Appearance

`src/character/appearance/FfxivCharaDat.js` is one input adapter for the serializable `CharacterAppearanceData`. The corresponding client mesh, skeleton, shape and material selection are supplied in the character definition. See `CHARACTER-ASSETS.md` for the verified source chain and remaining format uncertainties.

Height applies relative to the authored model scale, avoiding double scaling a model whose source appearance was baked offline. Custom bone scaling is applied after animation sampling, while its unscaled sample is restored before the next sample; the transform must not compound each frame.

The sandbox UI imports a user-selected DAT. It does not contain a hard-coded parser for a personal filename. Definitions can cover additional model families and component variants without changing the DAT parser or runtime ownership model.

## Environment and audio

`WorldTime` is independent of the renderer and can advance locally, pause, or accept external state. Environment samples use continuous interpolation. Source-backed profiles include their client version, source path and hash. See `ENVIRONMENT-SOURCES.md` for distinctions between decoded fields and browser approximations.

`AudioRuntime` registers one audio decoder on the supplied AssetRuntime. Scene BGM and action SFX share resource loading, buses and AudioContext ownership. User gestures unlock playback; scene changes replace pending playback and fade the old track. Audio source mapping and conversion are recorded in `AUDIO-SOURCES.md`.

## Mounts and HUD

`MountRuntime` uses an asset definition for the mount model, named clips and rider attachment. Grounded movement, takeoff, flying, ascent/descent and landing are semantic states. The camera consumes the rider focus height rather than assuming the raw client camera-height integer is a browser world-space distance.

`HudLayoutRuntime` stores four independent layout slots in localStorage. Draft edits support Save/Cancel, anchor-relative coordinates, drag, scale, opacity, visibility and reset. Saved layouts reapply on resize. Layout data never changes combat or character state.

## Build and publish

Partial converted-asset manifests can be merged without recopying the original game client:

```sh
node scripts/assets/build-sandbox.mjs --inputs=<character.partial.json>,<mount.partial.json>,<audio-source-manifest.json> --out=work/sandbox-release --cdn-base=https://<cdn-origin>/ff14-assets/v1/
```

The command validates input hashes, deduplicates typed resource IDs, writes indexed packs, a local manifest, a CDN manifest and `publish-manifest.json`. Raw source manifests may contain research metadata; the runtime output selects only the resource metadata and declared system mappings it needs.

For a local assembled build set `SANDBOX_RELEASE_DIR` to this output. A CDN build additionally sets `SANDBOX_CDN=1`; only `sandbox/manifest.json` is embedded in the web app. New pack objects must be added to the existing publisher/ticket allowlist before activating that web release. Original map resource objects are not rebuilt or uploaded again.

## Acceptance

Use the project Fast Validation once after integration, then inspect the fixed representative maps and the specific new feature loops. Real-asset verification must distinguish a parsed file, an evaluated skeleton clip, and a correctly rendered/controlled character.

For this phase, deployment uses the existing release procedure after local acceptance. Do not add a second online browser/benchmark campaign after deployment has reported success.
