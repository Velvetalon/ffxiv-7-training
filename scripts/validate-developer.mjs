import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAssetRelease, prepareLocalSite, serveLocalSite } from './validation/local-site.mjs';
import { loadPlaywright } from './validation/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = 'work/v3-validation';
const DEFAULT_SITE = 'work/v3-validation/site';
const DEFAULT_ASSET_RELEASE = 'work/asset-performance/packed-all-final';
const DEFAULT_TIMEOUT = 45000;

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith('--')) result[key] = next, index += 1;
    else result[key] = true;
  }
  return result;
}

function resolveWork(value, label) {
  const absolute = path.resolve(root, value || DEFAULT_OUT);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !relative.startsWith(`work${path.sep}`)) {
    throw new Error(`${label} must stay under work/: ${absolute}`);
  }
  return absolute;
}

function compactError(error) {
  return error?.message || String(error);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function addCheck(checks, name, pass, detail = {}) {
  checks.push({ name, status: pass ? 'PASS' : 'FAIL', pass: Boolean(pass), detail });
}

function addSkip(checks, name, detail = {}) {
  checks.push({ name, status: 'SKIP', pass: null, detail });
}

async function waitWorld(page, sceneId, timeout) {
  await page.waitForFunction(id => {
    const world = window.__APP__?.world;
    return Boolean(world && world.sceneId === id && !world.loading && !world.loadError && world.isImported && world.navigation);
  }, sceneId, { timeout });
}

async function snapshot(page) {
  return page.evaluate(() => window.__APP__?.developer?.runtime?.getSnapshot?.() || null);
}

async function runCommand(page, command, args = {}) {
  return page.evaluate(async ({ command: name, args: payload }) => {
    const result = await window.__APP__?.developer?.runtime?.run?.(name, payload);
    if (!result) return result;
    return {
      ok: result.ok,
      reason: result.reason || null,
      state: result.state ? { scene: result.state.scene?.id || null } : undefined,
      id: result.id || result.mapId || result.skillId || null,
      preview: result.preview || false,
      pending: result.pending || false,
      resourceId: result.resourceId || null,
      time: result.time || null,
      settings: result.settings || null,
    };
  }, { command, args });
}

async function installAudioProbe(page) {
  await page.evaluate(() => {
    const audio = window.__APP__?.sandbox?.audio;
    if (!audio || audio.__v3ProbeInstalled) return;
    window.__v3AudioCalls = [];
    window.__v3AudioResults = [];
    const describe = value => {
      if (!value || typeof value !== 'object') return value;
      return { id: value.id || null, resourceId: value.resourceId || value.soundId || null, sceneId: value.sceneId || null };
    };
    for (const method of ['playScene', 'playAction']) {
      const original = audio[method].bind(audio);
      audio[method] = async (...args) => {
        window.__v3AudioCalls.push({ method, args: args.map(describe) });
        const result = await original(...args);
        window.__v3AudioResults.push({ method, result: describe(result) });
        return result;
      };
    }
    audio.__v3ProbeInstalled = true;
  });
}

async function installRuntimeProbe(page) {
  await page.evaluate(() => {
    const runtime = window.__APP__?.developer?.runtime;
    if (!runtime || runtime.__v3ProbeInstalled) return;
    window.__v3RuntimeCalls = [];
    const original = runtime.run.bind(runtime);
    runtime.run = async (...args) => {
      const result = await original(...args);
      const command = typeof args[0] === 'string' ? args[0] : args[0]?.command || args[0]?.type || null;
      const animation = window.__APP__?.world?.character?.animation;
      window.__v3RuntimeCalls.push({ command, result: result ? { ok: result.ok, reason: result.reason || null, resolvedId: result.resolvedId || null, id: result.id || null } : null,
        animationState: animation?.state || null, animationRemaining: animation?.actionRemaining ?? null,
        environmentParams: window.__APP__?.developer?.runtime?.getSnapshot?.().environment?.params || null });
      return result;
    };
    runtime.__v3ProbeInstalled = true;
  });
}

async function runtimeCalls(page) {
  return page.evaluate(() => (window.__v3RuntimeCalls || []).slice(-24));
}

async function audioProbe(page) {
  return page.evaluate(() => ({
    calls: (window.__v3AudioCalls || []).slice(-12),
    results: (window.__v3AudioResults || []).slice(-12),
    context: window.__APP__?.sandbox?.audio?.context?.state || null,
    bgm: window.__APP__?.sandbox?.audio?.bgm?.resourceId || null,
    pendingActions: window.__APP__?.sandbox?.audio?.pendingActions?.length ?? null,
  }));
}

async function exerciseMain(page, checks, args, report) {
  await waitWorld(page, 'gridania', args.timeout);
  await page.waitForFunction(() => Boolean(window.__APP__?.developer?.panel?.isOpen), null, { timeout: args.timeout });
  await installAudioProbe(page);
  await installRuntimeProbe(page);

  const exposed = await page.evaluate(() => {
    const developer = window.__APP__?.developer;
    return {
      keys: developer ? Object.keys(developer).sort() : [],
      runtime: typeof developer?.runtime?.run === 'function',
      snapshot: typeof developer?.runtime?.getSnapshot === 'function',
      panel: Boolean(developer?.panel?.element),
      overlay: Boolean(developer?.overlay?.element),
      preferences: typeof developer?.preferences?.snapshot === 'function',
      feedback: typeof developer?.feedback?.getState === 'function',
    };
  });
  addCheck(checks, 'runtime-bridge-dom-exposure', exposed.runtime && exposed.snapshot && exposed.panel && exposed.overlay && exposed.preferences && exposed.feedback, exposed);

  const tabIds = await page.locator('[data-dev-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.devTab));
  addCheck(checks, 'developer-toolbar-seven-tabs', tabIds.length === 7 && ['map', 'character', 'animation', 'skill', 'mount', 'audio', 'environment'].every(id => tabIds.includes(id)), { tabIds });

  const initial = await snapshot(page);
  report.initial = {
    scene: initial?.scene?.id || null,
    maps: initial?.maps?.length || 0,
    characterModel: initial?.character?.modelId || null,
    animationCount: initial?.animations?.total || initial?.animations?.ids?.length || 0,
    skills: initial?.skills?.length || 0,
    mounts: initial?.mounts?.length || 0,
    bgm: initial?.audio?.bgm?.length || 0,
    sfx: initial?.audio?.sfx?.length || 0,
    renderCalls: await page.evaluate(() => window.__APP__?.world?.renderer?.info?.render?.calls || 0),
  };
  addCheck(checks, 'gridania-runtime-renderable', Boolean(initial?.scene?.id === 'gridania' && initial?.character?.modelId && report.initial.renderCalls > 0), report.initial);

  // Map search, Chinese labels/IDs, recent history and coordinate teleport.
  await page.locator('[data-dev-map-search]').fill('格里达尼亚');
  const mapResult = page.locator('[data-dev-map-result]').first();
  const resultInfo = await mapResult.evaluate(node => ({ id: node.dataset.mapId, text: node.innerText.trim() })).catch(() => null);
  addCheck(checks, 'map-search-chinese-id', Boolean(resultInfo?.id === 'gridania' && /格里达尼亚/.test(resultInfo.text)), resultInfo || { result: null });
  if (resultInfo?.id) {
    await mapResult.click();
    await waitWorld(page, 'gridania', args.timeout);
    await page.waitForFunction(() => !window.__APP__?.world?.loading, null, { timeout: args.timeout });
  }
  await page.locator('[data-dev-map-select]').selectOption('limsa');
  await waitWorld(page, 'limsa', args.timeout);
  const afterSwitch = await snapshot(page);
  const recent = afterSwitch?.recent || [];
  addCheck(checks, 'map-switch-and-recent-history', afterSwitch?.scene?.id === 'limsa' && recent.includes('gridania') && recent.includes('limsa'), { scene: afterSwitch?.scene?.id, recent });
  const position = afterSwitch?.character?.position || afterSwitch?.player?.position || afterSwitch?.debug?.playerPosition;
  const point = { x: Number(position?.x || 0) + 0.37, y: Number(position?.y || 0), z: Number(position?.z || 0) + 0.23 };
  for (const axis of ['x', 'y', 'z']) await page.locator(`[data-dev-map-${axis}]`).fill(String(point[axis]));
  await page.locator('[data-dev-command="map.teleport"]').click();
  await page.waitForFunction(target => {
    const p = window.__APP__?.world?.player?.position;
    return p && ['x', 'y', 'z'].every(axis => Math.abs(p[axis] - target[axis]) < 0.05);
  }, point, { timeout: 5000 });
  const teleported = await page.evaluate(() => window.__APP__.world.player.position.toArray());
  addCheck(checks, 'map-xyz-teleport', ['x', 'y', 'z'].every((axis, index) => Math.abs(teleported[index] - point[axis]) < 0.05), { point, teleported });

  // Character JSON/reload, plus an optional real DAT fixture supplied by the caller.
  await page.locator('[data-dev-tab="character"]').click();
  const appearanceJson = await page.locator('[data-dev-character-json]').inputValue();
  let parsedAppearance = null;
  try { parsedAppearance = JSON.parse(appearanceJson); } catch { /* recorded as a failed check */ }
  addCheck(checks, 'character-appearance-json', Boolean(parsedAppearance && typeof parsedAppearance === 'object' && appearanceJson.length > 20), { bytes: appearanceJson.length, fields: parsedAppearance ? Object.keys(parsedAppearance).slice(0, 12) : [] });
  await page.locator('[data-dev-command="character.reload"]').click();
  await page.waitForFunction(() => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'character.reload', null, { timeout: 10000 });
  await page.waitForFunction(() => Boolean(window.__APP__?.world?.character?.model), null, { timeout: 10000 });
  addCheck(checks, 'character-reload-control', Boolean((await snapshot(page))?.character?.modelId), { modelId: (await snapshot(page))?.character?.modelId || null });
  const datPath = args.dat ? path.resolve(String(args.dat)) : null;
  if (!datPath) {
    addSkip(checks, 'character-dat-import', { reason: 'No --dat fixture was provided' });
  } else {
    try {
      await fs.access(datPath);
      await page.locator('[data-dev-dat]').setInputFiles(datPath);
      await page.waitForFunction(() => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'character.import', null, { timeout: 15000 });
      const datSnapshot = await snapshot(page);
      addCheck(checks, 'character-dat-import', Boolean(datSnapshot?.character?.appearance), { path: datPath, appearance: datSnapshot?.character?.appearance || null });
    } catch (error) {
      addCheck(checks, 'character-dat-import', false, { path: datPath, error: compactError(error) });
    }
  }

  // Four quick presets and one registered clip through the direct-play control.
  await page.locator('[data-dev-tab="animation"]').click();
  const animationResults = {};
  for (const id of ['idle', 'walk', 'run', 'jump']) {
    await page.locator(`[data-dev-animation-preset="${id}"]`).click();
    await page.waitForFunction(name => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'animation.play', id, { timeout: 5000 });
    const command = (await runtimeCalls(page)).at(-1);
    await sleep(100);
    const current = (await snapshot(page))?.animations?.current || null;
    animationResults[id] = { current, started: command?.animationState || null, remaining: command?.animationRemaining ?? null, ok: command?.result?.ok ?? false };
  }
  const presetPass = ['idle', 'walk', 'run'].every(id => animationResults[id].started === id)
    && animationResults.jump.started === 'jump-start' && animationResults.jump.ok;
  addCheck(checks, 'animation-preset-controls', presetPass, { ...animationResults, runtimeCalls: await runtimeCalls(page) });
  const registered = await page.evaluate(() => {
    const definition = window.__APP__?.world?.character?.definition?.animations || {};
    return definition.walk || definition.run || definition.idle || null;
  });
  if (!registered) {
    addSkip(checks, 'animation-registered-resource-direct-play', { reason: 'No non-preset registered clip in snapshot' });
  } else {
    await page.locator('[data-dev-animation-id]').fill(registered);
    await page.locator('[data-dev-command="animation.play"]').click();
    await page.waitForFunction(() => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'animation.play', null, { timeout: 5000 });
    const current = (await snapshot(page))?.animations?.current || null;
    addCheck(checks, 'animation-registered-resource-direct-play', current === registered, { requested: registered, current, runtimeCalls: await runtimeCalls(page) });
  }

  // Skill preview is intentionally dispatched outside combat validation/cost gates.
  await page.locator('[data-dev-tab="skill"]').click();
  const skillOptions = await page.locator('[data-dev-skill-select] option').evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean));
  const skillId = skillOptions.find(id => id === 'whm-afflatus-misery') || skillOptions[0];
  if (!skillId) {
    addSkip(checks, 'skill-preview-animation-and-audio', { reason: 'No parsed skill option' });
  } else {
    const bloodBefore = await page.evaluate(() => window.__APP__?.combat?.getState?.().resources?.bloodLily ?? null);
    await page.locator('[data-dev-skill-select]').selectOption(skillId);
    await page.locator('[data-dev-command="skill.trigger"]').click();
    await page.waitForFunction(id => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'skill.trigger'
      && window.__APP__?.world?.character?.state?.actionId === id, skillId, { timeout: 5000 });
    await sleep(350);
    const skillState = await snapshot(page);
    const audioState = await audioProbe(page);
    const bloodAfter = await page.evaluate(() => window.__APP__?.combat?.getState?.().resources?.bloodLily ?? null);
    const skillAudio = audioState.calls.some(call => call.method === 'playAction');
    addCheck(checks, 'skill-preview-animation-and-audio', skillState?.character?.actionId === skillId && skillAudio && bloodBefore === bloodAfter, {
      skillId, actionId: skillState?.character?.actionId || null, animation: skillState?.animations?.current || null,
      bloodBefore, bloodAfter, audio: audioState,
    });
  }

  // Mount preview is independent from the actual rider mount lifecycle.
  await page.locator('[data-dev-tab="mount"]').click();
  const mountId = await page.locator('[data-dev-mount-select] option').first().getAttribute('value');
  if (!mountId) {
    addSkip(checks, 'mount-preview-and-clear', { reason: 'No parsed mount option' });
    addSkip(checks, 'mount-ground-flight-lifecycle', { reason: 'No parsed mount option' });
  } else {
    await page.locator('[data-dev-mount-select]').selectOption(mountId);
    await page.locator('[data-dev-command="mount.spawn"]').click();
    await page.waitForFunction(() => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.preview?.kind === 'mount', null, { timeout: 15000 });
    const previewState = await snapshot(page);
    const clearResult = await runCommand(page, 'mount.clear');
    await page.waitForFunction(() => !window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.preview, null, { timeout: 5000 });
    addCheck(checks, 'mount-preview-and-clear', previewState?.developer?.preview?.kind === 'mount' && clearResult?.ok === true && !((await snapshot(page))?.developer?.preview), { mountId, preview: previewState?.developer?.preview || null, clearResult });

    await page.locator('[data-dev-command="mount.mount"]').click();
    await page.waitForFunction(() => window.__APP__?.world?.mount?.state?.isMounted === true, null, { timeout: 15000 });
    const mounted = await page.evaluate(() => ({ ...window.__APP__.world.mount.state }));
    await page.locator('[data-dev-command="mount.takeoff"]').click();
    await page.waitForFunction(() => ['takeoff', 'flying'].includes(window.__APP__?.world?.mount?.state?.movementMode), null, { timeout: 5000 });
    await page.waitForFunction(() => window.__APP__?.world?.mount?.state?.movementMode === 'flying', null, { timeout: 5000 });
    const flying = await page.evaluate(() => ({ ...window.__APP__.world.mount.state }));
    await page.locator('[data-dev-command="mount.land"]').click();
    await page.waitForFunction(() => window.__APP__?.world?.mount?.state?.movementMode === 'ground', null, { timeout: 7000 });
    const landed = await page.evaluate(() => ({ ...window.__APP__.world.mount.state }));
    await page.locator('[data-dev-command="mount.dismount"]').click();
    await page.waitForFunction(() => window.__APP__?.world?.mount?.state?.isMounted === false, null, { timeout: 5000 });
    const dismounted = await page.evaluate(() => ({ ...window.__APP__.world.mount.state }));
    addCheck(checks, 'mount-ground-flight-lifecycle', mounted.isMounted && flying.movementMode === 'flying' && landed.movementMode === 'ground' && !dismounted.isMounted, { mounted, flying, landed, dismounted });
  }

  // BGM/SFX lists are sourced from manifest scene entries and skill sound references.
  await page.locator('[data-dev-tab="audio"]').click();
  const audioLists = await page.evaluate(() => ({
    bgm: [...document.querySelectorAll('[data-dev-bgm-select] option')].map(node => node.value).filter(Boolean),
    sfx: [...document.querySelectorAll('[data-dev-sfx-select] option')].map(node => node.value).filter(Boolean),
  }));
  if (!audioLists.bgm.length) addCheck(checks, 'audio-bgm-list-and-play', false, audioLists);
  else {
    await page.locator('[data-dev-bgm-select]').selectOption(audioLists.bgm[0]);
    await page.locator('[data-dev-command="audio.bgm.play"]').click();
    await sleep(300);
    const probe = await audioProbe(page);
    addCheck(checks, 'audio-bgm-list-and-play', probe.calls.some(call => call.method === 'playScene') && Boolean(probe.bgm || probe.context), { selected: audioLists.bgm[0], probe });
    await page.locator('[data-dev-command="audio.bgm.stop"]').click();
  }
  if (!audioLists.sfx.length) addCheck(checks, 'audio-sfx-list-and-play', false, audioLists);
  else {
    await page.locator('[data-dev-sfx-select]').selectOption(audioLists.sfx[0]);
    await page.locator('[data-dev-command="audio.sfx.play"]').click();
    await sleep(250);
    const probe = await audioProbe(page);
    addCheck(checks, 'audio-sfx-list-and-play', probe.calls.some(call => call.method === 'playAction'), { selected: audioLists.sfx[0], probe });
  }
  const volume = 0.37;
  await page.locator('[data-dev-volume]').fill(String(volume));
  await page.waitForFunction(value => Math.abs(Number(window.__APP__?.developer?.runtime?.getSnapshot?.().audio?.settings?.volume) - value) < 0.02, volume, { timeout: 5000 });
  addCheck(checks, 'audio-volume-control', Math.abs(Number((await snapshot(page))?.audio?.settings?.volume) - volume) < 0.02, { volume });

  // Time, pause, profile, multipliers and reset.
  await page.locator('[data-dev-tab="environment"]').click();
  await page.locator('[data-dev-daynight="night"]').click();
  await page.waitForFunction(() => Number(window.__APP__?.developer?.runtime?.getSnapshot?.().environment?.time?.hour) < 0.1, null, { timeout: 5000 });
  await page.locator('[data-dev-daynight="day"]').click();
  await page.waitForFunction(() => Math.abs(Number(window.__APP__?.developer?.runtime?.getSnapshot?.().environment?.time?.hour) - 12) < 0.1, null, { timeout: 5000 });
  const pauseResult = await runCommand(page, 'environment.pause', { paused: true });
  const paused = (await snapshot(page))?.environment?.time?.paused;
  addCheck(checks, 'environment-time-daynight-pause', pauseResult?.ok === true && paused === true, { pauseResult, paused });
  const profileOptions = await page.locator('[data-dev-profile-select] option').evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean));
  const currentProfileId = (await snapshot(page))?.environment?.profileId;
  const profileId = profileOptions.find(id => id !== currentProfileId) || profileOptions[0];
  if (!profileId) {
    addSkip(checks, 'environment-profile-parameters-reset', { reason: 'No profile options' });
  } else {
    await page.locator('[data-dev-profile-select]').selectOption(profileId);
    const profileCommandObserved = await page.waitForFunction(id => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'environment.profile', profileId, { timeout: 5000 }).then(() => true).catch(() => false);
    const appliedProfileId = (await snapshot(page))?.environment?.profileId || null;
    const parameter = page.locator('[data-dev-env-param]').first();
    let parameterKey = null;
    let parameterApplied = false;
    if (await parameter.count()) {
      parameterKey = await parameter.getAttribute('data-dev-env-param');
      await parameter.fill('1.25');
      await parameter.dispatchEvent('input');
      await sleep(120);
      const parameterCalls = await runtimeCalls(page);
      parameterApplied = parameterCalls.some(call => call.command === 'environment.parameters' && Math.abs(Number(call.environmentParams?.[parameterKey]) - 1.25) < 0.01);
    }
    await page.locator('[data-dev-command="environment.reset"]').click();
    const resetObserved = await page.waitForFunction(() => window.__APP__?.developer?.runtime?.getSnapshot?.().developer?.lastCommand === 'environment.reset', null, { timeout: 5000 }).then(() => true).catch(() => false);
    const reset = await snapshot(page);
    const environmentCalls = await runtimeCalls(page);
    parameterApplied ||= environmentCalls.some(call => call.command === 'environment.parameters' && Math.abs(Number(call.environmentParams?.[parameterKey]) - 1.25) < 0.01);
    addCheck(checks, 'environment-profile-parameters-reset', profileCommandObserved && appliedProfileId === profileId && parameterApplied && resetObserved && reset?.environment?.manualOverrides?.parameters === false && reset.environment.manualOverrides?.profile === false, { profileId, appliedProfileId, parameterKey, parameterApplied, inputValue: await parameter.inputValue().catch(() => null), afterReset: { profileId: reset?.environment?.profileId, params: reset?.environment?.params, manualOverrides: reset?.environment?.manualOverrides }, commands: { profileCommandObserved, resetObserved }, runtimeCalls: environmentCalls });
  }

  // Compact overlay fields must carry live IDs/positions and runtime diagnostics.
  await page.locator('[data-dev-overlay-toggle]').click();
  await page.waitForFunction(() => !document.querySelector('[data-debug-overlay]')?.classList.contains('hidden'), null, { timeout: 3000 });
  await sleep(450);
  const overlay = await page.locator('[data-debug-overlay]').evaluate(node => Object.fromEntries([...node.querySelectorAll('[data-debug-field]')].map(field => [field.dataset.debugField, field.textContent.trim()])));
  const overlayFields = ['map', 'player', 'model', 'lod', 'cache', 'load'];
  const overlayPass = overlayFields.every(key => overlay[key] && overlay[key] !== '未知');
  addCheck(checks, 'debug-overlay-live-fields', overlayPass, overlay);

  // Targeted mobile fit check for the real panel/overlay DOM.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const panel = document.querySelector('[data-developer-panel]');
    const overlayNode = document.querySelector('[data-debug-overlay]');
    const p = panel?.getBoundingClientRect();
    const o = overlayNode?.getBoundingClientRect();
    return {
      panel: p ? { left: p.left, right: p.right, width: p.width, bottom: p.bottom } : null,
      overlay: o ? { left: o.left, right: o.right, width: o.width } : null,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  addCheck(checks, 'developer-panel-mobile-fit', Boolean(mobile.panel && mobile.panel.left >= 0 && mobile.panel.right <= 390 && mobile.overlay?.left >= 0 && mobile.overlay?.right <= 390 && !mobile.overflow), mobile);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Same-origin persistence check covers map/recent/appearance/camera/volume and developer state.
  await page.locator('[data-dev-tab="audio"]').click();
  await page.locator('[data-dev-volume]').fill('0.41');
  await page.locator('[data-dev-tab="environment"]').click();
  const canvas = page.locator('#world');
  const box = await canvas.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + box.width / 2 + 36, box.y + box.height / 2 + 12, { steps: 3 });
    await page.mouse.up({ button: 'right' });
  }
  await sleep(500);
  const persistedBefore = await page.evaluate(() => ({ settings: JSON.parse(localStorage.getItem('aetheryte-settings') || '{}'), panel: window.__APP__.developer.panel.getState() }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const reloadWorldReady = await page.waitForFunction(id => {
    const world = window.__APP__?.world;
    return Boolean(world && world.sceneId === id && !world.loading && !world.loadError && world.isImported && world.navigation);
  }, 'limsa', { timeout: args.timeout }).then(() => true).catch(() => false);
  const panelRestored = await page.waitForFunction(() => window.__APP__?.developer?.panel?.isOpen && window.__APP__.developer.panel.getState().tab === 'environment' && window.__APP__.developer.overlay.isEnabled, null, { timeout: 10000 }).then(() => true).catch(() => false);
  const persistedAfter = await page.evaluate(() => ({
    settings: JSON.parse(localStorage.getItem('aetheryte-settings') || '{}'),
    panel: window.__APP__.developer.panel.getState(),
    prefs: window.__APP__.developer.preferences.snapshot(),
  }));
  const settings = persistedAfter.settings || {};
  const prefs = persistedAfter.prefs || {};
  const persistencePass = reloadWorldReady && panelRestored && settings.lastSceneId === 'limsa'
    && Array.isArray(settings.recentSceneIds) && settings.recentSceneIds.includes('gridania') && settings.recentSceneIds.includes('limsa')
    && settings.appearance && Number.isFinite(Number(settings.camera?.azimuth))
    && Math.abs(Number(settings.volume) - 0.41) < 0.03
    && persistedAfter.panel.open && persistedAfter.panel.tab === 'environment' && persistedAfter.panel.overlay;
  addCheck(checks, 'session-preferences-survive-same-origin-reload', persistencePass, {
    before: { lastSceneId: persistedBefore.settings?.lastSceneId, recentSceneIds: persistedBefore.settings?.recentSceneIds, volume: persistedBefore.settings?.volume, panel: persistedBefore.panel },
    after: { reloadWorldReady, panelRestored, lastSceneId: settings.lastSceneId, recentSceneIds: settings.recentSceneIds, appearance: Boolean(settings.appearance), camera: settings.camera || null, volume: settings.volume, panel: persistedAfter.panel, prefs: { lastSceneId: prefs.lastSceneId, recent: prefs.recentSceneIds } },
  });
  report.final = { scene: (await snapshot(page))?.scene?.id || null, panel: persistedAfter.panel, overlay: persistedAfter.panel?.overlay || false };
}

async function exerciseRetry(browser, appUrl, checks, timeout) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  let blocked = 0;
  const failures = [];
  page.on('pageerror', error => failures.push(`pageerror: ${compactError(error)}`));
  page.on('requestfailed', request => failures.push(`request: ${request.url()} ${request.failure()?.errorText || ''}`));
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (!blocked && /\/maps\/gridania\//.test(url)) {
      blocked += 1;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const target = new URL(appUrl);
  target.searchParams.set('scene', 'gridania');
  target.searchParams.set('dev', '1');
  try {
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(() => Boolean(window.__APP__?.developer?.feedback), null, { timeout });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-runtime-retry]');
      return node && !node.classList.contains('hidden') && !document.querySelector('.runtime-feedback')?.classList.contains('hidden');
    }, null, { timeout: 15000 });
    const errorState = await page.evaluate(() => ({
      feedback: window.__APP__.developer.feedback.getState(),
      text: document.querySelector('.runtime-feedback')?.textContent?.trim() || '',
      retry: !document.querySelector('[data-runtime-retry]')?.classList.contains('hidden'),
    }));
    await page.locator('[data-runtime-retry]').click();
    await waitWorld(page, 'gridania', timeout);
    const recovered = await page.evaluate(() => ({ feedback: window.__APP__.developer.feedback.getState(), loadError: window.__APP__.world.loadError, imported: window.__APP__.world.isImported }));
    addCheck(checks, 'loading-error-visible-retry-recovers', blocked === 1 && errorState.retry && Boolean(errorState.feedback.error) && recovered.imported && !recovered.loadError, { blocked, errorState, recovered, browserErrors: failures.slice(0, 4) });
  } catch (error) {
    addCheck(checks, 'loading-error-visible-retry-recovers', false, { blocked, error: compactError(error), browserErrors: failures.slice(0, 4) });
  } finally {
    await context.close();
  }
}

