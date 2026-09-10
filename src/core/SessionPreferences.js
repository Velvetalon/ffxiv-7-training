const RECENT_SCENE_LIMIT = 8;
const APPEARANCE_FIELDS = [
  'schemaVersion', 'race', 'raceName', 'tribe', 'tribeName', 'sex', 'sexName',
  'ageId', 'height', 'face', 'hair', 'highlightsEnabled', 'skinColor',
  'rightEyeColor', 'hairColor', 'highlightColor', 'facialFeatures',
  'facialFeatureColor', 'eyebrows', 'leftEyeColor', 'eyes', 'smallIris',
  'nose', 'jaw', 'mouth', 'lipColorEnabled', 'lipColor', 'tailEarSize',
  'tailEarType', 'bust', 'facePaint', 'facePaintColor', 'modelFamily',
];
const CAMERA_FIELDS = ['azimuth', 'polar', 'distance', 'zoom', 'mode', 'focusHeight'];
const DEVELOPER_FIELDS = [
  'open', 'overlay', 'tab', 'selectedSceneId', 'selectedAnimationId',
  'selectedSkillId', 'selectedMountId', 'lastCommand',
];

/**
 * Small session-only preferences facade. The caller owns the settings object
 * and persistence mechanism; this class only adds bounded developer state.
 */
export class SessionPreferences {
  constructor(settingsOrOptions = {}, persistCallback = () => {}, options = {}) {
    const objectForm = settingsOrOptions && typeof settingsOrOptions === 'object'
      && ('settings' in settingsOrOptions || 'persist' in settingsOrOptions || 'persistCallback' in settingsOrOptions);
    const config = objectForm ? settingsOrOptions : options;
    this.settings = objectForm ? (settingsOrOptions.settings || {}) : settingsOrOptions;
    this.persistCallback = objectForm
      ? (settingsOrOptions.persist || settingsOrOptions.persistCallback || (() => {}))
      : (typeof persistCallback === 'function' ? persistCallback : () => {});
    this.delayMs = clampInt(config?.delayMs, 180, 0, 2000);
    this.timer = null;
    this.dirty = false;
    this.disposed = false;
    this.settings.recentSceneIds = cleanStringList(this.settings.recentSceneIds, RECENT_SCENE_LIMIT);
    this.flushHandler = () => this.flush();
    this.visibilityHandler = () => { if (document.visibilityState === 'hidden') this.flush(); };
    globalThis.addEventListener?.('pagehide', this.flushHandler);
    globalThis.document?.addEventListener?.('visibilitychange', this.visibilityHandler);
  }

  get lastSceneId() {
    return cleanString(this.settings.lastSceneId);
  }

  get recentSceneIds() {
    return cleanStringList(this.settings.recentSceneIds, RECENT_SCENE_LIMIT);
  }

  get appearance() {
    return cloneValue(this.settings.appearance);
  }

  get camera() {
    return cloneValue(this.settings.camera);
  }

  get developer() {
    return cloneValue(this.settings.developer) || {};
  }

  recordScene(sceneId) {
    const id = cleanString(sceneId);
    if (!id) return this;
    this.settings.lastSceneId = id;
    this.settings.recentSceneIds = [id, ...this.recentSceneIds.filter(value => value !== id)].slice(0, RECENT_SCENE_LIMIT);
    return this.schedule();
  }

  setAppearance(appearance) {
    const value = sanitizeAppearance(appearance);
    if (sameValue(this.settings.appearance || null, value)) return this;
    if (value) this.settings.appearance = value;
    else delete this.settings.appearance;
    return this.schedule();
  }

  setCamera(camera) {
    const value = sanitizeCamera(camera);
    if (sameValue(this.settings.camera || null, Object.keys(value).length ? value : null)) return this;
    if (Object.keys(value).length) this.settings.camera = value;
    else delete this.settings.camera;
    return this.schedule();
  }

  setDeveloper(patch) {
    const current = sanitizeDeveloper(this.settings.developer);
    const next = sanitizeDeveloper({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
    if (sameValue(current, next)) return this;
    this.settings.developer = next;
    return this.schedule();
  }

  snapshot() {
    return {
      lastSceneId: this.lastSceneId,
      recentSceneIds: this.recentSceneIds,
      appearance: this.appearance,
      camera: this.camera,
      developer: this.developer,
    };
  }

  schedule() {
    if (this.disposed) return this;
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (!this.delayMs) {
      this.flush();
      return this;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) {
        this.persistCallback(this.settings);
        this.dirty = false;
      }
    }, this.delayMs);
    return this;
  }

  flush() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.disposed && this.dirty) {
      this.persistCallback(this.settings);
      this.dirty = false;
    }
    return this;
  }

  dispose() {
    globalThis.removeEventListener?.('pagehide', this.flushHandler);
    globalThis.document?.removeEventListener?.('visibilitychange', this.visibilityHandler);
    this.flush();
    this.disposed = true;
    return this;
  }
}

export function sanitizeAppearance(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const field of APPEARANCE_FIELDS) {
    const item = value[field];
    if (typeof item === 'string' || typeof item === 'boolean' || Number.isFinite(item)) result[field] = item;
  }
  if (value.source?.rawCustomize && Array.isArray(value.source.rawCustomize)) {
    result.source = {
      format: cleanString(value.source.format) || 'FFXIV_CHARA_DAT',
      formatVersion: finiteInt(value.source.formatVersion),
      rawCustomize: value.source.rawCustomize.slice(0, 64).map(item => finiteInt(item)).filter(item => item !== null),
    };
  }
  if (value.palette && typeof value.palette === 'object') {
    const palette = {};
    for (const [key, colors] of Object.entries(value.palette).slice(0, 8)) {
      if (Array.isArray(colors)) palette[key] = colors.slice(0, 4).map(item => finiteNumber(item)).filter(item => item !== null);
    }
    if (Object.keys(palette).length) result.palette = palette;
  }
  return Object.keys(result).length ? result : null;
}

function sanitizeCamera(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const field of CAMERA_FIELDS) {
    const item = value[field];
    if (field === 'mode') {
      if (item === 'orbit' || item === 'follow') result[field] = item;
    } else if (Number.isFinite(Number(item))) {
      result[field] = Number(item);
    }
  }
  if (result.distance === undefined && result.zoom !== undefined) result.distance = result.zoom;
  delete result.zoom;
  return result;
}

function sanitizeDeveloper(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const field of DEVELOPER_FIELDS) {
    const item = value[field];
    if (typeof item === 'boolean') result[field] = item;
    else if (typeof item === 'string' && item.trim()) result[field] = item.trim().slice(0, 160);
  }
  return result;
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;
}

function cleanStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))].slice(0, limit);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function clampInt(value, fallback, min, max) {
  const number = finiteInt(value);
  return number === null ? fallback : Math.max(min, Math.min(max, number));
}

function cloneValue(value) {
  if (value === undefined || value === null) return value ?? null;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function sameValue(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return left === right; }
}

export default SessionPreferences;
