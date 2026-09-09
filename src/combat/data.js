const action = (id, name, en, kind, gcd, options) => Object.assign({
  id,
  name,
  en,
  icon: kind === 'weaponskill' ? 'sword' : kind === 'spell' ? 'sparkles' : 'zap',
  kind,
  gcd,
  cast: 0,
  recast: gcd ? 2.5 : 0,
  range: 0,
  potency: 0,
  description: '',
  slot: 99,
}, options || {});

const spell = (id, name, en, options) => action(id, name, en, 'spell', true, options);
const weapon = (id, name, en, options) => action(id, name, en, 'weaponskill', true, options);
const ability = (id, name, en, options) => action(id, name, en, 'ability', false, options);

export const JOBS = [
  {
    id: 'WHM', name: '白魔法师', en: 'WHITE MAGE', role: '治疗职业', color: '#e8e0cf',
    description: '以持续伤害、百合治疗和爆发性神圣魔法为核心的纯治疗职业。',
    resources: [
      { key: 'lily', name: '治愈百合', max: 3, color: '#9ee8ff' },
      { key: 'bloodLily', name: '血百合', max: 3, color: '#e76d8d' },
    ],
  },
  {
    id: 'PCT', name: '绘灵法师', en: 'PICTOMANCER', role: '远程魔法职业', color: '#d980c5',
    description: '循环调色魔法，并把生物、武器与风景画布转化为爆发伤害。',
    resources: [
      { key: 'palette', name: '调色量谱', max: 100, color: '#cdb5ff' },
      { key: 'whitePaint', name: '白色颜料', max: 5, color: '#f4f0dc' },
      { key: 'blackPaint', name: '黑色颜料', max: 1, color: '#55515f' },
      { key: 'creatureCanvas', name: '生物画布', max: 1, color: '#ef8da8' },
      { key: 'weaponCanvas', name: '武器画布', max: 1, color: '#f2bd66' },
      { key: 'landscapeCanvas', name: '风景画布', max: 1, color: '#7dd9c8' },
      { key: 'portrait', name: '肖像', max: 2, color: '#8ca8ff' },
    ],
  },
  {
    id: 'RPR', name: '钐镰客', en: 'REAPER', role: '近战物理职业', color: '#9f668d',
    description: '积累灵魂与魂衣量谱，借虚无化身执行高密度连击。',
    resources: [
      { key: 'soul', name: '灵魂量谱', max: 100, color: '#d63c67' },
      { key: 'shroud', name: '魂衣量谱', max: 100, color: '#65d9cf' },
      { key: 'lemure', name: '夜游魂衣', max: 5, color: '#77e5dd' },
      { key: 'void', name: '虚无魂', max: 5, color: '#a877db' },
      { key: 'immortal', name: '祭牲', max: 8, color: '#e7c7db' },
    ],
  },
];

const healerRole = [
  ability('role-lucid-dreaming', '醒梦', 'Lucid Dreaming', { icon: 'droplets', recast: 60, effect: 'lucid', description: '持续21秒，每3秒恢复550点魔力。' }),
  ability('role-swiftcast', '即刻咏唱', 'Swiftcast', { icon: 'wind', recast: 40, effect: 'swiftcast', description: '10秒内下一次有咏唱时间的魔法变为瞬发。' }),
  spell('role-esuna', '康复', 'Esuna', { icon: 'sparkle', cast: 1, mp: 400, range: 30, effect: 'esuna', description: '解除一个可被净化的弱化效果。' }),
  spell('role-raise', '复活', 'Raise', { icon: 'heart-pulse', cast: 8, mp: 2400, range: 30, effect: 'raise', description: '令目标进入衰弱状态并复活；单人训练中记录施法与魔力消耗。' }),
  ability('role-surecast', '沉稳咏唱', 'Surecast', { icon: 'shield', recast: 120, effect: 'surecast', description: '6秒内咏唱不会因多数伤害打断，并免疫多数击退与吸引。' }),
  spell('role-repose', '休眠', 'Repose', { icon: 'moon', cast: 2.5, mp: 600, range: 30, targetRequired: true, effect: 'repose', description: '令目标陷入睡眠30秒；受到伤害时解除。' }),
  ability('role-rescue', '营救', 'Rescue', { icon: 'move', recast: 120, range: 30, effect: 'rescue', description: '将队员拉向自身；单人训练中仅记录动作。' }),
];

