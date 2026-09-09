import assert from 'node:assert/strict';
import { createCombat, JOBS } from '../src/combat/index.js';

const base = { moving: false, distance: 3, positional: 'rear', target: true, targets: 1 };
const context = (extra) => Object.assign({}, base, extra || {});

function tick(combat, seconds, extra) {
  combat.tick(seconds, context(extra));
}

function settle(combat, extra) {
  let guard = 0;
  while (guard++ < 1000) {
    const state = combat.getState();
    if (!state.cast && state.gcd <= 0 && state.animationLock <= 0) return;
    tick(combat, 0.05, extra);
  }
  throw new Error('settle timeout');
}

function use(combat, id, extra) {
  const result = combat.use(id, context(extra));
  assert.equal(result.ok, true, `${id}: ${result.reason || 'failed'}`);
  return result;
}

function useAndSettle(combat, id, extra) {
  use(combat, id, extra);
  settle(combat, extra);
}

function action(combat, id) {
  const found = combat.getActions().find((item) => item.id === id);
  assert.ok(found, `missing action ${id}`);
  return found;
}

function verifyContract() {
  assert.deepEqual(JOBS.map((job) => job.id), ['WHM', 'PCT', 'RPR']);
  for (const job of JOBS) {
    const combat = createCombat(job.id);
    assert.ok(combat.getActions().length >= 20, `${job.id} roster too small`);
    assert.ok(job.resources.length >= 2, `${job.id} resource declarations missing`);
    tick(combat, 5);
    assert.equal(combat.getState().stats.elapsed, 0, 'pre-pull idle counted in PPS');
  }
}

function verifyCommonTiming() {
  const cast = createCombat('WHM');
  use(cast, 'whm-glare-iii');
  tick(cast, 0.4, { moving: true });
  assert.equal(cast.getState().cast, null, 'movement did not interrupt cast');
  assert.equal(cast.getState().stats.potency, 0);
  assert.equal(cast.drainEvents().at(-1).reason, '咏唱因移动中断');

  const liveTarget = createCombat('WHM');
  use(liveTarget, 'whm-glare-iii');
  tick(liveTarget, 1.6, { target: false, targets: 0 });
  assert.equal(liveTarget.getState().stats.potency, 0, 'cast resolved on lost target');

  const thin = createCombat('WHM');
  use(thin, 'whm-thin-air');
  tick(thin, 0.8);
  useAndSettle(thin, 'whm-glare-iii');
  assert.equal(thin.getState().mp, 10000, 'Thin Air did not make spell free');
  assert.equal(thin.getState().buffs.some((buff) => buff.id === 'thin-air'), false, 'Thin Air was not consumed');

  const queued = createCombat('WHM');
  use(queued, 'whm-dia');
  tick(queued, 2.1);
  assert.equal(queued.use('whm-glare-iii', context()).ok, true, 'GCD queue rejected');
  tick(queued, 0.5, { target: false, targets: 0 });
  assert.equal(queued.getState().stats.gcdCount, 1, 'queued action ignored live target context');
}

function verifyWhm() {
  const tetra = createCombat('WHM');
  assert.equal(action(tetra, 'whm-tetragrammaton').maxCharges, 2, 'level 98 Tetragrammaton charges missing');
  use(tetra, 'whm-tetragrammaton'); tick(tetra, 0.8);
  use(tetra, 'whm-tetragrammaton'); tick(tetra, 0.8);
  assert.equal(action(tetra, 'whm-tetragrammaton').charges, 0);

  const area = createCombat('WHM');
  useAndSettle(area, 'whm-holy-iii', { target: false, targets: 3, distance: 9 });
  assert.equal(area.getState().stats.potency, 0, 'Holy hit outside 8 yalms');
  area.reset();
  useAndSettle(area, 'whm-holy-iii', { target: false, targets: 3, distance: 7 });
  assert.equal(area.getState().stats.potency, 450, 'Holy nearby AoE total wrong');

  const combat = createCombat('WHM');
  assert.equal(combat.getState().resources.lily, 0);
  useAndSettle(combat, 'whm-dia');
  use(combat, 'whm-presence-of-mind');
  tick(combat, 0.8);
  for (let i = 0; i < 3; i += 1) useAndSettle(combat, 'whm-glare-iv');
  assert.equal(combat.getState().buffs.some((buff) => buff.id === 'sacred-sight'), false);
  tick(combat, 60);
  assert.equal(combat.getState().resources.lily, 3, 'lily generation failed');
  for (let i = 0; i < 3; i += 1) useAndSettle(combat, 'whm-afflatus-solace');
  assert.equal(combat.getState().resources.bloodLily, 3);
  useAndSettle(combat, 'whm-afflatus-misery', { targets: 3 });
  assert.equal(combat.getState().resources.bloodLily, 0);
  assert.ok(combat.getState().stats.potency >= 70 + 3 * 640 + 1320 * 2, 'WHM representative potency too low');

  use(combat, 'whm-temperance'); tick(combat, 0.8);
  combat.hp = 5000;
  use(combat, 'whm-asylum'); tick(combat, 0.8);
  useAndSettle(combat, 'whm-cure');
  assert.equal(combat.getState().hp, 5770, 'Temperance/Asylum healing modifiers or Asylum tick wrong');
  use(combat, 'whm-divine-caress'); tick(combat, 0.8);
  assert.equal(combat.receiveDamage(500), 50, 'Temperance mitigation or Divine Caress shield wrong');
  assert.ok(combat.getState().buffs.some((buff) => buff.id === 'divine-aura'));

  combat.drainEvents();
  use(combat, 'whm-aetherial-shift');
  const move = combat.drainEvents().find((event) => event.type === 'move');
  assert.deepEqual({ kind: move.kind, distance: move.distance }, { kind: 'forward', distance: 15 });
}

