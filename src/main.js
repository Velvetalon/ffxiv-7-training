import { createCombat, JOBS } from './combat/index.js';
import { World, SCENES, loadSceneCatalog } from './world/index.js';
import { $, escape, formatNumber, icon, iconify } from './ui/dom.js';
import { drawMap as renderMap } from './ui/Minimap.js';
import { AudioRuntime } from './audio/AudioRuntime.js';
import { TeleportController } from './core/TeleportController.js';
import { TrainingDirector } from './core/TrainingDirector.js';
import { loadSettings, saveSettings as persistSettings } from './core/Settings.js';
import { mountShell } from './ui/Shell.js';
import { Hotbar } from './ui/Hotbar.js';
import { createDialogs } from './ui/Dialogs.js';
import { createHud } from './ui/Hud.js';
import './style.css';
import { assetProfiler } from './assets/AssetProfiler.js';
import { initializeHudLayout } from './ui/layout/index.js';
import { SandboxAssets } from './assets/SandboxAssets.js';
import { SandboxPanel } from './ui/SandboxPanel.js';
import { parseFfxivCharaDat } from './character/appearance/FfxivCharaDat.js';
import { SessionPreferences } from './core/SessionPreferences.js';
import { DeveloperRuntime } from './dev/DeveloperRuntime.js';
import { DeveloperPanel } from './ui/developer/DeveloperPanel.js';
import { DebugOverlay } from './ui/developer/DebugOverlay.js';
import { RuntimeFeedback } from './ui/RuntimeFeedback.js';

const settings = loadSettings();
const preferences = new SessionPreferences(settings, () => persistSettings(settings));
let currentScene = SCENES[0].id;
let feedbackTimeout;
const sandboxAssets = new SandboxAssets();
const audio = new AudioRuntime(sandboxAssets.runtime, settings, { getManifest: () => sandboxAssets.manifest });
let fps = 60;
let mobileMovement = null;
let sceneTransition = false;
let developerRuntime;
let initialCameraRestore = true;
let lastLoadFailure = null;

mountShell(JOBS);
const loadingFeedback = new RuntimeFeedback({ root: $('#app'), onRetry: () => retryLoading() });
try { await loadSceneCatalog(); } catch (error) { console.warn('Scene catalog:', error); }
const requestedScene = new URLSearchParams(window.location.search).get('scene');
currentScene = SCENES.some(scene => scene.id === requestedScene)
  ? requestedScene : SCENES.some(scene => scene.id === preferences.lastSceneId)
    ? preferences.lastSceneId : SCENES.find(scene => scene.id === 'gridania')?.id || SCENES[0].id;

const combat = createCombat('WHM');
const training = new TrainingDirector(combat);
const hotbar = new Hotbar(combat, JOBS);
const world = new World($('#world'), {
  initialScene: currentScene,
  onTarget: () => {},
  onInteract: (npc) => openDialogue(npc),
  onMove: () => { if (teleportController.cast) teleportController.cancel(); },
  onLoading: (progress,error) => {
    loadingFeedback.mapProgress(progress, error, assetProfiler.active?.sceneId || currentScene);
    if(error) { lastLoadFailure = 'map'; toast(`地区载入失败：${error}`); }
  },
  onSceneReady: id => {
    restoreCamera(id);
    preferences.recordScene(id);
    developerRuntime?.captureEnvironmentBase();
    if (id === currentScene) { sceneTitle(id); hud.invalidate(); }
  },
  onConnection: connection => travelConnection(connection),
});
world.setJob('WHM');
world.setQuality(settings.quality);
world.setControlMode(settings.controlMode);
world.setScene(currentScene);
world.targetNearest();

world.setAudioRuntime(audio);
const playSound = type => {
  const soundId = sandboxAssets.manifest?.uiSounds?.[type];
  if (soundId) void audio.playAction(soundId);
};
const teleportController = new TeleportController({
  scenes: SCENES,
  getSceneId: () => currentScene,
  isInCombat: () => combat.getState().inCombat,
  onStart: () => { closeModal(); playSound('buff'); world.effect({ type: 'buff', name: '传送', color: '#71dcf2', jobId: 'WHM' }); },
  onFinish: finishTeleport,
  onCancel: () => toast('传送已中断'),
  onError: toast,
});

const hud = createHud({ combat, world, jobs: JOBS, getTeleportCast: () => teleportController.cast });