const casterRole = [
  ability('role-addle', '昏乱', 'Addle', { icon: 'shield-alert', recast: 90, range: 25, targetRequired: true, effect: 'addle', description: '令目标造成的魔法伤害降低10%、物理伤害降低5%，持续15秒。' }),
  ability('role-lucid-dreaming', '醒梦', 'Lucid Dreaming', { icon: 'droplets', recast: 60, effect: 'lucid', description: '持续21秒，每3秒恢复550点魔力。' }),
  ability('role-swiftcast', '即刻咏唱', 'Swiftcast', { icon: 'wind', recast: 40, effect: 'swiftcast', description: '10秒内下一次有咏唱时间的魔法变为瞬发。' }),
  ability('role-surecast', '沉稳咏唱', 'Surecast', { icon: 'shield', recast: 120, effect: 'surecast', description: '6秒内咏唱不会因多数伤害打断，并免疫多数击退与吸引。' }),
  spell('role-sleep', '催眠', 'Sleep', { icon: 'moon', cast: 2.5, mp: 800, range: 30, effectRange: 5, targetRequired: true, effect: 'sleep', description: '令目标及其附近敌人陷入睡眠30秒；受到伤害时解除。' }),
];

const meleeRole = [
  ability('role-second-wind', '内丹', 'Second Wind', { icon: 'heart', recast: 120, heal: 800, effect: 'heal', description: '恢复自身生命值，恢复力800。' }),
  ability('role-leg-sweep', '扫腿', 'Leg Sweep', { icon: 'footprints', recast: 40, range: 3, targetRequired: true, effect: 'stun', description: '令目标眩晕3秒。' }),
  ability('role-bloodbath', '浴血', 'Bloodbath', { icon: 'heart-handshake', recast: 90, effect: 'bloodbath', description: '20秒内将物理攻击造成伤害的一部分转化为自身生命值。' }),
  ability('role-feint', '牵制', 'Feint', { icon: 'shield-alert', recast: 90, range: 10, targetRequired: true, effect: 'feint', description: '令目标造成的物理伤害降低10%、魔法伤害降低5%，持续15秒。' }),
  ability('role-arms-length', '亲疏自行', "Arm's Length", { icon: 'hand', recast: 120, effect: 'armsLength', description: '6秒内免疫多数击退与吸引，并对攻击者附加减速。' }),
  ability('role-true-north', '真北', 'True North', { icon: 'compass', recast: 45, maxCharges: 2, effect: 'trueNorth', description: '10秒内无视攻击方向要求，最多积累2档。' }),
];

