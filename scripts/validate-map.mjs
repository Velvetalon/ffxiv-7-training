#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { runRepresentative } from './validation/browser.mjs';

function options(argv) {
  return Object.fromEntries(argv.filter(value => value.startsWith('--')).map(value => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.length ? rest.join('=') : true];
  }));
}

const argv = process.argv.slice(2);
const id = argv.find(value => !value.startsWith('--')) || null;
const args = options(argv);
if (args.help) {
  console.log('Usage: node scripts/validate-map.mjs [scene-id] --url=URL [--out=FILE] [--headed] [--observe-ms=1500]');
  process.exit(0);
}
if (!args.url) throw new Error('Required: [scene-id] --url=URL');
const configPath = path.resolve(args.config || 'config/fast-validation.json');
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
const configured = (config.representatives || []).map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
const scenes = id ? [id] : configured;
if (!scenes.length) throw new Error('No representative maps are configured');
const defaultOut = id
  ? `work/fast-validation/map-${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
  : 'work/fast-validation/representatives.json';
const summary = await runRepresentative({
  url: args.url,
  scenes,
  timeoutMs: Number(args.timeout || args['timeout-ms'] || config.representative?.timeoutMs || 30000),
  observeMs: Number(args['observe-ms'] || config.representative?.observeMs || 1500),
  out: args.out || defaultOut,
  browserPath: args['browser-path'],
  playwrightModulePath: args['playwright-module-path'],
  headed: args.headed === true || args.headed === 'true',
});
const { failedMapIds, ...stdoutSummary } = summary;
console.log(JSON.stringify({ ...stdoutSummary, review: { urls: scenes.map(scene => {
  const target = new URL(args.url);
  target.searchParams.set('scene', scene);
  return target.href;
}), checklist: ['Confirm the scene is visually populated.', 'Confirm terrain and textures are plausible.', 'Confirm movement and camera response.'] } }));
if (summary.globalError || summary.counts.fail || summary.counts.timeout) process.exitCode = 1;
