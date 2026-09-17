/**
 * Normalization boundary for source-derived LGB lighting objects.
 *
 * The generator (tools/map-tools/environment/lgb/) records decoded fields with
 * their Meddle names and keeps anything unmapped as raw evidence.  This module
 * never invents renderer semantics: unknown fields stay labelled, unsupported
 * kinds stay data-only, and every payload must carry provenance before the
 * scene receives it.
 */

const LIGHT_ENGINE_KINDS = new Set(['PointLight', 'SpotLight']);
const ENGINE_PROVENANCE = 'source-derived-lgb-adapter';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, finite(value) ?? 0));
}

function wrapHour(value) {
  const number = finite(value);
  if (number === null) return null;
  return ((number % 24) + 24) % 24;
}

function hexToLinearColor(hex) {
  if (typeof hex !== 'string') return null;
  const text = hex.replace('#', '');
  const normalized = text.length === 3 ? text.split('').map(part => part + part).join('') : text;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16) / 255,
    g: Number.parseInt(normalized.slice(2, 4), 16) / 255,
    b: Number.parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

export function normalizeLightingObjects(input = {}) {
  const source = input.source || input.provenance || null;
  if (!source) {
    return { schemaVersion: input.schemaVersion ?? null, sceneId: input.sceneId || null, accepted: false, reason: 'missing-provenance', lights: [], sky: null, weather: null, unsupported: {} };
  }
  const lights = [];
  const unsupported = {};
  for (const object of Array.isArray(input.lights) ? input.lights : []) {
    const position = object.position && ['x', 'y', 'z'].every(axis => finite(object.position[axis]) !== null)
      ? { x: finite(object.position.x), y: finite(object.position.y), z: finite(object.position.z) }
      : null;
    if (!position) {
      unsupported['light-without-position'] = (unsupported['light-without-position'] || 0) + 1;
      continue;
    }
    const rgb = hexToLinearColor(object.colorHex);
    if (!rgb) {
      unsupported['light-without-color'] = (unsupported['light-without-color'] || 0) + 1;
      continue;
    }
    const kind = object.engineKind === 'SpotLight' && finite(object.angleRadians) !== null ? 'SpotLight' : 'PointLight';
    const light = {
      id: String(object.instanceId ?? object.name ?? lights.length),
      name: typeof object.name === 'string' && object.name.length ? object.name : null,
      kind,
      position,
      color: rgb,
      intensity: Math.max(0, finite(object.intensity) ?? 0),
      range: Math.max(0, finite(object.range) ?? 0),
      attenuation: {
        mode: object.attenuationMode === 'inverseSquare' ? 'inverseSquare' : 'unknown',
      },
      source: { engine: ENGINE_PROVENANCE, instanceId: object.instanceId ?? null, lgbType: object.lgbType ?? null },
    };
    if (kind === 'SpotLight') {
      light.angleRadians = Math.min(Math.PI, Math.max(0.01, finite(object.angleRadians)));
      const direction = object.direction && ['x', 'y', 'z'].every(axis => finite(object.direction[axis]) !== null)
        ? { x: finite(object.direction.x), y: finite(object.direction.y), z: finite(object.direction.z) }
        : { x: 0, y: -1, z: 0 };
      const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
      light.direction = {
        x: direction.x / length,
        y: direction.y / length,
        z: direction.z / length,
      };
    }
    lights.push(light);
  }

  const sky = input.sky && typeof input.sky.assetPath === 'string' && input.sky.assetPath.length
    ? {
        assetPath: input.sky.assetPath,
        decoded: input.sky.decoded === true,
        status: input.sky.decoded === true ? 'available' : 'reference-only',
        source: { engine: ENGINE_PROVENANCE, instanceId: input.sky.instanceId ?? null },
      }
    : null;

  const weather = input.weather && Number.isFinite(Number(input.weather.defaultOwnerId))
    ? {
        defaultOwnerId: Number(input.weather.defaultOwnerId),
        ownerIds: Array.isArray(input.weather.ownerIds)
          ? [...new Set(input.weather.ownerIds.map(id => Number(id)).filter(id => Number.isFinite(id)))].sort((left, right) => left - right)
          : [Number(input.weather.defaultOwnerId)],
        labels: 'UNKNOWN',
        note: 'EnvB section owner ids are preserved as raw ids; no weather label is invented.',
        source: { engine: ENGINE_PROVENANCE },
      }
    : null;

  return {
    schemaVersion: input.schemaVersion ?? 1,
    sceneId: input.sceneId || null,
    accepted: true,
    lights,
    sky,
    weather,
    unsupported,
    provenance: source,
  };
}

export function lightingObjectDiagnostics(normalized, { admitted = null, budget = null } = {}) {
  if (!normalized?.accepted) {
    return { sourceDerivedLights: { accepted: false, reason: normalized?.reason || 'missing-provenance' } };
  }
  return {
    sourceDerivedLights: {
      accepted: true,
      available: normalized.lights.length,
      admitted,
      budget,
      sky: normalized.sky ? normalized.sky.status : 'none',
      weatherOwnerIds: normalized.weather?.ownerIds || null,
      unsupported: { ...normalized.unsupported },
      provenance: normalized.provenance,
    },
  };
}

export { LIGHT_ENGINE_KINDS, clamp01 as clamp01Normalized, wrapHour as wrapHourNormalized };