const whm = [
  spell('whm-glare-iii', '闪耀', 'Glare III', { slot: 1, icon: 'sun', cast: 1.5, mp: 400, range: 25, potency: 330, targetRequired: true, effect: 'damage', description: '对单体造成330威力无属性魔法伤害。' }),
  spell('whm-dia', '天辉', 'Dia', { slot: 2, icon: 'sun-medium', mp: 400, range: 25, potency: 70, targetRequired: true, effect: 'whmDia', description: '造成70威力伤害，并附加30秒持续伤害，每3秒70威力。' }),
  spell('whm-holy-iii', '豪圣', 'Holy III', { slot: 3, icon: 'sparkles', cast: 2.5, mp: 400, potency: 150, aoe: true, selfAoe: true, effectRange: 8, falloff: 1, effect: 'whmHoly', description: '对自身周围8米内全部敌人造成150威力伤害并眩晕4秒。' }),
  spell('whm-afflatus-misery', '苦难之心', 'Afflatus Misery', { slot: 4, icon: 'flower-2', range: 25, potency: 1320, aoe: true, falloff: 0.5, targetRequired: true, effect: 'whmMisery', description: '血百合满开时可用；首个目标1320威力，其余目标伤害降低50%。' }),
  ability('whm-assize', '法令', 'Assize', { slot: 5, icon: 'circle-dot', recast: 40, potency: 400, aoe: true, selfAoe: true, effectRange: 15, falloff: 1, heal: 400, effect: 'whmAssize', description: '对自身周围15米内敌人造成400威力伤害，恢复队伍生命值并恢复最大魔力的5%。' }),
  ability('whm-presence-of-mind', '神速咏唱', 'Presence of Mind', { slot: 6, icon: 'fast-forward', recast: 120, effect: 'whmPresence', description: '15秒内魔法咏唱与复唱缩短20%，并获得3层神圣显迹，可施放闪耀神圣。' }),
  spell('whm-glare-iv', '闪耀神圣', 'Glare IV', { slot: 7, icon: 'sunrise', range: 25, potency: 640, aoe: true, falloff: 0.6, targetRequired: true, effect: 'whmGlareIv', description: '消耗1层神圣显迹；首个目标640威力，其余目标伤害降低40%。' }),
  spell('whm-afflatus-solace', '安慰之心', 'Afflatus Solace', { slot: 8, icon: 'heart', range: 30, heal: 800, effect: 'whmLilyHeal', description: '消耗1朵治愈百合，恢复单体生命值并滋养血百合。' }),
  spell('whm-afflatus-rapture', '狂喜之心', 'Afflatus Rapture', { slot: 9, icon: 'heart-pulse', heal: 400, effect: 'whmLilyHeal', description: '消耗1朵治愈百合，恢复周围队员生命值并滋养血百合。' }),
  ability('whm-thin-air', '无中生有', 'Thin Air', { slot: 10, icon: 'cloud', recast: 60, maxCharges: 2, effect: 'whmThinAir', description: '12秒内下一次魔法不消耗魔力，最多积累2档。' }),
  ability('whm-temperance', '节制', 'Temperance', { slot: 11, icon: 'shield-check', recast: 120, effect: 'whmTemperance', description: '20秒内治疗魔法效果提高20%、自身与队员受到伤害降低10%，并获得30秒神爱。' }),
  ability('whm-divine-caress', '神爱抚', 'Divine Caress', { slot: 12, icon: 'shield-plus', recast: 1, effect: 'whmDivineCaress', description: '消耗神爱，为周围队员附加400恢复力护盾；护盾结束后获得15秒、每3秒200恢复力的持续治疗。' }),
  ability('whm-benediction', '天赐祝福', 'Benediction', { slot: 13, icon: 'badge-plus', recast: 180, heal: 99999, effect: 'heal', description: '将目标生命值完全恢复。' }),
  ability('whm-tetragrammaton', '神名', 'Tetragrammaton', { slot: 14, icon: 'cross', recast: 60, maxCharges: 2, range: 30, heal: 700, effect: 'heal', description: '恢复单体生命值，恢复力700；98级特性后最多积累2档。' }),
  ability('whm-divine-benison', '神祝祷', 'Divine Benison', { slot: 15, icon: 'shield', recast: 30, maxCharges: 2, range: 30, effect: 'whmBenison', description: '为目标附加相当于500恢复力的护盾，持续15秒，最多积累2档。' }),
  ability('whm-asylum', '庇护所', 'Asylum', { slot: 16, icon: 'circle', recast: 90, range: 30, effect: 'whmAsylum', description: '设置24秒治疗区域，每3秒恢复100恢复力，并使受到的治疗提高10%。' }),
  ability('whm-plenary-indulgence', '全大赦', 'Plenary Indulgence', { slot: 17, icon: 'users', recast: 60, effect: 'whmPlenary', description: '10秒内群体治疗魔法额外触发200恢复力治疗。' }),
  ability('whm-aquaveil', '水流幕', 'Aquaveil', { slot: 18, icon: 'waves', recast: 60, range: 30, effect: 'whmAquaveil', description: '令目标受到的伤害降低15%，持续8秒。' }),
  ability('whm-liturgy', '礼仪之铃', 'Liturgy of the Bell', { slot: 19, icon: 'bell', recast: 180, range: 30, effect: 'whmLiturgy', description: '设置20秒治疗铃并获得5层；受击时最多每秒触发一次400恢复力群疗。' }),
  spell('whm-cure', '治疗', 'Cure', { slot: 20, icon: 'heart', cast: 1.5, mp: 400, range: 30, heal: 500, effect: 'heal', description: '恢复单体生命值，恢复力500。' }),
  spell('whm-cure-ii', '救疗', 'Cure II', { slot: 21, icon: 'heart', cast: 2, mp: 1000, range: 30, heal: 800, effect: 'heal', description: '恢复单体生命值，恢复力800。' }),
  spell('whm-cure-iii', '愈疗', 'Cure III', { slot: 22, icon: 'hearts', cast: 2, mp: 1500, range: 30, heal: 600, effect: 'heal', description: '恢复目标及其周围队员生命值，恢复力600。' }),
  spell('whm-medica', '医治', 'Medica', { slot: 23, icon: 'users', cast: 2, mp: 900, heal: 400, effect: 'heal', description: '恢复周围队员生命值，恢复力400。' }),
  spell('whm-medica-iii', '医济', 'Medica III', { slot: 24, icon: 'activity', cast: 2, mp: 1000, heal: 250, effect: 'whmMedicaIii', description: '恢复力250，并附加15秒、每3秒175恢复力的持续治疗。' }),
  spell('whm-regen', '再生', 'Regen', { icon: 'refresh-cw', mp: 400, range: 30, heal: 250, effect: 'whmRegen', description: '附加18秒持续治疗，每3秒250恢复力。' }),
  ability('whm-aetherial-shift', '以太变移', 'Aetherial Shift', { icon: 'move-right', recast: 60, effect: 'dash', description: '向前快速移动15米。' }),
  ...healerRole,
];

