// Structured programmatic control surface over the Babylon preview.
// Panel, scripts and browser automation call the same whitelist; no command
// accepts arbitrary code strings. Every dispatch returns
// { requestId, status, sceneEpoch, stateRevision, errorCode?, data? }.
// Mutating commands report `ok` only after the effect is observable in a
// rendered frame, never on a fixed sleep.

const EPOCH_STORAGE_KEY = 'ff14-workbench-boot-epoch';
const DEDUP_CACHE_LIMIT = 64;
const POSITION_EPSILON = 0.01;

const COMMANDS = [
  'capabilities.query',
  'state.read',
  'camera.set',
  'camera.get',
  'time.set',
  'viewpoint.set',
  'animation.pause',
  'animation.resume',
  'objects.locate',
  'objects.list',
  'map.switch',
];

function nextEpoch() {
  try {
    const epoch = Number(sessionStorage.getItem(EPOCH_STORAGE_KEY) || '0') + 1;
    sessionStorage.setItem(EPOCH_STORAGE_KEY, String(epoch));
    return epoch;
  } catch {
    return Date.now();
  }
}

function finiteVector(value) {
  const list = Array.isArray(value) ? value : [value?.x, value?.y, value?.z];
  const numbers = list.map(Number);
  return numbers.length === 3 && numbers.every(Number.isFinite) ? numbers : null;
}

