import { executeRole, validateRole } from './common.js';

const normalNames = [
  ['火炎之红', 'Fire in Red', 440], ['疾风之绿', 'Aero in Green', 480], ['流水之蓝', 'Water in Blue', 520],
];
const subtractiveNames = [
  ['冰结之青', 'Blizzard in Cyan', 800], ['飞石之黄', 'Stone in Yellow', 840], ['闪雷之品红', 'Thunder in Magenta', 880],
];
const normalAoe = [
  ['烈炎之红', 'Fire II in Red', 120], ['烈风之绿', 'Aero II in Green', 140], ['激水之蓝', 'Water II in Blue', 160],
];
const subtractiveAoe = [
  ['冰冻之青', 'Blizzard II in Cyan', 240], ['坚石之黄', 'Stone II in Yellow', 260], ['震雷之品红', 'Thunder II in Magenta', 280],
];
const creatures = [
  ['绒球构想', 'Pom Motif', 'pom'], ['翅膀构想', 'Wing Motif', 'wing'], ['兽爪构想', 'Claw Motif', 'claw'], ['兽牙构想', 'Maw Motif', 'fang'],
];
const muses = {
  pom: ['绒球彩绘', 'Pom Muse'], wing: ['翅膀彩绘', 'Winged Muse'], claw: ['兽爪彩绘', 'Clawed Muse'], fang: ['兽牙彩绘', 'Fanged Muse'],
};