function prepPct(combat) {
  useAndSettle(combat, 'pct-creature-motif');
  useAndSettle(combat, 'pct-weapon-motif');
  useAndSettle(combat, 'pct-landscape-motif');
}

function verifyPct() {
  const expiry = createCombat('PCT');
  useAndSettle(expiry, 'pct-aetherhues');
  tick(expiry, 31);
  assert.equal(action(expiry, 'pct-aetherhues').en, 'Fire in Red', 'Aetherhues did not expire');

  const preserve = createCombat('PCT');
  for (let i = 0; i < 7; i += 1) useAndSettle(preserve, 'pct-aetherhues');
  assert.equal(action(preserve, 'pct-aetherhues').en, 'Aero in Green');
  use(preserve, 'pct-subtractive-palette'); tick(preserve, 0.8);
  assert.equal(action(preserve, 'pct-aetherhues').en, 'Stone in Yellow', 'Subtractive Palette reset hue stage');
  tick(preserve, 31);
  assert.equal(action(preserve, 'pct-aetherhues').en, 'Fire in Red', 'subtractive state survived expiry');

  const combat = createCombat('PCT');
  prepPct(combat);
  assert.deepEqual([combat.getState().resources.creatureCanvas, combat.getState().resources.weaponCanvas, combat.getState().resources.landscapeCanvas], [1, 1, 1]);
  for (let i = 0; i < 6; i += 1) useAndSettle(combat, 'pct-aetherhues');
  use(combat, 'pct-scenic-muse');
  const field = combat.drainEvents().find((event) => event.type === 'field');
  assert.deepEqual({ id: field.id, radius: field.radius, duration: field.duration }, { id: 'starry-muse', radius: 5, duration: 20 });
  tick(combat, 0.8, { fields: ['starry-muse'] });
  use(combat, 'pct-subtractive-palette', { fields: ['starry-muse'] }); tick(combat, 0.8, { fields: ['starry-muse'] });
  for (let i = 0; i < 3; i += 1) useAndSettle(combat, 'pct-aetherhues', { fields: ['starry-muse'] });
  useAndSettle(combat, 'pct-star-prism', { fields: ['starry-muse'], targets: 3 });
  useAndSettle(combat, 'pct-comet-in-black', { fields: ['starry-muse'], targets: 3 });
  assert.equal(action(combat, 'pct-rainbow-drip').cast, 0, 'Rainbow Bright did not make Rainbow Drip instant');
  useAndSettle(combat, 'pct-rainbow-drip', { fields: ['starry-muse'], targets: 3 });

  use(combat, 'pct-steel-muse'); tick(combat, 0.8);
  for (const expected of ['Hammer Stamp', 'Hammer Brush', 'Polishing Hammer']) {
    assert.equal(action(combat, 'pct-hammer-combo').en, expected);
    useAndSettle(combat, 'pct-hammer-combo', { targets: 3 });
  }

  use(combat, 'pct-living-muse', { targets: 3 }); tick(combat, 0.8);
  useAndSettle(combat, 'pct-creature-motif');
  use(combat, 'pct-living-muse', { targets: 3 }); tick(combat, 0.8);
  assert.equal(combat.getState().resources.portrait, 1, 'Moogle portrait not built');
  useAndSettle(combat, 'pct-portrait', { targets: 3 });
  assert.ok(combat.getState().stats.potency > 10000, 'PCT representative rotation did not resolve');

  const fieldExit = createCombat('PCT');
  useAndSettle(fieldExit, 'pct-landscape-motif');
  useAndSettle(fieldExit, 'pct-aetherhues');
  use(fieldExit, 'pct-scenic-muse'); tick(fieldExit, 0.8, { fields: [] });
  const before = fieldExit.jobState.hyper;
  useAndSettle(fieldExit, 'pct-aetherhues', { fields: [] });
  assert.equal(fieldExit.jobState.hyper, before, 'Hyperphantasia consumed outside Starry Muse field');
}

function buildSoul(combat, amount) {
  while (combat.getState().resources.soul < amount) {
    useAndSettle(combat, 'rpr-slice');
    useAndSettle(combat, 'rpr-waxing-slice');
    useAndSettle(combat, 'rpr-infernal-slice');
  }
}

