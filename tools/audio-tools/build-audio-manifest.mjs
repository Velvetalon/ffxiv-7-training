#!/usr/bin/env node
// Build manifest.ready.audio.partial.json from an audio-source-manifest.json.
// Includes sceneBgm, rideBgm table and actionSfx entries declared by --sfx.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  const eq = token.indexOf('=');
  args[token.slice(2, eq < 0 ? undefined : eq)] = eq < 0 ? true : token.slice(eq + 1);
}
const sourceFile = resolve(args.source);
const outFile = resolve(args.out);
const sfxIds = String(args.sfx || '').split(',').filter(Boolean);
const rideAliases = args.ride ? JSON.parse(args.ride) : {};

const source = JSON.parse(await readFile(sourceFile, 'utf8'));
const audioDir = resolve(sourceFile, '..');
const sceneBgm = {};
const sceneBgmEvidence = {};
for (const [sceneId, entry] of Object.entries(source.sceneBgm || source.SceneBgm || {})) {
  sceneBgm[sceneId] = entry?.Id ?? entry?.id ?? null;
  sceneBgmEvidence[sceneId] = entry?.Evidence ?? entry?.evidence ?? null;
}

const resources = {};
const missing = [];
const wanted = new Set(Object.values(sceneBgm).filter(Boolean));
for (const sfx of sfxIds) wanted.add(sfx);
for (const alias of Object.values(rideAliases)) wanted.add(alias);

for (const id of wanted) {
  const record = source.resources?.[id] || source.Resources?.[id];
  if (!record) { missing.push({ id, reason: 'absent-from-source' }); continue; }
  const relative = record.path || record.Path;
  const absolute = resolve(audioDir, String(relative).replace(/^\.\//, ''));
  const bytes = await readFile(absolute).catch(() => null);
  if (!bytes) { missing.push({ id, reason: 'asset-missing', path: relative }); continue; }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== (record.hash || record.Hash)) { missing.push({ id, reason: 'hash-mismatch', path: relative }); continue; }
  const metadata = record.metadata || record.Metadata || {};
  const sourceInfo = record.source || record.Source || {};
  const fmt = String(metadata.format || metadata.Format || '');
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
      format: fmt,
      decodeMethod: fmt.includes('MS-ADPCM') ? 'tools/audio-tools/convert-msadpcm.mjs' : 'Lumina ScdFile.GetAudio',
      sourceScd: sourceInfo.scdPath || sourceInfo.ScdPath || null,
    },
    assetPath: './' + relative.replace(/^\.\//, ''),
  };
}

const rideBgm = {};
for (const [mountId, resourceId] of Object.entries(rideAliases)) {
  if (resources[resourceId]) rideBgm[mountId] = { id: resourceId, loop: true };
  else missing.push({ id: resourceId, reason: 'ride-alias-missing', mountId });
}

const actionSfx = {};
for (const id of sfxIds) if (resources[id]) actionSfx[id] = { id, bus: 'sfx' };

const ready = {
  schemaVersion: 1,
  source: {
    kind: 'audio-ready',
    extractor: 'tools/audio-tools/extract-audio.ps1 + build-audio-manifest.mjs',
    note: 'Source-derived sceneBgm, rideBgm and actionSfx; provenance kept per resource.',
  },
  sceneBgm,
  sceneBgmEvidence,
  rideBgm,
  actionSfx,
  resources,
  missing,
  counts: {
    scenes: Object.keys(sceneBgm).length,
    mappedScenes: Object.values(sceneBgm).filter(Boolean).length,
    resources: Object.keys(resources).length,
    rideBgm: Object.keys(rideBgm).length,
    actionSfx: Object.keys(actionSfx).length,
    missing: missing.length,
  },
};
await writeFile(outFile, JSON.stringify(ready, null, 2) + '\n', 'utf8');
if (missing.length) { console.error(JSON.stringify({ outFile, counts: ready.counts, missing }, null, 2)); process.exitCode = 2; }
else console.log(JSON.stringify({ outFile, counts: ready.counts }));
