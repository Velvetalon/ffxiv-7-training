import assert from 'node:assert/strict';
import { ProfileResolver } from '../../src/audio/ProfileResolver.js';
import { CueScheduler } from '../../src/audio/CueScheduler.js';
import { VoiceManager } from '../../src/audio/VoiceManager.js';
import { MusicArbiter } from '../../src/audio/MusicArbiter.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok', name); };

test('resolver: exact action rule beats generic fallback; append layers dedupe', () => {
  const resolver = new ProfileResolver();
  const base = { id: 'base', rules: [{ event: 'action.release', slot: 'primary', mode: 'replace', cue: { clip: 'generic' } }] };
  const job = { id: 'whm', rules: [
    { event: 'action.release', slot: 'primary', mode: 'replace', priority: 5, conditions: { actionId: 'stone3' }, cue: { clip: 'stone3' } },
    { event: 'action.release', slot: 'weapon', mode: 'append-layer', layerId: 'cane-swish', conditions: { weapon: 'cane' }, cue: { clip: 'cane-swish' } },
  ] };
  const handle = resolver.bindProfiles('player', [base, job]);
  const result = resolver.resolve({ type: 'action.release', ownerId: 'player' }, { actionId: 'stone3', weapon: 'cane' });
  const clips = result.layers.map(layer => layer.rule.cue.clip).sort();
  assert.deepEqual(clips, ['cane-swish', 'stone3']);
  const repeated = resolver.resolve({ type: 'action.release', ownerId: 'player' }, { actionId: 'stone3', weapon: 'cane' });
  const weaponLayers = repeated.layers.filter(layer => layer.slot === 'weapon');
  assert.equal(weaponLayers.length, 1);
  resolver.unbind(handle);
});

test('resolver: suppress wins and conflicts reported at equal priority', () => {
  const resolver = new ProfileResolver();
  resolver.bindProfiles('p', [{ id: 'a', rules: [{ event: 'e', slot: 'primary', mode: 'replace', priority: 2, cue: { clip: 'a' } }] }]);
  resolver.bindProfiles('p', [{ id: 'b', rules: [{ event: 'e', slot: 'primary', mode: 'replace', priority: 2, cue: { clip: 'b' } }] }]);
  const conflict = resolver.resolve({ type: 'e', ownerId: 'p' });
  assert.equal(conflict.conflicts.length, 1);
  resolver.bindProfiles('p', [{ id: 'c', rules: [{ event: 'e', suppress: true }] }]);
  const suppressed = resolver.resolve({ type: 'e', ownerId: 'p' });
  assert.equal(suppressed.suppressed.length, 1);
  assert.equal(suppressed.layers.length, 0);
});

test('scheduler: stale events dropped, owner cancel works', () => {
  let now = 10;
  const scheduler = new CueScheduler({ getContextTime: () => now, staleWindowSeconds: 0.5 });
  const fresh = scheduler.schedule({ at: 10.2, ownerId: 'p', task: 'a' });
  assert.equal(fresh.ok, true);
  const stale = scheduler.schedule({ at: 8, ownerId: 'p', task: 'b' });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-dropped');
  const due = scheduler.schedule({ at: 9.7, ownerId: 'q', task: 'c' });
  assert.equal(due.ok, true);
  assert.equal(scheduler.finish(due.id).state, 'running');
  const cancelled = scheduler.cancelOwner('p', 'test');
  assert.equal(cancelled.length, 1);
});

test('voice manager: per-cue and per-entity budgets preempt oldest', () => {
  const voices = new VoiceManager({ limits: { perCue: 2, perEntity: 3, global: 10 } });
  for (let i = 0; i < 4; i++) {
    const start = voices.start({ cueId: 'x', ownerId: 'p', nodes: { stop() {} } });
    assert.equal(start.ok, true);
  }
  assert.equal(voices.count('p'), 2);
  for (let i = 0; i < 4; i++) voices.start({ cueId: `y${i}`, ownerId: 'p', nodes: { stop() {} } });
  assert.ok(voices.count('p') <= 3, 'entity budget enforced');
});

test('music arbiter: mount request wins, release restores scene without restart', () => {
  const arbiter = new MusicArbiter();
  const scene = arbiter.request({ source: 'scene', trackId: 'bgm-city', priority: 10 });
  assert.equal(scene.reused, false);
  const again = arbiter.request({ source: 'scene', trackId: 'bgm-city', priority: 10 });
  assert.equal(again.reused, true);
  const mount = arbiter.request({ source: 'mount', trackId: 'ride-chocobo', priority: 20 });
  assert.equal(mount.trackId, 'ride-chocobo');
  const restored = arbiter.release('mount');
  assert.equal(restored.changed, true);
  assert.equal(restored.trackId, 'bgm-city');
});

console.log(`\n${passed} tests passed`);
