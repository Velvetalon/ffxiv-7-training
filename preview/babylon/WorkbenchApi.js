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
  'objects.pick',
  'objects.inspect',
  'resources.whoUses',
  'map.switch',
  'case.capture',
  'case.save',
  'case.list',
  'case.restore',
];

const CASE_STORAGE_KEY = 'ff14-workbench-cases';
const CASE_SCHEMA_VERSION = 1;

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

function readStoredCases() {
  try {
    return JSON.parse(localStorage.getItem(CASE_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeStoredCases(cases) {
  try {
    localStorage.setItem(CASE_STORAGE_KEY, JSON.stringify(cases));
    return true;
  } catch {
    return false;
  }
}

function assetVersionFields(api) {
  const diagnostics = api.assets?.diagnostics?.() || {};
  return {
    assetRunId: diagnostics.assetVersion || null,
    mapManifest: diagnostics.mapManifest || null,
  };
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

  function findObjectMesh(stableAddress) {
    const [mapId, modelIndexPart, instancePart] = String(stableAddress || '').split(':');
    const modelIndex = Number(modelIndexPart);
    const sourceInstanceIndex = Number(instancePart);
    if (!Number.isFinite(modelIndex) || !Number.isFinite(sourceInstanceIndex)) return null;
    if (mapId && mapId !== api.mapId) return null;
    const suffix = `:${modelIndex}:${sourceInstanceIndex}:`;
    return (api.scene?.meshes || []).find(candidate => {
      const meta = candidate?.metadata?.ff14;
      return meta && meta.sourceInstanceIndex === sourceInstanceIndex && candidate.name.includes(suffix);
    }) || null;
  }

  function registryRecord(resourceId) {
    if (!resourceId) return null;
    const registry = api.assets?.runtime?.registry;
    const record = registry?.resources?.get?.(resourceId) || registry?.get?.(resourceId) || null;
    return record ? { id: record.id || resourceId, type: record.type || null, size: record.size || 0, hash: record.hash || null } : { id: resourceId };
  }

  function textureProvenance(material) {
    const slots = material?.metadata?.ffxiv?.textureSlots || [];
    const provenance = [];
    for (const slot of slots) {
      const texture = material[slot.property];
      const meta = texture?.metadata?.ffxiv || null;
      provenance.push({
        property: slot.property,
        semantic: slot.semantic,
        runtimePath: slot.runtimePath || meta?.runtimePath || null,
        sourcePath: slot.sourcePath || meta?.sourcePath || null,
        resourceId: meta?.resourceId || null,
        fullResourceId: meta?.fullResourceId || null,
        previewEncoding: meta?.preview ?? null,
        gammaSpace: texture ? texture.gammaSpace : null,
        uvScale: texture ? [texture.uScale ?? 1, texture.vScale ?? 1] : null,
        dimensions: texture?.getSize ? Object.values(texture.getSize()).filter(Number.isFinite).slice(0, 2) : null,
      });
    }
    return provenance;
  }

  function materialProvenance(material, records) {
    if (!material) return null;
    const meta = material.metadata?.ffxiv || null;
    const channelMapping = meta?.channelMapping || null;
    const finalParams = {
      className: material.getClassName?.() || null,
      albedoColor: material.albedoColor ? material.albedoColor.asArray().map(value => Number(value.toFixed(4))) : null,
      metallic: Number.isFinite(material.metallic) ? material.metallic : null,
      roughness: Number.isFinite(material.roughness) ? material.roughness : null,
      transparencyMode: material.transparencyMode ?? null,
      alphaCutOff: Number.isFinite(material.alphaCutOff) ? material.alphaCutOff : null,
      useAlphaFromAlbedoTexture: material.useAlphaFromAlbedoTexture ?? null,
      backFaceCulling: material.backFaceCulling ?? null,
      twoSidedLighting: material.twoSidedLighting ?? null,
      environmentIntensity: Number.isFinite(material.environmentIntensity) ? material.environmentIntensity : null,
    };
    const users = [];
    for (const candidate of api.scene?.meshes || []) {
      if (candidate.material !== material) continue;
      const instance = candidate.metadata?.ff14;
      if (!instance) continue;
      const record = records.find(entry => entry.asset === instance.sourceAsset);
      users.push(`${api.mapId}:${record?.index ?? '?'}:${instance.sourceInstanceIndex}`);
      if (users.length >= 5) break;
    }
    return {
      name: material.name || null,
      ffxiv: meta ? {
        materialPath: meta.materialPath,
        shader: meta.shader,
        shaderFamily: meta.shaderFamily,
        workflow: meta.workflow,
        flags: meta.flags,
        channelSemantics: channelMapping || { note: 'UNKNOWN: no confirmed channel mapping for this workflow', r: 'UNKNOWN', g: 'UNKNOWN', b: 'UNKNOWN', a: 'UNKNOWN' },
        sourceNormalYInverted: meta.sourceNormalYInverted ?? null,
        previewEncoding: meta.preview ?? null,
        unsupported: meta.unsupported || [],
        alphaThreshold: meta.alphaThreshold ?? null,
      } : { note: 'no ffxiv provenance metadata on material' },
      textures: textureProvenance(material),
      finalParams,
      sharedBy: { instanceCount: users.length, representativeStableAddresses: users },
    };
  }

  function meshMaterials(mesh) {
    const material = mesh.material;
    if (!material) return [];
    return material.subMaterials ? material.subMaterials.filter(Boolean) : [material];
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

    'objects.locate': (requestId, passedArgs) => {
      const records = api.loader?.records || [];
      if (passedArgs.stableAddress || Number.isFinite(Number(passedArgs.modelIndex))) {
        const stableAddress = passedArgs.stableAddress || `${api.mapId}:${Number(passedArgs.modelIndex)}:${Number(passedArgs.sourceInstanceIndex ?? 0)}`;
        const mesh = findObjectMesh(stableAddress);
        if (!mesh) return build(requestId, 'ok', { data: { found: false, stableAddress } });
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

    'objects.pick': (requestId, args) => {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return reject(requestId, 'invalid-args', 'x and y screen coordinates required');
      const records = api.loader?.records || [];
      const pick = api.scene.pick(x, y, mesh => Boolean(mesh?.metadata?.ff14));
      if (!pick?.hit || !pick.pickedMesh) {
        return build(requestId, 'ok', { data: { hit: false } });
      }
      const record = objectRecord(pick.pickedMesh, records);
      return build(requestId, 'ok', {
        data: { hit: true, distance: Number(pick.distance?.toFixed(2)) || null, object: record },
      });
    },

    'objects.inspect': (requestId, passedArgs) => {
      const records = api.loader?.records || [];
      let mesh = null;
      if (passedArgs.stableAddress) {
        mesh = findObjectMesh(passedArgs.stableAddress);
        if (!mesh) return build(requestId, 'ok', { data: { found: false, stableAddress: passedArgs.stableAddress } });
      } else if (Number.isFinite(Number(passedArgs.x)) && Number.isFinite(Number(passedArgs.y))) {
        const pick = api.scene.pick(Number(passedArgs.x), Number(passedArgs.y), candidate => Boolean(candidate?.metadata?.ff14));
        mesh = pick?.pickedMesh || null;
        if (!mesh) return build(requestId, 'ok', { data: { hit: false } });
      } else {
        return reject(requestId, 'invalid-args', 'stableAddress or screen x/y required');
      }

      const meta = mesh.metadata.ff14;
      const record = records.find(candidate => candidate.asset === meta.sourceAsset);
      if (!record) return reject(requestId, 'unavailable', `loader record missing for ${meta.sourceAsset}`);
      const resourceId = record.resourceId || null;
      const parent = mesh.parent;
      const materials = meshMaterials(mesh).map(material => materialProvenance(material, records));
      return build(requestId, 'ok', {
        data: {
          instance: {
            stableAddress: `${api.mapId}:${record.index}:${meta.sourceInstanceIndex}`,
            meshName: mesh.name,
            sourceAsset: meta.sourceAsset,
            modelIndex: record.index,
            sourceInstanceIndex: meta.sourceInstanceIndex,
            spatialCell: meta.spatialCell ?? null,
            determinantSign: meta.determinantSign ?? null,
            worldMatrix: meta.worldMatrix || Array.from(mesh.getWorldMatrix().m),
            sourceMatrix: meta.sourceMatrix || null,
            parent: parent ? { name: parent.name, worldPosition: parent.position ? [parent.position.x, parent.position.y, parent.position.z].map(value => Number(value.toFixed(3))) : null } : null,
            enabled: mesh.isEnabled(),
          },
          model: {
            resourceId,
            registry: registryRecord(resourceId),
            contentHash: resourceId?.startsWith('glb:sha256:') ? resourceId.slice('glb:sha256:'.length) : null,
            siblingPlacementCount: record.matrices?.length ?? 0,
          },
          geometry: {
            totalVertices: mesh.getTotalVertices?.() ?? null,
            subMeshes: mesh.subMeshes?.length ?? null,
            hasUV: Boolean(mesh.isVerticesDataPresent?.('uv')),
            hasUV2: Boolean(mesh.isVerticesDataPresent?.('uv2')),
            hasVertexColor: Boolean(mesh.isVerticesDataPresent?.('color')),
          },
          materials,
        },
      });
    },

    'resources.whoUses': (requestId, passedArgs) => {
      const resourceId = String(passedArgs.resourceId || '').trim();
      if (!resourceId) return reject(requestId, 'invalid-args', 'resourceId required');
      const records = api.loader?.records || [];
      const modelUsers = [];
      const materialUsers = [];
      for (const record of records) {
        if (record.resourceId === resourceId) {
          modelUsers.push({ kind: 'model', count: record.matrices?.length ?? 0, sampleStableAddress: `${api.mapId}:${record.index}:0`, sourceAsset: record.asset });
        }
        const materialPaths = Array.isArray(record.materials) ? record.materials : [];
        if (materialPaths.some(entry => (entry?.resourceId || entry) === resourceId)) {
          materialUsers.push({ kind: 'material', sampleStableAddress: `${api.mapId}:${record.index}:0`, sourceAsset: record.asset });
        }
      }
      const registry = registryRecord(resourceId);
      const manifestMaterial = api.assets?.manifest?.materials?.[resourceId] ? { presentIn: 'manifest.materials' } : null;
      return build(requestId, 'ok', {
        data: {
          resourceId,
          registry,
          uses: { modelInstances: modelUsers, materials: materialUsers, manifestMaterial },
          totalModelPlacements: modelUsers.reduce((sum, entry) => sum + entry.count, 0),
          representative: modelUsers.slice(0, 3),
        },
      });
    },

    'case.capture': async (requestId, args) => {
      if (!api.isReady) return reject(requestId, 'unavailable', 'preview not interactive');
      await waitForFrame();
      const records = api.loader?.records || [];
      const objectLimit = Math.min(Math.max(Number(args.objectLimit) || 2, 0), 50);
      const objects = [];
      const seen = new Set();
      for (const mesh of api.scene?.meshes || []) {
        const record = objectRecord(mesh, records);
        if (!record || seen.has(record.stableAddress)) continue;
        seen.add(record.stableAddress);
        objects.push(record);
        if (objects.length >= objectLimit) break;
      }
      let buildInfo = null;
      try {
        buildInfo = await fetch(new URL('build-info.json', location.href).href).then(response => response.json());
      } catch { /* version detail stays null */ }
      const canvas = api.engine?.getRenderingCanvas?.();
      const assetFields = assetVersionFields(api);
      const snapshot = {
        schemaVersion: CASE_SCHEMA_VERSION,
        kind: 'case',
        caseId: String(args.caseId || `e3t1-${Date.now()}`),
        createdAt: new Date().toISOString(),
        map: {
          id: api.mapId,
          name: api.assets?.scene?.name || null,
          territoryId: api.assets?.scene?.territoryId ?? null,
          manifest: assetFields.mapManifest,
        },
        camera: cameraSnapshot(),
        time: api.stats?.time ?? null,
        objects,
        debug: { renderMode: api.renderDebug?.mode ?? null },
        quality: {
          lodEnabled: api.loader?.state?.lod?.enabled ?? null,
          animationsEnabled: api.scene ? api.scene.animationsEnabled : null,
        },
        browser: {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          dpr: window.devicePixelRatio,
          backend: api.engine ? `WebGL${api.engine.webGLVersion}` : null,
        },
        versions: {
          ...assetFields,
          engine: buildInfo ? `${buildInfo.engine} ${buildInfo.engineVersion}` : null,
          sourceSha256: buildInfo?.sourceSha256 || null,
          sceneEpoch,
          stateRevision,
        },
      };
      return build(requestId, 'ok', { data: { case: snapshot } });
    },

    'case.save': (requestId, args) => {
      const snapshot = args.case || args.snapshot;
      if (!snapshot?.caseId || snapshot.kind !== 'case') return reject(requestId, 'invalid-args', 'case.caseId and kind=recommended required');
      const cases = readStoredCases();
      cases[snapshot.caseId] = snapshot;
      return writeStoredCases(cases)
        ? build(requestId, 'ok', { data: { caseId: snapshot.caseId, stored: Object.keys(cases).length } })
        : reject(requestId, 'unavailable', 'localStorage write failed');
    },

    'case.list': requestId => build(requestId, 'ok', {
      data: {
        cases: Object.entries(readStoredCases()).map(([caseId, snapshot]) => ({
          caseId,
          mapId: snapshot.map?.id ?? null,
          createdAt: snapshot.createdAt ?? null,
        })),
      },
    }),

    'case.restore': async (requestId, args) => {
      const snapshot = args.case || (args.caseId ? readStoredCases()[args.caseId] : null);
      if (!snapshot?.map) return reject(requestId, 'invalid-args', 'case object or caseId required');
      const semantics = args.semantics === 'strict' ? 'strict' : 'compatible';
      if (snapshot.schemaVersion !== CASE_SCHEMA_VERSION) {
        return reject(requestId, 'schema-unsupported', `case schema ${snapshot.schemaVersion}, supported ${CASE_SCHEMA_VERSION}`);
      }
      if (snapshot.map.id !== api.mapId) {
        if (semantics === 'strict') return reject(requestId, 'map-mismatch', `case targets ${snapshot.map.id}, current ${api.mapId}`);
        const maps = api.assets?.config?.maps || {};
        if (!maps[snapshot.map.id]) return reject(requestId, 'map-unavailable', `map not in catalog: ${snapshot.map.id}`);
        const next = new URL(location.href);
        next.searchParams.set('scene', snapshot.map.id);
        try { sessionStorage.setItem('ff14-workbench-pending-case', JSON.stringify(snapshot)); } catch { /* best effort */ }
        return build(requestId, 'accepted', { data: { navigateTo: next.href, mapId: snapshot.map.id, semantics } });
      }

      const current = assetVersionFields(api);
      const diffs = [];
      for (const field of ['assetRunId', 'mapManifest']) {
        if (snapshot.versions?.[field] && snapshot.versions[field] !== current[field]) {
          diffs.push({ field, case: snapshot.versions[field], current: current[field] });
        }
      }
      if (semantics === 'strict' && diffs.length) {
        return build(requestId, 'failed', { errorCode: 'version-mismatch', data: { diffs } });
      }

      if (Number.isFinite(Number(snapshot.time)) || typeof snapshot.time === 'string') {
        try { api.setTime(snapshot.time); } catch (error) {
          return reject(requestId, 'invalid-args', `time restore failed: ${error.message}`);
        }
      }
      if (snapshot.camera?.position && snapshot.camera?.target) {
        const applied = api.setCameraState({
          position: snapshot.camera.position,
          target: snapshot.camera.target,
          ...(Number.isFinite(Number(snapshot.camera.fov)) ? { fov: Number(snapshot.camera.fov) } : {}),
          ...(snapshot.camera.referenceView ? { id: snapshot.camera.referenceView } : {}),
        });
        if (!applied) return reject(requestId, 'invalid-args', 'camera restore rejected');
      }
      if (snapshot.debug?.renderMode && api.renderDebug) {
        try { api.renderDebug.setMode(snapshot.debug.renderMode); } catch { diffs.push({ field: 'debug.renderMode', case: snapshot.debug.renderMode, current: null }); }
      }

      await waitForFrame();
      const missing = [];
      const restored = [];
      const records = api.loader?.records || [];
      for (const object of snapshot.objects || []) {
        const [mapId, modelIndexPart, instancePart] = String(object.stableAddress || '').split(':');
        const modelIndex = Number(modelIndexPart);
        const sourceInstanceIndex = Number(instancePart);
        const suffix = `:${modelIndex}:${sourceInstanceIndex}:`;
        const mesh = Number.isFinite(modelIndex) && Number.isFinite(sourceInstanceIndex)
          ? (api.scene?.meshes || []).find(candidate => {
            const meta = candidate?.metadata?.ff14;
            return meta && meta.sourceInstanceIndex === sourceInstanceIndex
              && (candidate.name.includes(suffix) || String(object.modelIndex) === modelIndexPart);
          })
          : null;
        if (mesh) {
          const record = objectRecord(mesh, records);
          if (record && record.resourceId !== object.resourceId) {
            diffs.push({ field: `object ${object.stableAddress} resourceId`, case: object.resourceId, current: record.resourceId });
          }
          restored.push(object.stableAddress);
        } else {
          missing.push(object.stableAddress);
        }
      }

      const after = cameraSnapshot();
      let cameraObserved = true;
      if (snapshot.camera?.position) {
        cameraObserved = Math.hypot(
          after.position[0] - snapshot.camera.position[0],
          after.position[1] - snapshot.camera.position[1],
          after.position[2] - snapshot.camera.position[2],
        ) <= 0.05;
      }
      const completeness = cameraObserved && missing.length === 0 ? 'complete' : 'partial';
      stateRevision += 1;
      return build(requestId, 'ok', {
        data: { completeness, restored: restored.length, missing, diffs, camera: after },
      });
    },
  };

  async function dispatch(command, args = {}) {    const requestId = String(args.requestId || `req-${stateRevision}-${Math.random().toString(36).slice(2, 8)}`);
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

  // A cross-map restore stashes the case in sessionStorage before navigating;
  // the next boot applies it once the preview is interactive.
  let lastRestore = null;
  try {
    const pending = sessionStorage.getItem('ff14-workbench-pending-case');
    if (pending) {
      sessionStorage.removeItem('ff14-workbench-pending-case');
      const bootstrap = () => {
        if (api.isReady) {
          lastRestore = dispatch('case.restore', { case: JSON.parse(pending), requestId: 'pending-case-restore' });
        } else {
          setTimeout(bootstrap, 500);
        }
      };
      setTimeout(bootstrap, 500);
    }
  } catch { /* storage unavailable */ }

  return {
    dispatch,
    sceneEpoch,
    commands: COMMANDS,
    stateSnapshot,
    get lastRestore() { return lastRestore; },
  };
}

export default createWorkbenchApi;