const dialogs = createDialogs({ world, combat, scenes: SCENES, settings, getSceneId: () => currentScene, getTargetCount: () => targetCount, hotbar, training });
const { openTeleport, openBook, openSettings, openMap, openDialogue, openHelp, closeModal } = dialogs;
const hudLayout = initializeHudLayout({
  root: $('#app'),
  onEditingChange: editing => world.setInputEnabled(!editing && !dialogs.active),
});
const sandboxPanel = new SandboxPanel({
  root: $('#app'), world, onError: toast,
  onAppearance: importAppearance,
  onAnimation: state => world.character.animation.play(state, { loop: false, restart: true }),
  onMount: async id => {
    if (world.mount.state.isMounted) {
      if (!world.mount.dismount()) throw new Error('请先降落再下坐骑');
    } else {
      const definition = sandboxAssets.mounts.find(item => item.id === id);
      if (!definition) throw new Error('坐骑资源尚未就绪');
      await world.mount.mount(definition);
    }
  },
});
const sandboxButton = document.createElement('button');
sandboxButton.id = 'sandbox-open';
sandboxButton.className = 'icon-button';
sandboxButton.title = '角色与世界';
sandboxButton.setAttribute('aria-label', '角色与世界');
sandboxButton.innerHTML = icon('user-round-cog');
$('#hud-layout-open').before(sandboxButton);
iconify(sandboxButton);
sandboxButton.addEventListener('click', () => sandboxPanel.toggle());
world.sandboxReady = world.loadPromise.then(async success => {
  if (!success) return;
  await sandboxAssets.initialize();
  world.skillDefinitions.merge(sandboxAssets.skills);
  const saved = preferences.appearance;
  const appearance = saved && sandboxAssets.getCharacter(saved) ? saved : sandboxAssets.manifest.defaultAppearance;
  const definition = await reloadCharacter(appearance);
  await world.setNpcDefinition(definition);
  await audio.playScene(world.sceneId);
}).catch(error => {
  lastLoadFailure = 'character';
  world.sandboxError = error.message;
  loadingFeedback.setCharacterLoading(false);
  loadingFeedback.fail(error, currentScene);
  console.warn('Sandbox asset initialization:', error.message);
  toast(`角色资源载入失败：${error.message}`);
});

const debugOverlay = new DebugOverlay({ root: $('#app') });
developerRuntime = new DeveloperRuntime({
  world, assets: sandboxAssets, audio, scenes: SCENES, preferences,
  changeMap: id => finishTeleport(id),
  importAppearance, reloadCharacter: () => reloadCharacter(),
  teleportPosition: async ({ x, y, z }) => {
    if (world.loading || !world.navigation) throw new Error('请等待地图就绪');
    if (![x, y, z].every(Number.isFinite)) throw new Error('坐标必须是有限数字');
    const point = world.player.position.clone().set(x, y, z);
    await world.assetScene?.prepareLocation(point);
    teleportController.cancel();
    world.player.position.copy(point);
    world.character.syncTransform();
    world.jumpVelocity = 0;
    world.followCamera.reset();
    world.updateCamera(0);
  },
  retryLoad: retryLoading,
  getLoadingState: () => loadingFeedback.getState(),
  onAudioSettings: next => {
    if (typeof next.sound === 'boolean') settings.sound = next.sound;
    if (Number.isFinite(next.volume)) settings.volume = Math.max(0, Math.min(1, next.volume));
    saveSettings();
  },
});
const developerPanel = new DeveloperPanel({
  root: $('#app'), controller: developerRuntime,
  onStateChange: state => {
    preferences.setDeveloper(state);
    debugOverlay.setEnabled(Boolean(preferences.developer.overlay));
    $('#developer-open')?.classList.toggle('active', Boolean(preferences.developer.open));
  },
});
const developerButton = document.createElement('button');
developerButton.id = 'developer-open';
developerButton.className = 'icon-button';
developerButton.title = '开发者面板';
developerButton.setAttribute('aria-label', '开发者面板');
developerButton.innerHTML = icon('wrench');
$('#settings-open').before(developerButton);
iconify(developerButton);
developerButton.addEventListener('click', () => {
  if (dialogs.active) closeModal();
  hudLayout.close();
  sandboxPanel.close();
  developerPanel.toggle();
});
debugOverlay.setEnabled(Boolean(preferences.developer.overlay));
if (preferences.developer.open || new URLSearchParams(location.search).get('dev') === '1') developerPanel.open();

