const PHASES = new Map([
  ['map-select', '选择地图'],
  ['discovery:start', '读取地图清单'],
  ['manifest:fetch:start', '读取资源清单'],
  ['manifest:fetch:complete', '资源清单已就绪'],
  ['registry:start', '准备资源索引'],
  ['registry:ready', '资源索引已就绪'],
  ['collision:load:start', '加载碰撞数据'],
  ['collision:decode:start', '解析碰撞数据'],
  ['collision:decode:complete', '碰撞数据已就绪'],
  ['bvh:start', '建立导航数据'],
  ['bvh:complete', '导航数据已就绪'],
  ['models:load:start', '加载场景几何'],
  ['instantiate:start', '准备场景'],
  ['instantiate:complete', '场景已准备'],
  ['bootstrap:start', '准备首屏资源'],
  ['bootstrap:ready', '首屏资源已就绪'],
  ['first-render', '提交首帧'],
  ['engine-interactive', '场景可交互'],
  ['input:enabled', '场景可交互'],
  ['fully-loaded', '后台资源已就绪'],
  ['stream-error', '后台资源异常'],
]);

/**
 * Small runtime status surface shared by the map loader and developer panel.
 * It does not own loading promises and can be constructed before World.
 */
export class RuntimeFeedback {
  constructor(options = {}) {
    const config = options && typeof options === 'object' ? options : {};
    this.root = config.root || globalThis.document?.querySelector?.('#app') || globalThis.document?.body || null;
    this.loading = config.loading || globalThis.document?.querySelector?.('#loading') || null;
    this.onRetry = typeof config.onRetry === 'function' ? config.onRetry : () => {};
    this.world = config.world || null;
    this.getWorld = typeof config.getWorld === 'function' ? config.getWorld : null;
    this.profiler = config.profiler || null;
    this.state = {
      phase: '等待场景',
      phaseId: null,
      progress: null,
      error: null,
      mapId: null,
      characterLoading: false,
      ready: false,
      retrying: false,
      updatedAt: Date.now(),
    };
    this.lastRendered = '';
    this.element = this.createElement();
    this.onLoading = (progress, error, mapId) => this.mapProgress(progress, error, mapId);
    this.loadingHandler = this.onLoading;
    this.render();
  }

  createElement() {
    if (!this.root || !globalThis.document?.createElement) return null;
    const element = document.createElement('aside');
    element.className = 'runtime-feedback hidden';
    element.setAttribute('aria-live', 'polite');
    element.innerHTML = `
      <span class="runtime-feedback__phase" data-runtime-phase></span>
      <span class="runtime-feedback__detail" data-runtime-detail></span>
      <button class="runtime-feedback__retry hidden" type="button" data-runtime-retry>重试</button>`;
    const retry = element.querySelector('[data-runtime-retry]');
    retry?.addEventListener('click', () => {
      this.state.retrying = true;
      this.render();
      Promise.resolve(this.onRetry(this.state.mapId)).then(result => {
        if (result === false) this.fail('重试失败', this.state.mapId);
        else { this.state.retrying = false; this.render(); }
      }).catch(error => this.fail(error, this.state.mapId));
    });
    if (this.loading?.parentNode === this.root) this.loading.after(element);
    else this.root.append(element);
    return element;
  }

  mapProgress(progress, error = null, mapId = null) {
    if (mapId) this.state.mapId = cleanId(mapId);
    if (error) return this.fail(error, mapId);
    if (progress === null || progress === undefined || progress === '') this.state.progress = null;
    else if (Number.isFinite(Number(progress))) this.state.progress = Math.max(0, Math.min(1, Number(progress)));
    this.state.error = null;
    this.state.retrying = false;
    this.state.ready = this.state.progress === 1;
    if (this.state.ready) this.setPhase('ready', '已就绪');
    else if (this.state.progress === 0) this.setPhase('map-select', '准备加载地图');
    this.render();
    return this.getState();
  }

  setCharacterLoading(value) {
    this.state.characterLoading = Boolean(value);
    this.render();
    return this.getState();
  }

  fail(error, mapId = null) {
    if (mapId) this.state.mapId = cleanId(mapId);
    this.state.error = typeof error === 'string' ? error : error?.message || String(error || '加载失败');
    this.state.ready = false;
    this.state.retrying = false;
    this.setPhase('error', '加载失败');
    this.render();
    return this.getState();
  }

  ready(mapId = null) {
    if (mapId) this.state.mapId = cleanId(mapId);
    this.state.error = null;
    this.state.progress = 1;
    this.state.ready = true;
    this.state.retrying = false;
    this.setPhase('ready', '已就绪');
    this.render();
    return this.getState();
  }

  /** Derive a label from profiler events and actual World state. */
  update(world = this.world, profiler = this.profiler) {
    if (!world && this.getWorld) world = this.getWorld();
    if (world) this.world = world;
    if (profiler) this.profiler = profiler;
    const currentWorld = this.world;
    const active = this.profiler?.active;
    const mapId = active?.sceneId || currentWorld?.requestedSceneId || currentWorld?.sceneId || this.state.mapId;
    if (mapId) this.state.mapId = cleanId(mapId);
    const latest = active && Array.isArray(this.profiler?.events) ? this.profiler.events.at(-1) : null;
    if (latest?.name && PHASES.has(latest.name)) this.setPhase(latest.name, PHASES.get(latest.name));

    if (currentWorld?.loadError) {
      this.fail(currentWorld.loadError, mapId);
    } else if (currentWorld?.loading) {
      this.state.ready = false;
      this.state.error = null;
      if (!latest && this.state.phaseId === null) this.setPhase('map-select', '准备加载地图');
      this.render();
    } else if (currentWorld && currentWorld.sceneId && !this.state.error && (this.state.phaseId || this.state.progress !== null)) {
      // World marks loading false before optional background streaming. That is
      // the interactive boundary and should not keep the blocking screen open.
      this.state.ready = true;
      this.setPhase('ready', '已就绪');
      this.render();
    } else if (this.state.characterLoading) {
      this.render();
    }
    return this.getState();
  }

  setPhase(id, label) {
    this.state.phaseId = id || null;
    this.state.phase = label || PHASES.get(id) || id || '等待场景';
    this.state.updatedAt = Date.now();
  }

  getState() {
    return { ...this.state };
  }

  render() {
    if (!this.element) return;
    const state = this.state;
    const character = state.characterLoading ? ' · 角色资源' : '';
    const detail = state.error || `${state.mapId || '当前场景'}${character}`;
    const key = JSON.stringify([state.phase, detail, state.error, state.ready, state.retrying]);
    if (key === this.lastRendered) return;
    this.lastRendered = key;
    this.element.classList.toggle('hidden', !state.error && !state.characterLoading && (state.ready || !state.phaseId));
    this.element.querySelector('[data-runtime-phase]').textContent = state.phase;
    this.element.querySelector('[data-runtime-detail]').textContent = detail;
    const retry = this.element.querySelector('[data-runtime-retry]');
    retry?.classList.toggle('hidden', !state.error);
    if (retry) retry.disabled = state.retrying;
    if (this.loading) {
      this.loading.classList.toggle('loaded', state.ready || Boolean(state.error));
      const paragraph = this.loading.querySelector('p');
      if (paragraph && (state.error || !state.ready)) paragraph.textContent = state.error || state.phase;
    }
  }

  dispose() {
    this.element?.remove();
    this.element = null;
  }
}

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : null;
}

export default RuntimeFeedback;
