import { icon, iconify } from '../dom.js';

const UNKNOWN = '未知';
const hasValue = value => value !== undefined && value !== null && value !== '';
const text = (value, fallback = UNKNOWN) => hasValue(value) ? String(value) : fallback;
const objectValue = value => value && typeof value === 'object' ? value : {};
const point = value => {
  const source = objectValue(value);
  return {
    x: source.x ?? source.X ?? source[0],
    y: source.y ?? source.Y ?? source[1],
    z: source.z ?? source.Z ?? source[2],
  };
};
const positionText = value => {
  const p = point(value);
  return [p.x, p.y, p.z].every(hasValue) ? `${p.x}, ${p.y}, ${p.z}` : UNKNOWN;
};
const compactObject = value => {
  if (!value || typeof value !== 'object') return value;
  if (hasValue(value.level)) return value.level;
  if (hasValue(value.current)) return value.current;
  if (hasValue(value.state)) return value.state;
  if (hasValue(value.status)) return value.status;
  const pairs = Object.entries(value).filter(([, item]) => hasValue(item) && (typeof item !== 'object' || Array.isArray(item))).slice(0, 3);
  return pairs.length ? pairs.map(([key, item]) => `${key}:${item}`).join(' · ') : value;
};

function fieldValue(snapshot, key) {
  const data = snapshot || {};
  const map = objectValue(data.currentMap ?? data.scene ?? data.map);
  const player = objectValue(data.player);
  const character = objectValue(data.character ?? player.character ?? player);
  const appearance = objectValue(character.appearance ?? data.appearance ?? character.appearanceData);
  const animation = objectValue(data.animation ?? character.animation ?? data.animations);
  const mount = objectValue(data.currentMount ?? data.mount?.current ?? data.mount ?? character.mount);
  const environment = objectValue(data.environment);
  const camera = objectValue(data.camera);
  const debug = objectValue(data.debug);
  const cache = objectValue(data.cache ?? data.assets?.cache);
  const load = objectValue(data.load ?? data.loading ?? data.assets?.load);
  const materials = appearance.materialIds ?? appearance.materialIDs ?? appearance.materials ?? character.materialIds ?? character.materialIDs;
  const materialList = Array.isArray(materials) ? materials : [];
  const materialLabel = materialList.length ? `${materialList.slice(0, 3).join(', ')}${materialList.length > 3 ? ` +${materialList.length - 3}` : ''}` : UNKNOWN;
  const currentAnimation = animation.current ?? data.animations?.current ?? data.currentAnimation ?? character.currentAnimation;
  const action = data.currentAction ?? character.actionId ?? animation.action ?? animation.state;
  const profileObject = objectValue(environment.profile);
  const profile = profileObject.zoneId ?? profileObject.id ?? environment.profileId ?? environment.profile ?? data.environmentProfile;
  const lod = debug.lod?.stats ?? debug.lod ?? data.lod?.stats ?? data.lod ?? data.render?.lod;
  const cacheState = cache.state ?? cache.status ?? debug.cache;
  const loadState = load.phase ?? load.phaseId ?? load.state ?? load.status ?? debug.load ?? data.loadingStage;
  const values = {
    map: [map.name ?? map.displayName, map.id ?? map.mapId].filter(hasValue).join(' · ') || data.currentMapId,
    player: positionText(player.position ?? data.playerPosition ?? data.position ?? debug.playerPosition),
    camera: positionText(camera.position ?? data.cameraPosition ?? debug.cameraPosition),
    model: character.modelId ?? character.model ?? data.characterModelId,
    appearance: character.appearanceId ?? appearance.id ?? data.appearanceId,
    materials: materialLabel,
    animation: currentAnimation?.name ?? currentAnimation?.id ?? currentAnimation,
    action: compactObject(action),
    mount: [mount.name ?? mount.id ?? mount.mountId, mount.modelId ?? mount.model].filter(hasValue).join(' · ') || data.mountId,
    movement: compactObject(mount.movementMode ?? mount.state ?? data.movementMode ?? player.movementMode ?? character.movement),
    time: environment.worldTime ?? environment.hour ?? environment.time?.hour ?? data.worldTime?.hour,
    profile,
    lod: compactObject(lod),
    cache: compactObject(cacheState),
    load: compactObject(loadState),
  };
  if (key === 'time' && Number.isFinite(Number(values.time))) {
    const hour = ((Number(values.time) % 24) + 24) % 24;
    values.time = `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`;
  }
  return values[key];
}

