import { escape, icon, iconify } from '../dom.js';

const UNKNOWN = '未知';
const TAB_IDS = ['map', 'character', 'animation', 'skill', 'mount', 'audio', 'environment'];
const TAB_LABELS = {
  map: '地图',
  character: '角色',
  animation: '动作',
  skill: '技能',
  mount: '坐骑',
  audio: '音频',
  environment: '环境',
};

const hasValue = value => value !== undefined && value !== null && value !== '';
const text = (value, fallback = UNKNOWN) => hasValue(value) ? String(value) : fallback;
const objectValue = (value, fallback = {}) => value && typeof value === 'object' ? value : fallback;
const arrayValue = value => Array.isArray(value) ? value : [];
const idOf = item => typeof item === 'string' ? item : text(item?.id ?? item?.mapId ?? item?.mapID ?? item?.skillId ?? item?.skillID ?? item?.sourceSkillId ?? item?.sourceSkillID ?? item?.mountId ?? item?.mountID ?? item?.resourceId ?? item?.resourceID, '');
const labelOf = item => typeof item === 'string' ? item : text(item?.name ?? item?.displayName ?? item?.label ?? idOf(item), UNKNOWN);
const json = value => {
  if (!hasValue(value)) return UNKNOWN;
  try { return JSON.stringify(value, null, 2); } catch { return UNKNOWN; }
};

function resolveRuntime(controller) {
  return controller?.developerRuntime || controller?.runtime || controller || {};
}

function collection(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([id, item]) => item && typeof item === 'object' ? ({ id, ...item }) : ({ id, name: item }));
}

