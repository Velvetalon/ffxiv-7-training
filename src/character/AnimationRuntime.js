import * as THREE from 'three';

export class AnimationRuntime {
  constructor(model) {
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.clips = new Map();
    this.current = null;
    this.state = 'idle';
    this.actionRemaining = 0;
  }

  register(state, clip) {
    if (clip?.tracks?.length) this.clips.set(state, clip);
  }

  play(state, { loop = true, fade = 0.18, speed = 1, restart = false } = {}) {
    const clip = this.clips.get(state);
    if (!clip) return false;
    const action = this.mixer.clipAction(clip);
    if (this.current === action && !restart) return true;
    action.reset().setEffectiveTimeScale(speed).setEffectiveWeight(1);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    if (this.current && this.current !== action) action.crossFadeFrom(this.current, fade, false);
    else action.fadeIn(fade);
    action.play();
    this.current = action;
    this.state = state;
    this.actionRemaining = loop ? 0 : clip.duration / speed;
    return true;
  }

  update(dt, movementState = 'idle') {
    if (this.actionRemaining > 0) this.actionRemaining = Math.max(0, this.actionRemaining - dt);
    if (!this.actionRemaining) this.play(movementState);
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    this.clips.clear();
  }
}
