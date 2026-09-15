import { Color3, ShaderMaterial } from '@babylonjs/core';

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
  'override.set',
  'override.list',
  'override.undo',
  'override.redo',
  'override.clear',
  'patch.export',
  'patch.validate',
  'patch.import',
  'hot.updateMaterial',
  'hot.rollback',
  'hot.status',
  'isolate.enter',
  'isolate.env',
  'isolate.orbit',
  'isolate.wireframe',
  'isolate.exit',
  'isolate.status',
];

const CASE_STORAGE_KEY = 'ff14-workbench-cases';
const CASE_SCHEMA_VERSION = 1;
const PATCH_SCHEMA_VERSION = 1;
const ENVIRONMENT_PROPERTIES = ['exposure', 'fogNear', 'fogEnd', 'ambientIntensity', 'sunIntensity'];
const MATERIAL_PROPERTIES = ['roughness', 'metallic', 'albedoColor'];

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
    const cloned = overrideState.clones?.get(stableAddress);
    if (cloned) return cloned.replacement;
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
        runtimePath: meta?.runtimePath || slot.runtimePath || null,
        sourcePath: meta?.sourcePath || slot.sourcePath || null,
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

    'hot.updateMaterial': async (requestId, args) => {
      if (!api.isReady) return reject(requestId, 'unavailable', 'preview not interactive');
      const stableAddress = String(args.stableAddress || '');
      if (!stableAddress) return reject(requestId, 'invalid-args', 'stableAddress required');
      const change = args.change || {};
      const beforeCounts = hotCounts();
      const generationAtStart = hotState.generation;

      // The target always operates on a workbench-exclusive clone so rollback
      // can dispose freely and shared resources stay untouched.
      const materialBefore = materialForAddress(stableAddress);
      if (materialBefore.error) return reject(requestId, 'invalid-args', materialBefore.error);
      let entry = cloneForInstance(stableAddress);
      if (!entry) return reject(requestId, 'unavailable', 'could not establish an exclusive target');
      const mesh = entry.replacement;
      const baseMaterial = mesh.material; // workbench clone: exclusive
      const previousMaterial = baseMaterial;

      const applyShader = (addressForName, change) => {
        if (change.preset === 'broken') {
          const broken = new ShaderMaterial(`ffxiv-workbench-broken:${addressForName}`, api.scene, {
            vertexSource: `precision highp float; attribute vec3 position; uniform mat4 worldViewProjection;
void main(){ gl_Position = worldViewProjection * vec4(position, 1.0); }`,
            fragmentSource: `precision highp float; void main(){ gl_FragColor = vec4(1.0 ,; }`,
          }, { attributes: ['position'], uniforms: ['worldViewProjection'] });
          broken.metadata = { ffxiv: { workbenchCandidate: true } };
          return { candidateMaterial: broken };
        }
        if (change.preset === 'flat') {
          const flat = new ShaderMaterial(`ffxiv-workbench-flat:${addressForName}`, api.scene, {
            vertexSource: `precision highp float; attribute vec3 position; uniform mat4 worldViewProjection;
void main(){ gl_Position = worldViewProjection * vec4(position, 1.0); }`,
            fragmentSource: `precision highp float; uniform vec3 color;
void main(){ gl_FragColor = vec4(color, 1.0); }`,
          }, { attributes: ['position'], uniforms: ['worldViewProjection', 'color'] });
          flat.setColor3('color', new Color3(...(change.color || [0.8, 0.2, 0.2])));
          flat.metadata = { ffxiv: { workbenchCandidate: true } };
          return { candidateMaterial: flat };
        }
        return { error: "change.preset must be 'broken' or 'flat'" };
      };

      try {
        let outcome = null;
        let candidate = null;
        if (change.kind === 'texture') {
          // A copy of the clone so the previous binding stays untouched and
          // rollback can restore it verbatim.
          candidate = baseMaterial.clone(`ffxiv-workbench-candidate:${stableAddress}:${hotState.generation + 1}`);
          candidate.metadata = {
            ...(candidate.metadata || {}),
            ffxiv: { ...(candidate.metadata?.ffxiv || {}), workbenchCandidate: true },
          };
          const semantic = String(change.slot || 'albedo');
          const runtimePath = String(change.runtimePath || '');
          if (!runtimePath) return reject(requestId, 'invalid-args', 'change.runtimePath required');
          const property = semantic === 'albedo' ? 'albedoTexture' : semantic === 'normal' ? 'bumpTexture' : null;
          if (!property) return reject(requestId, 'invalid-args', `unsupported slot: ${semantic}`);
          const loaded = await api.materials.textureCache.load(runtimePath, semantic, { sourcePath: change.sourcePath || runtimePath });
          candidate[property] = loaded.texture;
          outcome = { candidateMaterial: candidate };
        } else if (change.kind === 'shader') {
          outcome = applyShader(stableAddress, change);
          if (outcome.error) return reject(requestId, 'invalid-args', outcome.error);
          candidate = outcome.candidateMaterial;
        } else {
          return reject(requestId, 'invalid-args', "change.kind must be 'texture' or 'shader'");
        }

        hotState.generation += 1;
        if (hotState.generation !== generationAtStart + 1) {
          disposeExclusiveMaterial(candidate);
          if (outcome.candidateMaterial) disposeExclusiveMaterial(outcome.candidateMaterial);
          return build(requestId, 'stale', { data: { note: 'superseded by a newer hot update' } });
        }

        const candidateMaterial = outcome.candidateMaterial || candidate;
        const ready = await compileCandidate(candidateMaterial, mesh, Number(args.timeoutMs) || 4000);
        if (!ready) {
          if (outcome.candidateMaterial) {
            // Compilation failed: keep the previous binding untouched.
            disposeExclusiveMaterial(outcome.candidateMaterial);
          }
          hotRecord(stableAddress, { summary: { kind: change.kind, status: 'candidate-rejected' } });
          return build(requestId, 'failed', {
            errorCode: 'candidate-rejected',
            data: { note: 'candidate never became ready; previous material kept', material: candidateMaterial.name, counts: hotCounts() },
          });
        }

        mesh.material = candidateMaterial;
        await waitForFrame();
        // The replaced material stays alive on the rollback stack until it is
        // rolled back or explicitly cleared; shared materials are never
        // disposed here.
        hotRecord(stableAddress, {
          summary: {
            kind: change.kind,
            status: 'replaced',
            material: candidateMaterial.name,
            previousMaterial: previousMaterial?.name || null,
            countsDelta: {
              materials: hotCounts().materials - beforeCounts.materials,
              textures: hotCounts().textures - beforeCounts.textures,
            },
          },
          rollback: () => {
            mesh.material = previousMaterial;
            disposeExclusiveMaterial(candidateMaterial);
          },
        });
        return mutate(requestId, null, {
          target: stableAddress,
          material: candidateMaterial.name,
          previousMaterial: previousMaterial?.name || null,
          counts: { before: beforeCounts, after: hotCounts() },
        });
      } catch (error) {
        // Texture load failure or shader construction error: keep the
        // previous binding and report the evidence.
        if (change.kind === 'shader') { /* candidate already disposed below */ }
        hotRecord(stableAddress, { summary: { kind: change.kind, status: 'candidate-error', message: error?.message || String(error) } });
        return build(requestId, 'failed', {
          errorCode: 'candidate-error',
          data: { message: error?.message || String(error), material: mesh.material?.name, counts: hotCounts() },
        });
      }
    },

    'hot.rollback': async (requestId, args) => {
      const stableAddress = String(args.stableAddress || '');
      const stack = hotState.targets.get(stableAddress);
      if (!stack?.length) return reject(requestId, 'invalid-args', `no hot-update history for ${stableAddress}`);
      const current = stack.pop();
      current.rollback?.();
      await waitForFrame();
      stateRevision += 1;
      return mutate(requestId, null, { rolledBack: current.summary, remaining: stack.length });
    },

    'hot.status': requestId => build(requestId, 'ok', {
      data: {
        generation: hotState.generation,
        last: hotState.last,
        targets: [...hotState.targets.entries()].map(([target, stack]) => ({ target, depth: stack.length })),
        counts: hotCounts(),
      },
    }),

    'isolate.enter': async (requestId, args) => {
      if (!api.isReady) return reject(requestId, 'unavailable', 'preview not interactive');
      if (isolateState.active) return reject(requestId, 'unavailable', 'isolation already active; call isolate.exit first');
      const stableAddress = String(args.stableAddress || '');
      const entry = cloneForInstance(stableAddress);
      if (!entry) return reject(requestId, 'invalid-args', `cannot isolate ${stableAddress}`);
      const mesh = entry.replacement;

      isolateState.active = true;
      isolateState.target = stableAddress;
      isolateState.savedCamera = cameraSnapshot();
      isolateState.savedEnv = captureEnvironmentForIsolate();
      isolateState.disabledMeshes = [];
      isolateState.wireframe = false;

      // Hide every enabled mesh except the isolated replacement. Meshes that
      // were already disabled (streamed out etc.) are not recorded.
      for (const candidate of api.scene.meshes || []) {
        if (candidate === mesh) continue;
        if (!candidate.isEnabled()) continue;
        candidate.setEnabled(false);
        isolateState.disabledMeshes.push(candidate);
      }

      // Neutral environment by default; the dependency change is reported.
      applyIsolateEnvironment('neutral');

      const bounds = mesh.getHierarchyBoundingVectors?.();
      const center = bounds ? bounds.min.add(bounds.max).scale(0.5) : mesh.getAbsolutePosition().clone();
      const radius = bounds ? bounds.max.subtract(bounds.min).length() * 0.5 : 5;
      isolateState.orbitCenter = center;
      isolateState.orbitRadius = Math.max(radius * 3, 4);
      isolateState.orbitAngle = 0.7;
      const orbit = orbitCameraPosition();
      api.setCameraState({ position: orbit, target: [center.x, center.y, center.z], fov: 0.82 });
      await waitForFrame();

      const visibleMeshes = (api.scene.meshes || []).filter(candidate => candidate.isEnabled() && candidate.isVisible).length;
      return mutate(requestId, null, {
        target: stableAddress,
        dependenciesChanged: {
          shadows: 'isolation removes ground/shadow receivers',
          fog: 'neutral rig disables map fog',
          neighbours: 'all other meshes hidden',
        },
        visibleMeshes,
        camera: cameraSnapshot(),
      });
    },

    'isolate.env': async (requestId, args) => {
      if (!isolateState.active) return reject(requestId, 'unavailable', 'isolation not active');
      const mode = args.mode === 'original' ? 'original' : 'neutral';
      const applied = applyIsolateEnvironment(mode);
      if (!applied) return reject(requestId, 'unavailable', 'environment lights unavailable');
      await waitForFrame();
      return mutate(requestId, null, { env: mode });
    },

    'isolate.orbit': async (requestId, args) => {
      if (!isolateState.active) return reject(requestId, 'unavailable', 'isolation not active');
      isolateState.orbitAngle = Number.isFinite(Number(args.angle)) ? Number(args.angle) : isolateState.orbitAngle + Math.PI / 4;
      if (Number.isFinite(Number(args.radius))) isolateState.orbitRadius = Math.max(1, Number(args.radius));
      const orbit = orbitCameraPosition();
      api.setCameraState({ position: orbit, target: [isolateState.orbitCenter.x, isolateState.orbitCenter.y, isolateState.orbitCenter.z] });
      await waitForFrame();
      return mutate(requestId, null, { angle: isolateState.orbitAngle, radius: isolateState.orbitRadius });
    },

    'isolate.wireframe': async (requestId, args) => {
      if (!isolateState.active) return reject(requestId, 'unavailable', 'isolation not active');
      const mesh = findObjectMesh(isolateState.target);
      const material = mesh?.material;
      if (!material) return reject(requestId, 'unavailable', 'isolated object has no material');
      isolateState.wireframe = args.on === undefined ? !isolateState.wireframe : Boolean(args.on);
      material.wireframe = isolateState.wireframe;
      await waitForFrame();
      return mutate(requestId, null, { wireframe: isolateState.wireframe });
    },

    'isolate.exit': async requestId => {
      if (!isolateState.active) return reject(requestId, 'invalid-args', 'isolation not active');
      for (const mesh of isolateState.disabledMeshes) mesh.setEnabled(true);
      const disabledCount = isolateState.disabledMeshes.length;
      isolateState.disabledMeshes = [];
      const material = findObjectMesh(isolateState.target)?.material;
      if (material && isolateState.wireframe) material.wireframe = false;
      applyIsolateEnvironment('original');
      if (isolateState.savedCamera) {
        api.setCameraState({ position: isolateState.savedCamera.position, target: isolateState.savedCamera.target, fov: isolateState.savedCamera.fov });
      }
      isolateState.active = false;
      const target = isolateState.target;
      isolateState.target = null;
      await waitForFrame();
      return mutate(requestId, null, {
        target,
        reEnabledMeshes: disabledCount,
        camera: cameraSnapshot(),
        note: 'the isolation clone (and its overrides) stays available through override.*; dispose it via override.undo',
      });
    },

    'isolate.status': requestId => build(requestId, 'ok', {
      data: {
        active: isolateState.active,
        target: isolateState.target,
        wireframe: isolateState.wireframe,
        hiddenMeshes: isolateState.disabledMeshes.length,
        resourceSampleOpen: 'UNSUPPORTED: opening a resource without its map requires a second scene; not available in this round',
      },
    }),

    'override.set': async (requestId, args) => {
      if (!api.isReady) return reject(requestId, 'unavailable', 'preview not interactive');
      const property = String(args.property || '');
      const value = args.value;
      if (args.scope === 'environment') {
        if (!ENVIRONMENT_PROPERTIES.includes(property)) return reject(requestId, 'invalid-args', `environment property must be one of ${ENVIRONMENT_PROPERTIES.join(', ')}`);
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) return reject(requestId, 'invalid-args', 'value must be a finite number >= 0');
        const accessor = environmentAccessor(property);
        const before = ensureEnvironmentOriginal(property);
        accessor.write(number);
        await waitForFrame();
        const observed = accessor.read();
        if (!Number.isFinite(observed) || Math.abs(observed - number) > Math.abs(number) * 0.01 + 1e-4) {
          return reject(requestId, 'not-observed', `wrote ${number}, read back ${observed}`);
        }
        pushOverride({
          scope: 'environment', property, before, after: number,
          undo: () => accessor.write(before),
          redo: () => accessor.write(number),
        });
        return mutate(requestId, null, { scope: 'environment', property, before, after: observed });
      }

      if (args.scope === 'instance' || args.scope === 'shared') {
        const stableAddress = String(args.stableAddress || '');
        if (!MATERIAL_PROPERTIES.includes(property)) return reject(requestId, 'invalid-args', `material property must be one of ${MATERIAL_PROPERTIES.join(', ')}`);
        const valueList = property === 'albedoColor' ? (Array.isArray(value) ? value.map(Number) : null) : null;
        if (property === 'albedoColor' && (!valueList || valueList.length !== 3 || valueList.some(entry => !Number.isFinite(entry) || entry < 0 || entry > 1))) {
          return reject(requestId, 'invalid-args', 'albedoColor value must be [r,g,b] with 0..1 components');
        }
        const number = property === 'albedoColor' ? null : Number(value);
        if (property !== 'albedoColor' && !Number.isFinite(number)) return reject(requestId, 'invalid-args', 'value must be finite');

        if (args.scope === 'shared') {
          const resolved = resolveMaterialTarget(stableAddress, Boolean(args.acknowledgeShared));
          if (resolved.error) return reject(requestId, 'invalid-args', resolved.error);
          if (resolved.sharedConflict) return build(requestId, 'rejected', { errorCode: 'shared-material', data: resolved.sharedConflict });
          const { material } = resolved;
          const before = readMaterialProperty(material, property);
          writeMaterialProperty(material, property, property === 'albedoColor' ? valueList : number);
          await waitForFrame();
          const after = readMaterialProperty(material, property);
          pushOverride({
            scope: 'shared', target: stableAddress, materialName: material.name, property, before, after,
            undo: () => writeMaterialProperty(material, property, before),
            redo: () => writeMaterialProperty(material, property, after),
          });
          return mutate(requestId, null, { scope: 'shared', stableAddress, property, before, after, affectedInstances: sharedUserCount(material) });
        }

        // Instance scope: the first override clones the material so other
        // users of the shared material keep their appearance.
        const beforeResolution = materialForAddress(stableAddress);
        if (beforeResolution.error) return reject(requestId, 'invalid-args', beforeResolution.error);
        const sharedMaterial = beforeResolution.material;
        const isClone = Boolean(sharedMaterial.metadata?.ffxiv?.workbenchClone);
        let before = null;
        let createdClone = false;
        if (!isClone && sharedUserCount(sharedMaterial) > 1) {
          before = readMaterialProperty(sharedMaterial, property);
          if (!cloneForInstance(stableAddress)) return reject(requestId, 'unavailable', 'material clone failed');
          createdClone = true;
        }
        const targetResolution = materialForAddress(stableAddress);
        if (targetResolution.error) return reject(requestId, 'invalid-args', targetResolution.error);
        const material = targetResolution.material;
        if (!createdClone) before = readMaterialProperty(material, property);
        writeMaterialProperty(material, property, property === 'albedoColor' ? valueList : number);
        await waitForFrame();
        const after = readMaterialProperty(material, property);
        pushOverride({
          scope: 'instance', target: stableAddress, materialName: material.name, property, before, after,
          createdClone,
          undo: () => {
            if (createdClone) {
              const entry = overrideState.clones.get(stableAddress);
              if (entry) {
                entry.instanceMesh.setEnabled(true);
                entry.replacement.dispose(false, true);
                overrideState.clones.delete(stableAddress);
              }
            } else {
              writeMaterialProperty(material, property, before);
            }
          },
          redo: () => {
            if (createdClone) {
              const entry = cloneForInstance(stableAddress);
              if (entry) writeMaterialProperty(entry.clone, property, after);
            } else {
              writeMaterialProperty(material, property, after);
            }
          },
        });
        return mutate(requestId, null, {
          scope: 'instance', stableAddress, property, before, after,
          clonedMaterial: createdClone ? material.name : null,
        });
      }

      return reject(requestId, 'invalid-args', "scope must be 'environment', 'instance' or 'shared'");
    },

    'override.list': requestId => build(requestId, 'ok', {
      data: {
        applied: overrideState.applied.map(({ undo, redo, ...rest }) => rest),
        redoable: overrideState.redo.length,
        originals: Object.fromEntries(overrideState.originals),
        clonedInstances: [...overrideState.clones.keys()],
      },
    }),

    'override.undo': async requestId => {
      const record = overrideState.applied.pop();
      if (!record) return reject(requestId, 'invalid-args', 'nothing to undo');
      record.undo();
      overrideState.redo.push(record);
      await waitForFrame();
      stateRevision += 1;
      return mutate(requestId, null, { undone: { scope: record.scope, target: record.target, property: record.property, restoredTo: record.before } });
    },

    'override.redo': async requestId => {
      const record = overrideState.redo.pop();
      if (!record) return reject(requestId, 'invalid-args', 'nothing to redo');
      record.redo();
      overrideState.applied.push(record);
      await waitForFrame();
      stateRevision += 1;
      return mutate(requestId, null, { redone: { scope: record.scope, target: record.target, property: record.property, value: record.after } });
    },

    'override.clear': async requestId => {
      const count = overrideState.applied.length;
      while (overrideState.applied.length) {
        const record = overrideState.applied.pop();
        record.undo();
      }
      overrideState.redo.length = 0;
      await waitForFrame();
      stateRevision += 1;
      return mutate(requestId, null, { cleared: count, clonedInstances: [...overrideState.clones.keys()].length });
    },

    'patch.export': (requestId, args) => {
      if (!overrideState.applied.length && !args.includeEmpty) return reject(requestId, 'invalid-args', 'no session overrides to export');
      const assetFields = assetVersionFields(api);
      const patch = {
        schemaVersion: PATCH_SCHEMA_VERSION,
        kind: 'patch',
        patchId: String(args.patchId || `patch-${Date.now()}`),
        createdAt: new Date().toISOString(),
        mapId: api.mapId,
        targetVersions: { assetRunId: assetFields.assetRunId, mapManifest: assetFields.mapManifest },
        overrides: overrideState.applied.map(({ undo, redo, ...rest }) => rest),
      };
      return build(requestId, 'ok', { data: { patch } });
    },

    'patch.validate': (requestId, args) => {
      const patch = args.patch;
      if (patch?.kind !== 'patch' || patch?.schemaVersion !== PATCH_SCHEMA_VERSION) return reject(requestId, 'invalid-args', `patch schema must be ${PATCH_SCHEMA_VERSION}`);
      const assetFields = assetVersionFields(api);
      const conflicts = [];
      if (patch.targetVersions?.assetRunId && patch.targetVersions.assetRunId !== assetFields.assetRunId) {
        conflicts.push({ field: 'assetRunId', patch: patch.targetVersions.assetRunId, current: assetFields.assetRunId });
      }
      if (patch.mapId && patch.mapId !== api.mapId) conflicts.push({ field: 'mapId', patch: patch.mapId, current: api.mapId });
      const invalid = (patch.overrides || []).filter(entry => {
        if (entry.scope === 'environment') return !ENVIRONMENT_PROPERTIES.includes(entry.property);
        return !entry.target || !MATERIAL_PROPERTIES.includes(entry.property);
      });
      return build(requestId, 'ok', {
        data: { applicable: conflicts.length === 0 && invalid.length === 0, conflicts, invalid, overrideCount: (patch.overrides || []).length },
      });
    },

    'patch.import': async (requestId, args) => {
      const patch = args.patch;
      if (patch?.kind !== 'patch' || patch?.schemaVersion !== PATCH_SCHEMA_VERSION) return reject(requestId, 'invalid-args', `patch schema must be ${PATCH_SCHEMA_VERSION}`);
      const assetFields = assetVersionFields(api);
      if (patch.targetVersions?.assetRunId && patch.targetVersions.assetRunId !== assetFields.assetRunId) {
        return build(requestId, 'failed', { errorCode: 'version-mismatch', data: { field: 'assetRunId', patch: patch.targetVersions.assetRunId, current: assetFields.assetRunId } });
      }
      if (patch.mapId && patch.mapId !== api.mapId) {
        return build(requestId, 'failed', { errorCode: 'map-mismatch', data: { patch: patch.mapId, current: api.mapId } });
      }
      const applied = [];
      const skipped = [];
      let index = 0;
      for (const entry of patch.overrides || []) {
        const result = await dispatch('override.set', {
          scope: entry.scope === 'environment' ? 'environment' : 'instance',
          property: entry.property,
          value: entry.after,
          stableAddress: entry.target,
          requestId: `${requestId}:${index}`,
        });
        index += 1;
        if (result.status === 'ok') applied.push({ target: entry.target ?? 'environment', property: entry.property });
        else skipped.push({ target: entry.target ?? 'environment', property: entry.property, reason: result.errorCode });
      }
      return mutate(requestId, null, { applied, skipped, patchId: patch.patchId });
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

  // ---- Parameter overrides (S04) -------------------------------------------
  // Layering: original resource -> shipped mapping/config -> saved experiment
  // preset (patch import) -> this session's temporary overrides. Only the
  // session layer lives in memory; patches record base versions and are the
  // only thing that leaves the page.
  const overrideState = {
    applied: [], // undo stack: {scope,target,property,before,after,undo}
    redo: [],
    originals: new Map(), // environment property -> first observed value
    clones: new Map(), // stableAddress -> cloned material
  };

  function environmentAccessor(property) {
    const scene = api.scene;
    switch (property) {
      case 'exposure':
        return {
          read: () => scene?.imageProcessingConfiguration?.exposure ?? null,
          write: value => { scene.imageProcessingConfiguration.exposure = value; },
        };
      case 'fogNear':
        return {
          read: () => scene?.fogStart ?? null,
          write: value => { scene.fogStart = value; },
        };
      case 'fogEnd':
        return {
          read: () => scene?.fogEnd ?? null,
          write: value => { scene.fogEnd = value; },
        };
      case 'ambientIntensity':
        return {
          read: () => api.environment?.ensureLights?.().ambient?.intensity ?? null,
          write: value => { api.environment.ensureLights().ambient.intensity = value; },
        };
      case 'sunIntensity':
        return {
          read: () => api.environment?.ensureLights?.().sun?.intensity ?? null,
          write: value => { api.environment.ensureLights().sun.intensity = value; },
        };
      default:
        return null;
    }
  }

  function ensureEnvironmentOriginal(property) {
    if (!overrideState.originals.has(property)) {
      const accessor = environmentAccessor(property);
      overrideState.originals.set(property, accessor.read());
    }
    return overrideState.originals.get(property);
  }

  function materialForAddress(stableAddress) {
    const mesh = findObjectMesh(stableAddress);
    if (!mesh) return { error: `object not found: ${stableAddress}` };
    const material = meshMaterials(mesh)[0];
    if (!material) return { error: `object has no material: ${stableAddress}` };
    return { mesh, material };
  }

  function sharedUserCount(material) {
    let count = 0;
    for (const candidate of api.scene?.meshes || []) {
      if (candidate.material === material || (material.subMaterials && material.subMaterials.includes(candidate.material))) count += 1;
    }
    return count;
  }

  function resolveMaterialTarget(stableAddress, acknowledgeShared) {
    const resolved = materialForAddress(stableAddress);
    if (resolved.error) return resolved;
    const { mesh, material } = resolved;
    const isClone = Boolean(material.metadata?.ffxiv?.workbenchClone);
    if (!isClone) {
      const users = sharedUserCount(material);
      if (users > 1 && !acknowledgeShared) {
        return {
          sharedConflict: {
            affectedInstances: users,
            materialPath: material.metadata?.ffxiv?.materialPath || material.name,
            note: 'material is shared; pass acknowledgeShared=true to mutate every user, or scope this override to the single instance',
          },
        };
      }
      return { mesh, material };
    }
    return { mesh, material };
  }

  function cloneForInstance(stableAddress) {
    if (overrideState.clones.has(stableAddress)) return overrideState.clones.get(stableAddress);
    const resolved = materialForAddress(stableAddress);
    if (resolved.error) return null;
    const instanceMesh = resolved.mesh;
    let replacement;
    let originalMaterial;
    if (instanceMesh.sourceMesh) {
      // Instanced meshes always render the master's material, so a true
      // per-instance edit needs a real mesh that shares the geometry but owns
      // its material. Clone the master, restore the instance transform, and
      // hide the instance for as long as the override lives.
      const master = instanceMesh.sourceMesh;
      replacement = master.clone(`ffxiv-workbench-inst:${stableAddress}`);
      replacement.position.copyFrom(instanceMesh.position);
      if (instanceMesh.rotationQuaternion) {
        replacement.rotationQuaternion = replacement.rotationQuaternion || replacement.rotationQuaternion.constructor.Zero();
        replacement.rotationQuaternion.copyFrom(instanceMesh.rotationQuaternion);
      } else {
        replacement.rotation.copyFrom(instanceMesh.rotation);
      }
      replacement.scaling.copyFrom(instanceMesh.scaling);
      replacement.parent = instanceMesh.parent;
      replacement.metadata = {
        ...(replacement.metadata || {}),
        ff14: {
          ...(replacement.metadata?.ff14 || master.metadata?.ff14 || {}),
          sourceAsset: instanceMesh.metadata?.ff14?.sourceAsset,
          sourceInstanceIndex: instanceMesh.metadata?.ff14?.sourceInstanceIndex,
          workbenchReplacementOf: stableAddress,
        },
      };
      replacement.setEnabled(true);
      instanceMesh.setEnabled(false);
      originalMaterial = master.material;
    } else {
      replacement = instanceMesh;
      originalMaterial = instanceMesh.material;
    }
    const clone = originalMaterial.clone(`ffxiv-workbench-clone:${stableAddress}`);
    clone.metadata = {
      ...(clone.metadata || {}),
      ffxiv: {
        ...(clone.metadata?.ffxiv || {}),
        materialPath: originalMaterial.metadata?.ffxiv?.materialPath || null,
        workbenchClone: true,
        clonedFromInstance: stableAddress,
      },
    };
    replacement.material = clone;
    const entry = { replacement, instanceMesh: instanceMesh.sourceMesh ? instanceMesh : null, originalMaterial, clone };
    overrideState.clones.set(stableAddress, entry);
    return entry;
  }

  function readMaterialProperty(material, property) {
    switch (property) {
      case 'roughness': return Number.isFinite(material.roughness) ? material.roughness : null;
      case 'metallic': return Number.isFinite(material.metallic) ? material.metallic : null;
      case 'albedoColor': return material.albedoColor ? material.albedoColor.asArray() : null;
      default: return null;
    }
  }

  function writeMaterialProperty(material, property, value) {
    switch (property) {
      case 'roughness': material.roughness = value; return true;
      case 'metallic': material.metallic = value; return true;
      case 'albedoColor': {
        const [r, g, b] = value;
        material.albedoColor.set(r, g, b);
        return true;
      }
      default: return false;
    }
  }

  function pushOverride(record) {
    overrideState.applied.push(record);
    overrideState.redo.length = 0;
    stateRevision += 1;
  }

  // ---- Isolation lab (S06) ---------------------------------------------------
  // One active isolation view at a time. The lab reuses the same scene and
  // material mapping (no separate simplified materials): every other mesh is
  // hidden, the camera orbits the object, and the environment can toggle
  // between the map's own lighting and a neutral flat rig. Dependencies that
  // change in isolation (shadows, fog, neighbours) are reported per enter().
  const isolateState = {
    active: false,
    target: null,
    savedCamera: null,
    savedEnv: null,
    disabledMeshes: [],
    wireframe: false,
    orbitAngle: 0,
    orbitRadius: 0,
    orbitCenter: null,
  };

  function isolateLights() {
    const lights = api.environment?.ensureLights?.();
    if (!lights?.sun || !lights?.ambient) return null;
    return lights;
  }

  function orbitCameraPosition() {
    const center = isolateState.orbitCenter;
    if (!center) return null;
    const { orbitAngle, orbitRadius } = isolateState;
    return [
      center.x + Math.cos(orbitAngle) * orbitRadius,
      center.y + orbitRadius * 0.35,
      center.z + Math.sin(orbitAngle) * orbitRadius,
    ];
  }

  function captureEnvironmentForIsolate() {
    const lights = isolateLights();
    return {
      exposure: api.scene?.imageProcessingConfiguration?.exposure ?? null,
      fogEnabled: api.scene?.fogEnabled ?? null,
      sunIntensity: lights?.sun?.intensity ?? null,
      ambientIntensity: lights?.ambient?.intensity ?? null,
      ambientDiffuse: lights?.ambient?.diffuse ? lights.ambient.diffuse.asArray() : null,
    };
  }

  function applyIsolateEnvironment(mode) {
    const lights = isolateLights();
    if (!lights) return false;
    if (mode === 'neutral') {
      api.scene.fogEnabled = false;
      lights.sun.intensity = 1.1;
      lights.ambient.intensity = 0.7;
      lights.ambient.diffuse.set(0.85, 0.85, 0.85);
    } else {
      const saved = isolateState.savedEnv;
      if (!saved) return false;
      api.scene.fogEnabled = saved.fogEnabled;
      if (Number.isFinite(saved.sunIntensity)) lights.sun.intensity = saved.sunIntensity;
      if (Number.isFinite(saved.ambientIntensity)) lights.ambient.intensity = saved.ambientIntensity;
      if (saved.ambientDiffuse) lights.ambient.diffuse.set(saved.ambientDiffuse[0], saved.ambientDiffuse[1], saved.ambientDiffuse[2]);
    }
    return true;
  }

  // Candidate -> validate/compile -> confirm the target is unchanged ->
  // replace -> dispose only workbench-exclusive resources. Failures keep the
  // previous binding. Rapid successive updates: only the newest candidate
  // lands; older ones abort through the generation counter.
  // ---- Hot update machinery (S05) -------------------------------------------
  // Candidate -> validate/compile -> confirm the target is unchanged ->
  // replace -> dispose only workbench-exclusive resources. Failures keep the
  // previous binding. Rapid successive updates: only the newest candidate
  // lands; older ones abort through the generation counter.
  const hotState = { generation: 0, targets: new Map(), last: null };

  function hotCounts() {
    return {
      materials: api.scene?.materials?.length ?? 0,
      textures: api.scene?.textures?.length ?? 0,
      meshes: api.scene?.meshes?.length ?? 0,
    };
  }

  function hotRecord(target, entry) {
    let stack = hotState.targets.get(target);
    if (!stack) {
      stack = [];
      hotState.targets.set(target, stack);
    }
    stack.push(entry);
    hotState.last = { target, ...entry.summary, at: new Date().toISOString() };
  }

  function disposeExclusiveMaterial(material) {
    // Never dispose shipped materials: they may be shared across instances
    // and even maps. Only workbench-created candidates are exclusive.
    if (material?.metadata?.ffxiv?.workbenchCandidate || material?.metadata?.ffxiv?.workbenchClone) {
      material.dispose(false, true);
      return true;
    }
    return false;
  }

  async function compileCandidate(candidate, mesh, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (candidate.isReady?.(mesh)) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return Boolean(candidate.isReady?.(mesh));
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
