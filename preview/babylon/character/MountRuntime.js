import { Quaternion, TransformNode, Vector3 } from '@babylonjs/core';
import { AnimationRuntime } from './AnimationRuntime.js';
import { instantiateNativeAsset, loadNativeContainer, loadRetargetedAnimation } from './NativeAssetLoader.js';

export class MountRuntime {
  constructor(character) {
    this.character = character;
    this.state = character.state.mount;
    this.state.loading = false;
    this.state.loadError = null;
    this.root = null;
    this.instance = null;
    this.seat = null;
    this.animation = null;
    this.definition = null;
    this.resourceId = null;
    this.resources = new Set();
    this.generation = 0;
  }

  async mount(definition) {
    if (!definition?.model) throw new Error('Mount definition is missing its model resource');
    if (!this.character.assets) throw new Error('Mount AssetRuntime is unavailable');
    if (!this.character.model) throw new Error('Character model is not ready for mounting');
    if (this.state.loading) return false;
    if (this.state.isMounted && !this.dismount()) return false;
    const generation = ++this.generation;
    this.state.loading = true;
    this.state.loadError = null;
    let loadedModel;
    let instance;
    const groups = [];
    try {
      loadedModel = await loadNativeContainer(this.character.scene, this.character.assets, definition.model, { priority: 0, retain: true });
      instance = instantiateNativeAsset(loadedModel, this.character.scene, {
        name: `mount:${definition.id}:${generation}`,
        cloneMaterials: true,
      });
      loadedModel = null;
      const scale = Number(definition.modelScales?.[this.character.state.appearance?.modelFamily] ?? definition.scale ?? 1);
      if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Invalid mount scale: ${scale}`);
      instance.root.scaling.scaleInPlace(scale);
      const mountAnimations = await Promise.all(Object.entries(definition.animations || {}).map(async ([state, id]) => {
        const group = await loadRetargetedAnimation(this.character.scene, this.character.assets, id, instance.root, {
          name: state,
          skeletons: instance.skeletons,
        });
        if (group) groups.push(group);
        return [state, group];
      }));
      const riderAnimations = await Promise.all(Object.entries(definition.riderAnimations || {}).map(async ([state, id]) => {
        const group = await loadRetargetedAnimation(this.character.scene, this.character.assets, id, this.character.model, {
          name: `mounted-${state}`,
        });
        if (group) groups.push(group);
        return [state, group];
      }));
      if (generation !== this.generation) return false;
      this.root = instance.root;
      this.instance = instance;
      this.definition = definition;
      this.resourceId = definition.model;
      this.resources = new Set([
        definition.model,
        ...Object.values(definition.animations || {}),
        ...Object.values(definition.riderAnimations || {}),
      ].filter(Boolean));
      this.root.parent = this.character.root;
      this.animation = new AnimationRuntime(this.root);
      for (const group of instance.animationGroups || []) this.animation.register(group.name, group);
      for (const [state, clipName] of Object.entries(definition.states || {})) {
        const group = instance.animationGroups?.find(item => item.name === clipName || item.name.endsWith(`:${clipName}`));
        if (group) this.animation.register(state, group);
      }
      for (const [state, group] of mountAnimations) if (group) this.animation.register(state, group);
      for (const [state, group] of riderAnimations) if (group) this.character.animation.register(`mounted-${state}`, group);
      this.character.animation?.alias('mounted-run', 'mounted-idle');
      this.character.animation?.alias('mounted-takeoff', 'mounted-idle');
      this.character.animation?.alias('mounted-landing', 'mounted-idle');
      const anchor = (definition.riderBone && instance.findNode(definition.riderBone)) || this.root;
      this.seat = new TransformNode('rider-attachment', this.character.scene);
      this.seat.parent = anchor;
      this.seat.scaling.setAll(1 / scale);
      this.seat.position.copyFrom(Vector3.FromArray(definition.riderPosition || [0, 0, 0]));
      if (definition.riderQuaternion) this.seat.rotationQuaternion = Quaternion.FromArray(definition.riderQuaternion).normalize();
      else if (definition.riderRotation) this.seat.rotation.copyFrom(Vector3.FromArray(definition.riderRotation));
      this.character.model.parent = this.seat;
      Object.assign(this.state, {
        isMounted: true,
        mountId: definition.id,
        movementMode: 'ground',
        loadError: null,
      });
      this.character.state.airborne = false;
      this.character.animation?.play('mounted-idle');
      instance = null;
      groups.length = 0;
      return true;
    } catch (error) {
      this.state.loadError = error?.message || String(error);
      this.character.model.parent = this.character.root;
      this.animation?.dispose();
      this.animation = null;
      this.root = null;
      this.instance = null;
      this.definition = null;
      Object.assign(this.state, { isMounted: false, mountId: null, movementMode: 'ground' });
      this.character.state.airborne = false;
      this.character.state.movement = 'idle';
      throw error;
    } finally {
      loadedModel?.dispose();
      instance?.dispose();
      for (const group of groups) group?.dispose?.();
      if (generation === this.generation) this.state.loading = false;
    }
  }

  takeoff() {
    if (!this.state.isMounted || !this.definition?.canFly || this.state.movementMode !== 'ground') return false;
    this.takeoffHeight = this.character.root.position.y + 2.5;
    this.state.movementMode = 'takeoff';
    this.animation?.play('takeoff', { loop: false, restart: true });
    return true;
  }

  land() {
    if (!this.state.isMounted || this.state.movementMode === 'ground') return false;
    this.state.movementMode = 'landing';
    this.animation?.play('land', { loop: false, restart: true });
    return true;
  }

  step(dt, { direction = Vector3.Zero(), ascend = 0, descend = 0 }, navigation) {
    if (!this.state.isMounted) return false;
    const position = this.character.root.position;
    const mode = this.state.movementMode;
    const moving = direction.lengthSquared() > 0;
    const speed = mode === 'ground' ? this.definition.speed || 11 : this.definition.flightSpeed || 18;
    const offset = direction.scale(speed * dt);
    if (mode === 'ground') {
      navigation.move(position, offset.x, offset.z);
      if (ascend) this.takeoff();
    } else {
      position.addInPlace(offset);
      if (mode === 'takeoff') {
        position.y = Math.min(this.takeoffHeight, position.y + 4 * dt);
        if (position.y >= this.takeoffHeight) this.state.movementMode = 'flying';
      } else if (mode === 'landing') {
        const floor = navigation.surfaceAt(position.x, position.z, position.y, 10000);
        if (!floor) {
          this.state.movementMode = 'flying';
          return true;
        }
        position.y = Math.max(floor.height, position.y - 6 * dt);
        if (position.y === floor.height) this.state.movementMode = 'ground';
      } else {
        position.y += (ascend - descend) * speed * 0.6 * dt;
        const floor = navigation.surfaceAt(position.x, position.z, position.y, 1);
        if (floor && position.y < floor.height + 0.5) {
          position.y = floor.height;
          this.state.movementMode = 'ground';
        }
      }
    }
    const activeMode = this.state.movementMode;
    const animationState = activeMode === 'ground'
      ? moving ? 'run' : 'idle'
      : activeMode === 'takeoff' ? 'takeoff'
        : activeMode === 'landing' ? (this.animation?.has('land') ? 'land' : 'hover')
          : ascend && this.animation?.has('ascend') ? 'ascend' : moving ? 'fly' : 'hover';
    this.animation?.update(dt, animationState);
    this.character.state.airborne = activeMode !== 'ground';
    this.character.state.movement = activeMode === 'ground'
      ? moving ? 'mounted-run' : 'mounted-idle'
      : 'mounted-flying';
    this.character.syncTransform();
    return true;
  }

  dismount() {
    if (!this.state.isMounted || this.state.movementMode !== 'ground') return false;
    this.generation++;
    this.character.model.parent = this.character.root;
    this.animation?.dispose();
    this.instance?.dispose({ disposeAnimationGroups: false });
    this.seat?.dispose(false, false);
    this.root = null;
    this.instance = null;
    this.seat = null;
    this.resourceId = null;
    this.definition = null;
    this.animation = null;
    this.resources.clear();
    Object.assign(this.state, {
      isMounted: false,
      mountId: null,
      movementMode: 'ground',
      loading: false,
      loadError: null,
    });
    this.character.state.airborne = false;
    this.character.state.movement = 'idle';
    return true;
  }

  dispose() {
    this.generation++;
    if (this.character.model) this.character.model.parent = this.character.root;
    this.animation?.dispose();
    this.instance?.dispose({ disposeAnimationGroups: false });
    this.seat?.dispose(false, false);
    this.resources.clear();
    this.root = null;
    this.instance = null;
    this.seat = null;
    this.animation = null;
    this.definition = null;
    Object.assign(this.state, { isMounted: false, mountId: null, movementMode: 'ground', loading: false });
    this.character.state.airborne = false;
  }
}
