import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { AppearanceRuntime } from '../../src/character/AppearanceRuntime.js'

globalThis.self = globalThis

const sandbox = new URL('../../public/extracted/sandbox/', import.meta.url)
const loader = new GLTFLoader()
const load = async relative => {
  const bytes = fs.readFileSync(new URL(relative, sandbox))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const originalError = console.error
  console.error = () => {}
  try {
    return await loader.parseAsync(buffer, '')
  } finally {
    console.error = originalError
  }
}

const manifest = JSON.parse(fs.readFileSync(new URL('manifest.character.partial.json', sandbox), 'utf8'))
const definition = manifest.characters['ffxiv-chara-40']
const appearance = JSON.parse(fs.readFileSync(new URL(definition.appearance, sandbox), 'utf8'))
const modelRecord = manifest.resources[definition.model]
const idleRecord = manifest.resources[definition.animations.idle]
const [decorated, baseline, idle] = await Promise.all([
  load(modelRecord.source),
  load(modelRecord.source),
  load(idleRecord.source),
])

const bindings = definition.appearanceBindings
const runtime = new AppearanceRuntime(appearance)
runtime.apply(decorated.scene, bindings)
const appearanceRoot = decorated.scene.getObjectByName('appearance-root')
if (!appearanceRoot || Math.abs(appearanceRoot.scale.x - 0.96) > 1e-6) throw new Error('authored height scale is not 0.96')
if (Math.abs(decorated.scene.scale.x - 1) > 1e-6) throw new Error('AppearanceRuntime double-applied authored height')

const clip = idle.animations[0]
const decoratedMixer = new THREE.AnimationMixer(decorated.scene)
const baselineMixer = new THREE.AnimationMixer(baseline.scene)
decoratedMixer.clipAction(clip).play()
baselineMixer.clipAction(clip).play()
runtime.beforeAnimation(decorated.scene)
decoratedMixer.setTime(1)
baselineMixer.setTime(1)
runtime.afterAnimation(decorated.scene)

const expected = bindings.bustScale
const evidence = {}
for (const name of bindings.bustBones) {
  const actual = decorated.scene.getObjectByName(name).scale
  const sampled = baseline.scene.getObjectByName(name).scale
  const ratio = actual.toArray().map((value, index) => value / sampled.toArray()[index])
  if (ratio.some((value, index) => Math.abs(value - expected[index]) > 1e-5)) {
    throw new Error(`${name} lost its appearance scale: ${ratio}`)
  }
  evidence[name] = { sampled: sampled.toArray(), actual: actual.toArray(), ratio }
}

console.log(JSON.stringify({
  model: definition.model,
  clip: clip.name,
  time: 1,
  authoredHeightScale: appearanceRoot.scale.x,
  runtimeOuterScale: decorated.scene.scale.x,
  effectiveHeightScale: appearanceRoot.scale.x * decorated.scene.scale.x,
  expectedBustScale: expected,
  bones: evidence,
}, null, 2))