function readDeveloperState(controller) {
  const direct = controller?.developer?.state;
  if (direct && typeof direct === 'object') return direct;
  const preferenceState = controller?.preferences?.developer;
  if (preferenceState && typeof preferenceState === 'object' && ('open' in preferenceState || 'overlay' in preferenceState || 'tab' in preferenceState)) return preferenceState;
  const nested = controller?.preferences?.developer?.state;
  if (nested && typeof nested === 'object') return nested;
  try {
    const stored = controller?.preferences?.get?.('developer.state') ?? controller?.getPreference?.('developer.state');
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

function updateOptions(select, items, placeholder = '暂无数据') {
  const normalized = items.filter(item => idOf(item)).map(item => ({ id: idOf(item), label: labelOf(item) }));
  const signature = JSON.stringify(normalized);
  if (select.dataset.optionsSignature === signature) return;
  const selected = select.value;
  select.dataset.optionsSignature = signature;
  select.innerHTML = normalized.length
    ? normalized.map(item => `<option value="${escape(item.id)}">${escape(item.label)} · ${escape(item.id)}</option>`).join('')
    : `<option value="">${escape(placeholder)}</option>`;
  if (normalized.some(item => item.id === selected)) select.value = selected;
}

function point(value) {
  const source = objectValue(value);
  return {
    x: source.x ?? source.X ?? source[0],
    y: source.y ?? source.Y ?? source[1],
    z: source.z ?? source.Z ?? source[2],
  };
}

export class DeveloperPanel {
  constructor({ root = document.body, controller = {}, onStateChange } = {}) {
    this.root = root;
    this.controller = controller;
    this.runtime = resolveRuntime(controller);
    this.onStateChange = onStateChange;
    const stored = readDeveloperState(controller);
    this.state = {
      open: Boolean(stored.open),
      tab: TAB_IDS.includes(stored.tab) ? stored.tab : 'map',
      overlay: Boolean(stored.overlay),
    };
    this.snapshot = null;
    this._maps = [];
    this._recentMaps = [];
    this._skills = [];
    this._mounts = [];
    this._animations = [];
    this._bgm = [];
    this._sfx = [];
    this._currentMapId = null;
    this._mapPositionDraftDirty = false;
    this._environmentParamDrafts = new Set();
    this._last = {};
    this._busy = 0;
    this.element = document.createElement('aside');
    this.element.className = 'developer-panel hidden';
    this.element.dataset.developerPanel = 'true';
    this.element.setAttribute('aria-label', '开发者验收面板');
    this._renderShell();
    this._bind();
    this.root.append(this.element);
    iconify(this.element);
    this._applyState(false);
  }

  _renderShell() {
    this.element.innerHTML = `
      <header class="developer-panel__header">
        <div class="developer-panel__title"><span class="developer-panel__mark">${icon('settings-2')}</span><div><strong>开发者工具</strong><small>VALIDATION RUNTIME</small></div></div>
        <div class="developer-panel__header-actions">
          <button class="icon-button" type="button" data-dev-overlay-toggle title="切换调试浮层" aria-label="切换调试浮层">${icon('activity')}</button>
          <button class="icon-button" type="button" data-dev-close title="关闭开发者面板" aria-label="关闭开发者面板">${icon('x')}</button>
        </div>
      </header>
      <nav class="developer-tabs" data-dev-tabs role="tablist" aria-label="开发者工具分类">
        ${TAB_IDS.map((id, index) => `<button type="button" role="tab" data-dev-tab="${id}" aria-selected="${index === 0}" title="${TAB_LABELS[id]}">${icon({ map: 'map', character: 'user-round', animation: 'activity', skill: 'zap', mount: 'anchor', audio: 'waves', environment: 'sun' }[id])}<span>${TAB_LABELS[id]}</span></button>`).join('')}
      </nav>
      <div class="developer-panel__body">
        <section class="developer-tab-panel" data-dev-tab-panel="map" role="tabpanel">
          <div class="developer-section-heading"><div><small>MAP RUNTIME</small><h2>地图快速检查</h2></div><output data-dev-field="map.current">${UNKNOWN}</output></div>
          <label class="developer-control developer-search"><span>${icon('search')}<b>搜索地图</b></span><input type="search" data-dev-map-search placeholder="中文名或 Map ID" autocomplete="off"></label>
          <div class="developer-results" data-dev-map-results role="listbox" aria-label="地图搜索结果"></div>
          <label class="developer-control"><span>快速切换</span><select data-dev-map-select><option value="">暂无地图数据</option></select></label>
          <div class="developer-subheading"><span>最近地图</span><small data-dev-map-recent-count></small></div>
          <div class="developer-chip-list" data-dev-map-recent></div>
          <div class="developer-subheading"><span>传送位置</span><small>世界坐标</small></div>
          <div class="developer-grid developer-grid--3 developer-coordinates">
            <label><span>X</span><input type="number" step="0.1" data-dev-map-x placeholder="未知"></label>
            <label><span>Y</span><input type="number" step="0.1" data-dev-map-y placeholder="未知"></label>
            <label><span>Z</span><input type="number" step="0.1" data-dev-map-z placeholder="未知"></label>
          </div>
          <button class="command developer-command" type="button" data-dev-command="map.teleport">${icon('locate-fixed')}<span>传送到指定位置</span></button>
        </section>

        <section class="developer-tab-panel hidden" data-dev-tab-panel="character" role="tabpanel">
          <div class="developer-section-heading"><div><small>CHARACTER RUNTIME</small><h2>外观与解析结果</h2></div><output data-dev-field="character.model">${UNKNOWN}</output></div>
          <div class="developer-grid developer-grid--2 developer-data-grid">
            <div><span>Race</span><output data-dev-field="character.race">${UNKNOWN}</output></div>
            <div><span>Sex</span><output data-dev-field="character.sex">${UNKNOWN}</output></div>
            <div><span>Face</span><output data-dev-field="character.face">${UNKNOWN}</output></div>
            <div><span>Hair</span><output data-dev-field="character.hair">${UNKNOWN}</output></div>
            <div class="developer-data-grid__wide"><span>Material IDs</span><output data-dev-field="character.materials" class="developer-wrap" title=""></output></div>
          </div>
          <div class="developer-subheading"><span>CharacterAppearanceData</span><small>只读</small></div>
          <textarea class="developer-json" data-dev-character-json readonly spellcheck="false" aria-label="当前 CharacterAppearanceData">${UNKNOWN}</textarea>
          <div class="developer-actions developer-actions--split">
            <button class="command" type="button" data-dev-command="character.reload">${icon('refresh-cw')}<span>重新加载角色</span></button>
            <label class="command developer-file"><span>${icon('download')}<span>导入 DAT</span></span><input type="file" accept=".dat,application/octet-stream" data-dev-dat></label>
          </div>
        </section>

        <section class="developer-tab-panel hidden" data-dev-tab-panel="animation" role="tabpanel">
          <div class="developer-section-heading"><div><small>ANIMATION / ACTION</small><h2>动作绑定检查</h2></div><output data-dev-field="animation.current">${UNKNOWN}</output></div>
          <div class="developer-quick-actions" data-dev-animation-presets>
            ${['idle', 'walk', 'run', 'jump'].map(id => `<button type="button" data-dev-animation-preset="${id}" title="播放 ${id}">${icon('play')}<span>${id[0].toUpperCase() + id.slice(1)}</span></button>`).join('')}
          </div>
          <label class="developer-control"><span>已解析动作</span><select data-dev-animation-select><option value="">暂无动作数据</option></select></label>
          <div class="developer-grid developer-grid--2"><label><span>其他 Animation ID</span><input type="text" data-dev-animation-id placeholder="输入实际 ID"></label><button class="command" type="button" data-dev-command="animation.play">${icon('play')}<span>直接播放</span></button></div>
          <div class="developer-data-grid developer-grid--2 developer-animation-info"><div><span>State</span><output data-dev-field="animation.status">${UNKNOWN}</output></div><div><span>Resource ID</span><output data-dev-field="animation.resource">${UNKNOWN}</output></div></div>
        </section>

        <section class="developer-tab-panel hidden" data-dev-tab-panel="skill" role="tabpanel">
          <div class="developer-section-heading"><div><small>SKILL DEFINITION</small><h2>技能表现直触</h2></div><output data-dev-field="skill.count">0</output></div>
          <label class="developer-control"><span>已解析 Skill</span><select data-dev-skill-select><option value="">暂无技能数据</option></select></label>
          <dl class="developer-definition-list">
            <div><dt>SkillID</dt><dd data-dev-field="skill.id">${UNKNOWN}</dd></div>
            <div><dt>AnimationID</dt><dd data-dev-field="skill.animation">${UNKNOWN}</dd></div>
            <div><dt>VFXID</dt><dd data-dev-field="skill.vfx">${UNKNOWN}</dd></div>
            <div><dt>SoundID</dt><dd data-dev-field="skill.sound">${UNKNOWN}</dd></div>
          </dl>
          <button class="command developer-command" type="button" data-dev-command="skill.trigger">${icon('zap')}<span>直接触发技能表现</span></button>
          <small class="developer-hint">绕过普通输入与战斗流程，仅调用解析后的表现链路。</small>
        </section>

        <section class="developer-tab-panel hidden" data-dev-tab-panel="mount" role="tabpanel">
          <div class="developer-section-heading"><div><small>MOUNT RUNTIME</small><h2>坐骑状态与动作</h2></div><output data-dev-field="mount.state">${UNKNOWN}</output></div>
          <label class="developer-control"><span>已解析坐骑</span><select data-dev-mount-select><option value="">暂无坐骑数据</option></select></label>
          <dl class="developer-definition-list">
            <div><dt>Mount ID</dt><dd data-dev-field="mount.id">${UNKNOWN}</dd></div>
            <div><dt>Name</dt><dd data-dev-field="mount.name">${UNKNOWN}</dd></div>
            <div><dt>Model</dt><dd data-dev-field="mount.model">${UNKNOWN}</dd></div>
            <div><dt>Skeleton / Animation</dt><dd data-dev-field="mount.assets">${UNKNOWN}</dd></div>
          </dl>
          <div class="developer-mount-actions">
            ${['spawn', 'mount', 'dismount', 'takeoff', 'land'].map(action => `<button class="command" type="button" data-dev-mount-action="${action}" data-dev-command="mount.${action}">${icon(action === 'spawn' ? 'plus' : action === 'mount' ? 'anchor' : action === 'dismount' ? 'log-out' : action === 'takeoff' ? 'arrow-up' : 'arrow-down')}<span>${({ spawn: 'Spawn', mount: 'Mount', dismount: 'Dismount', takeoff: 'Takeoff', land: 'Land' })[action]}</span></button>`).join('')}
          </div>
        </section>

        <section class="developer-tab-panel hidden" data-dev-tab-panel="audio" role="tabpanel">
          <div class="developer-section-heading"><div><small>AUDIO RUNTIME</small><h2>地图 BGM 与技能音效</h2></div><output data-dev-field="audio.map">${UNKNOWN}</output></div>
          <label class="developer-control"><span>当前地图 BGM</span><select data-dev-bgm-select><option value="">暂无 BGM 数据</option></select></label>
          <div class="developer-actions"><button class="command" type="button" data-dev-command="audio.bgm.play">${icon('play')}<span>播放 BGM</span></button><button class="command" type="button" data-dev-command="audio.bgm.stop">${icon('square')}<span>停止</span></button></div>
          <label class="developer-control"><span>Skill SFX</span><select data-dev-sfx-select><option value="">暂无 SFX 数据</option></select></label>
          <div class="developer-audio-meta"><span>Resource ID</span><output data-dev-field="audio.sfx.resource">${UNKNOWN}</output><span>Metadata</span><output data-dev-field="audio.sfx.metadata" class="developer-wrap">${UNKNOWN}</output></div>
          <div class="developer-actions"><button class="command" type="button" data-dev-command="audio.sfx.play">${icon('volume-2')}<span>播放 SFX</span></button><button class="command" type="button" data-dev-command="audio.sfx.stop">${icon('square')}<span>停止音频</span></button><label class="developer-toggle"><input type="checkbox" data-dev-audio-enabled><span>Audio enabled</span></label></div>
          <label class="developer-control developer-volume"><span>Volume</span><input type="range" min="0" max="1" step="0.01" data-dev-volume><output data-dev-field="audio.volume">${UNKNOWN}</output></label>
        </section>

        <section class="developer-tab-panel hidden" data-dev-tab-panel="environment" role="tabpanel">
          <div class="developer-section-heading"><div><small>ENVIRONMENT RUNTIME</small><h2>时间与光照配置</h2></div><output data-dev-field="environment.profile">${UNKNOWN}</output></div>
          <label class="developer-control developer-time"><span>WorldTime</span><input type="range" min="0" max="24" step="0.05" data-dev-world-hour><output data-dev-field="environment.time">${UNKNOWN}</output></label>
          <div class="developer-actions"><button class="command" type="button" data-dev-daynight="day">${icon('sun')}<span>Day</span></button><button class="command" type="button" data-dev-daynight="night">${icon('moon')}<span>Night</span></button></div>
          <label class="developer-control"><span>Environment Profile</span><select data-dev-profile-select><option value="">暂无 Profile 数据</option></select></label>
          <div class="developer-subheading"><span>主要参数覆盖</span><small>仅显示桥接提供的参数</small></div>
          <div class="developer-params" data-dev-env-params></div>
          <button class="command developer-command" type="button" data-dev-command="environment.reset">${icon('rotate-ccw')}<span>重置环境参数</span></button>
        </section>
      </div>
      <footer class="developer-panel__footer"><output data-dev-command-status>就绪</output><span data-dev-field="snapshot.age"></span></footer>`;
  }

  _bind() {
    this.element.addEventListener('click', event => {
      const tab = event.target.closest('[data-dev-tab]');
      if (tab) { this._setTab(tab.dataset.devTab); return; }
      if (event.target.closest('[data-dev-close]')) { this.close(); return; }
      if (event.target.closest('[data-dev-overlay-toggle]')) { this._setOverlay(!this.state.overlay); return; }
      const result = event.target.closest('[data-dev-map-result]');
      if (result) { this._switchMap(result.dataset.mapId); return; }
      const recent = event.target.closest('[data-dev-recent-map]');
      if (recent) { this._switchMap(recent.dataset.mapId); return; }
      const preset = event.target.closest('[data-dev-animation-preset]');
      if (preset) { this._playAnimation(preset.dataset.devAnimationPreset); return; }
      const dayNight = event.target.closest('[data-dev-daynight]');
      if (dayNight) { this._run('environment.time', { hour: dayNight.dataset.devDaynight === 'day' ? 12 : 0 }); return; }
      const mountAction = event.target.closest('[data-dev-mount-action]');
      if (mountAction) { this._runMount(mountAction.dataset.devMountAction); return; }
      const command = event.target.closest('[data-dev-command]');
      if (command) this._runCommandFromNode(command);
    });
    this.element.addEventListener('input', event => {
      if (event.target.matches('[data-dev-map-search]')) this._renderMapResults();
      if (event.target.matches('[data-dev-map-x], [data-dev-map-y], [data-dev-map-z]')) this._mapPositionDraftDirty = true;
      if (event.target.matches('[data-dev-world-hour]')) {
        this._setField('environment.time', this._formatHour(Number(event.target.value)));
        this._run('environment.time', { hour: Number(event.target.value) });
      }
      if (event.target.matches('[data-dev-volume]')) {
        this._setField('audio.volume', `${Math.round(Number(event.target.value) * 100)}%`);
        this._run('audio.settings', { volume: Number(event.target.value) });
      }
    });
    this.element.addEventListener('change', event => {
      const target = event.target;
      if (target.matches('[data-dev-map-select]')) this._switchMap(target.value);
      if (target.matches('[data-dev-animation-select]')) this._playAnimation(target.value);
      if (target.matches('[data-dev-skill-select]')) this._updateSkillDetails();
      if (target.matches('[data-dev-mount-select]')) this._updateMountDetails();
      if (target.matches('[data-dev-bgm-select]')) this._updateAudioDetails();
      if (target.matches('[data-dev-sfx-select]')) this._updateAudioDetails();
      if (target.matches('[data-dev-profile-select]')) this._run('environment.profile', { profile: target.value });
      if (target.matches('[data-dev-audio-enabled]')) this._run('audio.settings', { sound: target.checked });
      if (target.matches('[data-dev-env-param]')) {
        const key = target.dataset.devEnvParam;
        this._environmentParamDrafts.add(key);
        this._run('environment.parameters', { parameters: { [key]: Number(target.value) } }).then(result => {
          if (result?.ok) this._environmentParamDrafts.delete(key);
        });
      }
    });
    this.element.querySelector('[data-dev-dat]').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await this._run('character.import', { fileName: file.name, file });
      } finally {
        event.target.value = '';
      }
    });
  }

  _setTab(tab) {
    if (!TAB_IDS.includes(tab) || this.state.tab === tab) return;
    this.state.tab = tab;
    this._applyState();
  }

  _setOverlay(enabled) {
    this.state.overlay = Boolean(enabled);
    this._applyState();
  }

  _applyState(emit = true) {
    this.element.classList.toggle('hidden', !this.state.open);
    this.element.dataset.activeTab = this.state.tab;
    this.element.querySelectorAll('[data-dev-tab]').forEach(button => {
      const selected = button.dataset.devTab === this.state.tab;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    this.element.querySelectorAll('[data-dev-tab-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.devTabPanel !== this.state.tab));
    const overlay = this.element.querySelector('[data-dev-overlay-toggle]');
    overlay.classList.toggle('selected', this.state.overlay);
    overlay.setAttribute('aria-pressed', String(this.state.overlay));
    overlay.title = this.state.overlay ? '关闭调试浮层' : '打开调试浮层';
    if (emit) this._emitState();
  }

  _emitState() {
    const state = { ...this.state };
    try { this.onStateChange?.(state); } catch (error) { console.warn('Developer panel state:', error); }
    if (this.controller?.developer && typeof this.controller.developer === 'object') this.controller.developer.state = state;
    if (typeof this.controller?.preferences?.set === 'function') {
      try { this.controller.preferences.set('developer.state', state); } catch { /* preference storage is optional */ }
    }
  }

  open() { this.state.open = true; this._applyState(); return this; }
  close() { this.state.open = false; this._applyState(); return this; }
  toggle() { this.state.open = !this.state.open; this._applyState(); return this; }
  get isOpen() { return this.state.open; }
  getState() { return { ...this.state }; }
  setState(next = {}) {
    if (typeof next.open === 'boolean') this.state.open = next.open;
    if (TAB_IDS.includes(next.tab)) this.state.tab = next.tab;
    if (typeof next.overlay === 'boolean') this.state.overlay = next.overlay;
    this._applyState();
    return this;
  }

  async _run(command, args = {}) {
    const run = this.runtime?.run;
    if (typeof run !== 'function') {
      this._setStatus(`运行时未提供 ${command}`, true);
      return null;
    }
    this._busy++;
    this._setStatus(`执行 ${command}…`);
    try {
      const result = await run.call(this.runtime, command, args);
      if (result?.snapshot) this.update(result.snapshot);
      if (result?.ok && command === 'map.teleport') this._mapPositionDraftDirty = false;
      if (result?.ok === false) this._setStatus(result.reason || `${command} 未完成`, true);
      else this._setStatus(result?.message || `${command} 已执行`);
      return result;
    } catch (error) {
      this._setStatus(error?.message || `${command} 失败`, true);
      return null;
    } finally {
      this._busy--;
    }
  }

  _runCommandFromNode(node) {
    const command = node.dataset.devCommand;
    if (command === 'map.teleport') {
      const mapId = this.element.querySelector('[data-dev-map-select]').value || this.snapshot?.currentMap?.id || this.snapshot?.scene?.id || this.snapshot?.map?.id;
      const position = {};
      for (const axis of ['x', 'y', 'z']) {
        const field = this.element.querySelector(`[data-dev-map-${axis}]`);
        if (field.value !== '') position[axis] = Number(field.value);
      }
      const currentMapId = this._currentMapId || this.snapshot?.scene?.id || this.snapshot?.currentMap?.id;
      if (mapId && currentMapId && mapId !== currentMapId && Object.keys(position).length) {
        this._run('map.switch', { mapId }).then(result => {
          if (result?.ok) this._run(command, { position });
        });
      } else if (Object.keys(position).length) {
        this._run(command, { position });
      } else if (mapId && mapId !== currentMapId) {
        this._run('map.switch', { mapId });
      }
    } else if (command === 'character.reload') {
      const appearance = this.snapshot?.character?.appearance ?? this.snapshot?.appearance;
      this._run(command, appearance && typeof appearance === 'object' ? appearance : {});
    }
    else if (command === 'animation.play') this._playAnimation(this.element.querySelector('[data-dev-animation-id]').value || this.element.querySelector('[data-dev-animation-select]').value);
    else if (command === 'skill.trigger') this._run(command, { skillId: this.element.querySelector('[data-dev-skill-select]').value });
    else if (command === 'audio.bgm.play') this._run('audio.bgm', { sceneId: this.element.querySelector('[data-dev-bgm-select]').value });
    else if (command === 'audio.bgm.stop') this._run('audio.stop', { bgmOnly: true });
    else if (command === 'audio.sfx.play') this._run('audio.sfx', { resourceId: this.element.querySelector('[data-dev-sfx-select]').value });
    else if (command === 'audio.sfx.stop') this._run('audio.stop');
    else if (command === 'environment.reset') this._run(command);
  }

  _switchMap(mapId) {
    if (!mapId) return;
    const select = this.element.querySelector('[data-dev-map-select]');
    select.value = mapId;
    this._run('map.switch', { mapId });
  }

  _playAnimation(animationId) {
    if (!animationId) return;
    this.element.querySelector('[data-dev-animation-select]').value = animationId;
    this._run('animation.play', { animationId });
  }

  _runMount(action) {
    const mountId = this.element.querySelector('[data-dev-mount-select]').value;
    this._run(`mount.${action}`, { mountId });
  }

  _setStatus(message, error = false) {
    const output = this.element.querySelector('[data-dev-command-status]');
    output.textContent = text(message, '就绪');
    output.dataset.state = error ? 'error' : 'ok';
  }

  _setField(key, value, title = '') {
    const node = this.element.querySelector(`[data-dev-field="${key}"]`);
    if (!node) return;
    const rendered = text(value);
    node.textContent = rendered;
    if (rendered !== UNKNOWN || title) node.title = title || rendered;
    else node.removeAttribute('title');
  }

  _formatHour(hour) {
    if (!Number.isFinite(hour)) return UNKNOWN;
    const normalized = ((hour % 24) + 24) % 24;
    return `${String(Math.floor(normalized)).padStart(2, '0')}:${String(Math.floor((normalized % 1) * 60)).padStart(2, '0')}`;
  }

  _renderMapResults() {
    const search = this.element.querySelector('[data-dev-map-search]').value.trim().toLowerCase();
    const maps = this._maps;
    const matches = maps.filter(map => `${labelOf(map)} ${idOf(map)} ${text(map?.region, '')}`.toLowerCase().includes(search)).slice(0, 40);
    const host = this.element.querySelector('[data-dev-map-results]');
    const signature = `${search}|${matches.map(idOf).join(',')}`;
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    host.innerHTML = matches.length ? matches.map(map => `<button type="button" data-dev-map-result data-map-id="${escape(idOf(map))}" title="${escape(labelOf(map))} · ${escape(idOf(map))}"><span>${escape(labelOf(map))}</span><small>${escape(idOf(map))}</small></button>`).join('') : `<span class="developer-empty">${search ? '没有匹配地图' : '输入中文名或 ID 开始搜索'}</span>`;
  }

  _updateSkillDetails() {
    const skill = this._skills.find(item => idOf(item) === this.element.querySelector('[data-dev-skill-select]').value) || {};
    this._setField('skill.id', skill.sourceSkillId ?? skill.sourceSkillID ?? skill.skillId ?? skill.skillID ?? skill.id);
    this._setField('skill.animation', skill.animationId ?? skill.animationID ?? skill.animation);
    this._setField('skill.vfx', skill.vfxId ?? skill.vfxID ?? skill.vfx);
    this._setField('skill.sound', skill.soundId ?? skill.soundID ?? skill.sound);
  }

  _updateMountDetails() {
    const mount = this._mounts.find(item => idOf(item) === this.element.querySelector('[data-dev-mount-select]').value) || {};
    this._setField('mount.id', mount.mountId ?? mount.id);
    this._setField('mount.name', mount.name ?? mount.displayName);
    this._setField('mount.model', mount.modelId ?? mount.model);
    const assets = [mount.skeletonId ?? mount.skeleton, mount.animationId ?? mount.animation].filter(hasValue).join(' / ');
    this._setField('mount.assets', assets || (mount.modelId || mount.model ? UNKNOWN : null));
  }

  _updateAudioDetails() {
    const sfx = this._sfx.find(item => idOf(item) === this.element.querySelector('[data-dev-sfx-select]').value) || {};
    this._setField('audio.sfx.resource', sfx.resourceId ?? sfx.id);
    this._setField('audio.sfx.metadata', sfx.metadata ?? sfx.meta ?? sfx.resource);
  }

  update(snapshot = null) {
    if (snapshot && typeof snapshot === 'object') this.snapshot = snapshot;
    if (!snapshot) {
      const getSnapshot = this.runtime?.getSnapshot;
      if (typeof getSnapshot === 'function') {
          try {
            const result = getSnapshot.call(this.runtime);
            if (result?.then) {
              result.then(next => this.update(next)).catch(error => this._setStatus(error?.message || '快照读取失败', true));
              return this;
            }
            this.snapshot = result;
          } catch { return this; }
      }
    }
    if (!this.snapshot || typeof this.snapshot.then === 'function') return this;
    const data = this.snapshot;
    const mapBlock = objectValue(data.map);
    const sceneBlock = objectValue(data.scene);
    this._maps = collection(data.maps ?? data.mapCatalog ?? mapBlock.catalog ?? data.content?.maps);
    this._recentMaps = collection(data.recentMaps ?? data.recent ?? mapBlock.recent);
    this._skills = collection(data.skills ?? data.skillDefinitions ?? data.combat?.skills);
    this._mounts = collection(data.mounts ?? data.mountDefinitions ?? data.mount?.available);
    const animationBlock = objectValue(data.animation);
    const rawAnimations = data.animations ?? animationBlock.available ?? data.character?.animations;
    this._animations = Array.isArray(rawAnimations?.ids)
      ? rawAnimations.ids.map(id => ({ id, name: id }))
      : collection(rawAnimations);
    const currentMap = objectValue(data.currentMap ?? (sceneBlock.id ? sceneBlock : null) ?? (mapBlock.id ? mapBlock : null));
    const mapLabel = [currentMap.name ?? currentMap.displayName, currentMap.id ?? currentMap.mapId].filter(hasValue).join(' · ');
    this._setField('map.current', mapLabel || `${text(data.currentMapId, UNKNOWN)}`);
    const mapSelect = this.element.querySelector('[data-dev-map-select]');
    updateOptions(mapSelect, this._maps, '暂无地图数据');
    const mapChanged = Boolean(currentMap.id) && currentMap.id !== this._currentMapId;
    if (mapChanged) {
      this._currentMapId = currentMap.id;
      this._mapPositionDraftDirty = false;
      mapSelect.value = currentMap.id;
    }
    const currentPoint = point(data.player?.position ?? data.position ?? data.debug?.playerPosition ?? currentMap.position ?? currentMap.spawn);
    for (const axis of ['x', 'y', 'z']) {
      const input = this.element.querySelector(`[data-dev-map-${axis}]`);
      if (!this._mapPositionDraftDirty && hasValue(currentPoint[axis])) input.value = currentPoint[axis];
    }
    this._renderMapResults();
    this._renderRecentMaps();

    const character = objectValue(data.character ?? data.player?.character ?? data.player);
    const appearance = objectValue(character.appearance ?? data.appearance ?? character.appearanceData);
    this._setField('character.model', character.modelId ?? character.model);
    this._setField('character.race', appearance.raceName ?? appearance.race ?? appearance.tribeName ?? appearance.tribe);
    this._setField('character.sex', appearance.sex ?? appearance.gender);
    this._setField('character.face', appearance.face ?? appearance.faceId);
    this._setField('character.hair', appearance.hair ?? appearance.hairId);
    const materials = arrayValue(appearance.materialIds ?? appearance.materialIDs ?? appearance.materials ?? character.materialIds ?? character.materialIDs);
    const materialLabel = materials.length ? materials.join(', ') : UNKNOWN;
    this._setField('character.materials', materialLabel, materialLabel);
    const jsonSource = appearance.raw ?? appearance.data ?? data.characterAppearanceData ?? appearance;
    const appearanceJson = json(jsonSource);
    const jsonNode = this.element.querySelector('[data-dev-character-json]');
    if (jsonNode.value !== appearanceJson && document.activeElement !== jsonNode) jsonNode.value = appearanceJson;

    const animationSelect = this.element.querySelector('[data-dev-animation-select]');
    const animationItems = [{ id: 'idle', name: 'Idle' }, { id: 'walk', name: 'Walk' }, { id: 'run', name: 'Run' }, { id: 'jump', name: 'Jump' }, ...this._animations];
    updateOptions(animationSelect, animationItems, '暂无动作数据');
    const animation = objectValue(data.animation ?? data.character?.animation);
    const currentAnimation = animation.current ?? data.animations?.current ?? data.currentAnimation ?? character.currentAnimation;
    this._setField('animation.current', currentAnimation?.name ?? currentAnimation?.id ?? currentAnimation);
    this._setField('animation.status', animation.state ?? animation.status ?? data.currentAction ?? character.actionId);
    this._setField('animation.resource', currentAnimation?.resourceId ?? currentAnimation?.resourceID ?? currentAnimation?.resource);

    updateOptions(this.element.querySelector('[data-dev-skill-select]'), this._skills, '暂无技能数据');
    this._setField('skill.count', this._skills.length);
    this._updateSkillDetails();

    updateOptions(this.element.querySelector('[data-dev-mount-select]'), this._mounts, '暂无坐骑数据');
    const currentMount = objectValue(data.currentMount ?? data.mount?.current ?? data.mount ?? character.mount);
    const mountSelect = this.element.querySelector('[data-dev-mount-select]');
    if (currentMount.id && !mountSelect.matches(':focus')) mountSelect.value = currentMount.id;
    this._setField('mount.state', currentMount.state ?? data.mount?.state);
    this._updateMountDetails();

    const audio = objectValue(data.audio);
    const currentAudioMap = text(currentMap.id ?? currentMap.mapId, '');
    this._bgm = collection(audio.bgm ?? audio.backgroundMusic ?? data.bgm).filter(item => !item.mapId || !currentAudioMap || item.mapId === currentAudioMap || idOf(item) === currentAudioMap);
    this._sfx = collection(audio.sfx ?? audio.skillSfx ?? data.sfx);
    updateOptions(this.element.querySelector('[data-dev-bgm-select]'), this._bgm, '暂无 BGM 数据');
    updateOptions(this.element.querySelector('[data-dev-sfx-select]'), this._sfx, '暂无 SFX 数据');
    this._setField('audio.map', currentAudioMap || UNKNOWN);
    const audioSettings = objectValue(audio.settings);
    if (hasValue(audio.enabled ?? audioSettings.sound)) this.element.querySelector('[data-dev-audio-enabled]').checked = Boolean(audio.enabled ?? audioSettings.sound);
    const volume = Number(audio.volume ?? audioSettings.volume);
    if (Number.isFinite(volume)) {
      const volumeInput = this.element.querySelector('[data-dev-volume]');
      if (document.activeElement !== volumeInput) volumeInput.value = volume;
      this._setField('audio.volume', `${Math.round(volume * 100)}%`);
    }
    this._updateAudioDetails();

    const environment = objectValue(data.environment);
    const time = objectValue(environment.time);
    const hour = Number(environment.worldTime ?? environment.hour ?? time.hour ?? data.worldTime?.hour);
    const hourInput = this.element.querySelector('[data-dev-world-hour]');
    if (Number.isFinite(hour)) {
      if (document.activeElement !== hourInput) hourInput.value = hour;
      this._setField('environment.time', this._formatHour(hour));
    }
    const environmentProfile = objectValue(environment.profile);
    this._setField('environment.profile', environmentProfile.zoneId ?? environmentProfile.id ?? environment.profileId ?? environment.profile ?? data.environmentProfile);
    updateOptions(this.element.querySelector('[data-dev-profile-select]'), collection(environment.profiles ?? environment.profileChoices), '暂无 Profile 数据');
    const profileSelect = this.element.querySelector('[data-dev-profile-select]');
    const activeProfileId = environment.profileId ?? environmentProfile.zoneId ?? environmentProfile.id ?? (typeof environment.profile === 'string' ? environment.profile : '');
    if (activeProfileId && !profileSelect.matches(':focus')) profileSelect.value = activeProfileId;
    this._renderEnvironmentParams(environment.params ?? environment.overrides ?? {});
    this._last.updatedAt = Date.now();
    this._setField('snapshot.age', '实时快照');
    return this;
  }

  _renderRecentMaps() {
    const host = this.element.querySelector('[data-dev-map-recent]');
    const count = this.element.querySelector('[data-dev-map-recent-count]');
    const signature = this._recentMaps.map(idOf).join(',');
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    count.textContent = this._recentMaps.length ? `${this._recentMaps.length} 个` : '';
    const mapById = new Map(this._maps.map(map => [idOf(map), map]));
    const describe = value => typeof value === 'string' ? (mapById.get(value) || value) : value;
    host.innerHTML = this._recentMaps.length
      ? this._recentMaps.slice(0, 8).map(value => { const map = describe(value); return `<button type="button" data-dev-recent-map data-map-id="${escape(idOf(map))}" title="${escape(labelOf(map))} · ${escape(idOf(map))}"><span>${escape(labelOf(map))}</span><small>${escape(idOf(map))}</small></button>`; }).join('')
      : `<span class="developer-empty">暂无最近地图</span>`;
  }

  _renderEnvironmentParams(params) {
    const entries = Object.entries(objectValue(params)).filter(([, value]) => value === null || value === undefined || typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))));
    const host = this.element.querySelector('[data-dev-env-params]');
    const signature = entries.map(([key]) => key).join('|');
    if (host.dataset.signature === signature) {
      entries.forEach(([key, value]) => {
        const input = [...host.querySelectorAll('[data-dev-env-param]')].find(node => node.dataset.devEnvParam === key);
        if (input && document.activeElement !== input && !this._environmentParamDrafts.has(key)) input.value = hasValue(value) ? value : '';
      });
      return;
    }
    host.dataset.signature = signature;
    host.innerHTML = entries.length ? entries.map(([key, value]) => `<label><span title="${escape(key)}">${escape(key)}</span><input type="number" step="0.01" value="${hasValue(value) ? escape(value) : ''}" placeholder="${hasValue(value) ? '' : UNKNOWN}" data-dev-env-param="${escape(key)}"></label>`).join('') : `<span class="developer-empty">运行时未提供可覆盖参数</span>`;
  }
}

export function newDeveloperPanel(options) {
  return new DeveloperPanel(options);
}

export { TAB_IDS as DEVELOPER_TABS };
