import { getBaseActions } from './data.js';
import { getJobPlugin } from './registry.js';

const DEFAULT_CONTEXT = Object.freeze({ moving: false, distance: 8, positional: 'rear', target: true, targets: 1 });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const copyContext = (context) => Object.assign({}, DEFAULT_CONTEXT, context || {});
const round = (value, places = 3) => Number(value.toFixed(places));

export class CombatEngine {
  constructor(jobId) {
    this.events = [];
    this.setJob(jobId);
  }

  setJob(jobId) {
    const plugin = getJobPlugin(jobId);
    if (!plugin) throw new Error(`Unknown job: ${jobId}`);
    this.jobId = jobId;
    this.plugin = plugin;
    this.reset();
  }

  reset() {
    this.time = 0;
    this.inCombat = false;
    this.gcd = 0;
    this.gcdTotal = 2.5;
    this.cast = null;
    this.animationLock = 0;
    this.mp = 10000;
    this.maxHp = 10000;
    this.hp = this.maxHp;
    this.resources = {};
    this.buffs = new Map();
    this.targetDots = [];
    this.cooldowns = new Map();
    this.combo = null;
    this.comboRemaining = 0;
    this.queue = null;
    this.stats = { potency: 0, gcdCount: 0, ogcdCount: 0 };
    this.combatElapsed = 0;
    this.log = [];
    this.events.length = 0;
    this.lastContext = copyContext();
    this.manaTick = 3;
    this.jobState = this.plugin.createState(this);
  }

  tick(dt, context) {
    if (!Number.isFinite(dt) || dt <= 0) {
      if (context) this.lastContext = copyContext(context);
      return;
    }
    this.lastContext = copyContext(context || this.lastContext);
    let remaining = Math.min(dt, 3600);
    while (remaining > 0) {
      const step = Math.min(remaining, 0.05);
      this._step(step, this.lastContext);
      remaining -= step;
    }
  }

  use(actionId, context) {
    const current = copyContext(context || this.lastContext);
    this.lastContext = current;
    const action = this._findAction(actionId);
    if (!action) return this._error(actionId, '未知技能');

    const validation = this._validate(action, current, false);
    if (!validation.ok && validation.queueable) {
      this.queue = { id: action.id, context: current };
      return { ok: true };
    }
    if (!validation.ok) return this._error(action.id, validation.reason, action.name);
    this.queue = null;
    this._begin(action, current);
    return { ok: true };
  }

  getState() {
    const elapsed = this.combatElapsed;
    return {
      jobId: this.jobId,
      time: round(this.time),
      inCombat: this.inCombat,
      gcd: round(this.gcd),
      gcdTotal: round(this.gcdTotal),
      cast: this.cast ? { id: this.cast.action.id, name: this.cast.action.name, remaining: round(this.cast.remaining), total: round(this.cast.total) } : null,
      animationLock: round(this.animationLock),
      mp: Math.round(this.mp),
      hp: Math.round(this.hp),
      maxHp: this.maxHp,
      movementMultiplier: [...this.buffs.values()].reduce((value, buff) => Math.max(value, buff.movementMultiplier || 1), 1),
      resources: Object.assign({}, this.resources),
      buffs: [...this.buffs.values()].map((buff) => ({ id: buff.id, name: buff.name, remaining: round(buff.remaining), stacks: buff.stacks })),
      target: { dot: this.targetDots.map((dot) => ({ id: dot.id, name: dot.name, remaining: round(dot.remaining), potency: dot.potency })) },
      stats: {
        potency: round(this.stats.potency, 1),
        gcdCount: this.stats.gcdCount,
        ogcdCount: this.stats.ogcdCount,
        elapsed: round(elapsed),
        pps: elapsed > 0 ? round(this.stats.potency / elapsed, 2) : 0,
      },
      log: this.log.map((entry) => Object.assign({}, entry)),
      combo: this.combo ? { id: this.combo, remaining: round(this.comboRemaining) } : null,
      queue: this.queue ? { id: this.queue.id } : null,
    };
  }

