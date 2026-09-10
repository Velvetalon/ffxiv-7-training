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
  }

  apply(event) {
    if (event.type === 'error') return;
    const definition = this.definitions?.get(event.actionId);
    if (event.actionId !== this.lastAction || this.time - this.lastPlayed > 0.05) {
      this.character.playAction(definition, event);
      if (definition?.soundEvents?.length) {
        for (const cue of definition.soundEvents) {
          this.audio?.playAction(cue.resourceId, { delaySeconds: cue.delaySeconds || 0 });
        }
      } else if (definition?.soundId) {
        this.audio?.playAction(definition.soundId);
      }
      this.lastAction = event.actionId;
      this.lastPlayed = this.time;
    }
    if (event.type !== 'field') this.effects?.play(event, this.targetPosition(), this.character.state.jobId);
  }

  update(dt) { this.time += dt; }
}
