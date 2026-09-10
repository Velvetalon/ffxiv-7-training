import { createCombat, JOBS } from './combat/index.js';
import { World, SCENES, loadSceneCatalog } from './world/index.js';
import { $, escape, formatNumber } from './ui/dom.js';
import { drawMap as renderMap } from './ui/Minimap.js';
import { SkillAudio } from './audio/SkillAudio.js';
import { TeleportController } from './core/TeleportController.js';
import { TrainingDirector } from './core/TrainingDirector.js';
import { loadSettings, saveSettings as persistSettings } from './core/Settings.js';
import { mountShell } from './ui/Shell.js';
import { Hotbar } from './ui/Hotbar.js';
import { createDialogs } from './ui/Dialogs.js';
import { createHud } from './ui/Hud.js';
import './style.css';
import { assetProfiler } from './assets/AssetProfiler.js';

const settings = loadSettings();
let currentScene = SCENES[0].id;
let feedbackTimeout;
const skillAudio = new SkillAudio(settings);
let fps = 60;
let mobileMovement = null;
let sceneTransition = false;

mountShell(JOBS);
try { await loadSceneCatalog(); } catch (error) { console.warn('Scene catalog:', error); }
const requestedScene = new URLSearchParams(window.location.search).get('scene');
currentScene = SCENES.some(scene => scene.id === requestedScene)
  ? requestedScene : SCENES.find(scene => scene.id === 'gridania')?.id || SCENES[0].id;

const combat = createCombat('WHM');
const training = new TrainingDirector(combat);
const hotbar = new Hotbar(combat, JOBS);
const world = new World($('#world'), {
  initialScene: currentScene,
  onTarget: () => {},
  onInteract: (npc) => openDialogue(npc),
  onMove: () => { if (teleportController.cast) teleportController.cancel(); },
  onLoading: (progress,error) => {
    const screen=$('#loading');
    screen.classList.toggle('loaded',progress===1||!!error);
    screen.querySelector('p').textContent=error||`正在载入地区 ${Math.round((progress||0)*100)}%`;
    if(error)toast(`地区载入失败：${error}`);
  },
  onSceneReady: id => { if (id === currentScene) { sceneTitle(id); hud.invalidate(); } },
  onConnection: connection => travelConnection(connection),
});
world.setJob('WHM');
world.setQuality(settings.quality);
world.setControlMode(settings.controlMode);
world.setScene(currentScene);
world.targetNearest();

const playSound = (type, jobId) => skillAudio.play(type, jobId);
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
  teleportController.cancel();
  combat.reset();
  training.reset();
  world.clearFields();
  world.clearReturnGate();
  try {
    const success = await world.setScene(id, entry);
    if (success !== true) return { ok: false, reason: world.loadError || '地区载入失败，请重试' };
    currentScene = id;
    world.targetNearest();
    sceneTitle(id);
    hud.invalidate();
    hotbar.reset();
    closeModal();
    playSound('buff');
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
$('#teleport-open').addEventListener('click', openTeleport);
$('#book-open').addEventListener('click', () => openBook());
$('#settings-open').addEventListener('click', openSettings);
$('#help-open').addEventListener('click', openHelp);
$('#area-open').addEventListener('click', openMap);
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
    else if (teleportController.cast) teleportController.cancel();
    else world.clearTarget();
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || dialogs.active) return;
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
setTimeout(() => { if(!world.loading)$('#loading').classList.add('loaded'); }, 350);
let last = performance.now(), uiElapsed = 0, mapElapsed = 0, frameElapsed = 0, frameCount = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
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
    else world.effect(event);
    if (event.type === 'hit' || event.type === 'heal' || event.type === 'buff') playSound(event.type, event.jobId || combat.getState().jobId);
    if (event.type === 'error') toast(event.reason || `${event.name || '技能'}：咏唱中断`);
    showDamage(event);
  }
  uiElapsed += dt;
  mapElapsed += dt;
  frameElapsed += dt;
  frameCount++;
  if (uiElapsed >= 0.065) { renderCombat(); updateConnectionPrompt(); uiElapsed = 0; }
  if (mapElapsed >= 0.2) { drawMap($('#minimap')); if (dialogs.active === 'map-modal') drawMap($('#area-map-canvas'), true); mapElapsed = 0; }
  if (frameElapsed >= 1) {
    fps = Math.round(frameCount / frameElapsed);
    $('#render-stats').textContent = `${fps} FPS`;
    const eorzeaMinutes = Math.floor(Date.now() / (175 / 60 * 1000)) % 1440;
    $('#eorzea-time').textContent = `ET ${String(Math.floor(eorzeaMinutes / 60)).padStart(2, '0')}:${String(eorzeaMinutes % 60).padStart(2, '0')}`;
    frameCount = 0; frameElapsed = 0;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__APP__ = { world, combat, training, useAction, switchJob, teleport, reset, openTeleport, openBook, closeModal, SCENES, JOBS, getContext: context, getFPS: () => fps };