  getActions() {
    return getBaseActions(this.jobId).map((base) => {
      const action = this._decorate(base);
      const timing = this.plugin.timing ? this.plugin.timing(this, action) : null;
      if (timing) {
        if (timing.cast !== undefined) action.cast = timing.cast;
        if (timing.recast !== undefined) action.recast = timing.recast;
      }
      const cooldown = this._cooldownSnapshot(action);
      const validation = this._validate(action, this.lastContext, true);
      return Object.assign({}, action, {
        cooldown: round(cooldown.cooldown),
        charges: cooldown.charges,
        maxCharges: cooldown.maxCharges,
        enabled: validation.ok,
        reason: validation.ok ? undefined : validation.reason,
      });
    });
  }

  drainEvents() {
    const events = this.events.slice();
    this.events.length = 0;
    return events;
  }

  receiveDamage(amount, context) {
    let damage = Math.max(0, Number(amount) || 0);
    const incoming = context || this.lastContext;
    if (this.hasBuff('addle')) damage *= incoming.damageType === 'physical' ? 0.95 : 0.9;
    if (this.hasBuff('feint')) damage *= incoming.damageType === 'magic' ? 0.95 : 0.9;
    if (this.plugin.modifyIncomingDamage) damage = this.plugin.modifyIncomingDamage(this, damage, incoming);
    for (const [id, buff] of [...this.buffs]) {
      if (!buff.shield || damage <= 0) continue;
      const absorbed = Math.min(buff.shield, damage);
      buff.shield -= absorbed;
      damage -= absorbed;
      if (buff.shield <= 0) {
        this.buffs.delete(id);
        if (this.plugin.onShieldBreak) this.plugin.onShieldBreak(this, buff);
        else if (this.plugin.onBuffExpire) this.plugin.onBuffExpire(this, buff);
      }
    }
    this.hp = clamp(this.hp - damage, 0, this.maxHp);
    if (this.plugin.onDamage) this.plugin.onDamage(this, damage, context || this.lastContext);
    return Math.round(damage);
  }

  addBuff(id, name, duration, stacks = 1, extra) {
    const buff = Object.assign({ id, name, remaining: duration, stacks }, extra || {});
    if (buff.tickInterval && buff.tickRemaining === undefined) buff.tickRemaining = buff.tickInterval;
    this.buffs.set(id, buff);
  }

  removeBuff(id) {
    this.buffs.delete(id);
  }

  hasBuff(id) {
    return this.buffs.has(id);
  }

  buff(id) {
    return this.buffs.get(id);
  }

  consumeBuff(id, amount = 1) {
    const buff = this.buffs.get(id);
    if (!buff) return false;
    buff.stacks -= amount;
    if (buff.stacks <= 0) this.buffs.delete(id);
    return true;
  }

  setResource(key, value, max = 100) {
    this.resources[key] = clamp(Math.round(value), 0, max);
  }

  addResource(key, value, max = 100) {
    this.setResource(key, (this.resources[key] || 0) + value, max);
  }

  addDot(id, name, duration, potency, actionId, falloff = 1, context) {
    const existing = this.targetDots.find((dot) => dot.id === id);
    const dot = existing || { id, name, remaining: duration, tick: 3, potency, actionId, falloff };
    dot.remaining = duration;
    dot.tick = 3;
    dot.potency = potency;
    dot.actionId = actionId;
    dot.falloff = falloff;
    dot.snapshotMultiplier = this.plugin.damageMultiplier ? this.plugin.damageMultiplier(this, { id: actionId, name, kind: 'dot' }, context || this.lastContext) : 1;
    if (!existing) this.targetDots.push(dot);
  }

