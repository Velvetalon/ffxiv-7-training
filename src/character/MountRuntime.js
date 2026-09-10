import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationRuntime } from './AnimationRuntime.js';
import { disposeObject } from '../world/assets.js';

export class MountRuntime {
  constructor(character) {
    this.character = character;
    this.state = character.state.mount;
    this.root = null;
    this.animation = null;
    this.definition = null;
    this.resourceId = null;
    this.resources = new Set();
    this.generation = 0;
  }

  async mount(definition) {
    if (this.state.isMounted && !this.dismount()) return false;
    const generation = ++this.generation;
    const requested = new Set([definition.model, ...Object.values(definition.animations || {}), ...Object.values(definition.riderAnimations || {})]);
    const acquired = new Map();
    const loads = await Promise.allSettled([...requested].map(async id => {
      acquired.set(id, await this.character.assets.load(id, { priority: 0 }));
    }));
    const failed = loads.find(result => result.status === 'rejected');
    if (failed || generation !== this.generation) {
      for (const id of acquired.keys()) this.character.assets.release(id);
      if (failed) throw failed.reason;
      return false;
    }
    const asset = acquired.get(definition.model);
    const model = cloneSkeleton(asset.scene);
    const scale = definition.modelScales?.[this.character.state.appearance?.modelFamily] ?? definition.scale ?? 1;
    model.scale.multiplyScalar(scale);
    model.traverse(node => {
      if (Array.isArray(node.material)) node.material = node.material.map(material => material.clone());
      else if (node.material) node.material = node.material.clone();
      if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; }
    });
    this.root = model;
    this.definition = definition;
    this.resourceId = definition.model;
    this.resources = requested;
    this.character.root.add(model);
    this.animation = new AnimationRuntime(model);
    for (const clip of asset.animations || []) this.animation.register(clip.name, clip);
    for (const [state, clipName] of Object.entries(definition.states || {})) {
      this.animation.register(state, asset.animations?.find(clip => clip.name === clipName));
    }
    for (const [state, id] of Object.entries(definition.animations || {})) {
      this.animation.register(state, acquired.get(id)?.animations?.[0]);
    }
    for (const [state, id] of Object.entries(definition.riderAnimations || {})) {
      this.character.animation.register(`mounted-${state}`, acquired.get(id)?.animations?.[0]);
    }
    const anchor = (definition.riderBone && model.getObjectByName(definition.riderBone)) || model;
    const seat = new THREE.Group();
    seat.name = 'rider-attachment';
    seat.scale.setScalar(1 / scale);
    seat.position.fromArray(definition.riderPosition || [0, 0, 0]);
    if (definition.riderQuaternion) seat.quaternion.fromArray(definition.riderQuaternion).normalize();
    else if (definition.riderRotation) seat.rotation.fromArray([...definition.riderRotation, 'XYZ']);
    anchor.add(seat);
    seat.add(this.character.model);
    Object.assign(this.state, { isMounted: true, mountId: definition.id, movementMode: 'ground' });
    this.character.animation?.play('mounted-idle');
    return true;
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

  step(dt, { direction = new THREE.Vector3(), ascend = 0, descend = 0 }, navigation) {
    if (!this.state.isMounted) return false;
    const position = this.character.root.position;
    const mode = this.state.movementMode;
    const moving = direction.lengthSq() > 0;
    const speed = mode === 'ground' ? this.definition.speed || 11 : this.definition.flightSpeed || 18;
    const offset = direction.clone().multiplyScalar(speed * dt);
    if (mode === 'ground') {
      navigation.move(position, offset.x, offset.z);
      if (ascend) this.takeoff();
    } else {
      position.add(offset);
      if (mode === 'takeoff') {
        position.y = Math.min(this.takeoffHeight, position.y + 4 * dt);
        if (position.y >= this.takeoffHeight) this.state.movementMode = 'flying';
      } else if (mode === 'landing') {
        const floor = navigation.surfaceAt(position.x, position.z, position.y, 10000);
        if (!floor) { this.state.movementMode = 'flying'; return true; }
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
    const animationState = mode === 'ground' ? moving ? 'run' : 'idle' : ascend && this.animation?.clips.has('ascend') ? 'ascend' : moving ? 'fly' : 'hover';
    this.animation?.update(dt, animationState);
    this.character.state.movement = mode === 'ground' ? 'mounted-idle' : 'mounted-flying';
    return true;
  }

  dismount() {
    if (!this.state.isMounted || this.state.movementMode !== 'ground') return false;
    this.generation++;
    this.character.root.add(this.character.model);
    this.root.removeFromParent();
    this.animation?.dispose();
    disposeObject(this.root);
    for (const id of this.resources) this.character.assets.release(id);
    this.resources.clear();
    this.root = null;
    this.resourceId = null;
    this.definition = null;
    this.animation = null;
    Object.assign(this.state, { isMounted: false, mountId: null, movementMode: 'ground' });
    this.character.state.movement = 'idle';
    return true;
  }

  dispose() {
    this.generation++;
    if (!this.root) return;
    this.character.root.add(this.character.model);
    this.animation?.dispose();
    this.root.removeFromParent();
    disposeObject(this.root);
    for (const id of this.resources) this.character.assets?.release(id);
    this.resources.clear();
    this.root = null;
    this.animation = null;
    Object.assign(this.state, { isMounted: false, mountId: null, movementMode: 'ground' });
  }
}