export class DebugOverlay {
  constructor({ root = document.body } = {}) {
    this.root = root;
    this.enabled = false;
    this.snapshot = null;
    this.element = document.createElement('aside');
    this.element.className = 'debug-overlay hidden';
    this.element.dataset.debugOverlay = 'true';
    this.element.setAttribute('aria-label', '运行时调试信息');
    this.element.innerHTML = `
      <header><span>${icon('activity')}<strong>DEBUG</strong></span><small data-debug-status>OFF</small></header>
      <dl class="debug-overlay__grid">
        <div><dt>Map</dt><dd data-debug-field="map">${UNKNOWN}</dd></div>
        <div><dt>Player Pos</dt><dd data-debug-field="player">${UNKNOWN}</dd></div>
        <div><dt>Camera Pos</dt><dd data-debug-field="camera">${UNKNOWN}</dd></div>
        <div><dt>Model</dt><dd data-debug-field="model">${UNKNOWN}</dd></div>
        <div><dt>Appearance</dt><dd data-debug-field="appearance">${UNKNOWN}</dd></div>
        <div><dt>Materials</dt><dd data-debug-field="materials" title="">${UNKNOWN}</dd></div>
        <div><dt>Animation</dt><dd data-debug-field="animation">${UNKNOWN}</dd></div>
        <div><dt>Action / Skill</dt><dd data-debug-field="action">${UNKNOWN}</dd></div>
        <div><dt>Mount</dt><dd data-debug-field="mount">${UNKNOWN}</dd></div>
        <div><dt>Movement</dt><dd data-debug-field="movement">${UNKNOWN}</dd></div>
        <div><dt>WorldTime</dt><dd data-debug-field="time">${UNKNOWN}</dd></div>
        <div><dt>Profile</dt><dd data-debug-field="profile">${UNKNOWN}</dd></div>
        <div><dt>LOD</dt><dd data-debug-field="lod">${UNKNOWN}</dd></div>
        <div><dt>Cache</dt><dd data-debug-field="cache">${UNKNOWN}</dd></div>
        <div><dt>Load</dt><dd data-debug-field="load">${UNKNOWN}</dd></div>
      </dl>`;
    this.root.append(this.element);
    iconify(this.element);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.element.classList.toggle('hidden', !this.enabled);
    this.element.dataset.enabled = String(this.enabled);
    this.element.querySelector('[data-debug-status]').textContent = this.enabled ? 'ON' : 'OFF';
    return this;
  }

  get isEnabled() { return this.enabled; }

  update(snapshot = null) {
    if (snapshot && typeof snapshot === 'object') this.snapshot = snapshot;
    if (!this.snapshot) return this;
    const values = {};
    for (const key of ['map', 'player', 'camera', 'model', 'appearance', 'materials', 'animation', 'action', 'mount', 'movement', 'time', 'profile', 'lod', 'cache', 'load']) {
      values[key] = fieldValue(this.snapshot, key);
      const node = this.element.querySelector(`[data-debug-field="${key}"]`);
      if (!node) continue;
      const next = text(values[key]);
      if (node.textContent !== next) node.textContent = next;
      if (next !== UNKNOWN) node.title = next;
      else node.removeAttribute('title');
    }
    return this;
  }
}

export function newDebugOverlay(options) {
  return new DebugOverlay(options);
}
