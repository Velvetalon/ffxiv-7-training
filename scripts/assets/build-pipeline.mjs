#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
  const equals = arg.indexOf('=');
  const name = arg.slice(2, equals < 0 ? undefined : equals);
  options[name] = equals >= 0 ? arg.slice(equals + 1)
    : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
if (options.help || !options.out) {
  console.log(`Usage: node scripts/assets/build-pipeline.mjs --out work/assets [options]
  --scenes gridania,limsa   Select maps; omitted means the full active catalog
  --analysis path          Explicitly reuse an existing analysis/shard index
  --python executable      Python with Pillow installed (default: python)
  --pack-bytes n           Target bundle size (default: 8388608)
  --bootstrap-radius n     Must match runtime coverage (default: 35)
  --no-previews            Skip temporary 128px texture tier
  --collision-chunks       Partition large collision data; optional longer build
  --collision-cache path   Reuse verified per-map collision work
  --plan-only              Print commands without reading or writing assets

Produces content-hashed packs, map manifests, catalog, publish-manifest.json
and pipeline-result.json. It does not upload or activate a deployment.`);
  if (!options.help) process.exitCode = 2;
} else {
  const out = path.resolve(project, String(options.out));
  if (out === path.parse(out).root || out === project) throw new Error('--out must be a dedicated build directory');
  const node = process.execPath;
  const python = String(options.python || 'python');
  const analyzed = path.join(out, 'analysis', 'reference-analysis.json');
  const shards = path.join(out, 'analysis', 'shards');
  const analysis = options.analysis ? path.resolve(project, String(options.analysis)) : path.join(shards, 'index.json');
  const packed = path.join(out, 'packed');
  const previews = path.join(out, 'preview');
  const chunked = path.join(out, 'release');
  const steps = [];
  if (!options.analysis) {
    steps.push({ name: 'analyze', executable: node, args: ['--max-old-space-size=8192', 'scripts/assets/reference-analyzer.mjs', '--out', path.dirname(analyzed), ...(options.scenes ? ['--scenes', String(options.scenes)] : [])] });
    steps.push({ name: 'shard', executable: node, args: ['scripts/assets/summarize-reference-analysis.mjs', `--input=${analyzed}`, `--shard-out=${shards}`] });
  }
  steps.push({ name: 'bundle', executable: node, args: ['--max-old-space-size=8192', 'scripts/assets/bundle-planner.mjs', '--analysis', analysis, '--out', packed, '--target-bytes', String(options['pack-bytes'] || 8388608), '--bootstrap-radius', String(options['bootstrap-radius'] || 35)] });
  let release = packed;
  if (!options['no-previews']) {
    steps.push({ name: 'preview', executable: python, args: ['scripts/assets/build-previews.py', '--dir', packed, '--analysis', analysis, '--out', previews, '--cache', path.join(out, 'preview-cache'), '--workers', '2', '--resume'] });
    release = previews;
  }
  if (options['collision-chunks']) {
    steps.push({ name: 'collision', executable: node, args: ['--max-old-space-size=8192', 'scripts/assets/chunk-collision.mjs', '--dir', release, '--out', chunked, '--maps', 'all', ...(options['collision-cache'] ? ['--cache', path.resolve(project, String(options['collision-cache']))] : [])] });
    release = chunked;
  }
  const result = { schemaVersion: 1, out, release, publishManifest: path.join(release, 'publish-manifest.json'), steps };
  if (options['plan-only']) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    await mkdir(out, { recursive: true });
    for (const step of steps) {
      console.log(`Asset pipeline: ${step.name}`);
      const startedAt = Date.now();
      await new Promise((resolve, reject) => {
        const child = spawn(step.executable, step.args, { cwd: project, stdio: 'inherit', shell: false });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${step.name} exited with code ${code}`)));
      });
      step.durationMs = Date.now() - startedAt;
      step.status = 'complete';
    }
    const temporary = path.join(out, 'pipeline-result.json.tmp');
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
    await rename(temporary, path.join(out, 'pipeline-result.json'));
    console.log(`Asset pipeline ready: ${release}`);
  }
}