  dealDamage(action, context, potency, options) {
    if (!potency || potency <= 0) return 0;
    const nearby = action.selfAoe && action.effectRange > 0 && context.distance > action.effectRange ? 0 : Math.max(0, Math.floor(context.targets || (context.target ? 1 : 0)));
    const targetCount = action.aoe ? nearby : (context.target ? 1 : 0);
    if (targetCount <= 0) return 0;
    const falloff = options && options.falloff !== undefined ? options.falloff : (action.falloff === undefined ? 1 : action.falloff);
    let total = potency + potency * falloff * Math.max(0, targetCount - 1);
    total *= options && options.multiplier !== undefined ? options.multiplier : (this.plugin.damageMultiplier ? this.plugin.damageMultiplier(this, action, context) : 1);
    total = round(total, 1);
    this.stats.potency += total;
    this.log.push({ time: round(this.combatElapsed), name: action.name, potency: total, kind: options && options.kind ? options.kind : action.kind });
    this.events.push({ type: 'hit', actionId: action.id, name: action.name, potency: total, color: action.color, jobId: this.jobId });
    if (this.hasBuff('target-sleep')) this.removeBuff('target-sleep');
    if (this.hasBuff('bloodbath') && action.kind === 'weaponskill') this.heal(action, Math.max(1, Math.round(total)));
    return total;
  }

  heal(action, potency) {
    if (!potency) return;
    const modified = this.plugin.modifyHealing ? this.plugin.modifyHealing(this, action, potency) : potency;
    this.hp = clamp(this.hp + modified, 0, this.maxHp);
    this.log.push({ time: round(this.combatElapsed), name: action.name, potency: 0, healing: round(modified, 1), kind: 'heal' });
    this.events.push({ type: 'heal', actionId: action.id, name: action.name, potency: round(modified, 1), color: action.color, jobId: this.jobId });
  }

  _step(dt, context) {
    if (this.inCombat) this.combatElapsed += dt;
    this.time += dt;
    this.gcd = Math.max(0, this.gcd - dt);
    this.animationLock = Math.max(0, this.animationLock - dt);
    this._tickCooldowns(dt);
    this._tickBuffs(dt);
    this._tickDots(dt, context);
    this._tickMana(dt);
    if (this.comboRemaining > 0) {
      this.comboRemaining -= dt;
      if (this.comboRemaining <= 0) this.combo = null;
    }

    if (this.cast) {
      if (context.moving && this.cast.remaining > 0.5) {
        const interrupted = this.cast.action;
        this.cast = null;
        this.queue = null;
        this._error(interrupted.id, '咏唱因移动中断', interrupted.name);
      } else {
        this.cast.remaining -= dt;
        if (this.cast.remaining <= 0) {
          const pending = this.cast;
          this.cast = null;
          const completion = this._validateCompletion(pending.action, context);
          if (completion) this._error(pending.action.id, completion, pending.action.name);
          else this._resolve(pending.action, context, pending.mpCost);
        }
      }
    }

    if (this.plugin.tick) this.plugin.tick(this, dt, context);
    if (this.queue && !this.cast && this.gcd <= 0 && this.animationLock <= 0) {
      const queued = this.queue;
      this.queue = null;
      const action = this._findAction(queued.id);
      if (action) {
        const validation = this._validate(action, context, false);
        if (validation.ok) this._begin(action, context);
      }
    }
  }

  _tickCooldowns(dt) {
    for (const cooldown of this.cooldowns.values()) {
      if (cooldown.charges >= cooldown.maxCharges) continue;
      cooldown.timer -= dt;
      while (cooldown.timer <= 0 && cooldown.charges < cooldown.maxCharges) {
        cooldown.charges += 1;
        if (cooldown.charges < cooldown.maxCharges) cooldown.timer += cooldown.recast;
        else cooldown.timer = 0;
      }
    }
  }

  _tickBuffs(dt) {
    for (const [id, buff] of this.buffs) {
      buff.remaining -= dt;
      if (buff.tickInterval) {
        buff.tickRemaining -= dt;
        while (buff.tickRemaining <= 0 && buff.remaining >= -0.001) {
          buff.tickRemaining += buff.tickInterval;
          if (buff.healPotency) this.heal({ id, name: buff.name }, buff.healPotency);
        }
      }
      if (buff.remaining <= 0) {
        this.buffs.delete(id);
        if (this.plugin.onBuffExpire) this.plugin.onBuffExpire(this, buff);
      }
    }
  }

