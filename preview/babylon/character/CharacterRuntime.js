import { TransformNode } from '@babylonjs/core';
import { AnimationRuntime } from './AnimationRuntime.js';
import { AppearanceRuntime } from './AppearanceRuntime.js';
import { MovementRuntime } from './MovementRuntime.js';
import { ActorAnimation } from './factories.js';
import {
  instantiateNativeAsset,
  loadNativeContainer,
  loadRetargetedAnimation,
} from './NativeAssetLoader.js';

function disposeNode(node) {
  node?.dispose?.(false, true);
}

function modelScene(model, explicitScene) {
  return explicitScene || model?.root?.getScene?.() || model?.getScene?.() || null;
}

export class CharacterRuntime {
  constructor({ id, model, name = '', appearance = null, assetRuntime = null, scene = null } = {}) {
    this.id = id;
    this.name = name;
    this.scene = modelScene(model, scene);
    if (!this.scene) throw new Error('CharacterRuntime requires a Babylon scene or model');
    this.root = new TransformNode(`character:${id}`, this.scene);
    this.root.metadata = { ...(this.root.metadata || {}), characterId: id, entityId: id };
    this.state = {
      id, name, position: { x: 0, y: 0, z: 0 }, heading: 0,
      movement: 'idle', airborne: false, jobId: 'WHM', appearance,
      targetId: null, actionId: null,
      mount: { isMounted: false, mountId: null, movementMode: 'ground' },
    };
    this.assets = assetRuntime;
    this.appearance = new AppearanceRuntime(appearance);
    this.movement = new MovementRuntime(this);
    this.retained = new Set();
    this.model = null;
    this.modelInstance = null;
    this.animation = null;
    this.fallback = null;
    this.source = 'procedural';
    this.definition = null;
    this.generation = 0;
    this.lastAnimatedHeading = 0;
    this.actionSequence = 0;
    this.beforeAnimationsObserver = this.scene.onBeforeAnimationsObservable.add(() => {
      this.appearance.beforeAnimation(this.model);
    });
    this.afterAnimationsObserver = this.scene.onAfterAnimationsObservable.add(() => {
      this.appearance.afterAnimation(this.model);
    });
    if (model) this.setModel(model);
  }

  setModel(model, { clips = [], states = {}, source = 'procedural', instance = null } = {}) {
    this.animation?.dispose();
    if (this.model) {
      this.model.parent = null;
      if (this.modelInstance) this.modelInstance.dispose({ disposeAnimationGroups: false });
      else disposeNode(this.model);
    }
    this.modelInstance = instance || (model?.root && model?.animationGroups ? model : null);
    this.model = model?.root || model;
    if (!this.model) throw new Error('Character model is required');
    this.source = source;
    this.model.parent = this.root;
    for (const mesh of this.model.getChildMeshes?.(false) || []) {
      mesh.isPickable = true;
      mesh.receiveShadows = true;
      mesh.alwaysSelectAsActiveMesh = Boolean(mesh.skeleton);
      mesh.metadata = {
        ...(mesh.metadata || {}),
        characterId: this.id,
        entityId: this.id,
      };
    }
    this.root.metadata = {
      ...(this.root.metadata || {}),
      rig: this.model.metadata?.rig || null,
    };
    this.animation = new AnimationRuntime(this.model);
    for (const clip of clips) this.animation.register(clip.name, clip);
    for (const [state, clipName] of Object.entries(states)) {
      const clip = typeof clipName === 'string'
        ? clips.find(item => item.name === clipName || item.name.endsWith(`:${clipName}`))
        : clipName;
      if (clip) this.animation.register(state, clip);
    }
    this.fallback = source === 'procedural' ? new ActorAnimation(this.model) : null;
    this.animation.play('idle');
    return this;
  }

