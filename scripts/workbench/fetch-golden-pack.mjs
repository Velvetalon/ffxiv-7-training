#!/usr/bin/env node
/**
 * Materialize the golden map (Kugane / e3t1) asset pack on disk so local
 * workbench runs never depend on the throttled CDN.
 *
 * Downloads, once, into work/babylon-golden-map/:
 *   catalog_<hash>.json
 *   maps/e3t1/manifest_<hash>.json.gz
 *   packs/<hash>.aethpak         (every bundle the manifest references)
 *
 * Existing files of matching size are kept (resumable); each file retries.
 * Serve it with BABYLON_ASSET_DIR=work/babylon-golden-map npm run dev:babylon.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5173';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'babylon-golden-map');
const GOLDEN_MAP_ID = 'e3t1';
const ATTEMPTS = 5;

function parseArgs(argv) {
  const result = {};
  for (const value of argv) {
    if (!value.startsWith('--')) continue;
    const body = value.slice(2);
    const index = body.indexOf('=');
    if (index < 0) result[body] = true;
    else result[body.slice(0, index)] = body.slice(index + 1);
  }
  return result;
}

async function ticketUrls(origin) {
  const response = await fetch(`${origin}/ff14-assets/ticket?mode=batch`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`ticket HTTP ${response.status}`);
  return response.json();
}

// GET batch mode signs everything except .aethpak bundles; bundles are
// authorized by POSTing their explicit keys (same contract as AssetDelivery).
async function signBundleUrls(origin, keys) {
  const urls = {};
  for (let offset = 0; offset < keys.length; offset += 200) {
    const batch = keys.slice(offset, offset + 200);
    const response = await fetch(`${origin}/ff14-assets/ticket`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: batch }),
    });
    if (!response.ok) throw new Error(`bundle ticket HTTP ${response.status}`);
    const result = await response.json();
    Object.assign(urls, result.urls);
  }
  return urls;
}

async function downloadToFile(url, file, expectedBytes = null) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      if (expectedBytes !== null && fsSync.existsSync(file)) {
        const { size } = fsSync.statSync(file);
        if (size === expectedBytes) return 'kept';
      }
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let buffer = Buffer.from(await response.arrayBuffer());
      // fetch() transparently decompresses; .json.gz artifacts must stay
      // gzipped on disk because the local dev server re-announces the
      // Content-Encoding header.
      if (file.endsWith('.json.gz')) buffer = await import('node:zlib').then(zlib => zlib.gzipSync(buffer));
      if (expectedBytes !== null && buffer.length !== expectedBytes) throw new Error(`size mismatch: got ${buffer.length}, want ${expectedBytes}`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buffer);
      return attempt > 1 ? 'retried' : 'downloaded';
    } catch (error) {
      if (attempt === ATTEMPTS) throw new Error(`failed after ${ATTEMPTS} attempts: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, attempt * 4000));
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path.basename(new URL(url).pathname)}`);
  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = (args.url || DEFAULT_URL).replace(/\/$/, '');
  const ticket = await ticketUrls(origin);
  const signed = { ...ticket.urls };
  const resolve = key => {
    const normalized = key.replace(/^\/+/, '');
    const entry = Object.entries(signed).find(([candidate]) => candidate === normalized || candidate.endsWith(`/${normalized}`));
    if (!entry?.[1]) throw new Error(`no signed URL for ${key}`);
    return entry[1];
  };

  const catalogEntry = Object.keys(signed).find(key => key.includes('catalog_'));
  if (!catalogEntry) throw new Error('ticket has no catalog entry');
  const catalog = await fetchJson(resolve(catalogEntry));
  const catalogName = path.basename(catalogEntry);
  const catalogResult = await downloadToFile(resolve(catalogEntry), path.join(OUT_DIR, catalogName));
  console.log(`catalog  ${catalogName}: ${catalogResult} (${catalog.maps ? Object.keys(catalog.maps).length : '?'} maps, release ${catalog.releaseId})`);

  const entry = catalog.maps?.[GOLDEN_MAP_ID];
  if (!entry?.manifest) throw new Error(`catalog has no manifest for ${GOLDEN_MAP_ID}`);
  const manifestKey = entry.manifest.replace(/^\/+/, '');
  const manifestName = path.basename(manifestKey);
  const manifest = await fetchJson(resolve(manifestKey));
  await downloadToFile(resolve(manifestKey), path.join(OUT_DIR, 'maps', GOLDEN_MAP_ID, manifestName));
  console.log(`manifest ${manifestKey}: downloaded`);

  const bundles = Object.values(manifest.bundles || {});
  if (!bundles.length) throw new Error('manifest lists no bundles');
  const bundleKeys = bundles.map(bundle => bundle.url.replace(/^\/+/, '').replace(/^ff14-assets\/v1\//, ''));
  Object.assign(signed, await signBundleUrls(origin, bundleKeys.map(key => `ff14-assets/v1/${key}`)));
  let totalBytes = 0;
  let done = 0;
  const startedAt = Date.now();
  const queue = bundleKeys.map(key => ({ key, url: resolve(`ff14-assets/v1/${key}`) }));
  const workers = Array.from({ length: Number(args.concurrency) || 3 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      const file = path.join(OUT_DIR, item.key.replace(/^ff14-assets\/v1\//, ''));
      const result = await downloadToFile(item.url, file);
      done += 1;
      totalBytes += fsSync.existsSync(file) ? fsSync.statSync(file).size : 0;
      process.stdout.write(`\r  packs: ${done}/${bundles.length} (${(totalBytes / 1024 / 1024).toFixed(0)} MiB, ${Math.round((Date.now() - startedAt) / 1000)}s) last=${result}   `);
    }
  });
  await Promise.all(workers);
  console.log(`\nGolden pack ready at ${path.relative(REPO_ROOT, OUT_DIR)}`);
  console.log(`Serve locally with: BABYLON_ASSET_DIR=${path.relative(REPO_ROOT, OUT_DIR).replaceAll('\\', '/')} npm run dev:babylon`);
}

await main();
