# Developer Panel Runtime Contract

`DeveloperPanel` and `DebugOverlay` are intentionally UI-only. The root runtime injects a small bridge when constructing the panel:

```js
const developerRuntime = {
  getSnapshot() { return snapshot; },
  run(command, args) { return dispatchDeveloperCommand(command, args); },
};
const developerPanel = new DeveloperPanel({
  root: document.querySelector('#app'),
  controller: { developerRuntime, developer: { state: savedState } },
  onStateChange: state => saveSettings({ developer: { state } }),
});
const debugOverlay = newDebugOverlay({ root: document.querySelector('#app') });
```

The root may call `panel.update(snapshot)` and `overlay.update(snapshot)` at a low UI cadence (four times per second is sufficient). Updates are incremental and preserve focused input values.

## Commands

`run(command, args)` receives these command names. IDs in `args` are always the IDs supplied by the snapshot; absent values are left empty and rendered as `未知`.

| Command | Arguments |
| --- | --- |
| `map.switch` | `{ mapId }` |
| `map.teleport` | `{ position: { x?, y?, z? } }` (the panel switches maps first when needed) |
| `character.reload` | `{}` |
| `character.import` | `{ fileName, file: File }` |
| `animation.play` | `{ animationId }` |
| `skill.trigger` | `{ skillId }` |
| `mount.spawn`, `mount.mount`, `mount.dismount`, `mount.takeoff`, `mount.land` | `{ mountId }` |
| `audio.bgm` | `{ sceneId }` |
| `audio.stop` | `{ bgmOnly?: boolean }` |
| `audio.sfx` | `{ resourceId }` |
| `audio.settings` | `{ sound?, volume? }` |
| `environment.time` | `{ hour }` |
| `environment.profile` | `{ profile }` |
| `environment.parameters` | `{ parameters: { sunMultiplier?, ambientMultiplier?, fogMultiplier?, exposureMultiplier? } }` |
| `environment.reset` | `{}` |

A successful command may return `{ ok: true, snapshot, message }`; failures should return `{ ok: false, reason }`. The bridge can omit `snapshot` when a later runtime tick will provide it.

## Snapshot shape

The UI accepts the compact runtime names below and tolerates omitted sections. Arrays may also be ID-keyed objects.

```js
{
  maps: [{ id, name, region, position }],
  scene: { id, name, region },
  recent: [mapId],
  player: { position, modelId, movementMode },
  character: {
    modelId, appearanceId,
    appearance: { id, race, sex, face, hair, materialIDs, raw },
    materialIDs, actionId, mount,
  },
  animations: { current, ids },
  skills: [{ id, name, animationId, vfxId, soundId }],
  mounts: [{ id, name, modelId, skeletonId, animationId }],
  mount: { current, state },
  audio: {
    bgm: [{ id, name, resourceId, mapId }],
    sfx: [{ id, name, resourceId, resource }],
    currentBgm, settings: { sound, volume },
  },
  environment: { profile, profiles, params, time: { hour, day, paused }, manualOverrides },
  debug: { playerPosition, cameraPosition, lod, cache },
  loading: { active, error, stage },
}
```

The `controller.developer.state` object stores `{ open, tab, overlay }`. `onStateChange` is called whenever any of those values changes, so the root can persist it with the existing preferences mechanism.