function restoreCamera(sceneId) {
  const camera = preferences.camera;
  if (Number.isFinite(camera?.polar)) world.polar = Math.max(0.05, Math.min(Math.PI - 0.05, camera.polar));
  if (Number.isFinite(camera?.distance)) world.zoom = Math.max(2, Math.min(60, camera.distance));
  if (initialCameraRestore && sceneId === preferences.lastSceneId && Number.isFinite(camera?.azimuth)) world.azimuth = camera.azimuth;
  initialCameraRestore = false;
  world.followCamera.reset();
}

async function importAppearance(file) {
  return reloadCharacter(parseFfxivCharaDat(await file.arrayBuffer()));
}

async function reloadCharacter(appearance) {
  if (world.mount.state.isMounted && !world.mount.dismount()) throw new Error('请先降落再重载角色');
  loadingFeedback.setCharacterLoading(true);
  world.sandboxError = null;
  try {
    await sandboxAssets.initialize();
    world.skillDefinitions.merge(sandboxAssets.skills);
    const selected = appearance || world.character.state.appearance || preferences.appearance || sandboxAssets.manifest.defaultAppearance;
    const definition = sandboxAssets.getCharacter(selected);
    if (!definition) throw new Error('此种族或外观部件尚未包含在资源目录中');
    await world.character.loadDefinition(definition, selected);
    preferences.setAppearance(selected);
    if (selected) sandboxPanel.setAppearance(selected);
    sandboxPanel.setAssets({ animations: [...world.character.animation.clips.keys()], mounts: sandboxAssets.mounts });
    loadingFeedback.setCharacterLoading(false);
    if (!world.loading && !world.loadError) loadingFeedback.ready(currentScene);
    lastLoadFailure = null;
    return definition;
  } catch (error) {
    lastLoadFailure = 'character';
    world.sandboxError = error.message;
    loadingFeedback.setCharacterLoading(false);
    loadingFeedback.fail(error, currentScene);
    throw error;
  }
}

async function retryLoading() {
  if (lastLoadFailure === 'character' || world.sandboxError) {
    const definition = await reloadCharacter();
    if (!world.npcDefinition) await world.setNpcDefinition(definition);
    await audio.playScene(currentScene);
    return { ok: true };
  }
  return finishTeleport(loadingFeedback.getState().mapId || currentScene);
}

function toast(message) {
  const node = $('#feedback');
  node.textContent = message;
  node.classList.add('visible');
  clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => node.classList.remove('visible'), 2100);
}

function context() {
  return { ...world.getContext(), targets: targetCount };
}
let targetCount = 1;

function useAction(id) {
  if(world.loading)return {ok:false,reason:'地图加载中'};
  if (teleportController.cast) { toast('正在传送'); return { ok: false, reason: '正在传送' }; }
  const result = combat.use(id, context());
  if (!result.ok) toast(result.reason || '技能尚未就绪');
  else hotbar.flash(id);
  return result;
}

function switchJob(id) {
  if (id === combat.getState().jobId) return;
  teleportController.cancel();
  combat.setJob(id);
  training.reset();
  world.setJob(id);
  if (id === 'RPR') world.moveToDummy();
  hotbar.reset();
  hud.invalidate();
  hotbar.hideTooltip();
  toast(`已切换为${JOBS.find(job => job.id === id).name}`);
  renderCombat();
}

function reset() {
  teleportController.cancel();
  combat.reset();
  training.reset();
  world.clearFields();
  world.clearReturnGate();
  hud.invalidate();
  hotbar.reset();
  toast('练习已重置');
  renderCombat();
}

function sceneTitle(id) {
  const scene = SCENES.find(item => item.id === id);
  if (!scene) return;
  $('#scene-name').textContent = scene.name;
  $('#scene-region').textContent = scene.region;
  $('#scene-en').textContent = scene.en;
  const title = $('#scene-title');
  title.querySelector('span').textContent = scene.region;
  title.querySelector('h2').textContent = scene.name;
  title.querySelector('small').textContent = scene.en;
  title.classList.remove('show');
  void title.offsetWidth;
  title.classList.add('show');
}