const plugin = {
  id: 'PCT',

  createState(engine) {
    engine.setResource('palette', 0);
    engine.setResource('whitePaint', 0, 5);
    engine.setResource('blackPaint', 0, 1);
    engine.setResource('creatureCanvas', 0, 1);
    engine.setResource('weaponCanvas', 0, 1);
    engine.setResource('landscapeCanvas', 0, 1);
    engine.setResource('portrait', 0, 2);
    return { hue: 0, subtractive: 0, creatureIndex: 0, creatureCanvas: null, depictions: 0, portraits: [], hammerStep: 0, hyper: 0 };
  },

  decorate(engine, action) {
    const state = engine.jobState;
    if (action.id === 'pct-aetherhues' || action.id === 'pct-aetherhues-aoe') {
      const aoe = action.id.endsWith('-aoe');
      const set = state.subtractive > 0 ? (aoe ? subtractiveAoe : subtractiveNames) : (aoe ? normalAoe : normalNames);
      const row = set[state.hue];
      action.name = row[0]; action.en = row[1]; action.potency = row[2];
      action.cast = state.subtractive > 0 ? 2.3 : 1.5;
      action.recast = state.subtractive > 0 ? 3.3 : 2.5;
      action.mp = state.subtractive > 0 ? 400 : 300;
    }
    if (action.id === 'pct-creature-motif') {
      const row = creatures[state.creatureIndex]; action.name = row[0]; action.en = row[1];
    }
    if (action.id === 'pct-living-muse' && state.creatureCanvas) {
      const row = muses[state.creatureCanvas]; action.name = row[0]; action.en = row[1];
    }
    if (action.id === 'pct-portrait' && state.portraits.length) {
      const madeen = state.portraits[0] === 'madeen';
      action.name = madeen ? '马蒂恩的惩罚' : '莫古力激流';
      action.en = madeen ? 'Retribution of the Madeen' : 'Mog of the Ages';
      action.potency = madeen ? 1400 : 1300;
    }
    if (action.id === 'pct-hammer-combo') {
      const rows = [['重锤敲章', 'Hammer Stamp', 560], ['重锤掠刷', 'Hammer Brush', 620], ['重锤抛光', 'Polishing Hammer', 680]];
      const row = rows[state.hammerStep]; action.name = row[0]; action.en = row[1]; action.potency = row[2];
      action.highlight = engine.hasBuff('hammer-time');
    }
    if (action.id === 'pct-rainbow-drip') action.highlight = engine.hasBuff('rainbow-bright');
    if (action.id === 'pct-star-prism') action.highlight = engine.hasBuff('starstruck');
    if (action.id === 'pct-subtractive-palette') action.highlight = engine.resources.palette >= 50 || engine.hasBuff('subtractive-spectrum');
    return action;
  },

  validate(engine, action) {
    const roleReason = validateRole(engine, action);
    if (roleReason) return roleReason;
    const state = engine.jobState;
    switch (action.id) {
      case 'pct-subtractive-palette':
        if (state.subtractive > 0) return '减色混合仍在生效';
        if (engine.resources.palette < 50 && !engine.hasBuff('subtractive-spectrum')) return '调色量谱不足50';
        break;
      case 'pct-holy-in-white':
        if (engine.resources.whitePaint < 1) return '没有白色颜料';
        if (engine.hasBuff('monochrome')) return '单色调期间不可使用';
        break;
      case 'pct-comet-in-black': if (engine.resources.blackPaint < 1 || !engine.hasBuff('monochrome')) return '需要单色调与黑色颜料'; break;
      case 'pct-creature-motif': if (state.creatureCanvas) return '生物画布已有图案'; break;
      case 'pct-living-muse': if (!state.creatureCanvas) return '生物画布为空'; break;
      case 'pct-portrait': if (!state.portraits.length) return '没有可呈现的肖像'; break;
      case 'pct-weapon-motif': if (engine.resources.weaponCanvas || engine.hasBuff('hammer-time')) return '武器画布不可绘制'; break;
      case 'pct-steel-muse': if (!engine.inCombat) return '只能在战斗中使用'; if (!engine.resources.weaponCanvas) return '武器画布为空'; break;
      case 'pct-hammer-combo': if (!engine.hasBuff('hammer-time')) return '需要锤击时刻'; break;
      case 'pct-landscape-motif': if (engine.resources.landscapeCanvas || engine.hasBuff('starry-muse')) return '风景画布不可绘制'; break;
      case 'pct-scenic-muse': if (!engine.inCombat) return '只能在战斗中使用'; if (!engine.resources.landscapeCanvas) return '风景画布为空'; break;
      case 'pct-star-prism': if (!engine.hasBuff('starstruck')) return '需要星极'; break;
      case 'pct-tempera-grassa': if (!engine.hasBuff('tempera-coat')) return '需要坦培拉涂层'; break;
      default: break;
    }
    return null;
  },

  isInstant(engine, action) {
    if ((action.id === 'pct-creature-motif' || action.id === 'pct-weapon-motif' || action.id === 'pct-landscape-motif') && !engine.inCombat) return true;
    if (action.id === 'pct-rainbow-drip' && engine.hasBuff('rainbow-bright')) return true;
    return false;
  },

  timing(engine, action) {
    if (action.id === 'pct-rainbow-drip' && engine.hasBuff('rainbow-bright')) return { cast: 0, recast: 2.5 };
    const inspired = this.inStarryField(engine) && engine.hasBuff('inspiration') && engine.jobState.hyper > 0 &&
      (action.id.startsWith('pct-aetherhues') || ['pct-star-prism', 'pct-holy-in-white', 'pct-comet-in-black'].includes(action.id));
    if (inspired) return { cast: action.cast * 0.75, recast: action.recast * 0.75 };
    return null;
  },

  damageMultiplier(engine) {
    return engine.hasBuff('starry-muse') ? 1.05 : 1;
  },

  execute(engine, action) {
    const role = executeRole(engine, action);
    if (role) return role;
    const state = engine.jobState;
    switch (action.effect) {
      case 'pctAether':
      case 'pctAetherAoe':
        if (state.subtractive > 0) { state.subtractive -= 1; engine.consumeBuff('subtractive-palette'); }
        state.hue += 1;
        if (state.hue >= 3) {
          state.hue = 0;
          engine.removeBuff('aetherhues');
          if (action.name.includes('蓝')) { engine.addResource('palette', 25); this.grantPaint(engine); }
          if (action.name.includes('品红')) this.grantPaint(engine);
        } else engine.addBuff('aetherhues', state.hue === 1 ? '色调' : '色调II', 30, state.hue);
        this.consumeHyper(engine);
        return {};
      case 'pctSubtractive':
        if (engine.hasBuff('subtractive-spectrum')) engine.removeBuff('subtractive-spectrum'); else engine.addResource('palette', -50);
        state.subtractive = 3;
        engine.addBuff('subtractive-palette', '减色混合', 30, 3);
        engine.addBuff('monochrome', '单色调', 30);
        if (engine.resources.whitePaint > 0) { engine.addResource('whitePaint', -1, 5); engine.setResource('blackPaint', 1, 1); }
        return { buffEvent: true };
      case 'pctHoly': engine.addResource('whitePaint', -1, 5); this.consumeHyper(engine); return {};
      case 'pctComet': engine.setResource('blackPaint', 0, 1); engine.removeBuff('monochrome'); this.consumeHyper(engine); return {};
      case 'pctRainbow': this.grantPaint(engine); engine.removeBuff('rainbow-bright'); return {};
      case 'pctCreatureMotif': {
        const painted = creatures[state.creatureIndex][2]; state.creatureCanvas = painted; state.creatureIndex = (state.creatureIndex + 1) % 4; engine.setResource('creatureCanvas', 1, 1); return { buffEvent: true };
      }
      case 'pctLivingMuse':
        state.depictions += 1; state.creatureCanvas = null; engine.setResource('creatureCanvas', 0, 1);
        if (state.depictions === 2) state.portraits.push('moogle');
        if (state.depictions === 4) { state.portraits.push('madeen'); state.depictions = 0; }
        state.portraits = state.portraits.slice(-2); engine.setResource('portrait', state.portraits.length, 2); return {};
      case 'pctPortrait': state.portraits.shift(); engine.setResource('portrait', state.portraits.length, 2); return {};
      case 'pctWeaponMotif': engine.setResource('weaponCanvas', 1, 1); return { buffEvent: true };
      case 'pctSteelMuse': engine.setResource('weaponCanvas', 0, 1); state.hammerStep = 0; engine.addBuff('hammer-time', '锤击时刻', 30, 3); return { buffEvent: true };
      case 'pctHammer': state.hammerStep = (state.hammerStep + 1) % 3; engine.consumeBuff('hammer-time'); return {};
      case 'pctLandscapeMotif': engine.setResource('landscapeCanvas', 1, 1); return { buffEvent: true };
      case 'pctStarryMuse':
        engine.setResource('landscapeCanvas', 0, 1); state.hyper = 5;
        engine.addBuff('starry-muse', '星空彩绘', 20); engine.addBuff('inspiration', '灵感', 30); engine.addBuff('hyperphantasia', '超绝想象', 30, 5);
        engine.addBuff('subtractive-spectrum', '减色光谱', 30); engine.addBuff('starstruck', '星极', 20);
        return { buffEvent: true, field: { id: 'starry-muse', radius: 5, duration: 20, color: '#ecd08d' } };
      case 'pctStarPrism': engine.removeBuff('starstruck'); this.consumeHyper(engine); return { heal: 400 };
      case 'pctSmudge': engine.addBuff('smudge-speed', '速涂', 5, 1, { movementMultiplier: 1.5 }); return { buffEvent: true, move: { kind: 'forward', distance: 15 } };
      case 'pctTemperaCoat': engine.addBuff('tempera-coat', '坦培拉涂层', 10, 1, { shield: engine.maxHp * 0.2 }); return { buffEvent: true };
      case 'pctTemperaGrassa': engine.removeBuff('tempera-coat'); engine.addBuff('tempera-grassa', '坦培拉厚涂', 10, 1, { shield: engine.maxHp * 0.1 }); return { buffEvent: true };
      default: return {};
    }
  },

  grantPaint(engine) {
    if (engine.hasBuff('monochrome') && engine.resources.blackPaint === 0) {
      engine.setResource('blackPaint', 1, 1);
    } else {
      engine.addResource('whitePaint', 1, 5);
    }
  },

  consumeHyper(engine) {
    if (!this.inStarryField(engine) || !engine.hasBuff('inspiration') || engine.jobState.hyper <= 0) return;
    engine.jobState.hyper -= 1;
    const buff = engine.buff('hyperphantasia'); if (buff) buff.stacks = engine.jobState.hyper;
    if (engine.jobState.hyper <= 0) {
      engine.removeBuff('hyperphantasia'); engine.removeBuff('inspiration'); engine.addBuff('rainbow-bright', '彩虹明亮', 30);
    }
  },

  onShieldBreak(engine, buff) {
    if (buff.id === 'tempera-coat') engine.reduceCooldown('pct-tempera-coat', 60);
    if (buff.id === 'tempera-grassa') engine.reduceCooldown('pct-tempera-coat', 30);
  },

  onBuffExpire(engine, buff) {
    if (buff.id === 'aetherhues') engine.jobState.hue = 0;
    if (buff.id === 'subtractive-palette') engine.jobState.subtractive = 0;
    if (buff.id === 'starry-muse') {
      engine.removeBuff('inspiration');
      engine.removeBuff('hyperphantasia');
      engine.jobState.hyper = 0;
    }
  },

  inStarryField(engine) {
    const fields = engine.lastContext.fields;
    return engine.hasBuff('starry-muse') && (!Array.isArray(fields) || fields.includes('starry-muse'));
  },
};

export default plugin;