const pct = [
  spell('pct-aetherhues', '火炎之红', 'Fire in Red', { slot: 1, icon: 'palette', cast: 1.5, mp: 300, range: 25, potency: 440, targetRequired: true, effect: 'pctAether', description: '依调色状态在火炎之红、疾风之绿、流水之蓝及减色三连之间变换。' }),
  spell('pct-aetherhues-aoe', '烈炎之红', 'Fire II in Red', { slot: 2, icon: 'paint-bucket', cast: 1.5, mp: 300, range: 25, potency: 120, aoe: true, falloff: 1, targetRequired: true, effect: 'pctAetherAoe', description: '依调色状态变换为对应范围魔法，命中目标及其周围敌人。' }),
  ability('pct-subtractive-palette', '减色混合', 'Subtractive Palette', { slot: 3, icon: 'blend', recast: 1, effect: 'pctSubtractive', description: '消耗50点调色量谱，获得3层减色混合，并将1层白色颜料转换为黑色颜料。' }),
  spell('pct-holy-in-white', '神圣之白', 'Holy in White', { slot: 4, icon: 'sparkle', range: 25, potency: 520, aoe: true, falloff: 0.4, targetRequired: true, effect: 'pctHoly', description: '消耗1层白色颜料；首个目标520威力，其余目标伤害降低60%。单色调期间不可用。' }),
  spell('pct-comet-in-black', '彗星之黑', 'Comet in Black', { slot: 5, icon: 'circle-dot-dashed', recast: 3.3, range: 25, potency: 880, aoe: true, falloff: 0.4, targetRequired: true, effect: 'pctComet', description: '单色调期间消耗1层黑色颜料；首个目标880威力，其余目标伤害降低60%。' }),
  spell('pct-rainbow-drip', '彩虹泼墨', 'Rainbow Drip', { slot: 6, icon: 'rainbow', cast: 4, recast: 6, range: 25, potency: 1000, aoe: true, falloff: 0.15, targetRequired: true, effect: 'pctRainbow', description: '直线范围首个目标1000威力，其余目标伤害降低85%，并获得1层白色颜料；彩虹明亮时瞬发且复唱缩短。' }),
  spell('pct-creature-motif', '绒球构想', 'Pom Motif', { slot: 7, icon: 'rabbit', cast: 3, recast: 4, effect: 'pctCreatureMotif', description: '依次绘制绒球、翅膀、兽爪、兽牙；脱战时瞬发，生物画布必须为空。' }),
  ability('pct-living-muse', '绒球彩绘', 'Pom Muse', { slot: 8, icon: 'wand-sparkles', recast: 40, maxCharges: 3, range: 25, potency: 1100, aoe: true, falloff: 0.4, targetRequired: true, effect: 'pctLivingMuse', description: '呈现当前生物画布并随图案变换技能；首个目标1100威力，最多积累3档。' }),
  ability('pct-portrait', '莫古力激流', 'Mog of the Ages', { slot: 9, icon: 'image', recast: 30, range: 25, potency: 1300, aoe: true, falloff: 0.4, targetRequired: true, effect: 'pctPortrait', description: '依当前肖像变为莫古力激流或马蒂恩的惩罚，造成1300或1400威力直线范围伤害。' }),
  spell('pct-weapon-motif', '锤子构想', 'Hammer Motif', { slot: 10, icon: 'hammer', cast: 3, recast: 4, effect: 'pctWeaponMotif', description: '绘制锤子；脱战时瞬发，武器画布必须为空。' }),
  ability('pct-steel-muse', '锤子彩绘', 'Striking Muse', { slot: 11, icon: 'hammer', recast: 60, maxCharges: 2, effect: 'pctSteelMuse', description: '战斗中消耗锤子画布，获得3层锤击时刻；最多积累2档。' }),
  weapon('pct-hammer-combo', '重锤敲章', 'Hammer Stamp', { slot: 12, icon: 'hammer', range: 25, potency: 560, aoe: true, falloff: 0.4, targetRequired: true, effect: 'pctHammer', description: '依次变为重锤敲章、重锤掠刷、重锤抛光，威力560/620/680，均为暴击直击。' }),
  spell('pct-landscape-motif', '星空构想', 'Starry Sky Motif', { slot: 13, icon: 'telescope', cast: 3, recast: 4, effect: 'pctLandscapeMotif', description: '绘制星空；脱战时瞬发，风景画布必须为空。' }),
  ability('pct-scenic-muse', '星空彩绘', 'Starry Muse', { slot: 14, icon: 'stars', recast: 120, effect: 'pctStarryMuse', description: '战斗中消耗星空画布；20秒内伤害提高5%，获得5层超绝想象、星极与减色光谱。' }),
  spell('pct-star-prism', '天星棱光', 'Star Prism', { slot: 15, icon: 'star', range: 25, potency: 1400, aoe: true, falloff: 0.4, targetRequired: true, heal: 400, effect: 'pctStarPrism', description: '消耗星极；首个目标1400威力，其余目标伤害降低60%，并恢复队伍生命值。' }),
  ability('pct-smudge', '速涂', 'Smudge', { slot: 16, icon: 'move-right', recast: 20, effect: 'pctSmudge', description: '向前快速移动15米，并提高移动速度5秒。' }),
  ability('pct-tempera-coat', '坦培拉涂层', 'Tempera Coat', { slot: 17, icon: 'shield', recast: 120, effect: 'pctTemperaCoat', description: '获得相当于最大生命20%的护盾，持续10秒；护盾破裂时复唱缩短60秒。' }),
  ability('pct-tempera-grassa', '坦培拉厚涂', 'Tempera Grassa', { slot: 18, icon: 'shield-plus', recast: 1, effect: 'pctTemperaGrassa', description: '移除涂层，为周围队员附加相当于最大生命10%的护盾，持续10秒。' }),
  ...casterRole,
];

