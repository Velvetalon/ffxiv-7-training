#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './validation/browser.mjs';
import { prepareLocalSite, serveLocalSite } from './validation/local-site.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_OUT = path.join(root, 'work/quality-v2-validation');
const DEFAULT_CHARACTER_MANIFEST = path.join(root, 'public/extracted/sandbox-v2/character/character-model.partial.json');
const DEFAULT_GAMEPLAY_MANIFEST = path.join(root, 'public/extracted/sandbox-v2/gameplay/manifest.gameplay.partial.json');
const DEFAULT_SCENE = 'gridania';
const DEFAULT_TIMEOUT = 45000;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf('=');
    const name = token.slice(2, separator < 0 ? undefined : separator);
    const next = argv[index + 1];
    args[name] = separator >= 0
      ? token.slice(separator + 1)
      : next && !next.startsWith('--') ? argv[++index] : true;
  }
  return args;
}

function asBoolean(value) {
  return value === true || value === '' || String(value).toLowerCase() === 'true';
}

function resolvePath(value, fallback) {
  return path.resolve(root, String(value || fallback));
}

function assertWorkPath(file, label) {
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !relative.startsWith(`work${path.sep}`)) {
    throw new Error(`${label} must be inside this project's work/ directory: ${absolute}`);
  }
  return absolute;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function compactError(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 400);
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function entriesWithPositiveCounts(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([, count]) => finitePositive(count));
}

function firstCharacter(manifest) {
  return manifest?.characters?.['ffxiv-chara-40'] || Object.values(manifest?.characters || {})[0] || null;
}

function summarizeSourceCoverage(manifest, characterPath) {
  const character = firstCharacter(manifest);
  const completeness = character?.completeness || manifest?.completeness || {};
  const hands = completeness.hands || {};
  const feet = completeness.feet || {};
  const iris = completeness.iris || {};
  const modelRecord = Object.values(manifest?.resources || {}).find(record => record?.metadata?.kind === 'character-model');

  const weightedFingerCounts = {
    ...(hands.weightedFingerVertexCounts || {}),
    ...(hands.weightedFingerBoneVertexCounts || {}),
    ...(hands.fingerWeightedBoneVertexCounts || {}),
    ...(hands.fingerVertexCounts || {}),
  };
  const declaredFingerBones = [...new Set([
    ...(Array.isArray(hands.fingerBones) ? hands.fingerBones.filter(Boolean) : Object.keys(hands.fingerBones || {})),
    ...Object.keys(weightedFingerCounts),
  ])];
  const weightedBoneVertexCounts = hands.weightedBoneVertexCounts || {};
  const fingerEntries = declaredFingerBones
    .map(name => [name, Number(weightedFingerCounts[name] ?? weightedBoneVertexCounts[name] ?? 0)])
    .filter(([, count]) => finitePositive(count));
  const handVertices = Number(hands.regionVertices || hands.handRegionVertices || hands.vertices || 0);
  const feetCounts = entriesWithPositiveCounts(feet.weightedBoneVertexCounts);
  const irisBones = Array.isArray(iris.weightedBones) ? iris.weightedBones.filter(Boolean) : [];
  const modelMeta = modelRecord?.metadata || {};
  const materialRoles = modelMeta.materialShaders || modelMeta.materialRoles || {};
  const irisRoleCount = Object.values(materialRoles).filter(role => String(role?.role || role?.shader || '').toLowerCase() === 'iris').length;

  return {
    path: characterPath,
    characterId: character?.id || null,
    model: {
      sourceVertices: Number(modelMeta.sourceVertices || 0),
      sourceMeshCount: Number(modelMeta.sourceMeshCount || modelMeta.glbMeshes || 0),
      skeletonBones: Number(modelMeta.skeletonBones || 0),
    },
    parts: {
      hands: {
        regionVertices: handVertices,
        declaredFingerBones: declaredFingerBones.slice(0, 16),
        weightedFingerBones: fingerEntries.map(([name]) => name).slice(0, 16),
        weightedFingerVertices: fingerEntries.reduce((sum, [, count]) => sum + count, 0),
        pass: handVertices > 0 && declaredFingerBones.length >= 2 && fingerEntries.length >= 2,
      },
      feet: {
        regionVertices: Number(feet.regionVertices || feet.footRegionVertices || 0),
        weightedBones: feetCounts.map(([name]) => name).slice(0, 16),
        weightedVertices: feetCounts.reduce((sum, [, count]) => sum + Number(count), 0),
        pass: finitePositive(feet.regionVertices || feet.footRegionVertices) && feetCounts.length > 0,
      },
      iris: {
        weightedBones: irisBones.slice(0, 8),
        materialRoleCount: irisRoleCount,
        depthTest: iris.depthTest ?? iris.material?.depthTest ?? null,
        pass: irisBones.length > 0 && irisRoleCount > 0 && iris.depthTest !== false && iris.material?.depthTest !== false,
      },
    },
  };
}