function teleport(id, immediate = false) {
  if (sceneTransition || world.loading) { toast('地区正在载入'); return { ok: false, reason: '地区正在载入' }; }
  if (world.loadError && !world.isImported && id === currentScene) return finishTeleport(id);
  return teleportController.start(id, immediate);
}
async function finishTeleport(id, entry = {}) {
  if (sceneTransition || world.loading) return { ok: false, reason: '地区正在载入' };
  if (!SCENES.some(scene => scene.id === id)) return { ok: false, reason: '目标地区尚未开放' };
  sceneTransition = true;
  developerRuntime?.clearPreview();
  teleportController.cancel();
  combat.reset();
  training.reset();
  world.clearFields();
  world.clearReturnGate();
  try {
    const success = await world.setScene(id, entry);
    if (success !== true) return { ok: false, reason: world.loadError || '地区载入失败，请重试' };
    currentScene = id;
    lastLoadFailure = null;
    const locationUrl = new URL(location.href);
    locationUrl.searchParams.set('scene', id);
    history.replaceState(null, '', locationUrl);
    world.targetNearest();
    sceneTitle(id);
    hud.invalidate();
    hotbar.reset();
    closeModal();
    playSound('buff');
    void audio.playScene(id);
    return { ok: true };
  } catch (error) {
    toast(error.message || '地区载入失败，请重试');
    return { ok: false, reason: error.message || '地区载入失败，请重试' };
  } finally {
    sceneTransition = false;
  }
}

function findConnection(id) {
  return world.getConnections?.().find(connection => connection.id === id) || null;
}

function travelConnection(connection) {
  if (sceneTransition || world.loading) { toast('地区正在载入'); return { ok: false }; }
  if (combat.getState().inCombat) { toast('战斗中无法穿越区域出口，请先重置练习'); return { ok: false }; }
  if (!world.canUseConnection(connection?.id)) { toast('请靠近区域出口后再进入'); return { ok: false }; }
  const target = SCENES.find(scene => scene.id === connection.targetScene);
  if (!target) { toast('该出口的目标地区尚未开放'); return { ok: false }; }
  return finishTeleport(target.id, { arrivalConnection: connection.targetConnection || connection.arrivalConnection, arrival: connection.arrival, entryFrom: currentScene });
}

function updateConnectionPrompt() {
  const prompt = $('#connection-prompt');
  const connection = world.getNearbyConnection?.();
  const target = connection && SCENES.find(scene => scene.id === connection.targetScene);
  prompt.classList.toggle('hidden', !connection || !target || world.loading || sceneTransition);
  if (!connection || !target) return;
  $('#connection-name').textContent = `${connection.name || '区域出口'} · ${target.name}`;
  $('#connection-travel').dataset.connectionTravel = connection.id;
}

function renderCombat() { hud.render(); hotbar.render(); }

function drawMap(canvas, expanded = false) {
  renderMap(canvas, world.getInfo(), currentScene, expanded);
}

