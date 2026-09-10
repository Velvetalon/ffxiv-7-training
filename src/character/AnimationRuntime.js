import * as THREE from 'three';

export class AnimationRuntime {
  constructor(model) {
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.clips = new Map();
    this.aliases = new Map();
    this.current = null;
    this.state = 'idle';
    this.actionRemaining = 0;
    this.looping = false;
  }

  register(state, clip, aliases = []) {
    if (!clip?.tracks?.length || !state) return false;
    this.clips.set(state, clip);
    for (const alias of aliases) this.alias(alias, state);
    return true;
  }

  alias(state, target) {
    if (state && target) this.aliases.set(state, target);
    return this;
  }

  resolve(state) {
    if (this.clips.has(state)) return state;
    const alias = this.aliases.get(state);
    return alias && this.clips.has(alias) ? alias : null;
  }

  has(state) { return Boolean(this.resolve(state)); }

  clip(state) {
    const resolved = this.resolve(state);
    return resolved ? this.clips.get(resolved) : null;
  }

  play(state, { loop = true, fade = 0.18, speed = 1, restart = false } = {}) {
    const resolved = this.resolve(state);
    const clip = resolved ? this.clips.get(resolved) : null;
    if (!clip) return false;
    const action = this.mixer.clipAction(clip);
    if (this.current === action && !restart && (this.looping || this.actionRemaining > 0)) return true;
    action.reset().setEffectiveTimeScale(speed).setEffectiveWeight(1);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, fade, false);
    else action.fadeIn(fade);
    action.play();
    this.current = action;
    this.state = state;
    this.looping = loop;
    this.actionRemaining = loop ? 0 : Math.max(0, clip.duration / Math.max(0.001, speed));
    return true;
  }

  update(dt, movementState = 'idle') {
    if (this.actionRemaining > 0) this.actionRemaining = Math.max(0, this.actionRemaining - dt);
    const oneShotMovement = movementState === 'jump-start' || movementState === 'jump-land';
    const justFinished = !this.actionRemaining && !this.looping && this.state === movementState;
    if (!this.actionRemaining && !justFinished && (!this.current || !this.looping || this.state !== movementState)) {
      this.play(movementState, { loop: !oneShotMovement });
    }
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.clips.clear();
    this.aliases.clear();
  }
}