async function sourceChecks({ characterPath, gameplayPath }) {
  let character;
  let gameplay;
  const checks = [];
  try {
    character = await readJson(characterPath);
    const summary = summarizeSourceCoverage(character, characterPath);
    checks.push({
      name: 'source-character-model',
      pass: summary.model.sourceVertices > 0 && summary.model.sourceMeshCount > 0 && summary.model.skeletonBones > 0,
      detail: summary.model,
    });
    checks.push({ name: 'source-hand-finger-geometry', pass: summary.parts.hands.pass, detail: summary.parts.hands });
    checks.push({ name: 'source-feet-geometry', pass: summary.parts.feet.pass, detail: summary.parts.feet });
    checks.push({ name: 'source-iris-material', pass: summary.parts.iris.pass, detail: summary.parts.iris });
  } catch (error) {
    checks.push({ name: 'source-character-manifest', pass: false, detail: { path: characterPath, error: compactError(error) } });
  }
  try {
    gameplay = await readJson(gameplayPath);
    const skills = gameplay.skillPresentations || gameplay.skills || {};
    const skillIds = ['whm-presence-of-mind', 'whm-assize', 'whm-temperance'];
    const skillSummary = Object.fromEntries(skillIds.map(id => [id, {
      animation: Boolean(skills[id]?.animationId || skills[id]?.animationResourceId || skills[id]?.animationState),
      sound: Boolean(skills[id]?.soundId || skills[id]?.soundEvents?.length),
    }]));
    const jumpStates = Object.keys(gameplay.jump?.states || {});
    checks.push({
      name: 'source-gameplay-partial',
      pass: jumpStates.includes('jump-start') && jumpStates.includes('jump-airborne') && jumpStates.includes('jump-land') &&
        skillIds.every(id => skillSummary[id].animation && skillSummary[id].sound),
      detail: { jumpStates, skills: skillSummary },
    });
  } catch (error) {
    checks.push({ name: 'source-gameplay-manifest', pass: false, detail: { path: gameplayPath, error: compactError(error) } });
  }
  return { checks, character, gameplay };
}

function check(name, pass, detail = {}) {
  return { name, pass: Boolean(pass), detail };
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(String(value || ''));
}

function hasAscii(value) {
  return /[A-Za-z0-9]/.test(String(value || ''));
}

function urlWithScene(url, scene) {
  const target = new URL(url);
  target.searchParams.set('scene', scene);
  return target.href;
}

async function waitForWorld(page, scene, timeoutMs) {
  await page.goto(urlWithScene(page.__sandboxAppUrl, scene), {
    waitUntil: 'domcontentloaded', timeout: timeoutMs,
  });
  await page.waitForFunction(id => {
    const world = window.__APP__?.world;
    return Boolean(world && world.sceneId === id && !world.loading && world.isImported && world.navigation &&
      world.renderer?.info?.render?.calls > 0);
  }, scene, { timeout: timeoutMs });
  await page.evaluate(async () => { await window.__APP__.world.sandboxReady; });
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function clickCanvas(page, xRatio = 0.5, yRatio = 0.5) {
  const box = await page.locator('#world').boundingBox();
  if (!box) throw new Error('World canvas has no bounding box');
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
  return box;
}

async function inspectCharacter(page) {
  return page.evaluate(() => {
    const world = window.__APP__?.world;
    const character = world?.character;
    const model = character?.model;
    let meshes = 0;
    let skinnedMeshes = 0;
    let vertices = 0;
    let skeletonBones = 0;
    const meshNames = [];
    const irisMaterials = [];
    const partMeshes = { hands: [], feet: [] };
    const inspectMesh = node => {
      const nativeMesh = typeof node.getTotalVertices === 'function';
      if (nativeMesh ? !node.getTotalVertices() : !node.isMesh) return;
      meshes++;
      if (node.isSkinnedMesh || (nativeMesh && node.skeleton)) {
        skinnedMeshes++;
        skeletonBones = Math.max(skeletonBones, node.skeleton?.bones?.length || 0);
      }
      vertices += nativeMesh ? node.getTotalVertices() : node.geometry?.attributes?.position?.count || 0;
      if (meshNames.length < 48) meshNames.push(node.name || '(unnamed)');
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material) continue;
        const label = [node.name, material.name, material.metadata?.ffxivRole, material.userData?.role, material.userData?.shader,
          material.userData?.semantic, material.userData?.source].filter(Boolean).join(' ').toLowerCase();
        if (/iris|iri/.test(label)) irisMaterials.push({ label: label.slice(0, 140), depthTest: material.depthTest !== false && material.disableDepthWrite !== true });
        if (/hand|glov|arm|te_l|te_r|finger/.test(label)) partMeshes.hands.push(node.name || label.slice(0, 80));
        if (/foot|shoe|sho|asi_/.test(label)) partMeshes.feet.push(node.name || label.slice(0, 80));
      }
    };
    if (model?.getChildMeshes) model.getChildMeshes().forEach(inspectMesh);
    else model?.traverse?.(inspectMesh);
    const appearance = character?.state?.appearance || null;
    const modelScale = model?.scaling?.asArray?.() || model?.scale?.toArray?.() || null;
    const runtimeDefinition = character?.definition?.appearanceBindings || null;
    const runtimeCompleteness = runtimeDefinition?.completeness || null;
    const animationStates = [...(character?.animation?.clips?.keys?.() || [])];
    return {
      source: character?.source || null,
      modelPresent: Boolean(model),
      animationPresent: Boolean(character?.animation),
      meshes, skinnedMeshes, vertices, skeletonBones,
      meshNames,
      irisMaterials: irisMaterials.slice(0, 12),
      irisDepthTestValid: irisMaterials.length > 0 && irisMaterials.every(item => item.depthTest),
      partMeshes: { hands: [...new Set(partMeshes.hands)].slice(0, 12), feet: [...new Set(partMeshes.feet)].slice(0, 12) },
      animationStates: animationStates.slice(0, 64),
      appearanceFormat: appearance?.source?.format || null,
      appearanceMatch: appearance ? { race: appearance.race, tribe: appearance.tribe, sex: appearance.sex, face: appearance.face, hair: appearance.hair } : null,
      modelScale,
      runtimeCompleteness,
      sandboxError: world?.sandboxError || null,
      renderCalls: world?.renderer?.info?.render?.calls || 0,
      sceneRootChildren: world?.sceneRoot?.children?.length || 0,
    };
  });
}

