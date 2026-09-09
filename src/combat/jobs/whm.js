import { executeRole, validateRole } from './common.js';

const plugin = {
  id: 'WHM',

  createState(engine) {
    engine.setResource('lily', 0, 3);
    engine.setResource('bloodLily', 0, 3);
    return { lilyTimer: 20 };
  },

  decorate(engine, action) {
    if (action.id === 'whm-glare-iv') action.highlight = engine.hasBuff('sacred-sight');
    if (action.id === 'whm-afflatus-misery') action.highlight = engine.resources.bloodLily >= 3;
    if (action.id === 'whm-divine-caress') action.highlight = engine.hasBuff('divine-grace');
    if (action.id === 'whm-cure-ii' && engine.hasBuff('freecure')) { action.mp = 0; action.highlight = true; }
    if (action.id === 'whm-liturgy' && engine.hasBuff('liturgy')) {
      action.name = '礼仪之铃结束'; action.en = 'Liturgy of the Bell End'; action.recast = 0; action.noCooldown = true; action.highlight = true;
      action.description = '结束礼仪之铃，并按剩余层数每层触发200恢复力治疗。';
    }
    return action;
  },

  validate(engine, action) {
    const roleReason = validateRole(engine, action);
    if (roleReason) return roleReason;
    if (action.id === 'whm-glare-iv' && !engine.hasBuff('sacred-sight')) return '需要神圣显迹';
    if ((action.id === 'whm-afflatus-solace' || action.id === 'whm-afflatus-rapture') && engine.resources.lily < 1) return '没有治愈百合';
    if (action.id === 'whm-afflatus-misery' && engine.resources.bloodLily < 3) return '血百合尚未满开';
    if (action.id === 'whm-divine-caress' && !engine.hasBuff('divine-grace')) return '需要神爱';
    return null;
  },

  timing(engine, action) {
    if (engine.hasBuff('presence-of-mind') && action.kind === 'spell') {
      return { cast: action.cast * 0.8, recast: action.recast * 0.8 };
    }
    return null;
  },

  execute(engine, action) {
    const role = executeRole(engine, action);
    if (role) return role;
    switch (action.effect) {
      case 'damage': return {};
      case 'whmHoly': if ((engine.lastContext.targets || 0) > 0 && engine.lastContext.distance <= 8) engine.addBuff('target-stun', '眩晕', 4); return {};
      case 'whmDia': engine.addDot('dia', '天辉', 30, 70, action.id); return {};
      case 'whmMisery': engine.setResource('bloodLily', 0, 3); return {};
      case 'whmAssize': engine.mp = Math.min(10000, engine.mp + 500); return { heal: 400 };
      case 'whmPresence':
        engine.addBuff('presence-of-mind', '神速咏唱', 15);
        engine.addBuff('sacred-sight', '神圣显迹', 30, 3);
        return { buffEvent: true };
      case 'whmGlareIv': engine.consumeBuff('sacred-sight'); return {};
      case 'whmLilyHeal':
        engine.addResource('lily', -1, 3);
        engine.addResource('bloodLily', 1, 3);
        return { heal: action.heal + (action.id === 'whm-afflatus-rapture' && engine.hasBuff('confession') ? 200 : 0) };
      case 'whmThinAir': engine.addBuff('thin-air', '无中生有', 12); return { buffEvent: true };
      case 'whmTemperance':
        engine.addBuff('temperance', '节制', 20);
        engine.addBuff('divine-grace', '神爱', 30);
        return { buffEvent: true };
      case 'whmDivineCaress':
        engine.removeBuff('divine-grace');
        engine.addBuff('divine-caress', '神爱抚', 10, 1, { shield: 400, hotOnExpire: true });
        return { buffEvent: true };
      case 'whmBenison': engine.addBuff('divine-benison', '神祝祷', 15, 1, { shield: 500 }); return { buffEvent: true };
      case 'whmAsylum': engine.addBuff('asylum', '庇护所', 24, 1, { tickInterval: 3, healPotency: 100 }); return { buffEvent: true };
      case 'whmPlenary': engine.addBuff('confession', '告解', 10); return { buffEvent: true };
      case 'whmAquaveil': engine.addBuff('aquaveil', '水流幕', 8); return { buffEvent: true };
      case 'whmLiturgy': {
        const active = engine.buff('liturgy');
        if (active) { engine.heal(action, active.stacks * 200); engine.removeBuff('liturgy'); return { buffEvent: true }; }
        engine.addBuff('liturgy', '礼仪之铃', 20, 5); engine.jobState.liturgyLock = 0; return { buffEvent: true };
      }
      case 'whmMedicaIii': engine.addBuff('medica-iii-hot', '医济', 15, 1, { tickInterval: 3, healPotency: 175 }); return { heal: 250 + (engine.hasBuff('confession') ? 200 : 0) };
      case 'whmRegen': engine.addBuff('regen', '再生', 18, 1, { tickInterval: 3, healPotency: 250 }); return { heal: 0 };
      case 'dash': return { buffEvent: true, move: { kind: 'forward', distance: 15 } };
      default:
        if (action.id === 'whm-cure' && Math.random() < 0.15) engine.addBuff('freecure', '救疗效果提高', 15);
        if (action.id === 'whm-cure-ii') engine.removeBuff('freecure');
        return { heal: action.heal + (engine.hasBuff('confession') && ['whm-cure-iii', 'whm-medica'].includes(action.id) ? 200 : 0) };
    }
  },

  tick(engine, dt) {
    engine.jobState.liturgyLock = Math.max(0, (engine.jobState.liturgyLock || 0) - dt);
    if (!engine.inCombat || engine.resources.lily >= 3) return;
    engine.jobState.lilyTimer -= dt;
    if (engine.jobState.lilyTimer <= 0) {
      engine.jobState.lilyTimer += 20;
      engine.addResource('lily', 1, 3);
    }
  },

  onBuffExpire(engine, buff) {
    if (buff.id === 'divine-caress' && buff.hotOnExpire) engine.addBuff('divine-aura', '神爱光环', 15, 1, { tickInterval: 3, healPotency: 200 });
    if (buff.id === 'liturgy' && buff.stacks > 0) engine.heal({ id: 'whm-liturgy', name: '礼仪之铃' }, buff.stacks * 200);
  },

  onDamage(engine) {
    const bell = engine.buff('liturgy');
    if (!bell || engine.jobState.liturgyLock > 0) return;
    engine.heal({ id: 'whm-liturgy', name: '礼仪之铃' }, 400);
    engine.jobState.liturgyLock = 1;
    engine.consumeBuff('liturgy');
  },

  modifyIncomingDamage(engine, amount) {
    let damage = amount;
    if (engine.hasBuff('temperance')) damage *= 0.9;
    if (engine.hasBuff('aquaveil')) damage *= 0.85;
    return damage;
  },

  modifyHealing(engine, action, potency) {
    let healing = potency;
    if (engine.hasBuff('asylum')) healing *= 1.1;
    if (engine.hasBuff('temperance') && action.kind === 'spell') healing *= 1.2;
    return healing;
  },
};

export default plugin;