function printHelp() {
  console.log(`Usage: node scripts/validate-developer.mjs [options]
  --url URL                         Reuse an existing /ff14-web/ base URL
  --out PATH                        Report directory under work/ (default work/v3-validation)
  --site PATH                       JS-only site directory under work/
  --asset-release PATH              Existing packed world release (default work/asset-performance/packed-all-final)
  --skip-build                      Reuse --site without running Vite
  --dat PATH                        Optional real FFXIV_CHARA_40.dat fixture
  --browser-path PATH               Chromium executable
  --playwright-module-path PATH     Existing Playwright package/module directory
  --timeout MS                      Bounded interaction timeout (default 45000)
  --server-only                     Keep a hidden local V3 server alive and write work/v3-validation/server.json
  --no-retry-probe                  Skip the targeted one-request map failure/retry check
  --help                            Show this help

This is a focused Gridania + Limsa developer-tools pass. It never runs the 65-map smoke pass.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { printHelp(); process.exit(0); }

const out = resolveWork(args.out, '--out');
const site = resolveWork(args.site || DEFAULT_SITE, '--site');
const timeout = Math.max(10000, Number(args.timeout) || DEFAULT_TIMEOUT);

if (args['server-only']) {
  const assetRelease = await findAssetRelease(root, args['asset-release'] || DEFAULT_ASSET_RELEASE);
  await prepareLocalSite({ root, out: site, assetRelease, skipBuild: true });
  const server = await serveLocalSite({ root, out: site, assetRelease });
  const record = {
    pid: process.pid,
    url: server.url,
    site,
    assetRelease,
    startedAt: new Date().toISOString(),
    hidden: Boolean(args.hidden),
    preservedV2: { pid: 27204, port: 56515, url: 'http://127.0.0.1:56515/ff14-web/' },
  };
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'server.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
  await new Promise(() => {});
}

const startedAt = Date.now();
const checks = [];
const report = {
  schemaVersion: 1,
  kind: 'developer-validation-v3',
  status: 'RUNNING',
  scope: { scenes: ['gridania', 'limsa'], full65Smoke: false, visualFidelity: false },
  startedAt: new Date().toISOString(),
  commandNode: process.execPath,
  out,
  site,
  dat: args.dat ? path.resolve(String(args.dat)) : null,
  checks,
};
let server = null;
let browser = null;
let page = null;
let appUrl = args.url ? String(args.url) : null;
const pageErrors = [];
const consoleErrors = [];
let requestFailures = 0;

try {
  const assetRelease = await findAssetRelease(root, args['asset-release'] || DEFAULT_ASSET_RELEASE);
  report.assetRelease = assetRelease;
  if (!appUrl) {
    await prepareLocalSite({ root, out: site, assetRelease, skipBuild: Boolean(args['skip-build']) });
    server = await serveLocalSite({ root, out: site, assetRelease });
    appUrl = server.url;
  }
  report.url = appUrl;
  const { chromium } = await loadPlaywright(args['playwright-module-path'] || 'C:/Users/v_whcnwwang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
  browser = await chromium.launch({
    executablePath: args['browser-path'] || process.env.BROWSER_PATH || undefined,
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(compactError(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => { requestFailures += 1; });
  const target = new URL(appUrl);
  target.searchParams.set('scene', 'gridania');
  target.searchParams.set('dev', '1');
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
  await exerciseMain(page, checks, { ...args, timeout }, report);
  if (!args['no-retry-probe']) await exerciseRetry(browser, appUrl, checks, timeout);
  else addSkip(checks, 'loading-error-visible-retry-recovers', { reason: '--no-retry-probe' });
  await context.close();
} catch (error) {
  addCheck(checks, 'validator-execution', false, { error: compactError(error), stack: error?.stack || null });
} finally {
  await page?.context()?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.totalMs = Date.now() - startedAt;
  report.consoleSummary = {
    pageErrorCount: pageErrors.length,
    consoleErrorCount: consoleErrors.length,
    requestFailureCount: requestFailures,
    pageErrors: pageErrors.slice(0, 8),
    consoleErrors: consoleErrors.slice(0, 8),
  };
  report.failures = checks.filter(item => item.status === 'FAIL').map(item => ({ name: item.name, detail: item.detail }));
  report.status = report.failures.length ? 'FAIL' : 'PASS';
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(out, 'summary.json'), `${JSON.stringify({
    status: report.status, totalMs: report.totalMs, url: report.url || null,
    full65Smoke: false, failureCount: report.failures.length,
    failures: report.failures.map(item => item.name), consoleSummary: report.consoleSummary,
    report: path.join(out, 'report.json'),
  }, null, 2)}\n`);
}

console.log(JSON.stringify({
  status: report.status,
  totalMs: report.totalMs,
  url: report.url || null,
  full65Smoke: false,
  failureCount: report.failures.length,
  failures: report.failures.map(item => item.name),
  consoleSummary: report.consoleSummary,
  report: path.join(out, 'report.json'),
}, null, 2));
if (report.status === 'FAIL') process.exitCode = 1;