async function importDat(page, datPath, timeoutMs) {
  if (!datPath) return { attempted: false, check: check('native-dat-import', false, { reason: 'Provide --dat=PATH to exercise the native file picker.' }) };
  try {
    await page.locator('#sandbox-open').click();
    const input = page.locator('[data-appearance-file]');
    await input.waitFor({ state: 'attached', timeout: 5000 });
    await page.evaluate(() => {
      const character = window.__APP__.world.character;
      if (!character.__sandboxOriginalLoadDefinition) {
        character.__sandboxOriginalLoadDefinition = character.loadDefinition.bind(character);
        character.loadDefinition = async (...args) => {
          window.__sandboxDatLoadCalls = (window.__sandboxDatLoadCalls || 0) + 1;
          const result = await character.__sandboxOriginalLoadDefinition(...args);
          window.__sandboxDatLastResult = result;
          return result;
        };
      }
      window.__sandboxDatLoadCalls = 0;
      window.__sandboxDatLastResult = null;
    });
    await input.setInputFiles(datPath);
    await page.waitForFunction(() => {
      const appearance = window.__APP__?.world?.character?.state?.appearance;
      return window.__sandboxDatLoadCalls > 0 && window.__sandboxDatLastResult === true &&
        window.__APP__?.world?.character?.source === 'ffxiv-client' &&
        appearance?.source?.format === 'FFXIV_CHARA_DAT';
    }, null, { timeout: timeoutMs });
    const details = await page.evaluate(() => {
      const world = window.__APP__.world;
      const appearance = world.character.state.appearance;
      const stateText = document.querySelector('[data-appearance-state]')?.textContent || '';
      const scale = world.character.model?.scaling?.asArray?.() || world.character.model?.scale?.toArray?.() || [];
      return {
        loadCalls: window.__sandboxDatLoadCalls || 0,
        source: appearance?.source?.format || null,
        stateText: stateText.slice(0, 160),
        match: { race: appearance?.race, tribe: appearance?.tribe, sex: appearance?.sex, face: appearance?.face, hair: appearance?.hair },
        scale: scale.map(Number),
        finiteScale: scale.length === 3 && scale.every(Number.isFinite),
        modelVisible: world.character.model?.visible !== false,
      };
    });
    const pass = details.loadCalls > 0 && details.source === 'FFXIV_CHARA_DAT' && details.finiteScale && details.modelVisible &&
      !details.stateText.includes('未导入外观');
    return { attempted: true, check: check('native-dat-import', pass, details) };
  } catch (error) {
    return { attempted: true, check: check('native-dat-import', false, { path: datPath, error: compactError(error) }) };
  }
}

async function traceJump(page) {
  const samples = [];
  let baselineY = null;
  try {
    await page.locator('#world').focus({ timeout: 2000 });
    await page.evaluate(() => { window.__sandboxJumpTrace = []; });
    baselineY = await page.evaluate(() => window.__APP__.world.player.position.y);
    await page.keyboard.down('Space');
    for (let index = 0; index < 60; index++) {
      samples.push(await page.evaluate(() => {
        const world = window.__APP__.world;
        return {
          y: Number(world.player.position.y.toFixed(3)),
          floor: Number((world.navigation.surfaceAt(world.player.position.x, world.player.position.z)?.height ?? 0).toFixed(3)),
          airborne: Boolean(world.character.state.airborne),
          movement: world.character.state.movement,
          animation: world.character.animation?.state || null,
          velocity: Number((world.character.movement.verticalVelocity || 0).toFixed(3)),
          inputEnabled: Boolean(world.input?.enabled),
          keys: [...(world.input?.keys || [])],
        };
      }));
      if (index === 1) await page.keyboard.up('Space');
      if (index > 10 && samples.at(-1)?.movement === 'idle' && samples.at(-2)?.movement === 'idle') break;
      await sleep(30);
    }
  } finally {
    await page.keyboard.up('Space').catch(() => {});
  }
  const movements = [...new Set(samples.map(item => item.movement).filter(Boolean))];
  const animations = [...new Set(samples.map(item => item.animation).filter(Boolean))];
  const start = samples.find(item => item.movement === 'jump-start');
  const airborne = samples.find(item => item.airborne && item.movement === 'jump-airborne');
  const landing = samples.find(item => item.movement === 'jump-land' || item.animation === 'jump-land');
  const last = samples.at(-1) || {};
  const landed = samples.some(item => item.landed) || (!last.airborne && last.movement === 'idle' && Number.isFinite(last.floor));
  return {
    samples: samples.length,
    movements,
    animations,
    peakY: samples.length ? Math.max(...samples.map(item => item.y)) : null,
    start: Boolean(start), airborne: Boolean(airborne), landing: Boolean(landing), landed,
    restored: !last.airborne && last.movement === 'idle' && Number.isFinite(baselineY) && Math.abs(last.y - baselineY) < 0.05,
    firstSamples: samples.slice(0, 4),
    last: { y: last.y, floor: last.floor, movement: last.movement, animation: last.animation, airborne: last.airborne,
      inputEnabled: last.inputEnabled, keys: last.keys },
  };
}

