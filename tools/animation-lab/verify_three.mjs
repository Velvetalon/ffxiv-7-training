import fs from 'node:fs';
import { AnimationMixer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

globalThis.self = globalThis;

const path = new URL('./cbem_joy.animation.glb', import.meta.url);
const bytes = fs.readFileSync(path);
const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const loader = new GLTFLoader();

const gltf = await new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
const clip = gltf.animations[0];
const bones = [];
gltf.scene.traverse((node) => {
  if (node !== gltf.scene) bones.push(node.name);
});

if (gltf.animations.length !== 1) throw new Error(`expected one clip, got ${gltf.animations.length}`);
if (clip.tracks.length !== 276) throw new Error(`expected 276 keyframe tracks, got ${clip.tracks.length}`);
if (bones.length !== 101) throw new Error(`expected 101 nodes, got ${bones.length}`);
if (Math.abs(clip.duration - 3.833333) > 0.0001) throw new Error(`unexpected duration ${clip.duration}`);

const animatedNodes = [];
gltf.scene.traverse((node) => {
  if (node !== gltf.scene) animatedNodes.push(node);
});
const mixer = new AnimationMixer(gltf.scene);
mixer.clipAction(clip).play();
mixer.setTime(0);
const atZero = new Map(animatedNodes.map((node) => [node, [...node.position, ...node.quaternion, ...node.scale]]));
mixer.setTime(1);
let changedNodesAtOneSecond = 0;
for (const node of animatedNodes) {
  const before = atZero.get(node);
  const after = [...node.position, ...node.quaternion, ...node.scale];
  if (after.some((value, index) => Math.abs(value - before[index]) > 1e-6)) changedNodesAtOneSecond++;
}
if (changedNodesAtOneSecond === 0) throw new Error('AnimationMixer did not change any node transforms');

console.log(JSON.stringify({
  sceneChildren: gltf.scene.children.length,
  nodes: bones.length,
  animations: gltf.animations.length,
  clipName: clip.name,
  clipDuration: clip.duration,
  keyframeTracks: clip.tracks.length,
  changedNodesAtOneSecond,
  firstTracks: clip.tracks.slice(0, 6).map((track) => ({
    name: track.name,
    keys: track.times.length,
    valueSize: track.getValueSize(),
  })),
}, null, 2));
