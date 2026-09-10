import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';

const root = resolve(process.argv[2] || new URL('../..', import.meta.url).pathname);
const audioDir = resolve(root, 'public/sandbox/audio');
const sourcePath = resolve(audioDir, 'audio-source-manifest.json');
const outputPath = resolve(audioDir, 'manifest.ready.audio.partial.json');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const sceneBgm = {};
const sceneBgmEvidence = {};
for (const [sceneId, entry] of Object.entries(source.sceneBgm || source.SceneBgm || {})) {
  const id = entry?.Id ?? entry?.id ?? null;
  sceneBgm[sceneId] = id;
  sceneBgmEvidence[sceneId] = entry?.Evidence ?? entry?.evidence ?? null;
}

const sourceResources = source.resources || source.Resources || {};
const selectedIds = new Set(Object.values(sceneBgm).filter(Boolean));
const resources = {};
const missing = [];
for (const id of selectedIds) {
  const record = sourceResources[id];
  if (!record) { missing.push({ id, reason: 'resource absent from source manifest' }); continue; }
  const path = record.path || record.Path;
  const absolute = resolve(audioDir, String(path).replace(/^\.\//, ''));
  const bytes = await readFile(absolute).catch(() => null);
  if (!bytes) { missing.push({ id, reason: 'asset file missing', path }); continue; }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== (record.hash || record.Hash)) { missing.push({ id, reason: 'sha256 mismatch', path, expected: record.hash || record.Hash, actual: hash }); continue; }
  const metadata = record.metadata || record.Metadata || {};
  const sourceInfo = record.source || record.Source || {};
  resources[id] = {
    type: 'audio',
    hash,
    size: bytes.byteLength,
    dependencies: [],
    metadata: {
      mime: metadata.mime || metadata.Mime,
      loopStart: metadata.loopStart ?? metadata.LoopStart ?? null,
      loopEnd: metadata.loopEnd ?? metadata.LoopEnd ?? null,
      channels: metadata.channels ?? metadata.Channels ?? null,
      rate: metadata.rate ?? metadata.Rate ?? null,
      format: metadata.format || metadata.Format,
      decodeMethod: metadata.format === 'HCA->OGG (VGAudio+oggenc2)' || metadata.Format === 'HCA->OGG (VGAudio+oggenc2)'
        ? 'VFXEditor ScdHca XOR + VGAudioCli + oggenc2 -q 4'
        : 'Lumina ScdFile.GetAudio',
      sourceScd: sourceInfo.scdPath || sourceInfo.ScdPath || null,
    },
    assetPath: `./${path.replace(/^\.\//, '')}`,
    bundle: null,
    offset: null,
    length: bytes.byteLength,
  };
}

const ready = {
  schemaVersion: 1,
  source: {
    kind: 'scene-bgm-ready',
    extractor: 'tools/audio-tools/extract-daytime-bgm.ps1',
    note: 'Source-derived daytime scene BGM only; action fixture and ambience excluded.',
  },
  sceneBgm,
  sceneBgmEvidence,
  resources,
  missing,
  counts: {
    scenes: Object.keys(sceneBgm).length,
    mappedScenes: Object.values(sceneBgm).filter(Boolean).length,
    resources: Object.keys(resources).length,
    missing: missing.length,
  },
};
await writeFile(outputPath, `${JSON.stringify(ready, null, 2)}\n`, 'utf8');
if (missing.length) {
  console.error(JSON.stringify({ outputPath, counts: ready.counts, missing }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ outputPath, counts: ready.counts }));
}