async function probeSkills(page, timeoutMs) {
  const ids = ['whm-presence-of-mind', 'whm-assize', 'whm-temperance'];
  const result = { bookEntries: [], actions: [], sourceStarts: 0, audio: null };
  try {
    await page.locator('#book-open').click();
    await page.locator('.book-modal').waitFor({ state: 'visible', timeout: 5000 });
    result.bookEntries = await page.locator('.book-skill').evaluateAll(nodes => nodes.map(node => node.dataset.inspect).filter(Boolean));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    // Unlock first so a pending scene track cannot be mistaken for a skill cue.
    await page.locator('#sandbox-open').click();
    await sleep(180);
    result.audio = await page.evaluate(() => {
      const audio = window.__APP__.sandbox.audio;
      const context = audio.ensureContext?.();
      window.__sandboxActionSourceStarts = 0;
      if (context && !context.__sandboxPatched) {
        const originalCreate = context.createBufferSource.bind(context);
        context.createBufferSource = () => {
          const source = originalCreate();
          const originalStart = source.start.bind(source);
          source.start = (...args) => { window.__sandboxActionSourceStarts++; return originalStart(...args); };
          return source;
        };
        context.__sandboxPatched = true;
      }
      return { state: context?.state || null, unlocked: Boolean(audio.isUnlocked?.()), starts: 0 };
    });
    for (const id of ids) {
      const before = await page.evaluate(() => window.__sandboxActionSourceStarts || 0);
      await page.locator(`[data-action="${id}"]`).first().click();
      await page.waitForFunction(actionId => window.__APP__?.world?.character?.state?.actionId === actionId,
        id, { timeout: Math.min(timeoutMs, 6000) }).catch(() => {});
      await page.waitForFunction(previous => (window.__sandboxActionSourceStarts || 0) > previous,
        before, { timeout: Math.min(timeoutMs, 15000) }).catch(() => {});
      const after = await page.evaluate(actionId => {
        const app = window.__APP__;
        const definition = app.sandbox.assets.manifest?.skills?.[actionId] || {};
        const animationState = definition.animationState || definition.animation?.state || null;
        const animation = app.world.character.animation;
        return {
          actionId: app.world.character.state.actionId,
          actionPhase: app.world.character.state.actionPhase || null,
          actionError: app.world.character.state.actionError || null,
          animationState,
          clipRegistered: Boolean(animationState && animation?.has(animationState)),
          clipDuration: animationState ? Number(animation?.clip(animationState)?.getLength?.() ?? animation?.clip(animationState)?.duration ?? 0) : 0,
          starts: window.__sandboxActionSourceStarts || 0,
          soundId: definition.soundId || null,
          context: app.sandbox.audio.context?.state || null,
        };
      }, id);
      result.actions.push({ id, before, after, sourceStarts: after.starts - before });
      if (id !== ids.at(-1)) {
        await page.waitForFunction(() => {
          const state = window.__APP__?.combat?.getState?.();
          return Boolean(state && !state.cast && Number(state.animationLock || 0) <= 0.02);
        }, null, { timeout: 3000 }).catch(() => {});
      }
    }
    result.sourceStarts = await page.evaluate(() => window.__sandboxActionSourceStarts || 0);
    result.audio.context = await page.evaluate(() => window.__APP__.sandbox.audio.context?.state || null);
  } catch (error) {
    result.error = compactError(error);
  }
  const actionsPass = result.actions.length === ids.length && result.actions.every(item =>
    item.after.actionId === item.id && item.after.clipRegistered && item.after.clipDuration > 0 &&
    item.sourceStarts > 0 && !item.after.actionError);
  const bookPass = ids.every(id => result.bookEntries.includes(id));
  return check('native-skill-buttons-and-audio', actionsPass && bookPass, {
    bookEntryCount: result.bookEntries.length,
    bookEntries: result.bookEntries.filter(id => ids.includes(id)),
    actions: result.actions.map(item => ({ id: item.id, actionId: item.after.actionId, clipRegistered: item.after.clipRegistered,
      clipDuration: Number(item.after.clipDuration.toFixed(3)), sourceStarts: item.sourceStarts, error: item.after.actionError })),
    sourceStarts: result.sourceStarts,
    audioContext: result.audio?.context || null,
    error: result.error || null,
  });
}

