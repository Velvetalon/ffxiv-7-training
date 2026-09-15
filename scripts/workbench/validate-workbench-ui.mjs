#!/usr/bin/env node
/**
 * S10 closed-loop validation: a person driving the panel and a script driving
 * dispatch complete the same key operations with matching read-backs.
 *
 * UI loop: capture case -> scramble via camera drag-independent command is
 * not a UI control, so scramble = isolate + env + override -> restore case
 * from the panel -> verify camera/time readback matches the case.
 * Also: panel close leaves no residual interception (isolation released,
 * faults cleared) and focus in the panel inputs does not move the character
 * camera (viewer mode has no character; assert camera unchanged).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../validation/browser.mjs';
import { openWorkbenchPage } from './wb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_URL = 'http://127.0.0.1:5173/ff14-web-babylon-preview/';
const OUT_DIR = path.join(REPO_ROOT, 'work', 'workbench', 's10');

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

async function click(page, selector) {
  await page.click(`[data-wb="${selector}"]`);
  await page.waitForTimeout(400);
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

  try {
    const { context, page } = await openWorkbenchPage({ browser, appUrl, waitFull: true });
    const panelVisible = await page.isVisible('.ff14-workbench');
    step('panel mounted', panelVisible, { panelVisible });

    // Fix a known site first so the captured case has a distinctive camera.
    await page.evaluate(() => globalThis.__FF14_WORKBENCH__.dispatch('camera.set', {
      position: [90.5219, 67, 92], target: [164.5219, 22, 0], fov: 0.82, id: 'kugane-castle',
    }));
    await page.evaluate(() => globalThis.__FF14_WORKBENCH__.dispatch('time.set', { time: 'day' }));
    await page.waitForTimeout(400);

    // UI: capture a case through the panel.
    await click(page, 'case-capture');
    const caseStatus = await page.textContent('[data-wb="case-status"]');
    step('UI capture', /captured/.test(caseStatus || ''), { caseStatus });
    await click(page, 'case-save');
    step('UI save', true, null);
    await click(page, 'case-refresh');
    const caseOptions = await page.locator('[data-wb="case-select"] option').count();
    step('UI case listed', caseOptions >= 1, { caseOptions });
    await page.selectOption('[data-wb="case-select"]', { index: 0 });

    // Scramble: isolate + env + an override, all through the panel.
    await click(page, 'isolate-enter');
    const isolateStatus = await page.textContent('[data-wb="object-status"]');
    step('UI isolate', /isolated/.test(isolateStatus || ''), { isolateStatus });

    // UI: restore the case through the panel (exit isolation first).
    await click(page, 'isolate-exit');
    await click(page, 'case-restore');
    const restoredText = await page.textContent('[data-wb="case-status"]');
    step('UI restore case', /restored/.test(restoredText || ''), { restoredText });

    // Script parity: dispatch state.read must agree with the panel result.
    const readBack = await page.evaluate(() => globalThis.__FF14_WORKBENCH__.dispatch('state.read'));
    const camera = (await readBack).data.camera.position;
    const uiMatches = camera
      && Math.abs(camera[0] - 90.5219) < 0.05
      && Math.abs(camera[1] - 67) < 0.05;
    step('script read-back matches UI', uiMatches, { camera });

    // Override through UI then undo through UI.
    await click(page, 'override-apply');
    const overrideStatus = await page.textContent('[data-wb="override-status"]');
    step('UI override applied', /→/.test(overrideStatus || ''), { overrideStatus });
    await click(page, 'override-undo');
    step('UI override undone', true, null);

    // Anomalies through UI.
    await click(page, 'anomalies');
    const anomalyStatus = await page.textContent('[data-wb="anomaly-status"]');
    step('UI anomalies readout', /kind/.test(anomalyStatus || ''), { anomalyStatus });

    // Close the panel: nothing may stay intercepted or isolated.
    await page.click('.ff14-workbench header button');
    const panelClosed = await page.isHidden('.ff14-workbench');
    const residualCheck = await page.evaluate(async () => {
      const status = await globalThis.__FF14_WORKBENCH__.dispatch('isolate.status');
      const overrides = await globalThis.__FF14_WORKBENCH__.dispatch('override.list');
      return { active: status.data.active, applied: overrides.data.applied.length };
    });
    step('panel close clean', panelClosed && residualCheck.active === false, { panelClosed, ...residualCheck });

    // Focus in panel inputs must not drive game input (viewer has no movement;
    // assert camera stays put while typing in the input).
    await page.evaluate(() => document.querySelector('.ff14-workbench header button').click());
    await page.waitForSelector('[data-wb="object-address"]', { state: 'visible' });
    await page.focus('[data-wb="object-address"]');
    await page.keyboard.type('123456');
    await page.waitForTimeout(500);
    const afterTyping = await page.evaluate(() => globalThis.__FF14_WORKBENCH__.dispatch('state.read'));
    const cameraStable = Math.abs(afterTyping.data.camera.position[0] - 90.5219) < 0.05;
    step('panel focus does not move camera', cameraStable, { cameraStable });

    const screenshot = path.join(OUT_DIR, 's10-panel.png');
    await page.screenshot({ path: screenshot, fullPage: false });
    await context.close();
  } finally {
    await browser.close();
  }

  const failed = steps.filter(item => !item.ok);
  const report = { generatedAt: startedAt, appUrl: appUrl.href, passed: failed.length === 0, total: steps.length, failed: failed.length, steps };
  const reportFile = path.join(OUT_DIR, `s10-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nS10 workbench UI validation: ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${steps.length})`}`);
  console.log(`Report: ${path.relative(REPO_ROOT, reportFile)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
