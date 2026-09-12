import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const origin = args.origin || 'https://yuluo.site';
const base = '/ff14-web-babylon-preview/';
const source = path.resolve(root, args.source || 'site-babylon-preview');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const htmlIdentity = text => ({
  title: /<title>(.*?)<\/title>/s.exec(text)?.[1] || null,
  scripts: [...text.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1]),
});
const checks = [];
async function readRemote(relative) {
  const url = new URL(relative, origin);
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { url: url.href, status: response.status, bytes: bytes.length, sha256: sha(bytes), body: bytes };
}
async function sameArtifact(relative) {
  const [remote, local] = await Promise.all([readRemote(`${base}${relative}`), fs.readFile(path.join(source, relative))]);
  checks.push({ name: `artifact:${relative}`, pass: remote.status === 200 && remote.sha256 === sha(local) });
  const { body, ...evidence } = remote;
  return evidence;
}

const [preview, main, fallback, health] = await Promise.all([
  readRemote(base), readRemote('/ff14-web/'), readRemote('/ff14-web-nope-content-proof/'), readRemote('/api/healthz'),
]);
const localIndex = await fs.readFile(path.join(source, 'index.html'));
const localMain = await fs.readFile(path.join(root, 'site/index.html'));
const previewIdentity = htmlIdentity(preview.body.toString());
const mainIdentity = htmlIdentity(main.body.toString());
const fallbackIdentity = htmlIdentity(fallback.body.toString());
checks.push({ name: 'preview-local-content', pass: preview.sha256 === sha(localIndex) && preview.status === 200 });
checks.push({ name: 'preview-not-catch-all', pass: preview.sha256 !== fallback.sha256 && previewIdentity.title !== fallbackIdentity.title });
checks.push({ name: 'preview-not-main', pass: preview.sha256 !== main.sha256 && previewIdentity.scripts[0] !== mainIdentity.scripts[0] });
checks.push({ name: 'main-content-preserved', pass: main.sha256 === sha(localMain) && main.status === 200 });
let healthJson;
try { healthJson = JSON.parse(health.body.toString()); } catch { healthJson = null; }
checks.push({ name: 'api-json-health', pass: health.status === 200 && Boolean(healthJson) && (healthJson.status === 'ok' || healthJson.ok === true) });
const build = JSON.parse(await fs.readFile(path.join(source, 'build-info.json'), 'utf8'));
checks.push({ name: 'native-babylon-build', pass: build.engine === 'Babylon.js' && build.engineVersion === '9.26.0' && build.threeModules === 0 && build.mapCount === 65 });
const files = ['build-info.json', 'app-config.json', 'extracted/active.json'];
for (const script of previewIdentity.scripts) {
  if (!script.startsWith(base)) throw new Error(`Unexpected preview script outside isolated base: ${script}`);
  files.push(script.slice(base.length));
}
for (const match of preview.body.toString().matchAll(/href=["']([^"']+\.css)["']/g)) {
  if (match[1].startsWith(base)) files.push(match[1].slice(base.length));
}
for (const name of await fs.readdir(path.join(source, 'assets'))) {
  if (/\.(?:js|css|wasm)$/.test(name)) files.push(`assets/${name}`);
}
const artifactFiles = [...new Set(files)].sort();
const artifacts = [];
for (let offset = 0; offset < artifactFiles.length; offset += 6) {
  artifacts.push(...await Promise.all(artifactFiles.slice(offset, offset + 6).map(sameArtifact)));
}
const evidence = (response, identity) => {
  const { body, ...fields } = response;
  return { ...fields, ...identity };
};
const report = {
  checkedAt: new Date().toISOString(),
  status: checks.every(check => check.pass) ? 'PASS' : 'FAIL',
  preview: evidence(preview, previewIdentity),
  main: evidence(main, mainIdentity),
  fallback: evidence(fallback, fallbackIdentity),
  api: { ...evidence(health), content: healthJson },
  build, artifacts, checks,
};
const out = path.resolve(root, args.out || 'work/babylon-preview/deployment-proof.json');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ...report,
  artifactCount: artifacts.length,
  artifacts: artifacts.filter(item => /\/(?:build-info\.json|app-config\.json|(?:index|app|main|SceneLoader|LodWorker)-[^/]+\.(?:js|css))$/.test(item.url))
    .map(item => ({ url: item.url, bytes: item.bytes, sha256: item.sha256 })),
  checks: { total: checks.length, passed: checks.filter(check => check.pass).length, failures: checks.filter(check => !check.pass) },
  out,
}, null, 2));
process.exitCode = report.status === 'PASS' ? 0 : 1;
