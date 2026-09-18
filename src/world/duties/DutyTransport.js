const DEFAULT_TIMEOUT_MS = 15000;

function cleanKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanCoordinate(point) {
  const x = finiteNumber(point?.x);
  const z = finiteNumber(point?.z);
  if (x === null || z === null) return null;
  const y = finiteNumber(point?.y);
  return { x, y, z };
}

function pickSpawn(status) {
  if (!status || typeof status !== 'object') return null;
  for (const key of ['spawn', 'spawnPoint', 'entrance', 'entrancePosition']) {
    const spawn = cleanCoordinate(status[key] || status[key]?.position);
    if (spawn) return spawn;
  }
  return null;
}

function pickDutySpawn(duty) {
  return pickSpawn(duty) || pickSpawn(duty?.status) || pickSpawn(duty?.entrance);
}

export class DutyTransport {
  constructor({
    world,
    scenes,
    getPosition,
    setPosition,
    saveCamera,
    restoreCamera,
    teleport,
    getSceneId,
    catalog = null,
    getCatalog = null,
    maxStack = 8,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onTimeout,
    onFailure,
    onCancel,
  }) {
    Object.assign(this, {
      world, scenes, getPosition, setPosition, saveCamera, restoreCamera,
      teleport, getSceneId, onTimeout, onFailure, onCancel,
      catalog: null, getCatalog,
    });
    this.setCatalog(catalog);
    this.maxStack = Math.max(1, Math.trunc(Number(maxStack) || 8));
    this.timeoutMs = Math.max(1000, Math.trunc(Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    this.returnStack = [];
    this.pending = null;
    this.timeoutId = null;
  }

  get unavailable() {
    return !Array.isArray(this.scenes) || !this.scenes.length;
  }

  setCatalog(catalog) {
    this.catalog = catalog && Array.isArray(catalog.duties) ? catalog : null;
    return this.catalog;
  }

  resolveDuty(duty) {
    if (duty && typeof duty === 'object') return duty;
    const dutyKey = cleanKey(duty);
    if (!dutyKey) return null;
    const source = typeof this.getCatalog === 'function' ? this.getCatalog() : this.catalog;
    return source?.duties?.find(item => item?.dutyKey === dutyKey) || null;
  }

  getDuty(dutyKey) {
    return this.resolveDuty(dutyKey);
  }

  canEnter(duty) {
    const resolvedDuty = this.resolveDuty(duty);
    if (!resolvedDuty || typeof resolvedDuty !== 'object') return { ready: false, reason: '副本信息无效' };
    if (this.pending) return { ready: false, reason: '传送进行中' };
    if (this.unavailable) return { ready: false, reason: '场景目录未加载' };
    const sceneKey = (Array.isArray(resolvedDuty.sceneKeys) ? resolvedDuty.sceneKeys : []).map(cleanKey).find(Boolean);
    if (!sceneKey || !this.scenes.some(scene => scene?.id === sceneKey)) {
      return { ready: false, reason: '场景未构建' };
    }
    if (typeof this.teleport !== 'function') return { ready: false, reason: '传送通路不可用' };
    return { ready: true, reason: null, sceneKey, duty: resolvedDuty };
  }

  enter(duty) {
    const gate = this.canEnter(duty);
    if (!gate.ready) return { ok: false, reason: gate.reason };
    const dutyKey = cleanKey(gate.duty.dutyKey);
    const context = this.captureReturnContext(dutyKey);
    if (!context) return { ok: false, reason: '无法记录返回位置' };
    this.returnStack.push(context);
    while (this.returnStack.length > this.maxStack) this.returnStack.shift();
    const spawn = pickDutySpawn(gate.duty);
    this.setPending({
      direction: 'enter',
      dutyKey,
      sceneKey: gate.sceneKey,
      spawn,
      context,
    });
    const result = this.teleport(gate.sceneKey, { dutyEnter: { dutyKey, spawn } });
    if (!result?.ok) {
      this.clearPending();
      this.popContext(context);
      return { ok: false, reason: result?.reason || '无法进入副本' };
    }
    return { ok: true, dutyKey, sceneKey: gate.sceneKey };
  }

  leave() {
    if (this.pending) return { ok: false, reason: '传送进行中' };
    if (this.unavailable) return { ok: false, reason: '场景目录未加载' };
    if (!this.returnStack.length) return this.returnToDefaultSpawn();
    const context = this.returnStack.at(-1);
    if (!this.scenes.some(scene => scene?.id === context.fromSceneId)) {
      this.returnStack.pop();
      return { ok: false, reason: '来源场景未构建' };
    }
    if (this.currentSceneId() === context.fromSceneId) {
      this.returnStack.pop();
      this.restoreContext(context);
      return { ok: true, sceneKey: context.fromSceneId, restored: true };
    }
    this.returnStack.pop();
    this.setPending({
      direction: 'leave',
      dutyKey: context.entry?.dutyKey || null,
      sceneKey: context.fromSceneId,
      context,
    });
    const result = this.teleport(context.fromSceneId, { dutyReturn: true });
    if (!result?.ok) {
      this.clearPending();
      this.returnStack.push(context);
      return { ok: false, reason: result?.reason || '无法返回原位置' };
    }
    return { ok: true, sceneKey: context.fromSceneId };
  }

  complete(sceneKey) {
    if (!this.pending || this.pending.finished) return false;
    if (this.pending.sceneKey !== sceneKey) return false;
    const pending = this.pending;
    this.clearPending();
    if (pending.direction === 'enter' && pending.spawn) this.setPosition?.(pending.spawn);
    return true;
  }

  abort(reason = '副本传送失败') {
    if (!this.pending) return false;
    const pending = this.pending;
    this.clearPending();
    if (pending.direction === 'enter') this.popContext(pending.context);
    else if (this.returnStack.at(-1) !== pending.context) this.returnStack.push(pending.context);
    this.restoreContext(pending.context);
    this.onFailure?.(reason);
    return true;
  }

  cancel(reason = '副本传送已取消') {
    if (!this.pending) return false;
    const pending = this.pending;
    this.clearPending();
    if (pending.direction === 'enter' && this.returnStack.at(-1) === pending.context) this.returnStack.pop();
    this.onCancel?.(reason);
    return true;
  }

  clear(reason = '副本返回点已清理') {
    if (this.pending) this.cancel(reason);
    this.returnStack.length = 0;
  }

  sync(moving) {
    if (!this.pending) return;
    if (moving) { this.cancel('移动已中断副本传送'); return; }
    if (Date.now() - this.pending.beganAt > this.timeoutMs) this.abort('进入副本超时，已恢复原位');
  }

  returnToDefaultSpawn() {
    const spawn = cleanCoordinate(this.world?.spawn);
    if (!spawn) return { ok: false, reason: '没有可返回的位置' };
    this.setPosition?.(spawn);
    this.restoreCamera?.({
      azimuth: finiteNumber(this.world?.azimuth) ?? 0,
      polar: finiteNumber(this.world?.polar) ?? 1.17,
      distance: finiteNumber(this.world?.zoom) ?? 14,
    });
    return { ok: true, sceneKey: this.currentSceneId(), defaultSpawn: true };
  }

  snapshot() {
    return {
      ready: !this.unavailable && typeof this.teleport === 'function',
      pending: this.pending ? { ...this.pending } : null,
      returnStack: this.returnStack.map(context => ({
        fromSceneId: context.fromSceneId,
        position: { ...context.position },
        cameraState: { ...context.cameraState },
        entry: { ...context.entry },
      })),
    };
  }

  dispose() {
    this.clearPending();
    this.returnStack.length = 0;
  }

  captureReturnContext(dutyKey) {
    const position = cleanCoordinate(this.getPosition?.());
    if (!position) return null;
    return {
      fromSceneId: this.currentSceneId(),
      position,
      cameraState: this.saveCamera?.() || {},
      entry: { type: 'menu', dutyKey: dutyKey || null },
    };
  }

  setPending(value) {
    this.pending = { ...value, beganAt: Date.now(), finished: false };
    clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => this.handleTimeout(), this.timeoutMs);
  }

  clearPending() {
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
    const finished = this.pending?.finished;
    this.pending = finished ? this.pending : null;
  }

  handleTimeout() {
    if (!this.pending) return;
    this.abort('进入副本超时，已恢复原位');
  }

  popContext(context) {
    if (this.returnStack.at(-1) === context) this.returnStack.pop();
  }

  restoreContext(context) {
    if (!context) return;
    this.setPosition?.(context.position);
    this.restoreCamera?.(context.cameraState);
  }

  currentSceneId() {
    return this.getSceneId?.() ?? this.world?.sceneId ?? null;
  }
}
