#!/usr/bin/env node
/**
 * Workbench CLI: drives the Babylon preview through the structured
 * Workbench API (globalThis.__FF14_WORKBENCH__) instead of clicking menus.
 *
 * Examples:
 *   node scripts/workbench/wb.mjs --command=capabilities.query
 *   node scripts/workbench/wb.mjs --command=camera.set --args='{"position":[90,67,92],"target":[164,22,0]}'
 *   node scripts/workbench/wb.mjs --command=map.switch --args='{"mapId":"gridania"}' --follow
 *
 * Prints the structured result as JSON. Exit code 0 for ok/accepted, 3 for
 * rejected/stale/failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const GOLDEN_MAP_ID = 'e3t1';

function parseArgs(argv) {
  const result = { _: [] };
  for (const value of argv) {
    if (!value.startsWith('--')) { result._.push(value); continue; }
    const body = value.slice(2);
    const index = body.indexOf('=');
    if (index < 0) result[body] = true;
    else result[body.slice(0, index)] = body.slice(index + 1);
  }
  return result;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export async function openWorkbenchPage({ browser, appUrl, timeoutMs = 300000, waitFull = false }) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const target = new URL(appUrl.href);
  target.searchParams.set('viewer', '1');
  if (!target.searchParams.get('scene')) target.searchParams.set('scene', GOLDEN_MAP_ID);
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(globalThis.__FF14_WORKBENCH__ && globalThis.__BABYLON_PREVIEW__?.isReady), null, { timeout: timeoutMs, polling: 250 });
  if (waitFull) {
    await page.waitForFunction(() => globalThis.__BABYLON_PREVIEW__?.isFullyLoaded, null, { timeout: timeoutMs, polling: 500 });
  }
  return { context, page };
}

export async function dispatch(page, command, args = {}) {
  return page.evaluate(({ command, args }) => globalThis.__FF14_WORKBENCH__.dispatch(command, args), { command, args });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command || args._[0];
  if (!command || command === 'help') {
    console.log('Usage: node scripts/workbench/wb.mjs --command=NAME [--args=JSON] [--url=URL] [--follow] [--full] [--keep-open]');
    process.exit(command ? 0 : 2);
  }
  let commandArgs = {};
  if (args.args) {
    try {
      commandArgs = JSON.parse(args.args);
    } catch (error) {
      console.error(`--args is not valid JSON: ${error.message}`);
      process.exit(2);
    }
  }

  const appUrl = normalizeUrl(args.url || DEFAULT_URL);
  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });

  let result;
  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: Boolean(args.full) });
    result = await dispatch(page, command, commandArgs);

    if (command === 'map.switch' && args.follow && result?.status === 'accepted' && result?.data?.navigateTo) {
      // Viewer mode switches maps by navigation; follow across the reload and
      // report the new boot's state with its new sceneEpoch.
      await page.goto(result.data.navigateTo, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(() => Boolean(globalThis.__FF14_WORKBENCH__ && globalThis.__BABYLON_PREVIEW__?.isReady), null, { timeout: 300000, polling: 250 });
      result = { ...result, followed: await dispatch(page, 'state.read') };
    }

    if (args['read-back']) {
      result = { ...result, readBack: await dispatch(page, args['read-back']) };
    }
    if (args.screenshot) {
      await page.screenshot({ path: path.resolve(args.screenshot), fullPage: false });
      result = { ...result, screenshot: path.resolve(args.screenshot) };
    }
    if (!args['keep-open']) await context.close();
    else {
      console.error('Keeping browser open; press Ctrl+C to exit.');
      await new Promise(() => {});
    }
  } finally {
    if (!args['keep-open']) await browser.close();
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result?.status === 'ok' || result?.status === 'accepted' ? 0 : 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
