import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const reportFiles = (args.reports || 'work/fast-validation-babylon/smoke.json').split(',');
const rows = new Map();
for (const file of reportFiles) {
  const report = JSON.parse(await fs.readFile(path.resolve(root, file), 'utf8'));
  for (const result of report.results || []) rows.set(result.id, result);
}
const active = JSON.parse(await fs.readFile(path.join(root, 'public/extracted/active.json'), 'utf8'));
const build = JSON.parse(await fs.readFile(path.resolve(root, args.build || 'site-babylon-preview/build-info.json'), 'utf8'));
const origin = args.url || 'https://yuluo.site/ff14-web-babylon-preview/';
const escape = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
let passed = 0;
const lines = [
  '# Babylon Map Coverage',
  '',
  `Generated: ${new Date().toISOString()}. Catalog: ${active.runId}. Maps: ${Object.keys(active.scenes).length}.`,
  `Build source SHA-256: \`${build.sourceSha256}\`. Engine: ${build.engine} ${build.engineVersion}; Three modules: ${build.threeModules}.`,
  '',
  'Runtime checks require the requested map ID to match the instantiated Babylon map, real map geometry, navigation and a rendered frame. This is basic runnable/streaming coverage, not full-scene visual parity or full-resolution background-completion certification.',
  '',
  '| Map / Scene | Runnable In Babylon | Entry | Content Evidence | Unmigrated / Failure Reason |',
  '| --- | --- | --- | --- | --- |',
];
for (const [id, scene] of Object.entries(active.scenes)) {
  const result = rows.get(id);
  const e = result?.evidence;
  const pass = result?.status === 'pass' && result.sceneId === id && e?.mapId === id
    && e.engine === 'Babylon.js' && e.instantiatedModels > 0 && e.meshes > 0 && e.sampleVertices > 0
    && e.manifest && e.sampleResourceId;
  if (pass) passed++;
  const url = new URL(origin);
  url.searchParams.set('scene', id);
  const manifestHash = /manifest_([a-f0-9]{64})/.exec(e?.manifest || '')?.[1];
  const evidence = e ? `title=${escape(e.title)}; ${e.backend}; actual=${e.mapId}; models=${e.instantiatedModels}; meshes=${e.meshes}; manifest SHA-256=${manifestHash || 'not recorded'}; sample=${e.sampleResourceId || 'not recorded'}` : 'No current runtime evidence';
  const reason = pass ? '' : result?.message || result?.reason || (result ? 'Content evidence incomplete' : 'Not yet executed');
  lines.push(`| ${escape(scene.name || id)} (${id}) | ${pass ? 'YES (basic runtime)' : 'NO / UNVERIFIED'} | [${id}](${url.href}) | ${evidence} | ${escape(reason)} |`);
}
lines.push('', `Result: ${passed}/${Object.keys(active.scenes).length} maps with content-level runtime evidence.`, '', `Reports: ${reportFiles.map(file => `\`${file}\``).join(', ')}.`);
const out = path.resolve(root, args.out || 'docs/BABYLON-MAP-COVERAGE.md');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, lines.join('\n') + '\n');
console.log(JSON.stringify({ maps: Object.keys(active.scenes).length, pass: passed, unverified: Object.keys(active.scenes).length - passed, out }));
process.exitCode = passed === Object.keys(active.scenes).length ? 0 : 1;
