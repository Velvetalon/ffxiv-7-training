// Integration check: AudioRuntime delegates mapped skill cues to AudioEngine.
import assert from 'node:assert/strict';
import { AudioRuntime } from '../../src/audio/AudioRuntime.js';

const clipId = 'audio:sha256:ca1d8fa916e1c583f5c84dae8e7c1f48c55a257045f33d5247fce5816ced39e6';
const rawId = 'audio.scd.sound_vfx_ability_se_vfx_abi_whm_pbaeddheal_c_scd.a0';
const makeRuntime = () => ({
  __audioDecoderInstalled: true,
  manifest: {
    resources: { [clipId]: { type: 'audio' } },
    actionSfx: { [rawId]: { id: clipId } },
    sceneBgm: { limsa: { id: 'audio:sha256:a5a3963263e1b3c8f57979d4c7600651b99bcce20595fe33368d4ea38dbe2562' } },
  },
  load: async () => ({ length: 4, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(4) }),
  release() {},
});

const audio = new AudioRuntime(makeRuntime(), { sound: true, volume: 1 }, {
  AudioContext: class {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { buffer: null, loop: false, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  },
});
audio.setSkills({ 'whm-assize': { skillId: 3571, soundId: clipId, timing: { soundDelaySeconds: 0 } } });

const result = await audio.playAction(rawId);
console.log('result', JSON.stringify(result));
assert.equal(result.ok, true);
assert.equal(result.via, 'engine');
assert.equal(result.skillId, 3571);
const stats = audio.engine.stats();
assert.ok(stats.voices.active >= 1, 'engine voice active');
console.log('engine integration PASS', JSON.stringify(stats.voices));

