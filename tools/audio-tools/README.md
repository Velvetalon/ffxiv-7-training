# Offline FF14 audio extraction

This tool reads real client SCD data without modifying or scanning the game
installation. It deliberately uses the existing `tools/map-tools/MapExtract.cmd
raw` boundary to copy a scene's `level/sound.lgb`, then uses the community
Lumina SCD parser to resolve its `SoundInstanceObject.AssetPath`, decrypt
OggVorbis payloads, and emit browser-ready `.ogg` files plus loop metadata.

```powershell
.\extract-audio.ps1 `
  -Client 'G:\WeGameApps\rail_apps\ffxiv(2000340)' `
  -Scene gridania,limsa `
  -LuminaRoot 'G:\FFXIV-MapTools\Lumina' `
  -MapExtract 'G:\FFXIV-MapTools\MapExtract.cmd'
```

`ScdExtract.csproj` references the pinned local Lumina checkout at invocation
time; no game client files or third-party checkout are copied into this repo.
`ScdFile.GetAudio()` performs the community parser's SCD XOR decryption. OGG
payloads are written as-is after that verified decode, preserving source
samples; MP3 is also retained when present. MS-ADPCM/ATRAC9 records are
reported as unsupported instead of being mislabeled as WAV.

Output `audio-source-manifest.json` records:

- scene -> selected BGM resource (music/loop flags come from `SoundBasicDesc`);
- resource hash, bytes, MIME, channel/rate and loop start/end seconds;
- source SCD path, sound index, audio index and local number;
- all `sound.lgb` references and extraction errors.

The checked-in `scene-bgm.json` is deliberately evidence-only for the current
client: TerritoryType 132/129/130 resolve through BGMSituation 1003/1020/1035
to BGM rows 6/25/44 and the three named client SCDs. On client version
`2026.09.01.0000.0000` those music files use `dataType=26` with `comp/rciph`
chunks; the pinned community parser does not decode that cipher, so the tool
records `Unknown` and never emits the ciphertext as playable audio.

For current HCA music (`dataType=26`), pass the open-source VFXEditor
`VGAudioCli.exe` path as `-VGAudio`. Pass its `oggenc2.exe` as `-OggEnc` to
publish compact browser OGG instead of a large intermediate WAV. Without the
HCA converter the extractor records `Unknown` and never publishes ciphertext
as playable audio.

The scene BGM manifest is source evidence for the generic Asset Runtime
packer. It is not a replacement for the packed runtime manifest: the packer
must assign `resources[id]` bundle offsets and merge `sceneBgm` into its final
manifest. Action/Skill `SoundID` mappings stay `Unknown` until Action EXD/EXH
rows and the corresponding SCD source are verified; this tool never invents
IDs from keyboard or UI action names.

For the source-derived world catalog, run `extract-daytime-bgm.ps1` after
`probe-scene-bgm.ps1`. It batches unique daytime SCD paths once and writes
deduplicated `sceneBgm` references for all 65 catalog scenes. Rows whose
current-client BGM EXD row is absent remain Unknown; `BGM_Null` is recorded as
confirmed no playback.

## Browser action audio

Action SCD records may decode as valid MS-ADPCM WAV files. Chromium Web Audio
does not accept that codec through `decodeAudioData`, so keep the extracted WAV
as source evidence and create a PCM derivative before packing. The converter
accepts repeatable input/output pairs and can rewrite the partial manifest while
preserving its old resource keys for the packer's alias remap:

```powershell
node tools/audio-tools/convert-msadpcm.mjs `
  --manifest=public/extracted/sandbox/manifest.skill-sfx.partial.json `
  --input=public/extracted/sandbox/audio/afflatus-misery-caster.wav `
  --output=public/extracted/sandbox/audio/afflatus-misery-caster.pcm.wav `
  --input=public/extracted/sandbox/audio/afflatus-misery-target.wav `
  --output=public/extracted/sandbox/audio/afflatus-misery-target.pcm.wav
```

Then rebuild the sandbox release from the rewritten partial manifest. Do not
feed the original MS-ADPCM files directly to the browser runtime:

```powershell
node scripts/assets/build-sandbox.mjs `
  --inputs=public/extracted/sandbox/manifest.character.partial.json,public/extracted/sandbox/manifest.mount.partial.json,public/sandbox/audio/manifest.ready.audio.partial.json,public/extracted/sandbox/manifest.skill-sfx.partial.json `
  --out=work/sandbox-release-final `
  --cdn-base=https://img.yuluo.site/ff14-assets/v1/
```

The current partial skill manifest points to the PCM derivatives and records
`sourceFormat: MS-ADPCM WAV` plus the conversion note. The original ADPCM files
remain alongside them as source evidence; `public/sandbox/audio/` is raw,
ignored delivery input and is not part of the packed runtime output.

The converter walks RIFF chunks structurally, including the known malformed
two-byte-long MS-ADPCM `fmt` advertisement in these client exports. It emits
the block's newer `sample2` PCM sample before `sample1`, matching the
independent FFmpeg decoder; do not replace it with a header-only codec label.
