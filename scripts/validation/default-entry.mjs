#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const url = new URL(args.url || 'http://127.0.0.1:4173/ff14-web-babylon-preview/');
url.searchParams.set('scene', args.scene || 'e3t1');
url.searchParams.set('noworkbench', '');
const timeoutMs = Number(args.timeout || 180000);
const out = path.resolve(root, args.out || 'work/debug-scan/default-entry.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  url: url.href,
  status: 'RUNNING',
  errors: [],
};

const { chromium } = await loadPlaywright(args['playwright-module-path']);
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push({ type: 'pageerror', text: error.message }));
page.on('console', message => {
  if (message.type() === 'error') report.errors.push({ type: 'console', text: message.text() });
});
page.on('response', response => {
  if (response.status() >= 400) report.errors.push({ type: 'http', status: response.status(), url: response.url() });
});

async function sample() {
  return page.evaluate(() => {
    const world = globalThis.__APP__?.world;
    const character = world?.character;
    const feedback = document.querySelector('.runtime-feedback');
    return {
      appPresent: Boolean(globalThis.__APP__),
      title: document.title,
      map: {
        id: world?.sceneId || null,
        loading: world?.loading ?? null,
        imported: world?.isImported ?? null,
        error: world?.loadError || null,
        navigation: Boolean(world?.navigation),
      },
      character: {
        source: character?.source || null,
        model: Boolean(character?.model),
        definition: Boolean(character?.definition),
        animations: character?.animation?.clips?.size ?? 0,
        error: world?.sandboxError || null,
      },
      npc: {
        definition: Boolean(world?.npcDefinition),
        count: world?.characters?.size ?? 0,
      },
      feedback: feedback ? {
        hidden: feedback.classList.contains('hidden'),
        text: feedback.textContent.trim(),
      } : null,
    };
  });
}

const startedAt = Date.now();
try {
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  let state;
  do {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Default entry did not become ready in ${timeoutMs}ms`);
    state = await sample();
    if (state.map.error || state.character.error) throw new Error(state.map.error || state.character.error);
    await sleep(250);
  } while (!(
    state.appPresent
    && state.map.id === (args.scene || 'e3t1')
    && state.map.loading === false
    && state.map.imported === true
    && state.map.navigation
    && state.character.source === 'ffxiv-client'
    && state.character.model
    && state.character.definition
    && state.character.animations > 0
    && state.npc.definition
    && state.npc.count >= 2
  ));
  report.state = state;
  report.durationMs = Date.now() - startedAt;
  report.status = report.errors.length ? 'FAIL' : 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.durationMs = Date.now() - startedAt;
  report.error = error.message;
  report.state = await sample().catch(() => null);
} finally {
  await context.close();
  await browser.close();
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({ ...report, errors: report.errors.slice(0, 20) }, null, 2));
process.exitCode = report.status === 'PASS' ? 0 : 1;