async function probeMount(page, timeoutMs) {
  const result = { mountOptions: 0 };
  try {
    const panel = page.locator('.sandbox-panel');
    if (await panel.evaluate(node => node.classList.contains('hidden'))) await page.locator('#sandbox-open').click();
    await page.locator('.sandbox-panel').waitFor({ state: 'visible', timeout: 5000 });
    const mountSelect = page.locator('[data-mount]');
    result.mountOptions = await mountSelect.locator('option').count();
    if (!result.mountOptions) throw new Error('Sandbox mount selector has no options');
    await mountSelect.selectOption({ index: 0 });
    await page.locator('[data-mount-toggle]').click();
    await page.waitForFunction(() => window.__APP__.world.mount.state.isMounted && !window.__APP__.world.mount.state.loading,
      null, { timeout: timeoutMs });
    const mounted = await page.evaluate(() => {
      const world = window.__APP__.world;
      const p = world.player.position;
      return { state: { ...world.mount.state }, position: [p.x, p.y, p.z], modelParent: world.character.model?.parent?.name || null };
    });
    await clickCanvas(page, 0.5, 0.5);
    const groundStart = await page.evaluate(() => {
      const p = window.__APP__.world.player.position;
      return [p.x, p.y, p.z];
    });
    await page.keyboard.down('KeyW'); await sleep(420); await page.keyboard.up('KeyW');
    const groundEnd = await page.evaluate(() => {
      const p = window.__APP__.world.player.position;
      return [p.x, p.y, p.z];
    });
    const groundMoved = Math.hypot(groundEnd[0] - groundStart[0], groundEnd[2] - groundStart[2]);

    await page.locator('[data-flight-toggle]').click();
    await page.waitForFunction(() => ['takeoff', 'flying'].includes(window.__APP__.world.mount.state.movementMode), null, { timeout: 3000 });
    await page.waitForFunction(() => window.__APP__.world.mount.state.movementMode === 'flying', null, { timeout: 4000 });
    const takeoff = await page.evaluate(() => ({ mode: window.__APP__.world.mount.state.movementMode, y: window.__APP__.world.player.position.y }));
    await page.keyboard.down('Space'); await sleep(320); await page.keyboard.up('Space');
    const ascended = await page.evaluate(() => ({ mode: window.__APP__.world.mount.state.movementMode, y: window.__APP__.world.player.position.y }));
    await page.keyboard.down('KeyX'); await sleep(260); await page.keyboard.up('KeyX');
    const descended = await page.evaluate(() => ({ mode: window.__APP__.world.mount.state.movementMode, y: window.__APP__.world.player.position.y }));

    await page.locator('[data-flight-toggle]').click();
    await page.waitForFunction(() => window.__APP__.world.mount.state.movementMode === 'ground', null, { timeout: 5000 });
    const landed = await page.evaluate(() => ({ mode: window.__APP__.world.mount.state.movementMode, y: window.__APP__.world.player.position.y,
      airborne: window.__APP__.world.character.state.airborne }));
    await page.locator('[data-mount-toggle]').click();
    await page.waitForFunction(() => !window.__APP__.world.mount.state.isMounted, null, { timeout: 3000 });
    const dismounted = await page.evaluate(() => ({ mounted: window.__APP__.world.mount.state.isMounted,
      modelParent: window.__APP__.world.character.model?.parent?.name || null, movement: window.__APP__.world.character.state.movement }));
    Object.assign(result, { mounted, ground: { start: groundStart, end: groundEnd, distance: Number(groundMoved.toFixed(3)) },
      takeoff, ascended, descended, landed, dismounted });
  } catch (error) {
    result.error = compactError(error);
  }
  const pass = Boolean(result.mounted?.state?.isMounted) && result.ground?.distance > 0.01 &&
    ['takeoff', 'flying'].includes(result.takeoff?.mode) && result.ascended?.y > result.takeoff?.y + 0.1 &&
    result.descended?.y < result.ascended?.y - 0.1 && result.landed?.mode === 'ground' && !result.landed?.airborne &&
    result.dismounted?.mounted === false;
  return check('native-mount-ground-flight-dismount', pass, {
    mountOptions: result.mountOptions,
    groundDistance: result.ground?.distance ?? null,
    modes: [result.mounted?.state?.movementMode, result.takeoff?.mode, result.ascended?.mode, result.descended?.mode,
      result.landed?.mode, result.dismounted?.mounted === false ? 'dismounted' : null],
    heights: { takeoff: result.takeoff?.y, ascended: result.ascended?.y, descended: result.descended?.y, landed: result.landed?.y },
    modelParentAfterDismount: result.dismounted?.modelParent || null,
    error: result.error || null,
  });
}

