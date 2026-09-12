export class AnimationRuntime {
  constructor(model) {
    this.model = model;
    this.clips = new Map();
    this.aliases = new Map();
    this.current = null;
    this.state = 'idle';
    this.actionRemaining = 0;
    this.looping = false;
    this.transition = null;
  }

  register(state, clip, aliases = []) {
    if (!clip?.targetedAnimations?.length || !state) return false;
    const previous = this.clips.get(state);
    if (previous && previous !== clip) previous.dispose?.();
    clip.stop?.();
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
    const group = resolved ? this.clips.get(resolved) : null;
    if (!group) return false;
    if (this.current === group && !restart && (this.looping || this.actionRemaining > 0)) return true;
    const previous = this.current;
    const replacingSameGroup = previous === group;
    if (replacingSameGroup) previous.stop(true);
    group.stop(true);
    group.reset();
    group.enableBlending = true;
    group.blendingSpeed = fade > 0 ? Math.min(1, 1 / Math.max(fade * 60, 1)) : 1;
    group.start(loop, speed);
    group.setWeightForAllAnimatables(previous && fade > 0 ? 0 : 1);
    if (previous && !replacingSameGroup && fade > 0) {
      previous.setWeightForAllAnimatables(1);
      this.transition = { from: previous, to: group, elapsed: 0, duration: fade };
    } else {
      if (!replacingSameGroup) previous?.stop(true);
      this.transition = null;
    }
    this.current = group;
    this.state = state;
    this.looping = loop;
    this.actionRemaining = loop ? 0 : Math.max(0, group.getLength() / Math.max(0.001, Math.abs(speed)));
    return true;
  }

  update(dt, movementState = 'idle') {
    if (this.transition) {
      this.transition.elapsed += dt;
      const weight = Math.min(1, this.transition.elapsed / Math.max(0.001, this.transition.duration));
      this.transition.from.setWeightForAllAnimatables(1 - weight);
      this.transition.to.setWeightForAllAnimatables(weight);
      if (weight >= 1) {
        this.transition.from.stop(true);
        this.transition = null;
      }
    }
    if (this.actionRemaining > 0) this.actionRemaining = Math.max(0, this.actionRemaining - dt);
    const oneShotMovement = movementState === 'jump-start' || movementState === 'jump-land';
    const justFinished = !this.actionRemaining && !this.looping && this.state === movementState;
    if (!this.actionRemaining && !justFinished && (!this.current || !this.looping || this.state !== movementState)) {
      this.play(movementState, { loop: !oneShotMovement });
    }
  }

  dispose() {
    const clips = new Set(this.clips.values());
    for (const clip of clips) {
      clip.stop?.(true);
      clip.dispose?.();
    }
    this.clips.clear();
    this.aliases.clear();
    this.current = null;
    this.transition = null;
  }
}
