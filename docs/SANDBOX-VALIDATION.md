# Sandbox Validation

Status: PASS, 2026-09-10. This is the compressed local proof for the final
sandbox release. It does not replace the release manifest or the source
provenance documents.

## Release

- Original packed release: `work/sandbox-release-final/`
- Corrected audio-only release: `work/sandbox-release-final-audiofix/`
- Local runtime copy: `public/sandbox/`
- World source release: `work/asset-performance/packed-all-final/`
- Fast-validation result: `work/sandbox-fast-validation/result.json`
- Raw audio remains in ignored `public/sandbox/audio/`; runtime packs contain
  the browser-compatible audio resources.

The final sandbox manifest contains 64 resources and 33 bundles: one character,
one mount, 65 scene-BGM entries, and one semantic skill-SFX definition.
`public/sandbox/manifest.json` uses local relative pack URLs;
`public/sandbox/manifest.cdn.json` uses the `ff14-assets/v1` CDN URLs; the
hashed manifest and `publish-manifest.json` are present beside them.

## Automated Summary

The one required `npm run validate-fast` run used the Node 24 runtime, the
existing Playwright package, and the final world release. It ran before the
later audio-only sample-order correction; the correction was verified by the
targeted proof below and did not trigger another full smoke or fixed-four run.

| Scope | Maps | Pass | Fail | Timeout | Sum / mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full smoke | 65 | 65 | 0 | 0 | 204147 ms / 3141 ms |
| Fixed representatives | 4 | 4 | 0 | 0 | 17399 ms / 4350 ms |

The complete run took `140468 ms`, with zero agent exceptions. Fixed IDs were
`gridania`, `x6f2`, `y6f1`, and `d2t1`; no additional maps were expanded.

## Source Chain and Audio

Pack-level hashes, the skill-to-GLB mapping, independent decoder comparison,
browser decode, and live action-cue proof are in
`work/sandbox-release-final-audiofix/audio-proof.json`. The action chain is:

- `whm-afflatus-misery` -> `skill-whm-afflatus-misery`
- real skill animation GLB: `glb:sha256:12a6399f997b060f651ca01f801c271986e7641001c51853311937b697c22b02`
- caster cue: `audio:sha256:4377c48740ba99310b515a06d0e724123986544b149aef6d632c1b057964c2ae`
- target cue: `audio:sha256:f397fe028e3bac60c6d1f67f8b4373667b9763e1e6291a303d0017cf77fd3b9e`
- cue timing: caster `0` seconds, target `0.3` seconds

FFmpeg 21.7 independently decoded repaired copies of the malformed source
headers. Both corrected packed PCM payloads are byte-identical to FFmpeg:
`diffBytes: 0` for caster and target. Both packed PCM16 WAV slices also decode
in real Chrome Web Audio; the browser reported approximately `2.463375 s` and
`3.482896 s` at its `48000 Hz` output rate. The targeted live Gridania probe
observed the `whm-afflatus-misery` animation state, a running audio context,
two action `AudioBufferSourceNode.start()` calls, and cue delays `[0, 0.3]`.

The local source partial now points to
`audio/afflatus-misery-caster.pcm.wav` and
`audio/afflatus-misery-target.pcm.wav`, while preserving the original
MS-ADPCM source files and provenance metadata. Re-extraction must run
`tools/audio-tools/convert-msadpcm.mjs` before `build-sandbox.mjs`; see
`tools/audio-tools/README.md`.

The converter uses a structural RIFF chunk walk that tolerates the known
two-byte-long MS-ADPCM `fmt` advertisement and emits the newer `sample2` PCM
sample before `sample1`, matching FFmpeg's block decoder. The corrected
manifest and packs are the audio-fix release above.

## Fixed-Four Observation

The text report and four scoped screenshots are in
`work/sandbox-fast-validation/fixed4/report.json`:

These observations belong to the earlier full fast-validation run; the later
audio-only correction changed no world, character, mount, or material payload,
so it was verified with the targeted audio proof instead of repeating these
four map observations.

- `gridania`: 1280/1280 textured materials loaded, movement `2.511`, camera
  delta `0.294`; populated New Gridania scene and visible client character.
- `x6f2`: 225/225 textured materials loaded, movement `2.457`, camera delta
  `0.294`; dark, low-contrast Heritage Found lighting but populated geometry
  and no blank or missing-core-resource symptom.
- `y6f1`: 492/492 textured materials loaded, movement `2.566`, camera delta
  `0.294`; populated Urqopacha scene with terrain, vegetation, and character.
- `d2t1`: 1064/1064 textured materials loaded, movement `2.538`, camera delta
  `0.294`; populated Idyllshire scene with terrain, structures, and character.

Earlier Gridania feature proof remains in
`work/sandbox-feature-gridania.json`: DAT appearance matching and stable
customization scale, day/night lighting and paused time, HUD save/restore,
mounted ground/flight/landing/dismount flow, and BGM playback. The final
fixed-four pass rechecked character source, loaded materials, movement, camera,
and the source-owned action SFX path without repeating the full feature flow.

## Limits

- The character partial includes idle, walk, run, joy, and the traced skill
  clip. Dedicated `turn-left`/`turn-right` clips are not present and are not
  claimed; runtime movement and camera turning were observed.
- Client material mapping remains an approximation for proprietary lighting and
  subsurface behavior; the fixed-four scenes showed loaded maps and no critical
  material/geometry failure.
- Visual observation is limited to the four fixed representatives; no
  all-screenshot or repeated full regression was run.