async function probeCamera(page) {
  const result = {};
  try {
    const canvas = page.locator('#world');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('World canvas has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const before = await page.evaluate(() => ({ azimuth: window.__APP__.world.azimuth, polar: window.__APP__.world.polar,
      zoom: window.__APP__.world.zoom, heading: window.__APP__.world.player.rotation.y }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'right' });
    const duringDown = await page.evaluate(() => ({ looking: window.__APP__.world.input.isLooking,
      heading: window.__APP__.world.player.rotation.y, azimuth: window.__APP__.world.azimuth }));
    await page.mouse.move(box.x + box.width * 0.5 + 64, box.y + box.height * 0.5 + 28, { steps: 5 });
    const duringMove = await page.evaluate(() => ({ azimuth: window.__APP__.world.azimuth, polar: window.__APP__.world.polar,
      heading: window.__APP__.world.player.rotation.y }));
    await page.mouse.up({ button: 'right' });
    const afterUp = await page.evaluate(() => ({ looking: window.__APP__.world.input.isLooking, azimuth: window.__APP__.world.azimuth,
      polar: window.__APP__.world.polar, zoom: window.__APP__.world.zoom, heading: window.__APP__.world.player.rotation.y }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 420);
    await sleep(120);
    const afterWheel = await page.evaluate(() => ({ zoom: window.__APP__.world.zoom }));
    const headingDelta = Math.atan2(Math.sin(afterUp.heading - (afterUp.azimuth + Math.PI)), Math.cos(afterUp.heading - (afterUp.azimuth + Math.PI)));
    Object.assign(result, { before, duringDown, duringMove, afterUp, afterWheel, headingDelta: Number(headingDelta.toFixed(4)) });
  } catch (error) {
    result.error = compactError(error);
  }
  const azimuthChanged = Number.isFinite(result.before?.azimuth) && Math.abs(result.afterUp?.azimuth - result.before.azimuth) > 0.01;
  const polarChanged = Number.isFinite(result.before?.polar) && Math.abs(result.afterUp?.polar - result.before.polar) > 0.01;
  const zoomChanged = Number.isFinite(result.afterUp?.zoom) && Math.abs(result.afterWheel?.zoom - result.afterUp.zoom) > 0.01;
  const pass = result.duringDown?.looking === true && result.afterUp?.looking === false && azimuthChanged && polarChanged &&
    zoomChanged && Number.isFinite(result.headingDelta) && Math.abs(result.headingDelta) < 0.08;
  return check('native-camera-look-and-wheel', pass, {
    rightDownLooking: result.duringDown?.looking ?? null,
    rightUpLooking: result.afterUp?.looking ?? null,
    azimuthDelta: result.before && result.afterUp ? Number((result.afterUp.azimuth - result.before.azimuth).toFixed(4)) : null,
    polarDelta: result.before && result.afterUp ? Number((result.afterUp.polar - result.before.polar).toFixed(4)) : null,
    zoomDelta: result.afterUp && result.afterWheel ? Number((result.afterWheel.zoom - result.afterUp.zoom).toFixed(4)) : null,
    headingDelta: result.headingDelta ?? null,
    error: result.error || null,
  });
}

async function probeChineseNavigation(page) {
  const result = {};
  try {
    await page.locator('#teleport-open').click();
    await page.locator('.teleport-modal').waitFor({ state: 'visible', timeout: 5000 });
    const teleport = await page.evaluate(() => ({
      regions: [...document.querySelectorAll('[data-region]')].map(node => node.innerText.trim()).filter(Boolean),
      destinations: [...document.querySelectorAll('[data-scene-region]')].map(node => ({
        id: node.dataset.teleport || null,
        text: node.innerText.trim(),
        region: node.querySelector('small')?.textContent?.trim() || '',
        name: node.querySelector('strong')?.textContent?.trim() || '',
      })),
    }));
    const teleportLabels = [...teleport.regions, ...teleport.destinations.flatMap(item => [item.region, item.name])].filter(Boolean);
    const teleportPass = teleport.destinations.length > 0 && teleportLabels.every(label => hasChinese(label) && !hasAscii(label));
    await page.keyboard.press('Escape');
    await page.locator('#area-open').click();
    await page.locator('.map-modal').waitFor({ state: 'visible', timeout: 5000 });
    const mapLabels = await page.locator('.map-places button, .map-exits button').allTextContents();
    // Place buttons intentionally show a small ordinal ("1", "2", ...);
    // strip that presentation prefix while still rejecting ASCII/internal IDs.
    const normalizedMapLabels = mapLabels.map(label => label.replace(/^\s*\d+/u, '').trim());
    const mapPass = normalizedMapLabels.length === 0 || normalizedMapLabels.every(label => hasChinese(label) && !hasAscii(label));
    Object.assign(result, { teleport: { regions: teleport.regions.length, destinations: teleport.destinations.length,
      sample: teleport.destinations.slice(0, 3).map(item => ({ id: item.id, region: item.region, name: item.name })) },
      map: { labels: normalizedMapLabels.length, sample: normalizedMapLabels.slice(0, 5) },
      teleportPass, mapPass });
  } catch (error) {
    result.error = compactError(error);
  }
  return check('native-teleport-map-chinese-labels', Boolean(result.teleportPass && result.mapPass), {
    teleport: result.teleport,
    map: result.map,
    error: result.error || null,
  });
}

