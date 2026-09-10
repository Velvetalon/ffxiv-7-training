export class SkillDefinitions {
  constructor(actions = [], presentation = {}) {
    this.definitions = new Map();
    for (const action of actions) {
      const source = presentation[action.id] || {};
      this.definitions.set(action.id, Object.freeze({
        id: action.id,
        skillId: source.skillId ?? null,
        name: action.name,
        animationId: source.animationId ?? null,
        animationState: source.animationState ?? action.id,
        vfxId: source.vfxId ?? null,
        soundId: source.soundId ?? null,
        timing: { cast: action.cast || 0, recast: action.recast || 0, ...(source.timing || {}) },
        provenance: source.provenance || 'demo-action-definition; client presentation mapping unavailable',
      }));
    }
  }

  merge(presentation) {
    for (const [id, values] of Object.entries(presentation)) {
      const current = this.definitions.get(id);
      if (current) this.definitions.set(id, Object.freeze({ ...current, ...values }));
    }
  }

  get(id) { return this.definitions.get(id) || null; }
}
