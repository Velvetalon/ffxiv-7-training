import {
  Engine,
  Scene,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core';
import BabylonAssets from './AssetBridge.js';
import { createFreeFlyControls } from './Controls.js';
import EnvironmentAdapter from './EnvironmentAdapter.js';
import MaterialAdapter from './MaterialAdapter.js';
import { createBabylonMapLoader } from './SceneLoader.js';
import { deriveMapViewpoints } from './viewpoints.js';
import './style.css';

const TIME_LABELS = { day: 'Day', dusk: 'Dusk', night: 'Night' };
const FULL_TEXTURE_UPGRADE_CONCURRENCY = 4;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function ensureRoot() {
  let root = document.getElementById('app');
  if (!root) {
    root = document.createElement('main');
    root.id = 'app';
    document.body.append(root);
  }
  root.innerHTML = `
    <canvas id="babylon-canvas" aria-label="Babylon world scene"></canvas>
    <section class="preview-panel preview-status" aria-live="polite">
      <div class="preview-title"><strong data-map-name>World Preview <small data-map-id></small></strong><span>Babylon WebGL2</span></div>
      <dl class="preview-stats">
        <div><dt>Stage</dt><dd data-stat="stage">boot</dd></div>
        <div><dt>Missing</dt><dd data-stat="missing">0</dd></div>
        <div><dt>FPS</dt><dd data-stat="fps">--</dd></div>
        <div><dt>Draw</dt><dd data-stat="draw">--</dd></div>
        <div><dt>Active</dt><dd data-stat="active">--</dd></div>
        <div><dt>Triangles</dt><dd data-stat="triangles">--</dd></div>
        <div><dt>Camera</dt><dd data-stat="camera">--</dd></div>
        <div><dt>Time</dt><dd data-stat="time">Day</dd></div>
        <div><dt>Backend</dt><dd data-stat="backend">--</dd></div>
      </dl>
    </section>
    <section class="preview-panel preview-controls" aria-label="Scene controls">
      <label class="map-control"><span>Map</span><select data-map-select aria-label="Map"></select></label>
      <div class="control-row" data-viewpoints></div>
      <div class="control-row">
        <button type="button" data-time="day">Day</button>
        <button type="button" data-time="dusk">Dusk</button>
        <button type="button" data-time="night">Night</button>
      </div>
      <label class="speed-control"><span>Speed</span><input data-speed type="range" min="0.05" max="6" step="0.05" value="0.65"><output data-speed-value>0.65</output></label>
      <button type="button" class="reset-button" data-reset>Reset view</button>
    </section>
    <div class="preview-error" data-error hidden></div>
  `;
  return root;
}

function formatCamera(camera) {
  return [camera.position.x, camera.position.y, camera.position.z].map(value => value.toFixed(1)).join(', ');
}

function drawCalls(engine) {
  return engine._drawCalls?.current ?? engine._drawCalls?.count ?? engine.getDrawCalls?.() ?? 0;
}

async function applyEnvironment(adapter, time = 'day') {
  if (!adapter?.setPreset) throw new Error('EnvironmentAdapter.setPreset is required');
  return adapter.setPreset(time, { apply: true });
}

function setTimeEnvironment(adapter, time) {
  if (typeof time === 'string' && TIME_LABELS[time]) {
    return { preset: time, state: adapter.setPreset(time, { apply: true }) };
  }
  const hour = Number(time);
  if (!Number.isFinite(hour) || !adapter?.setTime) {
    throw new Error('Time must be a day, dusk, night preset or a numeric hour');
  }
  const normalizedHour = ((hour % 24) + 24) % 24;
  return { hour: normalizedHour, state: adapter.setTime(normalizedHour, { apply: true }) };
}

async function upgradeSceneMaterials(adapter, scene) {
  if (typeof adapter?.upgradeMaterial !== 'function') {
    throw new Error('MaterialAdapter.upgradeMaterial is required for full-quality completion');
  }
  const materials = [...new Set(scene.materials || [])].filter(material => material?.metadata?.ffxiv?.preview);
  const rejected = [];
  let cursor = 0;
  const upgradeOne = async () => {
    while (cursor < materials.length) {
      const material = materials[cursor++];
      try {
        await adapter.upgradeMaterial(material, { priority: 20 });
      } catch (error) {
        rejected.push({ material: material.name, message: error?.message || String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FULL_TEXTURE_UPGRADE_CONCURRENCY, Math.max(1, materials.length)) }, upgradeOne));
  const adapterDiagnostics = adapter.diagnostics?.() || null;
  const missing = Object.entries(adapterDiagnostics?.missing?.textures || {}).map(([path, count]) => ({ path, count }));
  return {
    requested: materials.length,
    upgraded: materials.length - rejected.length,
    rejected,
    missing,
  };
} 

function setupMapSelector(root, assets) {
  const selector = root.querySelector('[data-map-select]');
  if (!selector) return;
  const scenes = assets.config?.maps || {};
  for (const [id, scene] of Object.entries(scenes)) {
    const option = document.createElement('option');
    option.value = id;
    option.selected = id === assets.mapId;
    option.textContent = `${scene.name || scene.fullSceneName || id} (${id})`;
    selector.append(option);
  }
  selector.addEventListener('change', () => {
    const next = new URL(location.href);
    next.searchParams.set('scene', selector.value);
    location.assign(next.href);
  });
}

function setText(root, name, value) {
  const element = root.querySelector(`[data-stat="${name}"]`);
  if (element) element.textContent = String(value);
}

export async function startBabylonPreview({
  assets: suppliedAssets = null,
  materialAdapter: suppliedMaterialAdapter = null,
  environmentAdapter: suppliedEnvironmentAdapter = null,
  assetFactory = BabylonAssets,
} = {}) {
  const root = ensureRoot();
  const canvas = root.querySelector('#babylon-canvas');
  const ready = deferred();
  const fullyLoaded = deferred();
  const api = {
    engine: null,
    scene: null,
    camera: null,
    assets: null,
    materials: null,
    environment: null,
    loader: null,
    controls: null,
    stats: { stage: 'boot', time: 'day' },
    ready: ready.promise,
    fullyLoaded: fullyLoaded.promise,
    isReady: false,
    isFullyLoaded: false,
    setViewpoint: () => false,
    setTime: () => 'day',
    setLodEnabled: () => false,
    getRuntimeSnapshot: () => ({ meshes: [] }),
    diagnostics: () => ({ stage: api.stats.stage }),
  };
  globalThis.__BABYLON_PREVIEW__ = api;

  try {
    const assets = suppliedAssets || await new assetFactory({
      onEvent: event => {
        api.stats.lastAssetEvent = event?.event || event?.type || 'asset';
      },
    }).initialize();
    api.assets = assets;
    api.mapId = assets.mapId;
    api.map = assets.scene;
    const mapName = assets.scene?.name || assets.scene?.fullSceneName || assets.mapId;
    document.title = `${mapName} · Babylon World Preview`;
    root.querySelector('[data-map-name]').firstChild.textContent = `${mapName} `;
    root.querySelector('[data-map-id]').textContent = `(${assets.mapId})`;
    canvas.setAttribute('aria-label', `${mapName} ${assets.mapId} Babylon scene`);
    setupMapSelector(root, assets);

    const engine = new Engine(canvas, true, {
      stencil: true,
      preserveDrawingBuffer: false,
      disableWebGL2Support: false,
    });
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    scene.collisionsEnabled = false;
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;

    const legacy = assets.legacy;
    const spawn = legacy?.training?.spawn || { x: 47.50471, y: 4.500001, z: -20.28513 };
    const camera = new UniversalCamera(`${assets.mapId}-camera`, new Vector3(spawn.x, spawn.y, spawn.z), scene);
    camera.minZ = 0.1;
    camera.maxZ = 3500;
    camera.fov = 0.82;
    camera.applyGravity = false;
    camera.checkCollisions = false;
    scene.activeCamera = camera;

    const materialAdapter = suppliedMaterialAdapter || new MaterialAdapter({
      scene,
      assets,
      map: assets.map,
      onDiagnostic: diagnostic => { api.stats.lastMaterialDiagnostic = diagnostic; },
    });
    const environmentAdapter = suppliedEnvironmentAdapter || new EnvironmentAdapter({
      scene,
      profile: assets.profile,
      onDiagnostic: diagnostic => { api.stats.lastEnvironmentDiagnostic = diagnostic; },
    });
    await applyEnvironment(environmentAdapter);
    const viewpoints = deriveMapViewpoints(legacy, { mapId: assets.mapId });
    const controls = createFreeFlyControls({
      camera,
      canvas,
      scene,
      viewpoints,
      onViewpoint: name => { api.stats.viewpoint = name; },
    });
    const loader = createBabylonMapLoader({
      scene,
      assets,
      materialAdapter,
      environmentAdapter,
      gpuQueue: assets.runtime?.gpu,
      onProgress: progress => {
        api.stats.stage = progress.phase;
        api.stats.loader = progress;
        setText(root, 'stage', progress.phase);
        setText(root, 'missing', progress.failures?.length || 0);
      },
      onError: (error, record) => {
        api.stats.lastLoadError = { message: error?.message || String(error), index: record?.index };
      },
    });

    api.engine = engine;
    api.scene = scene;
    api.camera = camera;
    api.materials = materialAdapter;
    api.environment = environmentAdapter;
    api.loader = loader;
    api.controls = controls;
    api.setViewpoint = name => controls.setViewpoint(name);
    api.setTime = time => {
      const applied = setTimeEnvironment(environmentAdapter, time);
      api.stats.time = applied.preset || applied.hour;
      setText(root, 'time', applied.preset ? TIME_LABELS[applied.preset] : `${applied.hour.toFixed(2)}h`);
      return applied.preset || applied.hour;
    };
    api.setLodEnabled = enabled => loader.setLodEnabled(enabled);
    api.getRuntimeSnapshot = () => loader.runtimeSnapshot();
    api.diagnostics = () => ({
      ...loader.diagnostics({ includeTransforms: true }),
      ...assets.diagnostics(),
      materials: materialAdapter.diagnostics?.() || null,
      environment: environmentAdapter.diagnostics?.() || null,
      stage: api.stats.stage,
      backend: engine.webGLVersion >= 2 ? 'WebGL2' : 'WebGL1',
      sourceInstanceCount: loader.diagnostics().sourcePlacementCount,
    });

    const viewpointsRoot = root.querySelector('[data-viewpoints]');
    for (const [name, viewpoint] of Object.entries(viewpoints)) {
      if (name === 'spawn') continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.viewpoint = name;
      button.textContent = viewpoint.label;
      viewpointsRoot.append(button);
      button.addEventListener('click', () => controls.setViewpoint(name));
    }
    root.querySelector('[data-reset]').addEventListener('click', () => controls.reset());
    root.querySelectorAll('[data-time]').forEach(button => button.addEventListener('click', () => api.setTime(button.dataset.time)));
    const speed = root.querySelector('[data-speed]');
    const speedValue = root.querySelector('[data-speed-value]');
    speed.addEventListener('input', () => {
      const current = controls.setSpeed(speed.value);
      speedValue.value = current.toFixed(2);
      speedValue.textContent = current.toFixed(2);
    });

    let lastStatsAt = 0;
    engine.runRenderLoop(() => {
      scene.render();
      const now = performance.now();
      if (now - lastStatsAt < 250) return;
      lastStatsAt = now;
      loader.setCameraPosition(camera.position);
      const diag = loader.diagnostics({ includeTransforms: false });
      const active = scene.getActiveMeshes?.().length ?? 0;
      const activeTriangles = scene.getActiveIndices ? Math.floor(scene.getActiveIndices() / 3) : diag.triangleCount;
      api.stats.fps = engine.getFps();
      api.stats.drawCalls = drawCalls(engine);
      api.stats.activeMeshes = active;
      api.stats.triangles = activeTriangles;
      setText(root, 'fps', api.stats.fps.toFixed(0));
      setText(root, 'draw', api.stats.drawCalls);
      setText(root, 'active', active);
      setText(root, 'triangles', activeTriangles.toLocaleString());
      setText(root, 'camera', formatCamera(camera));
      setText(root, 'backend', engine.webGLVersion >= 2 ? 'WebGL2' : 'WebGL1');
      api.stats.loader = diag;
    });
    window.addEventListener('resize', () => engine.resize());

    await loader.loadBootstrap();
    scene.render();
    if (loader.state.meshCount < 1) {
      throw new Error(`${assets.mapId} bootstrap produced no Babylon geometry`);
    }
    api.stats.stage = 'interactive';
    setText(root, 'stage', 'interactive');
    assets.mark?.('first-render', {
      models: loader.state.loadedModels,
      sourceInstances: loader.diagnostics().transformCount,
      meshes: loader.state.meshCount,
      triangles: loader.state.triangleCount,
    });
    assets.mark?.('interactive', { sourceInstances: loader.diagnostics().transformCount });
    api.isReady = true;
    ready.resolve(api);

    void loader.loadRemaining().then(async () => {
      api.stats.stage = 'upgrading-materials';
      setText(root, 'stage', 'upgrading-materials');
      const textureUpgrade = await upgradeSceneMaterials(materialAdapter, scene);
      api.stats.textureUpgrade = textureUpgrade;
      api.stats.textureUpgradeFailures = [...textureUpgrade.rejected, ...textureUpgrade.missing];
      api.isFullyLoaded = true;
      api.stats.stage = loader.state.phase;
      assets.mark?.('fully-loaded', {
        models: loader.state.loadedModels,
        sourceInstances: loader.diagnostics().transformCount,
        meshes: loader.state.meshCount,
        triangles: loader.state.triangleCount,
        failures: loader.state.failures.length,
      });
      fullyLoaded.resolve(api);
    }).catch(error => {
      api.stats.stage = 'complete-with-errors';
      fullyLoaded.reject(error);
    });

    return api;
  } catch (error) {
    api.stats.stage = 'error';
    const errorElement = root.querySelector('[data-error]');
    errorElement.hidden = false;
    errorElement.textContent = error?.message || String(error);
    ready.reject(error);
    fullyLoaded.reject(error);
    throw error;
  }
}

if (typeof window !== 'undefined') {
  const start = () => startBabylonPreview().catch(() => {});
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
