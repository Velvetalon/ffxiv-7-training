#!/usr/bin/env node
/**
 * S03 closed-loop validation: from a screen object back to source and final
 * parameters.
 *
 * Loop: pick a textured Kugane object -> inspect the provenance chain
 * (instance address -> model resource/hash -> materials -> texture slots ->
 * Babylon final params) -> distinguish a sibling instance sharing the model ->
 * reload the page and re-locate by the stable address -> export summaries.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage, dispatch } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5174/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's03');

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appUrl = new URL(args.url || DEFAULT_URL);
  if (!appUrl.pathname.endsWith('/')) appUrl.pathname += '/';
  const startedAt = new Date().toISOString();
  const steps = [];
  const step = (name, ok, result) => {
    steps.push({ name, ok, result });
    console.error(`  [${ok ? 'ok' : 'FAIL'}] ${name}`);
  };
  await fs.mkdir(OUT_DIR, { recursive: true });

  const { chromium } = await loadPlaywright(process.env.PLAYWRIGHT_MODULE_PATH);
  const browser = await chromium.launch({ headless: !args.headed, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'] });
  let inspection = null;
  let sibling = null;

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });

    // 1. Choose a real object with a textured material from the scene.
    const listed = await dispatch(page, 'objects.list', { limit: 200 });
    const withMaterial = (listed.data?.objects || []).filter(object => object.resourceId);
    const target = withMaterial.find(object => object.sourceAsset?.includes('bgparts')) || withMaterial[0];
    step('objects.list', Boolean(target), { total: listed.data?.total, selected: target?.stableAddress });
    if (!target) throw new Error('no placed object found');

    // 2. Inspect the provenance chain.
    const inspected = await dispatch(page, 'objects.inspect', { stableAddress: target.stableAddress });
    inspection = inspected.data;
    const chain = inspection || {};
    const hasInstance = Boolean(chain.instance?.stableAddress && chain.instance?.worldMatrix?.length === 16);
    const hasModel = Boolean(chain.model?.resourceId && chain.model?.contentHash);
    const material = (chain.materials || [])[0] || null;
    const hasMaterial = Boolean(material?.ffxiv?.materialPath && material?.ffxiv?.workflow);
    const hasTextures = (material?.textures || []).some(slot => slot.semantic && (slot.resourceId || slot.runtimePath));
    const hasFinalParams = material?.finalParams && Object.hasOwn(material.finalParams, 'transparencyMode');
    step('objects.inspect chain', inspected.status === 'ok' && hasInstance && hasModel && hasMaterial && hasTextures && hasFinalParams, {
      hasInstance, hasModel, hasMaterial, hasTextures, hasFinalParams,
      textureSemantics: (material?.textures || []).map(slot => slot.semantic),
    });

    // 3. Sibling instance sharing the same model resource: same identity,
    // different address and transform.
    const siblings = await page.evaluate(address => {
      const api = globalThis.__BABYLON_PREVIEW__;
      const records = api.loader.records;
      const mine = address.split(':');
      const record = records[Number(mine[1])];
      if (!record) return [];
      return record.matrices.map((_, index) => index === Number(mine[2]) ? null : `${api.mapId}:${record.index}:${index}`).filter(Boolean).slice(0, 1);
    }, target.stableAddress);
    if (siblings.length) {
      const siblingInspected = await dispatch(page, 'objects.inspect', { stableAddress: siblings[0] });
      sibling = siblingInspected.data;
      const sameModel = sibling.model?.resourceId === chain.model?.resourceId;
      const differentInstance = sibling.instance?.stableAddress !== chain.instance?.stableAddress
        && sibling.instance?.worldMatrix?.[12] !== chain.instance?.worldMatrix?.[12];
      step('sibling identity distinguished', siblingInspected.status === 'ok' && sameModel && differentInstance, {
        siblingAddress: sibling.instance?.stableAddress,
        sameModel,
        differentInstance,
      });
    } else {
      step('sibling identity distinguished', true, { note: 'single-placement model; identity check vacuously satisfied' });
    }

    // 4. whoUses for the model resource: counts + representatives.
    const whoUses = await dispatch(page, 'resources.whoUses', { resourceId: chain.model.resourceId });
    step('resources.whoUses', whoUses.status === 'ok'
      && whoUses.data?.uses?.modelInstances?.length >= 1
      && whoUses.data?.totalModelPlacements >= 1, whoUses.data);

    // 5. Reload and re-locate with the stable address.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.__FF14_WORKBENCH__ && globalThis.__BABYLON_PREVIEW__?.isReady), null, { timeout: 300000, polling: 250 });
    const relocated = await dispatch(page, 'objects.locate', { stableAddress: target.stableAddress });
    step('stable address survives reload', relocated.status === 'ok'
      && relocated.data?.found
      && relocated.data?.object?.resourceId === target.resourceId, relocated.data);

    // 6. Export the provenance summaries (full data to file, not console).
    await fs.writeFile(path.join(OUT_DIR, 'provenance.json'), `${JSON.stringify({ target, inspection, sibling, whoUses: whoUses.data }, null, 2)}\n`, 'utf8');
    step('provenance exported', true, { file: 'work/workbench/s03/provenance.json' });

    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s03-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS03 provenance validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