  _tickDots(dt, context) {
    for (let i = this.targetDots.length - 1; i >= 0; i -= 1) {
      const dot = this.targetDots[i];
      dot.remaining -= dt;
      dot.tick -= dt;
      while (dot.tick <= 0 && dot.remaining > -0.001) {
        dot.tick += 3;
        const pseudoAction = { id: dot.actionId, name: dot.name, kind: 'dot', aoe: false, falloff: dot.falloff };
        this.dealDamage(pseudoAction, Object.assign({}, context, { target: true, targets: 1 }), dot.potency, { kind: 'dot', multiplier: dot.snapshotMultiplier });
      }
      if (dot.remaining <= 0) this.targetDots.splice(i, 1);
    }
  }

  _tickMana(dt) {
    this.manaTick -= dt;
    while (this.manaTick <= 0) {
      this.manaTick += 3;
      this.mp = clamp(this.mp + (this.inCombat ? 200 : 600) + (this.hasBuff('lucid') ? 550 : 0), 0, 10000);
    }
  }

  _decorate(base) {
    const copy = Object.assign({}, base);
    return this.plugin.decorate ? this.plugin.decorate(this, copy) : copy;
  }

  _findAction(actionId) {
    const base = getBaseActions(this.jobId).find((candidate) => candidate.id === actionId);
    return base ? this._decorate(base) : null;
  }

  _validate(action, context, displayOnly) {
    const cooldown = this._cooldownSnapshot(action);
    const instant = this._isInstant(action);
    const busyGcd = action.gcd && (this.gcd > 0.001 || this.cast);
    if (busyGcd) {
      const queueWindow = Math.max(this.gcd, this.cast ? this.cast.remaining : 0);
      return { ok: false, queueable: !displayOnly && queueWindow <= 0.5, reason: '公共复唱中' };
    }
    if (this.cast) return { ok: false, reason: '正在咏唱' };
    if (this.animationLock > 0.001) return { ok: false, reason: '动作僵直中' };
    if (cooldown.charges <= 0) return { ok: false, reason: `复唱中 ${round(cooldown.cooldown, 1)}秒` };
    if (action.targetRequired && !context.target) return { ok: false, reason: '没有目标' };
    if (action.targetRequired && action.range > 0 && context.distance > action.range) return { ok: false, reason: '距离过远' };
    if (context.moving && action.cast > 0 && !instant) return { ok: false, reason: '移动中无法咏唱' };
    const mpCost = this._mpCost(action);
    if (mpCost > this.mp) return { ok: false, reason: '魔力不足' };
    if (this.plugin.validate) {
      const reason = this.plugin.validate(this, action, context);
      if (reason) return { ok: false, reason };
    }
    return { ok: true };
  }

  _validateCompletion(action, context) {
    if (action.targetRequired && !context.target) return '目标已丢失';
    if (action.targetRequired && action.range > 0 && context.distance > action.range) return '目标已超出距离';
    return null;
  }

  _begin(action, context) {
    const timing = this.plugin.timing ? this.plugin.timing(this, action) : null;
    const castTime = this._isInstant(action) ? 0 : (timing && timing.cast !== undefined ? timing.cast : action.cast);
    const recast = timing && timing.recast !== undefined ? timing.recast : action.recast;
    const mpCost = this._mpCost(action);
    if (action.kind === 'spell' && action.cast > 0) {
      if (this.hasBuff('swiftcast')) this.removeBuff('swiftcast');
    }
    if (action.gcd) {
      this.gcdTotal = recast;
      this.gcd = recast;
    }
    this._spendCooldown(action);
    if (castTime > 0) {
      this.cast = { action, context: copyContext(context), remaining: castTime, total: castTime, mpCost };
      this.events.push({ type: 'cast', actionId: action.id, name: action.name, potency: 0, color: action.color, jobId: this.jobId });
    } else {
      this._resolve(action, context, mpCost);
    }
  }

