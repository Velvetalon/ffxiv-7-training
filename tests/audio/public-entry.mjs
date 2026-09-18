// Public-entry + mute/stop acceptance checks in plain-node style (repo Node is v16).
import assert from 'node:assert/strict';

import * as audioEntry from '../../src/audio/index.js';
import { AudioRuntime } from '../../src/audio/AudioRuntime.js';

const sceneClip = 'audio:scene.limsa';
const mountClip = 'audio.mount.theme';

const makeRuntime = () => ({
  __audioDecoderInstalled: true,
  manifest: {
    resources: { [mountClip]: { id: mountClip, metadata: {} } },
    sceneBgm: { limsa: { id: sceneClip } },
  },
  load: async () => ({ length: 4, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(4) }),
  release() {},
});

const makeContextClass = () => {
  const counters = { started: 0, stopped: 0 };
  class FakeContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { buffer: null, loop: false, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() { counters.started++; }, stop() { counters.stopped++; }, onended: null }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  return { Context: FakeContext, counters };
};

const assertEntryExportsRealApi = () => {
  for (const name of ['AudioClip', 'ClipStore', 'AudioCue', 'validateCue', 'flattenCue', 'CUE_KINDS', 'LAYER_OPS', 'ProfileResolver', 'CueScheduler', 'VoiceManager', 'MusicArbiter', 'AudioEngine']) {
    assert.ok(audioEntry[name] !== undefined, 'missing export: ' + name);
  }
  for (const value of Object.values(audioEntry)) assert.notEqual(value, undefined);
};

const assertMountRequestRespectsSoundSetting = async () => {
  const { Context, counters } = makeContextClass();
  const audio = new AudioRuntime(makeRuntime(), { sound: false, volume: 1 }, { AudioContext: Context });
  const result = await audio.requestMountMusic(mountClip);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sound-disabled');
  assert.equal(counters.started, 0);
};

const assertMountLifecycleStopsSceneTrackAndResetWorks = async () => {
  const { Context, counters } = makeContextClass();
  const audio = new AudioRuntime(makeRuntime(), { sound: true, volume: 1 }, { AudioContext: Context });
  const scene = await audio.playScene('limsa');
  assert.equal(scene.ok, true);
  assert.equal(counters.started, 1);
  const mount = await audio.requestMountMusic(mountClip);
  assert.equal(mount.ok, true);
  assert.ok(counters.stopped >= 1, 'old scene track must stop before the mount voice starts');
  assert.equal(audio.engine.stats().voices.byBus.music, 1, 'exactly one music voice after mount');
  audio.stopAll();
  assert.equal(audio.engine.stats().voices.active, 0, 'stopAll must stop the mount voice');
  assert.equal(audio.engine.stats().music.sources, 0, 'arbiter sources reset on stopAll');
  assert.equal(audio.engine.stats().music.current, null);
};

const assertGlobalMuteStopsMountAndReEnableWorks = async () => {
  const { Context } = makeContextClass();
  const audio = new AudioRuntime(makeRuntime(), { sound: true, volume: 1 }, { AudioContext: Context });
  await audio.playScene('limsa');
  const mount = await audio.requestMountMusic(mountClip);
  assert.equal(mount.ok, true);
  audio.setSettings({ sound: false });
  assert.equal(audio.engine.stats().voices.active, 0, 'mute must stop engine voices');
  audio.setSettings({ sound: true });
  const again = await audio.requestMountMusic(mountClip);
  assert.equal(again.ok, true);
  assert.equal(audio.engine.stats().voices.byBus.music, 1);
};

const assertReleaseStopsMountVoiceAndRestoresSceneOnce = async () => {
  const { Context } = makeContextClass();
  const audio = new AudioRuntime(makeRuntime(), { sound: true, volume: 1 }, { AudioContext: Context });
  await audio.playScene('limsa');
  await audio.requestMountMusic(mountClip);
  const restored = await audio.releaseMountMusic();
  assert.equal(restored.ok, true);
  assert.equal(restored.trackId, sceneClip);
  assert.equal(audio.engine.stats().voices.byBus.music, 1, 'no overlap between restored scene voice and mount voice');
};

let passed = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log('ok', name); });

await test('public entry imports and exports only real APIs', assertEntryExportsRealApi);
await test('mount music request respects settings.sound', assertMountRequestRespectsSoundSetting);
await test('mount request stops scene track; stopAll stops mount and resets arbiter', assertMountLifecycleStopsSceneTrackAndResetWorks);
await test('global mute stops mount; re-enable allows fresh request', assertGlobalMuteStopsMountAndReEnableWorks);
await test('release stops mount voice and restores exactly one scene voice', assertReleaseStopsMountVoiceAndRestoresSceneOnce);
console.log(`\n${passed} tests passed`);

