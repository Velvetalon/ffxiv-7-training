const now = () => globalThis.performance?.now?.() ?? Date.now();

export class AssetProfiler {
  constructor({ maxEvents = 10000 } = {}) {
    this.maxEvents = maxEvents;
    this.events = [];
    this.resources = [];
    this.active = null;
    this.longTasks = [];
    this.longTaskObserver = null;
  }

  begin(sceneId, detail = {}) {
    this.active = { sceneId, startedAt: now(), detail, firstRender: null, interactive: null };
    this.events = [];
    this.resources = [];
    this.longTasks = [];
    this.observeLongTasks();
    return this.mark('map-select', detail);
  }

  mark(name, detail = {}) {
    const at = now();
    const event = { name, at, elapsedMs: this.active ? at - this.active.startedAt : null, detail };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return event;
  }

  resource(kind, detail = {}) {
    const at = now();
    const event = { kind, at, elapsedMs: this.active ? at - this.active.startedAt : null, ...detail };
    this.resources.push(event);
    if (this.resources.length > this.maxEvents) this.resources.splice(0, this.resources.length - this.maxEvents);
    return event;
  }

  firstRendered(detail = {}) {
    if (this.active?.firstRender) return this.active.firstRender;
    const event = this.mark('first-render', detail);
    if (this.active) this.active.firstRender = event;
    return event;
  }

  interactive(detail = {}) {
    if (this.active?.interactive) return this.active.interactive;
    const event = this.mark('interactive', detail);
    if (this.active) this.active.interactive = event;
    return event;
  }

  cpuSubmit(detail = {}) {
    return this.mark('gpu-cpu-submit', { metric: 'cpu-submission-ms', ...detail });
  }

  snapshot() {
    const startedAt = this.active?.startedAt ?? null;
    const phase = (start, end) => {
      const first = this.events.find(event => event.name === start);
      const last = this.events.find(event => event.name === end);
      return first && last ? Math.max(0, last.at - first.at) : null;
    };
    const sum = (kind, field) => this.resources.filter(event => event.kind === kind).reduce((total, event) => total + (event[field] || 0), 0);
    const full = this.events.find(event => event.name === 'fully-loaded');
    return {
      sceneId: this.active?.sceneId ?? null,
      startedAt,
      events: this.events.map(event => ({ ...event, elapsedMs: Number(event.elapsedMs?.toFixed?.(2) ?? event.elapsedMs) })),
      resources: this.resources.map(event => ({ ...event, elapsedMs: Number(event.elapsedMs?.toFixed?.(2) ?? event.elapsedMs) })),
      longTasks: this.longTasks.map(event => ({ ...event, relativeStartMs: startedAt === null ? null : Number((event.startTime - startedAt).toFixed(2)) })),
      firstRenderMs: this.active?.firstRender?.elapsedMs ?? null,
      interactiveMs: this.active?.interactive?.elapsedMs ?? null,
      fullyLoadedMs: full?.elapsedMs ?? null,
      phases: {
        discoveryMs: phase('discovery:start', 'registry:ready') ?? phase('discovery:start', 'manifest:fetch:complete'),
        bootstrapMs: phase('bootstrap:start', 'bootstrap:ready'),
        collisionDecodeMs: phase('collision:decode:start', 'collision:decode:complete'),
        bvhMs: phase('bvh:start', 'bvh:complete'),
        resourceDecodeTotalMs: sum('resource-ready', 'decodeMs'),
        instantiateCpuMs: sum('instantiate-cpu', 'cpuMs'),
        gpuUploadCpuMs: sum('gpu-upload-cpu', 'cpuMs'),
        longestFetchMs: Math.max(0, ...this.resources.filter(event => event.kind === 'fetch').map(event => event.fetchMs || 0)),
        longestLongTaskMs: Math.max(0, ...this.longTasks.map(event => event.duration)),
      },
      gpuTiming: 'Upload timings measure CPU submission. gpu-execution events are asynchronous EXT_disjoint_timer_query results where supported; disjoint/unavailable results are not estimates.',
    };
  }

  observeLongTasks() {
    if (this.longTaskObserver || !globalThis.PerformanceObserver) return;
    try {
      this.longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (this.active && entry.startTime >= this.active.startedAt) this.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      this.longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      this.longTaskObserver = null;
    }
  }

  dispose() {
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
  }
}

export const assetProfiler = globalThis.__ASSET_PROFILER__ ||= new AssetProfiler();
