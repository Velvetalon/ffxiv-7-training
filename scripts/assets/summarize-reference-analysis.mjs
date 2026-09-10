import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const input = path.resolve(process.argv.find(value => value.startsWith('--input='))?.slice(8) || 'work/asset-performance/reference-all/reference-analysis.json');
const shardOut = process.argv.find(value => value.startsWith('--shard-out='))?.slice(12);
const shardRoot = shardOut && path.resolve(shardOut);
if (shardRoot) await fsp.mkdir(path.join(shardRoot, 'resources'), { recursive: true });

class Reader {
  constructor(file) {
    this.text = ''; this.index = 0;
    if (file) { this.stream = fs.createReadStream(file, { encoding: 'utf8' }); this.iterator = this.stream[Symbol.asyncIterator](); }
    else this.iterator = { next: async () => ({ done: true }) };
  }
  async next() {
    while (this.index >= this.text.length) {
      const part = await this.iterator.next();
      if (part.done) return null;
      this.text = part.value; this.index = 0;
    }
    return this.text[this.index++];
  }
  async peek() { const value = await this.next(); if (value !== null) this.index--; return value; }
  async whitespace() { while (/\s/.test(await this.peek() || '')) await this.next(); }
  async expect(expected) { await this.whitespace(); const actual = await this.next(); if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`); }
  async string() {
    await this.expect('"');
    let raw = '"', escaped = false;
    for (;;) {
      const character = await this.next();
      if (character === null) throw new Error('Unexpected EOF in JSON string');
      raw += character;
      if (character === '"' && !escaped) return JSON.parse(raw);
      escaped = character === '\\' && !escaped;
      if (character !== '\\') escaped = false;
    }
  }
  async value({ capture = true } = {}) {
    await this.whitespace();
    const first = await this.peek();
    if (first === '"') return capture ? JSON.stringify(await this.string()) : (await this.string(), null);
    let raw = '', depth = 0, quoted = false, escaped = false;
    for (;;) {
      const character = await this.next();
      if (character === null) break;
      if (capture) raw += character;
      if (quoted) {
        if (character === '"' && !escaped) quoted = false;
        escaped = character === '\\' && !escaped;
        if (character !== '\\') escaped = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === '{' || character === '[') depth++;
      if (character === '}' || character === ']') depth--;
      if (depth === 0) {
        const next = await this.peek();
        if (next === ',' || next === '}' || next === ']' || next === null) return capture ? raw : null;
      }
    }
    return capture ? raw : null;
  }
  async objectEntries(handler) {
    await this.expect('{'); await this.whitespace();
    if (await this.peek() === '}') { await this.next(); return; }
    for (;;) {
      const key = await this.string(); await this.expect(':'); const raw = await this.value(); await handler(key, raw);
      await this.whitespace(); const separator = await this.next();
      if (separator === '}') return;
      if (separator !== ',') throw new Error(`Expected object separator, got ${separator}`);
    }
  }
  async arrayValues(handler) {
    await this.expect('['); await this.whitespace();
    if (await this.peek() === ']') { await this.next(); return; }
    for (;;) {
      await handler(await this.value()); await this.whitespace(); const separator = await this.next();
      if (separator === ']') return;
      if (separator !== ',') throw new Error(`Expected array separator, got ${separator}`);
    }
  }
}

const reader = new Reader(input);
const resourceInfo = new Map();
const bootstrapScenes = new Map();
const bootstrapByType = new Map();
const bootstrapBytes = [], sceneBytes = [], bootstrapModels = [], bootstrapShares = [];
const reuseBySceneCount = new Map();
const topReused = [];
let materialCount = 0, badCanonicalMaterials = 0, maps = 0, stats = null;
let inputRecord = null, reuseRaw = null, warningsRaw = null;
let resourceChunk = {}, resourceChunkCount = 0, resourceChunkIndex = 0;
const resourceShards = [], mapShards = {};
const flushResources = async () => {
  if (!resourceChunkCount || !shardRoot) return;
  const relative = `resources/${String(resourceChunkIndex++).padStart(4, '0')}.json`;
  await fsp.writeFile(path.join(shardRoot, relative), JSON.stringify(resourceChunk));
  resourceShards.push(relative); resourceChunk = {}; resourceChunkCount = 0;
};
const retainTop = entry => { topReused.push(entry); topReused.sort((a, b) => b.sizeBytes * b.sceneCount - a.sizeBytes * a.sceneCount); if (topReused.length > 10) topReused.pop(); };

async function readResources() {
  await reader.objectEntries(async (id, raw) => {
    const resource = JSON.parse(raw);
    resourceInfo.set(id, { type: resource.type, sizeBytes: resource.sizeBytes });
    if (resource.type === 'material') {
      materialCount++;
      const canonical = resource.metadata?.canonical;
      if (!canonical || canonical.dependencies?.join('|') !== (resource.dependencies || []).join('|') || canonical.samplers?.some(sampler => 'map' in sampler || 'path' in sampler)) badCanonicalMaterials++;
    }
    if (shardRoot) {
      resourceChunk[id] = resource; resourceChunkCount++;
      if (resourceChunkCount >= 1000) await flushResources();
    }
  });
  await flushResources();
}
async function readMaps() {
  await reader.objectEntries(async (sceneId, raw) => {
    const map = JSON.parse(raw); maps++;
    bootstrapBytes.push(map.bootstrap.resourceBytes); sceneBytes.push(map.resourceBytes); bootstrapModels.push(map.bootstrap.modelIndices.length); bootstrapShares.push(map.bootstrap.resourceBytes / map.resourceBytes);
    for (const id of map.bootstrap.resources) bootstrapScenes.set(id, (bootstrapScenes.get(id) || 0) + 1);
    if (shardRoot) {
      const relative = `maps/${sceneId}.json`;
      await fsp.mkdir(path.dirname(path.join(shardRoot, relative)), { recursive: true });
      await fsp.writeFile(path.join(shardRoot, relative), raw);
      mapShards[sceneId] = relative;
    }
  });
}
async function readReuse() {
  await reader.objectEntries(async (key, raw) => {
    if (key !== 'resources') return;
    reuseRaw = raw;
    const local = new Reader(); local.text = raw;
    await local.arrayValues(value => {
      const entry = JSON.parse(value); const distribution = reuseBySceneCount.get(entry.sceneCount) || { resources: 0, bytes: 0, repeatSavings: 0 };
      distribution.resources++; distribution.bytes += entry.sizeBytes; distribution.repeatSavings += entry.sizeBytes * (entry.sceneCount - 1); reuseBySceneCount.set(entry.sceneCount, distribution); retainTop(entry);
    });
  });
}
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b), count = sorted.length, at = p => sorted[Math.min(count - 1, Math.ceil(count * p) - 1)];
  return { count, min: sorted[0], p50: at(.5), p90: at(.9), p95: at(.95), max: sorted[count - 1], mean: Math.round(sorted.reduce((sum, value) => sum + value, 0) / count) };
};

await reader.expect('{');
for (;;) {
  await reader.whitespace();
  if (await reader.peek() === '}') break;
  const key = await reader.string(); await reader.expect(':');
  if (key === 'resources') await readResources();
  else if (key === 'maps') await readMaps();
  else if (key === 'reuse') await readReuse();
  else if (key === 'input') inputRecord = JSON.parse(await reader.value());
  else if (key === 'stats') stats = JSON.parse(await reader.value());
  else if (key === 'warnings') warningsRaw = await reader.value();
  else await reader.value({ capture: false });
  await reader.whitespace(); const separator = await reader.next();
  if (separator === '}') break;
  if (separator !== ',') throw new Error(`Expected root separator, got ${separator}`);
}
for (const [id, scenes] of bootstrapScenes) {
  const resource = resourceInfo.get(id); const group = bootstrapByType.get(resource.type) || { uniqueResources: 0, bytes: 0, uses: 0 };
  group.uniqueResources++; group.bytes += resource.sizeBytes; group.uses += scenes; bootstrapByType.set(resource.type, group);
}
const sharedBootstrap = [...bootstrapScenes].filter(([, scenes]) => scenes > 1);
const summary = {
  input, coverage: { scenes: maps, resources: stats?.uniqueResourceCount, bytes: stats?.uniqueResourceBytes, owners: stats?.ownerCount, edges: stats?.edgeCount, materials: materialCount, badCanonicalMaterials },
  reuseBySceneCount: Object.fromEntries([...reuseBySceneCount].sort(([a], [b]) => a - b)),
  bootstrap: { resourceBytes: distribution(bootstrapBytes), sceneResourceBytes: distribution(sceneBytes), models: distribution(bootstrapModels), shareOfSceneBytes: distribution(bootstrapShares), uniqueResources: bootstrapScenes.size, sharedAcrossScenes: sharedBootstrap.length, sharedBytes: sharedBootstrap.reduce((sum, [id]) => sum + resourceInfo.get(id).sizeBytes, 0), byType: Object.fromEntries(bootstrapByType) },
  topReused,
};
if (shardRoot) {
  await fsp.writeFile(path.join(shardRoot, 'reuse.json'), reuseRaw || '[]');
  await fsp.writeFile(path.join(shardRoot, 'summary.json'), JSON.stringify(summary));
  if (warningsRaw) await fsp.writeFile(path.join(shardRoot, 'warnings.json'), warningsRaw);
  await fsp.writeFile(path.join(shardRoot, 'index.json'), JSON.stringify({ schemaVersion: 1, format: 'asset-reference-shards-v1', input: inputRecord, stats, resourceShards, maps: mapShards, reuse: 'reuse.json', summary: 'summary.json', warnings: warningsRaw ? 'warnings.json' : null }));
}
console.log(JSON.stringify(summary, null, 2));