function verifyRpr() {
  const area = createCombat('RPR');
  useAndSettle(area, 'rpr-spinning-scythe', { target: false, targets: 3, distance: 6 });
  assert.equal(area.getState().stats.potency, 0);
  assert.equal(area.getState().resources.soul, 0);

  const broken = createCombat('RPR');
  useAndSettle(broken, 'rpr-soul-slice');
  useAndSettle(broken, 'rpr-soul-slice');
  assert.equal(broken.getState().gcdTotal, 2.5, 'Soul Slice used 30s as GCD');
  use(broken, 'rpr-gluttony'); tick(broken, 0.8);
  useAndSettle(broken, 'rpr-slice');
  assert.equal(broken.getState().buffs.some((buff) => buff.id === 'executioner'), false, 'unrelated GCD did not break Executioner');

  const combat = createCombat('RPR');
  useAndSettle(combat, 'rpr-soulsow');
  assert.equal(action(combat, 'rpr-soulsow').en, 'Harvest Moon');
  useAndSettle(combat, 'rpr-shadow-of-death');
  useAndSettle(combat, 'rpr-soul-slice');
  useAndSettle(combat, 'rpr-soul-slice');
  use(combat, 'rpr-gluttony'); tick(combat, 0.8);
  useAndSettle(combat, 'rpr-gibbet', { positional: 'flank' });
  useAndSettle(combat, 'rpr-gallows', { positional: 'rear' });
  use(combat, 'rpr-soul-spender'); tick(combat, 0.8);
  useAndSettle(combat, 'rpr-gibbet', { positional: 'flank' });
  buildSoul(combat, 50);
  use(combat, 'rpr-soul-spender'); tick(combat, 0.8);
  useAndSettle(combat, 'rpr-gallows', { positional: 'rear' });

  use(combat, 'rpr-arcane-circle'); tick(combat, 0.8);
  useAndSettle(combat, 'rpr-slice');
  tick(combat, 4);
  assert.equal(combat.getState().resources.immortal, 1);
  useAndSettle(combat, 'rpr-plentiful-harvest', { targets: 3 });
  use(combat, 'rpr-enshroud'); tick(combat, 0.8);
  assert.equal(combat.getState().resources.lemure, 5);
  use(combat, 'rpr-gluttony', { targets: 3 }); tick(combat, 0.8);
  for (const id of ['rpr-gibbet', 'rpr-gallows', 'rpr-gibbet', 'rpr-gallows']) {
    use(combat, id);
    assert.equal(combat.getState().gcdTotal, 1.5, 'Enshrouded reaping GCD was not 1.5s');
    settle(combat);
  }
  useAndSettle(combat, 'rpr-communio', { targets: 3 });
  assert.equal(action(combat, 'rpr-communio').en, 'Perfectio');
  useAndSettle(combat, 'rpr-communio', { targets: 3 });
  assert.equal(combat.getState().buffs.some((buff) => buff.id === 'perfectio-parata'), false);

  combat.drainEvents();
  use(combat, 'rpr-hells-ingress'); tick(combat, 0.8);
  use(combat, 'rpr-hells-ingress');
  const moves = combat.drainEvents().filter((event) => event.type === 'move');
  assert.deepEqual(moves.map((event) => event.kind), ['forward', 'return']);
  assert.ok(combat.getState().stats.potency > 10000, 'RPR representative rotation did not resolve');
}

function verifyPctPaintEdges() {
  const combat = createCombat('PCT');
  useAndSettle(combat, 'pct-landscape-motif');
  useAndSettle(combat, 'pct-aetherhues');
  use(combat, 'pct-scenic-muse');
  tick(combat, 0.8);
  use(combat, 'pct-subtractive-palette');
  tick(combat, 0.8);
  assert.equal(combat.getState().resources.whitePaint, 0);
  for (let i = 0; i < 3; i++) useAndSettle(combat, 'pct-aetherhues');
  assert.equal(combat.getState().resources.blackPaint, 1, 'pending paint conversion left both paint skills locked');
  use(combat, 'pct-comet-in-black');
  assert.equal(combat.getState().gcdTotal, 2.475, 'Comet failed to receive Inspiration recast reduction');
  settle(combat);

  const holy = createCombat('PCT');
  useAndSettle(holy, 'pct-landscape-motif');
  for (let i = 0; i < 3; i++) useAndSettle(holy, 'pct-aetherhues');
  use(holy, 'pct-scenic-muse'); tick(holy, 0.8);
  use(holy, 'pct-holy-in-white');
  assert.equal(holy.getState().gcdTotal, 1.875, 'Holy failed to receive Inspiration recast reduction');
}

verifyContract();
verifyCommonTiming();
verifyWhm();
verifyPct();
verifyPctPaintEdges();
verifyRpr();
console.log('Combat verification passed: contract, WHM, PCT, RPR, timing, queue, AoE, healing, movement, and expiry edges.');