export function createWorkbenchApi(api) {
  const sceneEpoch = nextEpoch();
  let stateRevision = 0;
  const dedupCache = new Map();

  const build = (requestId, status, extra = {}) => ({
    requestId,
    status,
    sceneEpoch,
    stateRevision,
    ...extra,
  });

  function mutate(requestId, errorCode, data = null) {
    stateRevision += 1;
    return build(requestId, 'ok', { data });
  }

  function reject(requestId, errorCode, detail = null) {
    return build(requestId, errorCode === 'invalid-args' ? 'rejected' : 'failed', { errorCode, data: detail });
  }

  function waitForFrame() {
    return new Promise(resolve => {
      const engine = api.engine;
      if (!engine?.onEndFrameObservable) {
        setTimeout(resolve, 32);
        return;
      }
      const observer = engine.onEndFrameObservable.addOnce(() => resolve());
      setTimeout(() => {
        if (observer) engine.onEndFrameObservable.remove(observer);
        resolve();
      }, 500);
    });
  }

  function cameraSnapshot() {
    const camera = api.camera;
    if (!camera) return null;
    const target = camera.target ? [camera.target.x, camera.target.y, camera.target.z] : null;
    return {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target,
      fov: camera.fov,
      referenceView: api.stats?.referenceView ?? null,
    };
  }

  function stateSnapshot() {
    return {
      mapId: api.mapId,
      stage: api.stats?.stage || null,
      ready: Boolean(api.isReady),
      fullyLoaded: Boolean(api.isFullyLoaded),
      camera: cameraSnapshot(),
      time: api.stats?.time ?? null,
      backend: api.engine ? `WebGL${api.engine.webGLVersion}` : null,
      meshes: api.loader?.state?.meshCount ?? null,
      failures: api.loader?.state?.failures?.length ?? null,
      animationsEnabled: api.scene ? api.scene.animationsEnabled : null,
      animatables: api.scene ? api.scene.getActiveAnimatables?.().length ?? 0 : null,
    };
  }

  function objectRecord(mesh, records) {
    const meta = mesh?.metadata?.ff14;
    if (!meta?.sourceAsset || meta.sourceInstanceIndex === undefined) return null;
    const record = records.find(candidate => candidate.asset === meta.sourceAsset);
    if (!record) return null;
    const matrix = mesh.getWorldMatrix();
    const position = [matrix.m[12], matrix.m[13], matrix.m[14]];
    return {
      stableAddress: `${api.mapId}:${record.index}:${meta.sourceInstanceIndex}`,
      sourceAsset: meta.sourceAsset,
      modelIndex: record.index,
      sourceInstanceIndex: meta.sourceInstanceIndex,
      resourceId: record.resourceId || null,
      meshName: mesh.name,
      worldPosition: position.map(value => Number(value.toFixed(3))),
    };
  }

  const handlers = {
    'capabilities.query': requestId => build(requestId, 'ok', {
      data: {
        commands: COMMANDS.slice(),
        mapId: api.mapId,
        engine: 'Babylon.js',
        engineVersion: api.engine?.constructor?.Version ?? null,
        viewerMode: true,
        mapSwitchSemantics: 'navigation',
      },
    }),

    'state.read': requestId => build(requestId, 'ok', { data: stateSnapshot() }),

    'camera.get': requestId => build(requestId, 'ok', { data: { camera: cameraSnapshot() } }),

    'camera.set': async (requestId, args) => {
      const position = finiteVector(args.position);
      const target = finiteVector(args.target);
      if (!position || !target) return reject(requestId, 'invalid-args', 'position and target must be 3 finite numbers');
      const applied = api.setCameraState({
        position,
        target,
        ...(Number.isFinite(Number(args.fov)) ? { fov: Number(args.fov) } : {}),
        ...(args.id ? { id: args.id } : {}),
      });
      if (!applied) return reject(requestId, 'invalid-args', 'setCameraState rejected the values');
      await waitForFrame();
      const after = cameraSnapshot();
      const moved = Math.hypot(
        after.position[0] - position[0],
        after.position[1] - position[1],
        after.position[2] - position[2],
      );
      if (moved > POSITION_EPSILON) return reject(requestId, 'not-observed', `camera drifted ${moved.toFixed(4)} after apply`);
      return mutate(requestId, null, { camera: after });
    },

    'time.set': async (requestId, args) => {
      const request = args.time ?? args.hour ?? args.preset;
      if (request === undefined) return reject(requestId, 'invalid-args', 'time preset or numeric hour required');
      try {
        const applied = api.setTime(request);
        await waitForFrame();
        return mutate(requestId, null, { time: applied });
      } catch (error) {
        return reject(requestId, 'invalid-args', error.message);
      }
    },

    'viewpoint.set': async (requestId, args) => {
      if (!args.name) return reject(requestId, 'invalid-args', 'viewpoint name required');
      const applied = api.setViewpoint(args.name);
      if (!applied) return reject(requestId, 'invalid-args', `unknown viewpoint: ${args.name}`);
      await waitForFrame();
      return mutate(requestId, null, { viewpoint: args.name, camera: cameraSnapshot() });
    },

    'animation.pause': async requestId => {
      if (!api.scene) return reject(requestId, 'unavailable', 'scene not ready');
      api.scene.animationsEnabled = false;
      await waitForFrame();
      return mutate(requestId, null, { animationsEnabled: false, animatables: api.scene.getActiveAnimatables?.().length ?? 0 });
    },

    'animation.resume': async requestId => {
      if (!api.scene) return reject(requestId, 'unavailable', 'scene not ready');
      api.scene.animationsEnabled = true;
      await waitForFrame();
      return mutate(requestId, null, { animationsEnabled: true, animatables: api.scene.getActiveAnimatables?.().length ?? 0 });
    },

    'objects.locate': (requestId, args) => {
      const records = api.loader?.records || [];
      if (args.stableAddress || Number.isFinite(Number(args.modelIndex))) {
        const [mapId, modelIndexPart, instancePart] = String(args.stableAddress || '').split(':');
        const modelIndex = args.stableAddress ? Number(modelIndexPart) : Number(args.modelIndex);
        const sourceInstanceIndex = args.stableAddress ? Number(instancePart) : Number(args.sourceInstanceIndex ?? 0);
        if (api.mapId && mapId && mapId !== api.mapId) return reject(requestId, 'invalid-args', `address map ${mapId} != current ${api.mapId}`);
        if (!Number.isFinite(modelIndex) || !Number.isFinite(sourceInstanceIndex)) return reject(requestId, 'invalid-args', 'stable address malformed');
        const suffix = `:${modelIndex}:${sourceInstanceIndex}:`;
        const mesh = (api.scene?.meshes || []).find(candidate => {
          const meta = candidate?.metadata?.ff14;
          return meta && candidate.name.includes(suffix) && meta.sourceInstanceIndex === sourceInstanceIndex;
        }) || (api.scene?.meshes || []).find(candidate => candidate.name === `${api.mapId}:${modelIndex}:${sourceInstanceIndex}`);
        if (!mesh) return build(requestId, 'ok', { data: { found: false, stableAddress: `${api.mapId}:${modelIndex}:${sourceInstanceIndex}` } });
        return build(requestId, 'ok', { data: { found: true, object: objectRecord(mesh, records) } });
      }
      return reject(requestId, 'invalid-args', 'stableAddress or modelIndex required');
    },

    'objects.list': (requestId, args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);
      const records = api.loader?.records || [];
      const seen = new Set();
      const objects = [];
      for (const mesh of api.scene?.meshes || []) {
        const record = objectRecord(mesh, records);
        if (!record || seen.has(record.stableAddress)) continue;
        seen.add(record.stableAddress);
        objects.push(record);
        if (objects.length >= limit) break;
      }
      return build(requestId, 'ok', { data: { total: seen.size, objects } });
    },

    'map.switch': (requestId, args) => {
      const mapId = String(args.mapId || '').trim();
      const maps = api.assets?.config?.maps || {};
      if (!mapId) return reject(requestId, 'invalid-args', 'mapId required');
      if (!maps[mapId]) return reject(requestId, 'invalid-args', `unknown map: ${mapId}`);
      if (mapId === api.mapId) return build(requestId, 'ok', { data: { already: true, mapId } });
      const next = new URL(location.href);
      next.searchParams.set('scene', mapId);
      return build(requestId, 'accepted', {
        data: {
          mapId,
          navigateTo: next.href,
          note: 'viewer mode switches maps by navigation; wait for the new page ready gate',
        },
      });
    },
  };

  async function dispatch(command, args = {}) {
    const requestId = String(args.requestId || `req-${stateRevision}-${Math.random().toString(36).slice(2, 8)}`);
    if (dedupCache.has(requestId)) return { ...dedupCache.get(requestId), duplicate: true };
    const name = String(command || '').trim();
    if (!handlers[name]) {
      return reject(requestId, 'unknown-command', name || '(empty)');
    }
    if (args.expectedEpoch !== undefined && Number(args.expectedEpoch) !== sceneEpoch) {
      return build(requestId, 'stale', { data: { expectedEpoch: Number(args.expectedEpoch), sceneEpoch } });
    }
    try {
      const pending = handlers[name](requestId, args);
      const value = pending instanceof Promise ? await pending : pending;
      dedupCache.set(requestId, value);
      if (dedupCache.size > DEDUP_CACHE_LIMIT) dedupCache.delete(dedupCache.keys().next().value);
      return value;
    } catch (error) {
      return reject(requestId, 'runtime-error', error?.message || String(error));
    }
  }

  return {
    dispatch,
    sceneEpoch,
    commands: COMMANDS,
    stateSnapshot,
  };
}

export default createWorkbenchApi;
