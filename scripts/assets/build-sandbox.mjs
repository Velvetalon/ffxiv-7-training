#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  const separator = token.indexOf('=');
  const name = token.slice(2, separator < 0 ? undefined : separator);
  args[name] = separator < 0 ? process.argv[++i] : token.slice(separator + 1);
}
if (!args.inputs || !args.out) throw new Error('Usage: node scripts/assets/build-sandbox.mjs --inputs=file1.json,file2.json --out=work/sandbox-release');
const out = path.resolve(args.out);
const maximum = Number(args['pack-bytes'] || 8 * 1024 * 1024);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const inputs = String(args.inputs).split(',').map(file => path.resolve(file));
const manifest = { schemaVersion: 1, resources: {}, aliases: {}, bundles: {}, characters: {}, mounts: {}, sceneBgm: {}, skills: {}, rideBgm: {}, actionSfx: {} };
const payloads = new Map();
const sections = [];
await fs.mkdir(path.join(out, 'packs'), { recursive: true });
for (const file of inputs) {
  const data = await readJson(file);
  const resources = data.resources || data.Resources || {};
  for (const [sourceId, resource] of Object.entries(resources)) {
    const type = resource.type || resource.Type;
    const relative = [resource.source, resource.url, resource.assetPath, resource.Path]
      .find(value => typeof value === 'string');
    if (typeof relative !== 'string' || /^https?:/.test(relative)) throw new Error(`Expected local converted resource: ${sourceId}`);
    const baseDir = data.__assetBaseDir ? path.resolve(data.__assetBaseDir) : path.dirname(file);
    const source = path.resolve(baseDir, relative);
    const digest = crypto.createHash('sha256');
    let size = 0;
    for await (const bytes of createReadStream(source)) { digest.update(bytes); size += bytes.length; }
    const sha = digest.digest('hex');
    if ((resource.hash || resource.Hash) && (resource.hash || resource.Hash).toLowerCase() !== sha) throw new Error(`Resource hash differs: ${sourceId}`);
    const id = `${type}:sha256:${sha}`;
    manifest.aliases[sourceId] = id;
    if (!payloads.has(id)) {
      const original = resource.metadata || resource.Metadata || {};
      const metadata = Object.fromEntries(Object.entries(original).map(([key, value]) => [key[0].toLowerCase() + key.slice(1), value]));
      payloads.set(id, { id, type, hash: sha, size, source, metadata });
    }
  }
  const normalized = { ...data };
  if (data.skillPresentations) normalized.skills = { ...data.skills, ...data.skillPresentations };
  for (const [id, character] of Object.entries(data.characters || {})) {
    const appearance = typeof character.appearance === 'string' ? await readJson(path.resolve(path.dirname(file), character.appearance)) : character.appearance;
    normalized.characters ||= {};
    normalized.characters[id] = {
      ...character,
      ...(appearance || character.appearanceMatch ? { appearance: appearance || character.appearanceMatch } : {}),
    };
    normalized.defaultAppearance ||= appearance;
  }
  const sourceSceneBgm = data.sceneBgm || data.SceneBgm;
  if (sourceSceneBgm) normalized.sceneBgm = Object.fromEntries(Object.entries(sourceSceneBgm).map(([id, value]) => {
    if (value === null) return [id, null];
    if (typeof value === 'string') return [id, { id: value, loop: true }];
    return [id, {
      id: value.id || value.Id, loop: true,
      loopStart: value.loopStart || value.LoopStart, loopEnd: value.loopEnd || value.LoopEnd,
    }];
  }));
  if (data.ActionSfx) normalized.actionSfx = data.ActionSfx;
  sections.push(normalized);
}

const aligned = value => Math.ceil(value / 8) * 8;
async function pack(entries) {
  const blocks = [Buffer.from('AETHPAK1')];
  const locations = [];
  let offset = 8;
  for (const item of entries) {
    const pad = aligned(offset) - offset;
    if (pad) blocks.push(Buffer.alloc(pad));
    offset += pad;
    blocks.push(await fs.readFile(item.source));
    locations.push({ item, offset });
    offset += item.size;
  }
  const bytes = Buffer.concat(blocks);
  const sha = hash(bytes), id = `pack:sha256:${sha}`, url = `packs/${sha}.aethpak`;
  await fs.writeFile(path.join(out, url), bytes);
  manifest.bundles[id] = { url, hash: sha, size: bytes.length };
  for (const { item, offset: start } of locations) {
    manifest.resources[item.id] = {
      type: item.type, hash: item.hash, size: item.size, dependencies: [], metadata: item.metadata,
      bundle: id, offset: start, length: item.size,
    };
  }
}
const byType = new Map();
for (const item of payloads.values()) {
  if (!byType.has(item.type)) byType.set(item.type, []);
  byType.get(item.type).push(item);
}
for (const entries of byType.values()) {
  let current = [], bytes = 8;
  for (const item of entries.sort((a, b) => a.id.localeCompare(b.id))) {
    if (current.length && aligned(bytes) + item.size > maximum) { await pack(current); current = []; bytes = 8; }
    current.push(item);
    bytes = aligned(bytes) + item.size;
  }
  if (current.length) await pack(current);
}
const remap = value => typeof value === 'string' ? manifest.aliases[value] || value
  : Array.isArray(value) ? value.map(remap)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)])) : value;
for (const input of sections) {
  for (const name of ['characters', 'mounts', 'sceneBgm', 'rideBgm', 'actionSfx', 'skills', 'environment', 'uiSounds']) {
    if (!input[name]) continue;
    const values = remap(input[name]);
    if (['characters', 'mounts', 'skills'].includes(name)) {
      for (const [id, definition] of Object.entries(values)) {
        const previous = manifest[name][id] || {};
        const merged = { ...previous, ...definition };
        for (const field of ['animations', 'riderAnimations', 'states', 'timing']) {
          if (definition[field]) merged[field] = { ...previous[field], ...definition[field] };
        }
        manifest[name][id] = merged;
      }
    } else {
      manifest[name] = { ...manifest[name], ...values };
    }
  }
  if (input.defaultAppearance) manifest.defaultAppearance = input.defaultAppearance;
}
const bundleFiles = Object.values(manifest.bundles).map(bundle => ({ path: bundle.url, size: bundle.size, hash: bundle.hash, contentType: 'application/octet-stream' }));
const text = JSON.stringify(manifest);
const entry = `sandbox_${hash(text)}.json`;
await fs.writeFile(path.join(out, entry), text);
await fs.writeFile(path.join(out, 'manifest.json'), text);
const files = bundleFiles;
files.push({ path: entry, size: Buffer.byteLength(text), hash: hash(text), contentType: 'application/json' });
if (args['cdn-base']) {
  const cdn = { ...manifest, bundles: Object.fromEntries(Object.entries(manifest.bundles).map(([id, bundle]) => [
    id, { ...bundle, url: new URL(bundle.url, String(args['cdn-base']).replace(/\/?$/, '/')).href },
  ])) };
  await fs.writeFile(path.join(out, 'manifest.cdn.json'), JSON.stringify(cdn));
}
await fs.writeFile(path.join(out, 'publish-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: `sandbox-${hash(text).slice(0, 16)}`, entry, files }, null, 2));
console.log(JSON.stringify({ resources: payloads.size, bundles: Object.keys(manifest.bundles).length, characters: Object.keys(manifest.characters).length, mounts: Object.keys(manifest.mounts).length, sceneBgm: Object.keys(manifest.sceneBgm).length, out }));
