#!/usr/bin/env node
import { runSmoke } from './validation/browser.mjs';

function options(argv) {
  return Object.fromEntries(argv.filter(value => value.startsWith('--')).map(value => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.length ? rest.join('=') : true];
  }));
}

const args = options(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node scripts/validate-smoke.mjs --url=URL [--out=FILE] [--scenes=id1,id2] [--timeout-ms=30000] [--concurrency=2]');
  process.exit(0);
}
if (!args.url) throw new Error('Required: --url=URL');
const summary = await runSmoke({
  url: args.url,
  scenes: args.scenes,
  timeoutMs: Number(args.timeout || args['timeout-ms'] || 30000),
  concurrency: Number(args.concurrency || 2),
  out: args.out || 'work/fast-validation/smoke.json',
  browserPath: args['browser-path'],
  playwrightModulePath: args['playwright-module-path'],
});
const { failedMapIds, ...stdoutSummary } = summary;
console.log(JSON.stringify(stdoutSummary));
if (summary.globalError || summary.counts.fail || summary.counts.timeout) process.exitCode = 1;