  _resolve(action, context, mpCost) {
    this.mp = clamp(this.mp - mpCost, 0, 10000);
    if (action.kind === 'spell' && action.mp > 0 && this.hasBuff('thin-air')) this.removeBuff('thin-air');
    this.animationLock = Math.max(this.animationLock, action.animationLock || 0.7);
    if (action.gcd) this.stats.gcdCount += 1;
    else this.stats.ogcdCount += 1;
    const result = this.plugin.execute ? (this.plugin.execute(this, action, context) || {}) : {};
    const potency = result.potency === undefined ? action.potency : result.potency;
    const dealt = this.dealDamage(Object.assign({}, action, result.action || {}), context, potency, result);
    const healing = result.heal === undefined ? action.heal : result.heal;
    if (healing) this.heal(action, healing);
    if (result.buffEvent) {
      this.events.push({ type: 'buff', actionId: action.id, name: action.name, potency: 0, color: action.color, jobId: this.jobId });
      this.log.push({ time: round(this.combatElapsed), name: action.name, potency: 0, kind: 'buff' });
    }
    if (result.move) {
      this.events.push(Object.assign({ type: 'move', actionId: action.id, name: action.name, jobId: this.jobId }, result.move));
      this.log.push({ time: round(this.combatElapsed), name: action.name, potency: 0, kind: 'move' });
    }
    if (result.field) {
      this.events.push(Object.assign({ type: 'field', actionId: action.id, name: action.name, jobId: this.jobId }, result.field));
      this.log.push({ time: round(this.combatElapsed), name: action.name, potency: 0, kind: 'field' });
    }
    if (dealt > 0 || result.startsCombat) this.inCombat = true;
    if (action.gcd && this.plugin.onGcdResolved) this.plugin.onGcdResolved(this, action, context, result);
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  _isInstant(action) {
    if (!action.cast) return true;
    if (action.kind === 'spell' && this.hasBuff('swiftcast')) return true;
    return Boolean(this.plugin.isInstant && this.plugin.isInstant(this, action));
  }

  _mpCost(action) {
    if (!action.mp || this.hasBuff('thin-air')) return 0;
    return action.mp;
  }

  _cooldownKey(action) {
    return action.cooldownKey || action.id;
  }

  _cooldownSnapshot(action) {
    if (action.noCooldown) return { cooldown: 0, charges: undefined, maxCharges: undefined };
    const cooldownRecast = action.cooldownRecast || action.recast;
    if (!cooldownRecast || action.gcd && !action.maxCharges && !action.cooldownKey) return { cooldown: 0, charges: undefined, maxCharges: undefined };
    const key = this._cooldownKey(action);
    const maxCharges = action.maxCharges || 1;
    const current = this.cooldowns.get(key);
    return {
      cooldown: current && current.charges < current.maxCharges ? current.timer : 0,
      charges: current ? current.charges : maxCharges,
      maxCharges,
    };
  }

  reduceCooldown(actionId, seconds) {
    const cooldown = this.cooldowns.get(actionId);
    if (cooldown && cooldown.charges < cooldown.maxCharges) cooldown.timer = Math.max(0, cooldown.timer - seconds);
  }

  _spendCooldown(action) {
    if (action.noCooldown) return;
    const cooldownRecast = action.cooldownRecast || action.recast;
    if (!cooldownRecast || action.gcd && !action.maxCharges && !action.cooldownKey) return;
    const key = this._cooldownKey(action);
    const maxCharges = action.maxCharges || 1;
    let cooldown = this.cooldowns.get(key);
    if (!cooldown) {
      cooldown = { charges: maxCharges, maxCharges, timer: 0, recast: cooldownRecast };
      this.cooldowns.set(key, cooldown);
    }
    if (cooldown.charges > 0) {
      cooldown.charges -= 1;
      cooldown.recast = cooldownRecast;
      if (cooldown.charges === maxCharges - 1) cooldown.timer = cooldownRecast;
    }
  }

  _error(actionId, reason, name) {
    this.events.push({ type: 'error', actionId, name: name || actionId, reason, potency: 0, jobId: this.jobId });
    return { ok: false, reason };
  }
}
