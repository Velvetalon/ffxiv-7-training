import { executeRole, validateRole } from './common.js';

const plugin = {
  id: 'RPR',

  createState(engine) {
    engine.setResource('soul', 0);
    engine.setResource('shroud', 0);
    engine.setResource('lemure', 0, 5);
    engine.setResource('void', 0, 5);
    engine.setResource('immortal', 0, 8);
    return { soulsow: false, executioner: 0, soulReaver: 0, perfectioOcculta: false, perfectioReady: false };
  },

  decorate(engine, action) {
    const state = engine.jobState;
    const enshrouded = engine.hasBuff('enshrouded');
    if (action.id === 'rpr-gluttony' && enshrouded) {
      action.name = '祭献'; action.en = 'Sacrificium'; action.potency = 530; action.recast = 1; action.cooldownKey = null; action.noCooldown = true;
      action.description = '魂衣期间消耗献奉，对目标及其周围敌人造成530威力伤害，其余目标伤害降低50%。';
    }
    if (action.id === 'rpr-gibbet') {
      if (enshrouded) { action.name = '虚无收割'; action.en = 'Void Reaping'; action.potency = 500; action.description = '消耗1层夜游魂衣并获得1层虚无魂；与交错收割交替时威力提高。'; }
      else if (state.executioner > 0) { action.name = '处刑绞决'; action.en = "Executioner's Gibbet"; action.potency = 700; action.description = '消耗1层处刑人；侧面攻击及对应强化可分别提高60威力。'; }
    }
    if (action.id === 'rpr-gallows') {
      if (enshrouded) { action.name = '交错收割'; action.en = 'Cross Reaping'; action.potency = 500; action.description = '消耗1层夜游魂衣并获得1层虚无魂；与虚无收割交替时威力提高。'; }
      else if (state.executioner > 0) { action.name = '处刑缢杀'; action.en = "Executioner's Gallows"; action.potency = 700; action.description = '消耗1层处刑人；背面攻击及对应强化可分别提高60威力。'; }
    }
    if (action.id === 'rpr-guillotine') {
      if (enshrouded) { action.name = '阴冷收割'; action.en = 'Grim Reaping'; action.potency = 200; action.description = '对前方敌人造成200威力，消耗1层夜游魂衣并获得1层虚无魂。'; }
      else if (state.executioner > 0) { action.name = '处刑断首'; action.en = "Executioner's Guillotine"; action.potency = 300; action.description = '消耗1层处刑人，对前方敌人造成300威力并增加10点魂衣量谱。'; }
    }
    if (action.id === 'rpr-soul-spender' && enshrouded) {
      action.name = '夜游魂切割'; action.en = "Lemure's Slice"; action.potency = 280; action.description = '消耗2层虚无魂，对单体造成280威力伤害。';
    } else if (action.id === 'rpr-soul-spender' && engine.hasBuff('enhanced-gibbet')) {
      action.name = '隐匿绞决'; action.en = 'Unveiled Gibbet'; action.potency = 440;
    } else if (action.id === 'rpr-soul-spender' && engine.hasBuff('enhanced-gallows')) {
      action.name = '隐匿缢杀'; action.en = 'Unveiled Gallows'; action.potency = 440;
    }
    if (action.id === 'rpr-grim-swathe' && enshrouded) {
      action.name = '夜游魂钐割'; action.en = "Lemure's Scythe"; action.potency = 100; action.description = '消耗2层虚无魂，对前方敌人造成100威力伤害。';
    }
    if (action.id === 'rpr-communio' && state.perfectioReady) {
      action.name = '完美收割'; action.en = 'Perfectio'; action.cast = 0; action.potency = 1200;
      action.description = '消耗完全准备，首个目标1200威力，其余目标伤害降低60%。';
      action.highlight = true;
    }
    if (action.id === 'rpr-soulsow' && state.soulsow) {
      action.name = '收获月'; action.en = 'Harvest Moon'; action.cast = 0; action.range = 25; action.potency = 800; action.aoe = true; action.falloff = 0.5; action.targetRequired = true;
      action.description = '消耗播魂种，首个目标800威力，其余目标伤害降低50%，灵魂量谱增加10。';
      action.highlight = true;
    }
    if ((action.id === 'rpr-hells-ingress' || action.id === 'rpr-hells-egress') && engine.hasBuff('threshold')) {
      action.name = '回退'; action.en = 'Regress'; action.recast = 0; action.noCooldown = true; action.effect = 'rprRegress';
      action.description = '返回地狱门记录的位置并移除地狱门。';
      action.highlight = true;
    }
    return action;
  },

  validate(engine, action) {
    const roleReason = validateRole(engine, action);
    if (roleReason) return roleReason;
    const state = engine.jobState;
    const enshrouded = engine.hasBuff('enshrouded');
    switch (action.id) {
      case 'rpr-gluttony':
        if (enshrouded) { if (!engine.hasBuff('oblatio')) return '需要献奉'; }
        else if (engine.resources.soul < 50) return '灵魂量谱不足50';
        break;
      case 'rpr-gibbet':
      case 'rpr-gallows':
      case 'rpr-guillotine': if (!enshrouded && state.executioner < 1 && state.soulReaver < 1) return '需要灵魂回收或处刑人'; break;
      case 'rpr-soul-spender':
      case 'rpr-grim-swathe':
        if (enshrouded) { if (engine.resources.void < 2) return '虚无魂不足2'; }
        else if (engine.resources.soul < 50) return '灵魂量谱不足50';
        break;
      case 'rpr-enshroud': if (enshrouded) return '已经处于魂衣状态'; if (engine.resources.shroud < 50 && !engine.hasBuff('ideal-host')) return '魂衣量谱不足50'; break;
      case 'rpr-communio': if (!state.perfectioReady && (!enshrouded || engine.resources.lemure < 1)) return '需要魂衣或完全准备'; break;
      case 'rpr-plentiful-harvest': if (engine.resources.immortal < 1) return '没有祭牲'; if (engine.hasBuff('bloodsown-circle')) return '血播之环期间不可使用'; break;
      case 'rpr-regress': if (!engine.hasBuff('threshold')) return '没有地狱门'; break;
      default: break;
    }
    return null;
  },

  isInstant(engine, action) {
    if (action.id === 'rpr-soulsow' && !engine.inCombat) return true;
    if (action.id === 'rpr-harpe' && engine.hasBuff('enhanced-harpe')) return true;
    return false;
  },

  timing(engine, action) {
    if (engine.hasBuff('enshrouded') && ['rpr-gibbet', 'rpr-gallows', 'rpr-guillotine'].includes(action.id)) return { cast: 0, recast: 1.5 };
    return null;
  },

  damageMultiplier(engine, action) {
    let multiplier = 1;
    if (engine.hasBuff('arcane-circle')) multiplier *= 1.03;
    if (engine.targetDots.some((dot) => dot.id === 'deaths-design') && action.kind !== 'dot') multiplier *= 1.1;
    return multiplier;
  },

  execute(engine, action, context) {
    const role = executeRole(engine, action);
    if (role) return role;
    const state = engine.jobState;
    const enshrouded = engine.hasBuff('enshrouded');
    switch (action.effect) {
      case 'rprSlice': engine.addResource('soul', 10); engine.combo = action.id; engine.comboRemaining = 30; return {};
      case 'rprWaxing': {
        const combo = engine.combo === 'rpr-slice'; engine.addResource('soul', combo ? 10 : 0); engine.combo = action.id; engine.comboRemaining = 30; return { potency: combo ? 500 : action.potency };
      }
      case 'rprInfernal': {
        const combo = engine.combo === 'rpr-waxing-slice'; engine.addResource('soul', combo ? 10 : 0); engine.combo = null; engine.comboRemaining = 0; return { potency: combo ? 600 : action.potency };
      }
      case 'rprSpinning': if (this.selfAoeHits(context)) { engine.addResource('soul', 10); engine.combo = action.id; engine.comboRemaining = 30; } return {};
      case 'rprNightmare': { const combo = engine.combo === 'rpr-spinning-scythe'; if (combo && this.selfAoeHits(context)) engine.addResource('soul', 10); engine.combo = null; return { potency: combo ? 200 : action.potency }; }
      case 'rprDeathsDesign': { const multiplier = this.designRemaining(engine) > 0 ? 1.1 : 1; engine.addDot('deaths-design', '死亡设计', Math.min(60, this.designRemaining(engine) + 30), 0, action.id); return { multiplier }; }
      case 'rprDeathsDesignAoe': { const multiplier = this.designRemaining(engine) > 0 ? 1.1 : 1; if (this.selfAoeHits(context)) engine.addDot('deaths-design', '死亡设计', Math.min(60, this.designRemaining(engine) + 30), 0, action.id); return { multiplier }; }
      case 'rprSoulSlice':
      case 'rprSoulScythe': if (this.selfAoeHits(context)) engine.addResource('soul', 50); return {};
      case 'rprGluttony':
        if (enshrouded) { engine.removeBuff('oblatio'); return { falloff: 0.5 }; }
        engine.addResource('soul', -50); state.executioner = 2; engine.addBuff('executioner', '处刑人', 30, 2); return {};
      case 'rprGibbet': return this.executeReaver(engine, action, context, 'flank');
      case 'rprGallows': return this.executeReaver(engine, action, context, 'rear');
      case 'rprGuillotine': return this.executeReaver(engine, action, context, null);
      case 'rprSoulSpender':
      case 'rprGrimSwathe':
        if (enshrouded) { engine.addResource('void', -2, 5); return {}; }
        engine.addResource('soul', -50); state.soulReaver = 1; engine.addBuff('soul-reaver', '灵魂回收', 30); return {};
      case 'rprEnshroud':
        if (engine.hasBuff('ideal-host')) engine.removeBuff('ideal-host'); else engine.addResource('shroud', -50);
        engine.setResource('lemure', 5, 5); engine.setResource('void', 0, 5); engine.addBuff('enshrouded', '魂衣', 30, 5); engine.addBuff('oblatio', '献奉', 30); return { buffEvent: true };
      case 'rprCommunio':
        if (state.perfectioReady) { state.perfectioReady = false; engine.removeBuff('perfectio-parata'); return {}; }
        engine.setResource('lemure', 0, 5); engine.setResource('void', 0, 5); engine.removeBuff('enshrouded');
        if (state.perfectioOcculta) { state.perfectioOcculta = false; engine.removeBuff('perfectio-occulta'); state.perfectioReady = true; engine.addBuff('perfectio-parata', '完全准备', 30); }
        return {};
      case 'rprArcaneCircle': engine.addBuff('arcane-circle', '神秘环', 20); engine.addBuff('circle-of-sacrifice', '献祭之环', 5); engine.addBuff('bloodsown-circle', '血播之环', 6); return { buffEvent: true };
      case 'rprPlentiful': {
        const stacks = engine.resources.immortal; engine.setResource('immortal', 0, 8); engine.addBuff('ideal-host', '理想宿主', 30); state.perfectioOcculta = true; engine.addBuff('perfectio-occulta', '完全收割隐匿', 30); return { potency: Math.min(1000, 720 + 40 * (stacks - 1)) };
      }
      case 'rprSoulsow':
        if (state.soulsow) { state.soulsow = false; engine.addResource('soul', 10); return {}; }
        state.soulsow = true; return { buffEvent: true };
      case 'rprHarpe': engine.addResource('soul', 10); engine.removeBuff('enhanced-harpe'); return {};
      case 'rprCrest': engine.addBuff('arcane-crest', '神秘纹', 5, 1, { shield: engine.maxHp * 0.1 }); return { buffEvent: true };
      case 'rprIngress': engine.addBuff('threshold', '地狱门', 10); engine.addBuff('enhanced-harpe', '强化勾刃', 20); return { move: { kind: 'forward', distance: 15, saveReturn: true } };
      case 'rprEgress': engine.addBuff('threshold', '地狱门', 10); engine.addBuff('enhanced-harpe', '强化勾刃', 20); return { move: { kind: 'backward', distance: 15, saveReturn: true } };
      case 'rprRegress': engine.removeBuff('threshold'); return { move: { kind: 'return', distance: 15 } };
      default: return {};
    }
  },

  executeReaver(engine, action, context, positional) {
    const state = engine.jobState;
    if (engine.hasBuff('enshrouded')) {
      engine.addResource('lemure', -1, 5); engine.addResource('void', 1, 5);
      const enshroud = engine.buff('enshrouded'); if (enshroud) enshroud.stacks = engine.resources.lemure;
      const enhanced = action.id === 'rpr-gibbet' ? engine.hasBuff('enhanced-void') : action.id === 'rpr-gallows' && engine.hasBuff('enhanced-cross');
      engine.removeBuff('enhanced-void'); engine.removeBuff('enhanced-cross');
      engine.addBuff(action.id === 'rpr-gibbet' ? 'enhanced-cross' : 'enhanced-void', action.id === 'rpr-gibbet' ? '交错收割效果提高' : '虚无收割效果提高', 30);
      if (engine.resources.lemure <= 0) { engine.removeBuff('enshrouded'); engine.setResource('void', 0, 5); }
      return { potency: action.potency + (enhanced ? 60 : 0) };
    }
    const executioner = state.executioner > 0;
    if (executioner) { state.executioner -= 1; const buff = engine.buff('executioner'); if (buff) buff.stacks = state.executioner; if (state.executioner <= 0) engine.removeBuff('executioner'); }
    else { state.soulReaver -= 1; if (state.soulReaver <= 0) engine.removeBuff('soul-reaver'); }
    engine.addResource('shroud', 10);
    const enhancedId = action.id === 'rpr-gibbet' ? 'enhanced-gibbet' : 'enhanced-gallows';
    const enhanced = engine.hasBuff(enhancedId);
    engine.removeBuff('enhanced-gibbet'); engine.removeBuff('enhanced-gallows');
    if (action.id === 'rpr-gibbet') engine.addBuff('enhanced-gallows', '缢杀效果提高', 60); else if (action.id === 'rpr-gallows') engine.addBuff('enhanced-gibbet', '绞决效果提高', 60);
    const correctPosition = positional && (context.positional === positional || engine.hasBuff('true-north'));
    return { potency: action.potency + (enhanced ? 60 : 0) + (correctPosition ? 60 : 0) };
  },

  onGcdResolved(engine, action) {
    if (engine.hasBuff('circle-of-sacrifice') && (action.kind === 'spell' || action.kind === 'weaponskill')) {
      engine.addResource('immortal', 1, 8); engine.removeBuff('circle-of-sacrifice');
    }
    const reaverActions = ['rpr-gibbet', 'rpr-gallows', 'rpr-guillotine'];
    if (!reaverActions.includes(action.id) && (engine.jobState.soulReaver > 0 || engine.jobState.executioner > 0)) {
      engine.jobState.soulReaver = 0; engine.jobState.executioner = 0;
      engine.removeBuff('soul-reaver'); engine.removeBuff('executioner');
    }
  },

  onBuffExpire(engine, buff) {
    if (buff.id === 'soul-reaver') engine.jobState.soulReaver = 0;
    if (buff.id === 'executioner') engine.jobState.executioner = 0;
    if (buff.id === 'perfectio-occulta') engine.jobState.perfectioOcculta = false;
    if (buff.id === 'perfectio-parata') engine.jobState.perfectioReady = false;
    if (buff.id === 'enshrouded') { engine.setResource('lemure', 0, 5); engine.setResource('void', 0, 5); }
  },

  onShieldBreak(engine, buff) {
    if (buff.id === 'arcane-crest') engine.addBuff('crest-returned', '活性纹', 15, 1, { tickInterval: 3, healPotency: 50 });
  },

  designRemaining(engine) {
    const dot = engine.targetDots.find((item) => item.id === 'deaths-design');
    return dot ? dot.remaining : 0;
  },

  selfAoeHits(context) {
    return (context.targets || 0) > 0 && context.distance <= 5;
  },
};

export default plugin;