  async loadDefinition(definition, appearance = this.state.appearance) {
    if (!this.assets) throw new Error('Character requires an AssetRuntime');
    if (!definition?.model) throw new Error('Character definition is missing its model resource');
    const generation = ++this.generation;
    let loadedModel = await loadNativeContainer(this.scene, this.assets, definition.model, { priority: 0, retain: true });
    let instance = null;
    const animationGroups = [];
    const detachedGroups = [];
    try {
      instance = instantiateNativeAsset(loadedModel, this.scene, {
        name: `character:${this.id}:model:${generation}`,
        cloneMaterials: true,
      });
      loadedModel = null;
      for (const group of instance.animationGroups) {
        group.name = group.name.replace(/^.*?:/, '');
        animationGroups.push(group);
      }
      const animationEntries = await Promise.all(Object.entries(definition.animations || {})
        .filter(([, resourceId]) => resourceId)
        .map(async ([state, resourceId]) => {
          const group = await loadRetargetedAnimation(this.scene, this.assets, resourceId, instance.root, {
            name: state,
            priority: 0,
            skeletons: instance.skeletons,
          });
          if (group) detachedGroups.push(group);
          return [state, group];
        }));
      if (generation !== this.generation) {
        instance.dispose();
        return false;
      }
      this.setModel(instance.root, {
        clips: animationGroups,
        states: definition.states || {},
        source: 'ffxiv-client',
        instance,
      });
      for (const [state, group] of animationEntries) if (group) this.animation.register(state, group);
      detachedGroups.length = 0;
      this.state.appearance = appearance ? structuredClone(appearance) : null;
      this.state.actionError = null;
      if (appearance) {
        this.appearance.setData(appearance);
        this.appearance.apply(this.model, definition.appearanceBindings);
      }
      this.definition = definition;
      this.animation.play('idle', { restart: true });
      instance = null;
      return true;
    } finally {
      loadedModel?.dispose();
      instance?.dispose();
      for (const group of detachedGroups) group.dispose();
    }
  }

  applyState(patch) {
    if (patch.position) this.root.position.copyFromFloats(patch.position.x, patch.position.y, patch.position.z);
    if (patch.heading !== undefined) this.root.rotation.y = patch.heading;
    if (patch.movement) this.state.movement = patch.movement;
    if (patch.jobId) this.state.jobId = patch.jobId;
    if (patch.targetId !== undefined) this.state.targetId = patch.targetId;
    if (patch.appearance) {
      this.appearance.setData(patch.appearance);
      this.state.appearance = this.appearance.serialize();
      this.appearance.apply(this.model, this.definition?.appearanceBindings);
    }
    if (patch.mount) Object.assign(this.state.mount, patch.mount);
    this.syncTransform();
  }

  syncTransform() {
    this.state.position.x = this.root.position.x;
    this.state.position.y = this.root.position.y;
    this.state.position.z = this.root.position.z;
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
    if (animationId && this.assets) {
      const generation = this.generation;
      void loadRetargetedAnimation(this.scene, this.assets, animationId, this.model, { name: clip })
        .then(group => {
          if (!group) throw new Error(`Action resource has no playable clip: ${animationId}`);
          if (generation !== this.generation) { group.dispose(); return; }
          this.animation.register(clip, group);
          if (sequence === this.actionSequence) this.animation.play(clip, { loop: false, restart: true });
        })
        .catch(error => { this.state.actionError = error.message; });
    } else {
      this.fallback?.trigger(event, this.state.jobId);
      if (definition?.animationId) this.state.actionError = `Action resource is not registered: ${definition.animationId}`;
    }
    return true;
  }

  update(dt, time) {
    this.syncTransform();
    this.state.turn = Math.atan2(
      Math.sin(this.state.heading - this.lastAnimatedHeading),
      Math.cos(this.state.heading - this.lastAnimatedHeading),
    );
    this.lastAnimatedHeading = this.state.heading;
    const motion = this.state.movement === 'idle' && Math.abs(this.state.turn) > 0.005
      ? this.state.turn > 0 ? 'turn-left' : 'turn-right'
      : this.state.movement;
    if (this.animation?.clips.size) {
      this.animation.update(dt, this.animation.has(motion) ? motion : this.state.movement);
      if (this.state.movement === 'jump-land' && this.animation.state === 'jump-land' && !this.animation.actionRemaining) {
        this.state.movement = 'idle';
      }
    } else {
      this.fallback?.update(dt, this.state.movement !== 'idle', time);
    }
  }

  dispose() {
    this.generation++;
    this.animation?.dispose();
    if (this.modelInstance) this.modelInstance.dispose({ disposeAnimationGroups: false });
    else disposeNode(this.model);
    this.model = null;
    this.modelInstance = null;
    this.scene.onBeforeAnimationsObservable.remove(this.beforeAnimationsObserver);
    this.scene.onAfterAnimationsObservable.remove(this.afterAnimationsObserver);
    this.root.dispose(false, true);
    for (const id of this.retained) this.assets?.release?.(id);
    this.retained.clear();
  }
}