const rpr = [
  weapon('rpr-slice', '切割', 'Slice', { slot: 1, range: 3, potency: 420, targetRequired: true, effect: 'rprSlice', description: '造成420威力伤害，灵魂量谱增加10。' }),
  weapon('rpr-waxing-slice', '增盈切割', 'Waxing Slice', { slot: 2, range: 3, potency: 260, targetRequired: true, effect: 'rprWaxing', description: '切割连击时威力500，灵魂量谱增加10。' }),
  weapon('rpr-infernal-slice', '地狱切割', 'Infernal Slice', { slot: 3, range: 3, potency: 280, targetRequired: true, effect: 'rprInfernal', description: '增盈切割连击时威力600，灵魂量谱增加10。' }),
  weapon('rpr-shadow-of-death', '死亡之影', 'Shadow of Death', { slot: 4, range: 3, potency: 300, targetRequired: true, effect: 'rprDeathsDesign', description: '造成300威力伤害，使自身对目标造成的伤害提高10%，持续30秒，可延长至60秒。' }),
  weapon('rpr-soul-slice', '灵魂切割', 'Soul Slice', { slot: 5, range: 3, potency: 460, targetRequired: true, recast: 2.5, cooldownRecast: 30, maxCharges: 2, cooldownKey: 'rpr-soul-slice', effect: 'rprSoulSlice', description: '造成460威力伤害，灵魂量谱增加50；与灵魂钐割共享2档充能。' }),
  ability('rpr-gluttony', '暴食', 'Gluttony', { slot: 6, icon: 'skull', recast: 60, range: 25, potency: 520, aoe: true, falloff: 0.75, targetRequired: true, effect: 'rprGluttony', description: '消耗50灵魂；首个目标520威力，其余目标伤害降低25%，获得2层处刑人。魂衣期间变为祭献。' }),
  weapon('rpr-gibbet', '绞决', 'Gibbet', { slot: 7, range: 3, potency: 500, targetRequired: true, effect: 'rprGibbet', description: '依状态变为处刑绞决或虚无收割；普通与处刑形态的正确侧面可提高威力。' }),
  weapon('rpr-gallows', '缢杀', 'Gallows', { slot: 8, range: 3, potency: 500, targetRequired: true, effect: 'rprGallows', description: '依状态变为处刑缢杀或交错收割；普通与处刑形态的正确背面可提高威力。' }),
  ability('rpr-soul-spender', '隐匿挥割', 'Blood Stalk', { slot: 9, icon: 'ghost', recast: 1, range: 3, potency: 340, targetRequired: true, effect: 'rprSoulSpender', description: '消耗50灵魂获得灵魂回收；强化状态时变为隐匿绞决/缢杀，魂衣时变为夜游魂切割。' }),
  ability('rpr-enshroud', '魂衣', 'Enshroud', { slot: 10, icon: 'ghost', recast: 15, effect: 'rprEnshroud', description: '消耗50魂衣量谱并获得5层夜游魂衣；理想宿主可免除消耗。' }),
  spell('rpr-communio', '团契', 'Communio', { slot: 11, icon: 'circle-dot', cast: 1.3, range: 25, potency: 1100, aoe: true, falloff: 0.4, targetRequired: true, effect: 'rprCommunio', description: '魂衣中消耗剩余夜游魂衣并结束魂衣；首个目标1100威力。准备完全时变为完美收割。' }),
  ability('rpr-arcane-circle', '神秘环', 'Arcane Circle', { slot: 12, icon: 'circle', recast: 120, effect: 'rprArcaneCircle', description: '20秒内伤害提高3%；5秒献祭之环内自身首次成功战技/魔法获得1层祭牲。' }),
  weapon('rpr-plentiful-harvest', '大丰收', 'Plentiful Harvest', { slot: 13, range: 15, potency: 720, aoe: true, falloff: 0.4, targetRequired: true, effect: 'rprPlentiful', description: '消耗全部祭牲，1层720威力，每多1层提高40，最多1000；获得理想宿主和完美收割隐匿。' }),
  spell('rpr-soulsow', '播魂种', 'Soulsow', { slot: 14, icon: 'moon', cast: 5, effect: 'rprSoulsow', description: '脱战时瞬发并准备收获月；准备后此槽变为收获月。' }),
  spell('rpr-harpe', '勾刃', 'Harpe', { slot: 15, icon: 'send', cast: 1.3, range: 25, potency: 300, targetRequired: true, effect: 'rprHarpe', description: '远程300威力；地狱入境/出境后获得强化勾刃，使下一次勾刃瞬发。' }),
  weapon('rpr-spinning-scythe', '旋转钐割', 'Spinning Scythe', { slot: 16, range: 0, potency: 160, aoe: true, selfAoe: true, effectRange: 5, falloff: 1, effect: 'rprSpinning', description: '对自身周围5米内敌人造成160威力伤害，灵魂量谱增加10。' }),
  weapon('rpr-nightmare-scythe', '噩梦钐割', 'Nightmare Scythe', { slot: 17, range: 0, potency: 140, aoe: true, selfAoe: true, effectRange: 5, falloff: 1, effect: 'rprNightmare', description: '对自身周围5米内敌人攻击；旋转钐割连击时威力200，灵魂量谱增加10。' }),
  weapon('rpr-whorl-of-death', '死亡之涡', 'Whorl of Death', { slot: 18, range: 0, potency: 100, aoe: true, selfAoe: true, effectRange: 5, falloff: 1, effect: 'rprDeathsDesignAoe', description: '对自身周围5米内敌人造成100威力，并附加30秒死亡设计，可延长至60秒。' }),
  weapon('rpr-soul-scythe', '灵魂钐割', 'Soul Scythe', { slot: 19, range: 0, potency: 180, aoe: true, selfAoe: true, effectRange: 5, falloff: 1, recast: 2.5, cooldownRecast: 30, maxCharges: 2, cooldownKey: 'rpr-soul-slice', effect: 'rprSoulScythe', description: '对自身周围5米内敌人造成180威力，灵魂量谱增加50；与灵魂切割共享2档充能。' }),
  ability('rpr-grim-swathe', '束缚挥割', 'Grim Swathe', { slot: 20, icon: 'ghost', recast: 1, range: 8, potency: 140, aoe: true, falloff: 1, targetRequired: true, effect: 'rprGrimSwathe', description: '消耗50灵魂，对前方敌人造成140威力并获得灵魂回收；魂衣时变为夜游魂钐割。' }),
  weapon('rpr-guillotine', '断首', 'Guillotine', { slot: 21, range: 8, potency: 200, aoe: true, falloff: 1, targetRequired: true, effect: 'rprGuillotine', description: '依状态变为处刑断首或阴冷收割，对前方敌人造成范围伤害。' }),
  ability('rpr-arcane-crest', '神秘纹', 'Arcane Crest', { slot: 22, icon: 'shield', recast: 30, effect: 'rprCrest', description: '获得相当于最大生命10%的护盾，持续5秒；破裂后附加15秒持续治疗。' }),
  ability('rpr-hells-ingress', '地狱入境', "Hell's Ingress", { slot: 23, icon: 'move-right', recast: 20, cooldownKey: 'rpr-hellsgate', effect: 'rprIngress', description: '向前移动15米，留下10秒地狱门并获得20秒强化勾刃；门存在时变为回退。' }),
  ability('rpr-hells-egress', '地狱出境', "Hell's Egress", { slot: 24, icon: 'move-left', recast: 20, cooldownKey: 'rpr-hellsgate', effect: 'rprEgress', description: '向后移动15米，留下10秒地狱门并获得20秒强化勾刃；门存在时变为回退。' }),
  ...meleeRole,
];

export const ACTIONS = { WHM: whm, PCT: pct, RPR: rpr };

export const getBaseActions = (jobId) => ACTIONS[jobId] || ACTIONS.WHM;
