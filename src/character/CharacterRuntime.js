import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationRuntime } from './AnimationRuntime.js';
import { ActorAnimation } from '../world/animation.js';
import { disposeObject } from '../world/assets.js';
import { AppearanceRuntime } from './AppearanceRuntime.js';
import { MovementRuntime } from './MovementRuntime.js';

function disposeCharacterModel(model) {
  const skeletons = new Set();
  model.traverse(node => { if (node.skeleton) skeletons.add(node.skeleton); });
  skeletons.forEach(skeleton => skeleton.dispose());
  disposeObject(model);
}

export class CharacterRuntime {
  constructor({ id, model, name = '', appearance = null, assetRuntime = null }) {
    this.id = id;
    this.root = new THREE.Group();
    this.root.name = `character:${id}`;
    this.root.userData.characterId = id;
    this.state = {
      id, name, position: { x: 0, y: 0, z: 0 }, heading: 0,
      movement: 'idle', airborne: false, jobId: 'WHM', appearance,
      actionId: null, mount: { isMounted: false, mountId: null, movementMode: 'ground' },
    };
    this.assets = assetRuntime;
    this.appearance = new AppearanceRuntime(appearance);
    this.movement = new MovementRuntime(this);
    this.retained = new Set();
    this.model = null;
    this.animation = null;
    this.fallback = null;
    this.source = 'procedural';
    this.generation = 0;
    this.lastAnimatedHeading = 0;
    this.actionSequence = 0;
    if (model) this.setModel(model);
  }

  setModel(model, { clips = [], states = {}, source = 'procedural' } = {}) {
    this.animation?.dispose();
    if (this.model) { this.model.removeFromParent(); disposeCharacterModel(this.model); }
    this.model = model;
    this.source = source;
    this.root.add(model);
    model.traverse(node => {
      if (node.isMesh) {
        node.userData.characterId = this.id;
        node.userData.entityId = this.id;
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.isSkinnedMesh) node.frustumCulled = false;
      }
    });
    this.root.userData.rig = model.userData.rig;
    this.animation = new AnimationRuntime(model);
    for (const clip of clips) this.animation.register(clip.name, clip);
    for (const [state, clipName] of Object.entries(states)) {
      const clip = clips.find(item => item.name === clipName);
      if (clip) this.animation.register(state, clip);
    }
    this.fallback = source === 'procedural' ? new ActorAnimation(model) : null;
    this.animation.play('idle');
  }

  async loadDefinition(definition, appearance = this.state.appearance) {
    if (!this.assets) throw new Error('Character requires an AssetRuntime');
    const generation = ++this.generation;
    const retained = [];
    const pending = new Map();
    let installed = false;
    const load = id => {
      if (!pending.has(id)) pending.set(id, this.assets.load(id, { priority: 0 }).then(value => {
        retained.push(id);
        return value;
      }));
      return pending.get(id);
    };
    try {
      const gltf = await load(definition.model);
      const animationEntries = await Promise.all(Object.entries(definition.animations || {}).filter(([, id]) => id).map(async ([state, id]) => {
        const asset = await load(id);
        return [state, asset.animations?.[0]];
      }));
      if (generation !== this.generation) return false;
      const model = cloneSkeleton(gltf.scene);
      model.traverse(node => {
        if (Array.isArray(node.material)) node.material = node.material.map(material => material.clone());
        else if (node.material) node.material = node.material.clone();
      });
      const originalResources = this.retained;
      this.retained = new Set(retained);
      this.setModel(model, { clips: gltf.animations || [], states: definition.states || {}, source: 'ffxiv-client' });
      for (const [state, clip] of animationEntries) this.animation.register(state, clip);
      this.state.appearance = appearance ? structuredClone(appearance) : null;
      this.state.actionError = null;
      if (appearance) {
        this.appearance.setData(appearance);
        this.appearance.apply(model, definition.appearanceBindings);
      }
      this.definition = definition;
      installed = true;
      this.animation.play('idle', { restart: true });
      for (const id of originalResources) this.assets.release(id);
      return true;
    } finally {
      if (!installed) {
        await Promise.allSettled([...pending.values()]);
        retained.forEach(id => this.assets.release(id));
      }
    }
  }

  applyState(patch) {
    if (patch.position) this.root.position.set(patch.position.x, patch.position.y, patch.position.z);
    if (patch.heading !== undefined) this.root.rotation.y = patch.heading;
    if (patch.movement) this.state.movement = patch.movement;
    if (patch.jobId) this.state.jobId = patch.jobId;
    if (patch.appearance) {
      this.appearance.setData(patch.appearance);
      this.state.appearance = this.appearance.serialize();
      this.appearance.apply(this.model, this.definition?.appearanceBindings);
    }
    if (patch.mount) Object.assign(this.state.mount, patch.mount);
    this.syncTransform();
  }

  syncTransform() {
    Object.assign(this.state.position, this.root.position);
    this.state.heading = this.root.rotation.y;
  }

  playAction(definition, event = {}) {
    this.state.actionId = definition?.id || event.actionId || null;
    this.state.actionPhase = event.type || 'action';
    this.state.actionError = null;
    const sequence = ++this.actionSequence;
    const clip = definition?.animationState || definition?.animationClip || this.state.actionId;
    if (this.animation?.play(clip, { loop: false, restart: true })) return true;
    const animationId = definition?.animationResourceId
      || (typeof definition?.animationId === 'string' ? definition.animationId : null)
      || definition?.animation?.resourceId;
    if (animationId && this.assets?.registry.resources.has(animationId)) {
      const generation = this.generation;
      void this.assets.load(animationId, { priority: 0 }).then(asset => {
        if (generation !== this.generation) { this.assets.release(animationId); return; }
        if (this.retained.has(animationId)) this.assets.release(animationId);
        else this.retained.add(animationId);
        if (!this.animation.register(clip, asset.animations?.[0])) {
          this.state.actionError = `动作资源没有可播放片段: ${animationId}`;
          return;
        }
        if (sequence === this.actionSequence) this.animation.play(clip, { loop: false, restart: true });
      }).catch(error => { this.state.actionError = error.message; });
    } else {
      this.fallback?.trigger(event, this.state.jobId);
      if (definition?.animationId) this.state.actionError = `动作资源尚未注册: ${definition.animationId}`;
    }
    return true;
  }

  update(dt, time) {
    this.syncTransform();
    this.state.turn = Math.atan2(Math.sin(this.state.heading - this.lastAnimatedHeading), Math.cos(this.state.heading - this.lastAnimatedHeading));
    this.lastAnimatedHeading = this.state.heading;
    const motion = this.state.movement === 'idle' && Math.abs(this.state.turn) > 0.005
      ? this.state.turn > 0 ? 'turn-left' : 'turn-right' : this.state.movement;
    this.appearance.beforeAnimation(this.model);
    if (this.animation?.clips.size) {
      this.animation.update(dt, this.animation.has(motion) ? motion : this.state.movement);
      if (this.state.movement === 'jump-land' && this.animation.state === 'jump-land' && !this.animation.actionRemaining) {
        this.state.movement = 'idle';
      }
    }
    else this.fallback?.update(dt, this.state.movement !== 'idle', time);
    this.appearance.afterAnimation(this.model);
  }

  dispose() {
    this.generation++;
    this.animation?.dispose();
    if (this.model) disposeCharacterModel(this.model);
    this.root.removeFromParent();
    for (const id of this.retained) this.assets?.release(id);
    this.retained.clear();
  }
}
