import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(project, 'public', 'extracted');
const argument = process.argv.find(item => item.startsWith('--root='))?.slice(7);
if (!argument) throw new Error('Usage: node scripts/publish-world.mjs --root=<verified-release-directory>');
const stage = path.resolve(argument);
const relative = path.relative(publicRoot, stage);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Release must be an independent directory inside public/extracted');
const candidate = JSON.parse(fs.readFileSync(path.join(stage, 'active.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(new URL('../tools/map-tools/world-catalog.json', import.meta.url), 'utf8'));
const required = catalog.scenes.map(scene => scene.id).sort();
if (JSON.stringify(Object.keys(candidate.scenes).sort()) !== JSON.stringify(required)) throw new Error('Incomplete world catalog');
for (const [id, record] of Object.entries(candidate.scenes)) {
  const manifest = fs.readFileSync(path.join(stage, id, 'scene.json'));
  if (createHash('sha256').update(manifest).digest('hex') !== record.manifestSha256) throw new Error(`Manifest changed after finalization: ${id}`);
  record.base = `${relative.split(path.sep).join('/')}/${id}/`;
}
candidate.publishedAt = new Date().toISOString();
const temp = path.join(publicRoot, `active-${process.pid}.tmp`);
fs.writeFileSync(temp, JSON.stringify(candidate, null, 2) + '\n');
fs.renameSync(temp, path.join(publicRoot, 'active.json'));
console.log(JSON.stringify({ runId: candidate.runId, maps: required.length, published: true }));
