import { EffectRuntime, STATE } from '../../src/vfx/EffectCore.js';
import * as THREE from 'three';

const root = new THREE.Group();
const runtime = new EffectRuntime();
const definition = {
  schemaVersion: 1,
  effectId: 'test/hit',
  duration: 0.4,
  nodes: [{ kind: 'emitter', lifeSeconds: 0.35, emissionRate: 40, maxAlive: 8, size: 0.12, spread: 1.5, rise: 1.2, color: [0.4, 0.8, 1] }],
};
runtime.registerCatalog({ 'test/hit': definition });

// Play
const anchor = new THREE.Vector3(1, 2, 3);
const handle = runtime.play({ effectId: 'test/hit' }, { root }, anchor);
runtime.update(1/60);
if (!handle) throw new Error('spawn failed');
let snap = runtime.inspect(handle);
if (snap.state !== STATE.RUNNING) throw new Error('expected RUNNING, got ' + snap.state);
if (root.children.length !== 1) throw new Error('expected emitter group attached');
const group = root.children[0];
if (!group.isGroup || group.children.length !== 8) throw new Error('expected 8 pooled particles');
if (Math.hypot(group.position.x - 1, group.position.y - 2, group.position.z - 3) > 1e-6) throw new Error('anchor not followed');

// Tick until natural drain
for (let t = 0; t < 2.0 && runtime.activeCount; t += 1/60) runtime.update(1/60);
if (runtime.activeCount !== 0) throw new Error('effect did not dispose naturally');
if (root.children.length !== 0) throw new Error('emitter group not removed');

// Cancel path
const handle2 = runtime.play({ effectId: 'test/hit' }, { root }, anchor);
runtime.cancel(handle2);
if (runtime.activeCount !== 0) throw new Error('cancel did not remove instance');
if (root.children.length !== 0) throw new Error('cancel did not detach group');

// Independent instances: same definition, two anchors, mutually exclusive states
const handleA = runtime.play({ effectId: 'test/hit' }, { root }, new THREE.Vector3(0, 0, 0));
const handleB = runtime.play({ effectId: 'test/hit' }, { root }, new THREE.Vector3(5, 0, 0));
runtime.cancel(handleA);
const snapB = runtime.inspect(handleB);
if (!snapB || snapB.state !== STATE.RUNNING) throw new Error('cancel of A killed B');
runtime.cancel(handleB);

// resolve paths
if (runtime.resolve({ effectId: 'missing' }).status !== 'unresolved') throw new Error('expected unresolved');
console.log('PASS EffectCore lifecycle, pooling, anchors, cancel/drain');



