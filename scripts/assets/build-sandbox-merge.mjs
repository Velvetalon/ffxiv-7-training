#!/usr/bin/env node
// Merge a fresh incremental build into the committed public/sandbox release.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  const eq = token.indexOf('=');
  args[token.slice(2, eq < 0 ? undefined : eq)] = eq < 0 ? true : token.slice(eq + 1);
}
if (!args.base || !args.patch) throw new Error('Usage: build-sandbox-merge --base=public/sandbox --patch=work/sandbox-release');
const baseDir = path.resolve(args.base);
const patchDir = path.resolve(args.patch);

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const base = await readJson(path.join(baseDir, 'manifest.json'));
const patch = await readJson(path.join(patchDir, 'manifest.json'));
const sections = ['resources', 'aliases', 'bundles', 'characters', 'mounts', 'sceneBgm', 'skills', 'rideBgm', 'actionSfx'];
const merged = { ...base };
for (const name of sections) merged[name] = { ...(base[name] || {}), ...(patch[name] || {}) };

await fs.mkdir(path.join(baseDir, 'packs'), { recursive: true });
for (const pack of await fs.readdir(path.join(patchDir, 'packs'))) {
  const target = path.join(baseDir, 'packs', pack);
  await fs.copyFile(path.join(patchDir, 'packs', pack), target).catch(error => { if (error.code !== 'EEXIST') throw error; });
}

const text = JSON.stringify(merged);
const entryHash = crypto.createHash('sha256').update(text).digest('hex');
const entry = `sandbox_${entryHash}.json`;
await fs.writeFile(path.join(baseDir, entry), text);
await fs.writeFile(path.join(baseDir, 'manifest.json'), text);
const files = Object.values(merged.bundles).map(bundle => ({ path: bundle.url, size: bundle.size, hash: bundle.hash, contentType: 'application/octet-stream' }));
files.push({ path: entry, size: Buffer.byteLength(text), hash: entryHash, contentType: 'application/json' });
await fs.writeFile(path.join(baseDir, 'publish-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'sandbox-' + entryHash.slice(0, 16), entry, files }, null, 2));
console.log(JSON.stringify({ resources: Object.keys(merged.resources).length, rideBgm: Object.keys(merged.rideBgm).length, actionSfx: Object.keys(merged.actionSfx).length, bundles: Object.keys(merged.bundles).length, entry }));
