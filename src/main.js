import { createCombat, JOBS } from './combat/index.js';
import { World, SCENES } from './world/index.js';
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

const settings = loadSettings();
let currentScene = SCENES[0].id;
let feedbackTimeout;
const skillAudio = new SkillAudio(settings);
let fps = 60;
let mobileMovement = null;

mountShell(JOBS);

const combat = createCombat('WHM');
const training = new TrainingDirector(combat);
const hotbar = new Hotbar(combat, JOBS);
const world = new World($('#world'), {
  onTarget: () => {},
  onInteract: (npc) => openDialogue(npc),
  onMove: () => { if (teleportController.cast) teleportController.cancel(); },
});
world.setJob('WHM');
world.setQuality(settings.quality);
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
  return teleportController.start(id, immediate);
}
function finishTeleport(id) {
  closeModal();
  combat.reset();
  training.reset();
  currentScene = id;
  world.setScene(id);
  world.setJob(combat.getState().jobId);
  if (combat.getState().jobId === 'RPR') world.moveToDummy();
  world.targetNearest();
  sceneTitle(id);
  hud.invalidate();
  hotbar.reset();
  playSound('buff');
  return { ok: true };
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
    document.querySelectorAll('[data-scene-region]').forEach(button => button.hidden = region.dataset.region !== 'all' && button.dataset.sceneRegion !== region.dataset.region);
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
  if (id === 'sound-toggle') { settings.sound = checked; saveSettings(); }
  if (id === 'volume') { settings.volume = Number(value); saveSettings(); }
  if (id === 'hud-scale') { settings.scale = Number(value); $('#hud-scale-output').textContent = `${value}%`; saveSettings(); }
  if (id === 'target-count') targetCount = Math.max(1, Math.min(8, Math.round(Number(value) || 1)));
  if (id === 'healing-pressure') training.setEnabled(checked);
});
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
setTimeout(() => $('#loading').classList.add('loaded'), 350);
let last = performance.now(), uiElapsed = 0, mapElapsed = 0, frameElapsed = 0, frameCount = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  world.update(dt);
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
  if (uiElapsed >= 0.065) { renderCombat(); uiElapsed = 0; }
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