async function captureCharacterScreenshots(page, out) {
  const canvas = page.locator('#world');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('World canvas has no bounding box for character capture');
  const closeup = path.join(out, 'character-front-final.png');
  const face = path.join(out, 'character-face-final.png');
  const orbit = path.join(out, 'character-front-orbit-final.png');
  await page.evaluate(() => {
    const world = window.__APP__.world;
    world.zoom = 4;
    world.azimuth += Math.PI;
    world.polar = 1.35;
    world.introFocus = 0;
    world.updateCamera?.(0);
    world.renderer?.render(world.scene, world.camera);
  });
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = '__sandboxCaptureOnly3d';
    style.textContent = '#app > *:not(#world) { visibility: hidden !important; }';
    document.head.append(style);
  });
  await sleep(240);
  await canvas.screenshot({ path: closeup });
  await page.evaluate(() => {
    const world = window.__APP__.world;
    world.zoom = 2.2;
    world.polar = 1.47;
    world.updateCamera?.(0);
    world.renderer?.render(world.scene, world.camera);
  });
  await sleep(180);
  await canvas.screenshot({ path: face });
  await page.evaluate(() => {
    const world = window.__APP__.world;
    world.zoom = 4;
    world.polar = 1.35;
    world.updateCamera?.(0);
    world.renderer?.render(world.scene, world.camera);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 8, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await sleep(180);
  await canvas.screenshot({ path: orbit });
  await page.evaluate(() => document.querySelector('#__sandboxCaptureOnly3d')?.remove());
  return { closeup, face, orbit };
}

async function inspectFixed4Reuse(file) {
  if (!file) return { status: 'not-requested', note: 'No prior fixed-four observation was supplied; this run only exercises Gridania.' };
  try {
    const report = await readJson(file);
    const scenes = report.scenes || report.results || report.representatives?.results || [];
    return {
      status: 'reused-reference-only', path: file,
      sourceStatus: report.status || report.result || null,
      sceneIds: scenes.map(item => item.id).filter(Boolean).slice(0, 8),
      errors: Array.isArray(report.errors) ? report.errors.length : null,
      note: 'Prior fixed-four observation is reference evidence, not a current fix claim.',
    };
  } catch (error) {
    return { status: 'unreadable', path: file, error: compactError(error) };
  }
}

function printHelp() {
  console.log(`Usage: node scripts/validate-sandbox.mjs [options]
  --url URL                         Reuse an existing /ff14-web/ base URL
  --out PATH                        Evidence directory under work/ (default work/quality-v2-validation)
  --dat PATH                        FFXIV_CHARA_40.dat used through the native file input
  --asset-release PATH              Existing world pack release for a local temporary server
  --site PATH                       Reuse/build this JS-only site directory
  --skip-build                      Reuse --site without running Vite
  --character-manifest PATH         Source character partial manifest
  --gameplay-manifest PATH          Source gameplay partial manifest
  --browser-path PATH               Chromium executable
  --playwright-module-path PATH     Existing Playwright package.json/module directory
  --timeout MS                      Bounded map/feature timeout (default 45000)
  --reuse-fixed4 PATH               Text-only prior fixed-four report; never treated as current proof
  --screenshots                     Capture two final character closeup/orbit frames for visual QA
  --plan-only                       Print scope without building or launching a browser
  --help                            Show this help

This is the bounded Gridania feature loop. It does not run the 65-map smoke pass.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { printHelp(); process.exit(0); }
const out = assertWorkPath(resolvePath(args.out, DEFAULT_OUT), '--out');
const timeoutMs = Math.max(5000, Number(args.timeout) || DEFAULT_TIMEOUT);
const datPath = args.dat ? path.resolve(String(args.dat)) : null;
const characterPath = resolvePath(args['character-manifest'], DEFAULT_CHARACTER_MANIFEST);
const gameplayPath = resolvePath(args['gameplay-manifest'], DEFAULT_GAMEPLAY_MANIFEST);
const assetRelease = args['asset-release'] ? path.resolve(String(args['asset-release'])) : null;
const fixed4Path = args['reuse-fixed4'] ? path.resolve(String(args['reuse-fixed4'])) : null;
const startedAt = Date.now();
let server = null;
let browser = null;
let page = null;
let appUrl = args.url ? String(args.url) : null;
const report = {
  schemaVersion: 1,
  kind: 'sandbox-feature-validation',
  status: 'RUNNING',
  scope: { scene: DEFAULT_SCENE, mapSmoke: false, full65: false },
  startedAt: new Date().toISOString(),
  commandNode: process.execPath,
  out,
  datPath,
  characterManifest: characterPath,
  gameplayManifest: gameplayPath,
  assetRelease,
  checks: [],
  errors: [],
};

try {
  const source = await sourceChecks({ characterPath, gameplayPath });
  report.checks.push(...source.checks);
  report.fixed4 = await inspectFixed4Reuse(fixed4Path);
  if (args['plan-only']) {
    report.status = 'READY';
    report.plan = { scene: DEFAULT_SCENE, dat: datPath, url: appUrl, out, assetRelease,
      sourceChecks: report.checks.map(item => ({ name: item.name, pass: item.pass })),
      note: 'Plan only; no browser, server, build, or full-map smoke was run.' };
    await writeJson(path.join(out, 'plan.json'), report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  if (!appUrl) {
    const site = assertWorkPath(resolvePath(args.site, path.join(out, 'site')), '--site');
    await prepareLocalSite({ root, out: site, assetRelease, skipBuild: asBoolean(args['skip-build']) });
    server = await serveLocalSite({ root, out: site, assetRelease });
    appUrl = server.url;
  }
  report.url = appUrl;
  const { chromium } = await loadPlaywright(args['playwright-module-path']);
  browser = await chromium.launch({
    executablePath: args['browser-path'] || process.env.BROWSER_PATH || undefined,
    headless: !asBoolean(args.headed),
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.__sandboxAppUrl = appUrl;
  const pageErrors = [];
  let closing = false;
  page.on('pageerror', error => { if (!closing) pageErrors.push(`pageerror: ${compactError(error)}`); });
  page.on('console', message => {
    if (closing || message.type() !== 'error') return;
    const text = compactError(message.text());
    if (/Client map import|Uncaught (?:ReferenceError|TypeError|SyntaxError)|Failed to load module script|Sandbox asset/i.test(text)) pageErrors.push(`console: ${text}`);
  });
  await waitForWorld(page, DEFAULT_SCENE, timeoutMs);
  const initial = await inspectCharacter(page);
  report.runtimeInitial = initial;
  report.checks.push(check('runtime-character-ready', initial.source === 'ffxiv-client' && initial.modelPresent && initial.animationPresent &&
    initial.meshes > 0 && initial.vertices > 0 && initial.skeletonBones > 0 && !initial.sandboxError, {
    source: initial.source, modelPresent: initial.modelPresent, animationPresent: initial.animationPresent,
    meshes: initial.meshes, vertices: initial.vertices, skeletonBones: initial.skeletonBones,
    animationStates: initial.animationStates.filter(state => /jump|skill-whm|idle|walk|run/.test(state)).slice(0, 24),
    sandboxError: initial.sandboxError,
  }));
  report.checks.push(check('runtime-iris-depth-test', initial.irisDepthTestValid, {
    irisMaterialCount: initial.irisMaterials.length,
    samples: initial.irisMaterials.slice(0, 4),
  }));

  const dat = await importDat(page, datPath, timeoutMs);
  report.checks.push(dat.check);
  const afterDat = await inspectCharacter(page);
  report.runtimeAfterDat = {
    source: afterDat.source, appearanceFormat: afterDat.appearanceFormat, meshes: afterDat.meshes,
    vertices: afterDat.vertices, skeletonBones: afterDat.skeletonBones, irisDepthTestValid: afterDat.irisDepthTestValid,
    partMeshes: afterDat.partMeshes, modelScale: afterDat.modelScale,
  };
  if (asBoolean(args.screenshots)) report.characterScreenshots = await captureCharacterScreenshots(page, out);
  if (dat.attempted) report.checks.push(check('runtime-dat-model-remains-complete', afterDat.source === 'ffxiv-client' && afterDat.modelPresent &&
    afterDat.vertices > 0 && afterDat.irisDepthTestValid, {
    source: afterDat.source, appearanceFormat: afterDat.appearanceFormat, vertices: afterDat.vertices,
    irisMaterialCount: afterDat.irisMaterials.length, irisDepthTestValid: afterDat.irisDepthTestValid,
  }));

  const jump = await traceJump(page);
  const jumpClips = ['jump-start', 'jump-airborne', 'jump-land'].every(state => jump.animations.includes(state));
  report.checks.push(check('native-space-jump-sequence', jump.start && jump.airborne && jump.landing && jump.landed && jump.restored && jumpClips,
    { ...jump, jumpClips }));
  report.checks.push(await probeSkills(page, timeoutMs));
  report.checks.push(await probeMount(page, timeoutMs));
  report.checks.push(await probeCamera(page));
  report.checks.push(await probeChineseNavigation(page));
  report.pageErrors = pageErrors.slice(0, 8);
  if (pageErrors.length) report.checks.push(check('no-fatal-browser-errors', false, { count: pageErrors.length, first: pageErrors.slice(0, 4) }));
  else report.checks.push(check('no-fatal-browser-errors', true, { count: 0 }));
  await context.close();
} catch (error) {
  report.errors.push(compactError(error));
  report.checks.push(check('validator-execution', false, { error: compactError(error) }));
} finally {
  await page?.context()?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.totalMs = Date.now() - startedAt;
  report.failures = report.checks.filter(item => !item.pass).map(item => ({ name: item.name, detail: item.detail }));
  report.status = report.failures.length || report.errors.length ? 'FAIL' : 'PASS';
  await writeJson(path.join(out, 'report.json'), report);
}

console.log(JSON.stringify({
  result: report.status,
  totalMs: report.totalMs,
  scene: DEFAULT_SCENE,
  checks: report.checks.length,
  failures: report.failures?.slice(0, 12).map(item => item.name) || [],
  errors: report.errors?.slice(0, 4) || [],
  report: path.join(out, 'report.json'),
  fullMapSmoke: false,
}, null, 2));
if (report.status === 'FAIL') process.exitCode = 1;