function downloadLog() {
  const state = combat.getState();
  const data = { version: '7.0', job: state.jobId, scene: currentScene, stats: state.stats, log: state.log };
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  anchor.download = `aetheryte-${state.jobId}-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function saveSettings() {
  persistSettings(settings);
  audio.setSettings?.(settings);
}
saveSettings();

document.addEventListener('click', (event) => {
  const connectionTravel = event.target.closest('[data-connection-travel]');
  if (connectionTravel) {
    const connection = findConnection(connectionTravel.dataset.connectionTravel);
    if (connection) travelConnection(connection);
    return;
  }
  const landmark = event.target.closest('[data-landmark]');
  if (landmark) {
    if (world.loading) { toast('地区正在载入'); return; }
    if (combat.getState().inCombat) { toast('请先重置练习再快速前往'); return; }
    const result = world.goToLandmark(landmark.dataset.landmark);
    if (result?.then) {
      toast('正在载入目的地附近区域');
      result.then(moved => { if (moved) closeModal(); }).catch(error => toast(`目的地载入失败：${error.message}`));
    } else if (result) closeModal();
    return;
  }
  if (event.target.closest('#training-hit')) {
    training.hit();
    closeModal();
    toast('已施加练习伤害');
    return;
  }
  const inspect = event.target.closest('[data-inspect]');
  if (inspect) { dialogs.inspectSkill(inspect.dataset.inspect); return; }
  const action = event.target.closest('[data-action]');
  if (action) { useAction(action.dataset.action); return; }
  const job = event.target.closest('[data-job]');
  if (job) { switchJob(job.dataset.job); return; }
  const destination = event.target.closest('[data-teleport]');
  if (destination) { teleport(destination.dataset.teleport); return; }
  const region = event.target.closest('[data-region]');
  if (region) {
    document.querySelectorAll('[data-region]').forEach(button => button.classList.toggle('selected', button === region));
    filterTeleportDestinations();
  }
  const quality = event.target.closest('[data-quality]');
  if (quality) {
    settings.quality = quality.dataset.quality;
    world.setQuality(settings.quality);
    document.querySelectorAll('[data-quality]').forEach(button => button.classList.toggle('selected', button === quality));
    saveSettings();
  }
  if (event.target.closest('.modal-close') || event.target.id === 'modal-layer') closeModal();
});
$('#app').addEventListener('contextmenu', event => event.preventDefault());
const showDialog = callback => () => {
  hudLayout.close();
  sandboxPanel.close();
  developerPanel.close();
  callback();
};
$('#teleport-open').addEventListener('click', showDialog(openTeleport));
$('#book-open').addEventListener('click', showDialog(() => openBook()));
$('#settings-open').addEventListener('click', showDialog(openSettings));
$('#hud-layout-open').addEventListener('click', () => { closeModal(); sandboxPanel.close(); developerPanel.close(); hudLayout.toggle(); });
$('#help-open').addEventListener('click', showDialog(openHelp));
$('#area-open').addEventListener('click', showDialog(openMap));
$('#reset').addEventListener('click', reset);
$('#reposition').addEventListener('click', () => { world.moveToDummy(); world.targetNearest(); });
$('#target-nearest').addEventListener('click', () => world.targetNearest());
$('#mobile-target').addEventListener('click', () => world.targetNearest());
$('#log-export').addEventListener('click', downloadLog);
$('#encounter-toggle').addEventListener('click', () => $('.encounter').classList.toggle('collapsed'));
document.addEventListener('input', (event) => {
  const { id, value, checked } = event.target;
  if (id === 'skill-search') document.querySelectorAll('[data-search]').forEach(row => row.hidden = !row.dataset.search.includes(value.toLowerCase()));
  if (id === 'teleport-search') filterTeleportDestinations();
  if (id === 'sound-toggle') { settings.sound = checked; saveSettings(); }
  if (id === 'volume') { settings.volume = Number(value); saveSettings(); }
  if (id === 'hud-scale') { settings.scale = Number(value); $('#hud-scale-output').textContent = `${value}%`; saveSettings(); }
  if (id === 'target-count') targetCount = Math.max(1, Math.min(8, Math.round(Number(value) || 1)));
  if (id === 'control-mode') { settings.controlMode = value; world.setControlMode(value); saveSettings(); }
  if (id === 'healing-pressure') training.setEnabled(checked);
});
function filterTeleportDestinations() {
  const term = $('#teleport-search')?.value.trim().toLowerCase() || '';
  const region = document.querySelector('[data-region].selected')?.dataset.region || 'all';
  document.querySelectorAll('[data-scene-region]').forEach(button => {
    const matchesRegion = region === 'all' || button.dataset.sceneRegion === region;
    button.hidden = !matchesRegion || !button.dataset.sceneSearch.includes(term);
  });
}
document.addEventListener('pointerover', (event) => {
  const action = event.target.closest('[data-action]');
  if (action && !dialogs.active) hotbar.showTooltip(action.dataset.action);
});
document.addEventListener('pointerout', (event) => {
  if (event.target.closest('[data-action]') && !event.relatedTarget?.closest('[data-action]')) hotbar.hideTooltip();
});
document.addEventListener('keydown', (event) => {
  if (hudLayout.isEditing) return;
  if (event.key === 'Tab' && dialogs.active) {
    const controls = [...$('#modal-layer').querySelectorAll('button:not([disabled]),input,select')].filter(node => node.offsetParent !== null);
    const next = event.shiftKey ? controls.at(-1) : controls[0];
    if ((event.shiftKey && document.activeElement === controls[0]) || (!event.shiftKey && document.activeElement === controls.at(-1))) {
      event.preventDefault();
      next?.focus();
    }
  }
  if (event.key === 'Escape') {
    if (dialogs.active) closeModal();
    else if (developerPanel.isOpen) developerPanel.close();
    else if (teleportController.cast) teleportController.cancel();
    else world.clearTarget();
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || dialogs.active || event.target.closest('.developer-panel')) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === 'KeyF') {
    const connection = world.getNearbyConnection?.();
    if (connection) { event.preventDefault(); travelConnection(connection); }
    return;
  }
  const actionId = hotbar.keyAction(event);
  if (actionId) { event.preventDefault(); useAction(actionId); }
  if (event.code === 'KeyH') openHelp();
  if (event.code === 'KeyT') openTeleport();
  if (event.code === 'KeyP') openBook();
  if (event.code === 'KeyM') openMap();
});

document.querySelectorAll('[data-move]').forEach(button => {
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    mobileMovement = button.dataset.move;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: mobileMovement, key: mobileMovement.slice(-1).toLowerCase(), bubbles: true }));
  });
  const release = () => {
    if (mobileMovement) window.dispatchEvent(new KeyboardEvent('keyup', { code: mobileMovement, key: mobileMovement.slice(-1).toLowerCase(), bubbles: true }));
    mobileMovement = null;
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
});

function showDamage(event) {
  if (!event.potency) return;
  const span = document.createElement('span');
  span.className = `damage-number ${event.type === 'heal' ? 'heal' : ''}`;
  span.style.setProperty('--offset', `${Math.random() * 90 - 45}px`);
  span.innerHTML = `<b>${formatNumber(event.potency)}</b><small>${escape(event.name)}</small>`;
  $('#floating-damage').appendChild(span);
  setTimeout(() => span.remove(), 1550);
}

function resize() { world.resize(window.innerWidth, window.innerHeight); }
window.addEventListener('resize', resize);
resize();
sceneTitle(currentScene);
renderCombat();
let last = performance.now(), uiElapsed = 0, mapElapsed = 0, frameElapsed = 0, developerElapsed = 0, frameCount = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  developerRuntime.update(dt);
  world.update(dt);
  if (!world.loading && world.isImported && assetProfiler.active?.firstRender && !assetProfiler.active?.interactive) {
    const overlay = getComputedStyle($('#loading'));
    if (overlay.visibility === 'hidden' && Number(overlay.opacity) <= 0.01 && world.input.enabled) {
      assetProfiler.mark('first-visible-render', { sceneId: world.sceneId });
      assetProfiler.interactive({ sceneId: world.sceneId, source: 'visible-imported-frame-input-enabled' });
    }
  }
  const ctx = context();
  combat.tick(dt, ctx);
  training.update(dt);
  world.setMovementSpeed(combat.getState().movementMultiplier || 1);
  teleportController.update(dt, ctx.moving);
  for (const event of combat.drainEvents()) {
    if (event.type === 'move') world.moveSkill({ ...event, gateDuration: event.saveReturn ? 10 : 0 });
    world.effect(event);
    if (event.type === 'error') toast(event.reason || `${event.name || '技能'}：咏唱中断`);
    showDamage(event);
  }
  uiElapsed += dt;
  mapElapsed += dt;
  frameElapsed += dt;
  developerElapsed += dt;
  frameCount++;
  if (uiElapsed >= 0.065) { renderCombat(); updateConnectionPrompt(); if (sandboxPanel.isOpen) sandboxPanel.update(); uiElapsed = 0; }
  if (mapElapsed >= 0.2) { drawMap($('#minimap')); if (dialogs.active === 'map-modal') drawMap($('#area-map-canvas'), true); mapElapsed = 0; }
  if (developerElapsed >= 0.25) {
    loadingFeedback.update(world, assetProfiler);
    if (!world.loading && world.isImported) preferences.setCamera({ azimuth: world.azimuth, polar: world.polar, distance: world.zoom });
    if (developerPanel.isOpen || preferences.developer.overlay) {
      const snapshot = developerRuntime.getSnapshot();
      if (developerPanel.isOpen) developerPanel.update(snapshot);
      if (preferences.developer.overlay) debugOverlay.update(snapshot);
    }
    developerElapsed = 0;
  }
  if (frameElapsed >= 1) {
    fps = Math.round(frameCount / frameElapsed);
    $('#render-stats').textContent = `${fps} FPS`;
    const eorzeaMinutes = Math.floor(world.worldTime.hour * 60);
    $('#eorzea-time').textContent = `ET ${String(Math.floor(eorzeaMinutes / 60)).padStart(2, '0')}:${String(eorzeaMinutes % 60).padStart(2, '0')}`;
    frameCount = 0; frameElapsed = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__APP__ = { world, combat, training, useAction, switchJob, teleport, reset, openTeleport, openBook, closeModal, SCENES, JOBS, sandbox: { assets: sandboxAssets, audio, panel: sandboxPanel, hudLayout }, developer: { runtime: developerRuntime, panel: developerPanel, overlay: debugOverlay, preferences, feedback: loadingFeedback }, getContext: context, getFPS: () => fps };
