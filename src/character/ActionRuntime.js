export class ActionRuntime {
  constructor(character, { definitions, audio, effects, targetPosition } = {}) {
    this.character = character;
    this.definitions = definitions;
    this.audio = audio;
    this.effects = effects;
    this.targetPosition = targetPosition || (() => character.root.position);
    this.time = 0;
    this.lastAction = null;
    this.lastPlayed = -Infinity;
    this.triggered = new Map();
  }

  apply(event) {
    if (event.type === 'error') return;
    const definition = this.definitions?.get(event.actionId);
    if (event.type === 'cast') {
      const castAnimation = definition?.castAnimationState || definition?.castAnimationClip;
      const castCues = definition?.castSoundEvents?.length || definition?.castSoundId;
      if (!castAnimation && !castCues) return;
      const castDefinition = castAnimation
        ? { ...definition, animationState: castAnimation, soundEvents: definition.castSoundEvents, soundId: definition.castSoundId }
        : { ...definition, soundEvents: definition.castSoundEvents, soundId: definition.castSoundId };
      this.trigger(event, castDefinition, 'cast');
      return;
    }
    this.trigger(event, definition, 'resolved');
  }

  trigger(event, definition, phase) {
    const previous = this.triggered.get(event.actionId);
    const duplicateBurst = previous && this.time - previous.time < 0.08;
    if (!duplicateBurst) {
      this.character.playAction(definition, event);
      this.playSounds(definition, phase);
      this.triggered.set(event.actionId, {
        phase,
        time: this.time,
        until: this.time,
      });
      this.lastAction = event.actionId;
      this.lastPlayed = this.time;
    }
    if (phase === 'resolved' && event.type !== 'field') this.effects?.play(event, this.targetPosition(), this.character.state.jobId);
  }

  playSounds(definition, phase = 'resolved') {
    const castCues = phase === 'cast' && definition?.castSoundEvents?.length ? definition.castSoundEvents : null;
    const castSoundId = phase === 'cast' ? definition?.castSoundId : null;
    const cues = castCues || (definition?.soundEvents?.length ? definition.soundEvents : null);
    if (cues) {
      const defaultDelay = Number(definition?.timing?.soundDelaySeconds || 0);
      for (const cue of cues) {
        const resourceId = cue?.resourceId || cue?.soundId || definition.soundId;
        if (!resourceId) continue;
        this.audio?.playAction(resourceId, {
          delaySeconds: Number(cue?.delaySeconds ?? defaultDelay) || 0,
          volume: cue?.volume,
        });
      }
    } else if (castSoundId || definition?.soundId) {
      this.audio?.playAction(castSoundId || definition.soundId, {
        delaySeconds: Number(definition?.timing?.soundDelaySeconds || 0) || 0,
      });
    }
  }

  update(dt) {
    this.time += dt;
    for (const [actionId, entry] of this.triggered) {
      if (this.time > Math.max(entry.until || entry.time, entry.time + 2)) this.triggered.delete(actionId);
    }
  }
}
