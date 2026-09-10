export class SkillDefinitions {
  constructor(actions = [], presentation = {}) {
    this.definitions = new Map();
    for (const action of actions) {
      this.definitions.set(action.id, makeDefinition(action, presentation[action.id] || {}));
    }
  }

  merge(presentation = {}) {
    for (const [id, values] of Object.entries(presentation)) {
      const current = this.definitions.get(id);
      if (current) this.definitions.set(id, makeDefinition(current, values));
    }
  }

  get(id) { return this.definitions.get(id) || null; }
  has(id) { return this.definitions.has(id); }
}

function makeDefinition(action = {}, source = {}) {
  const animation = source.animation && typeof source.animation === 'object' ? source.animation : {};
  const timing = Object.freeze({
    cast: action.timing?.cast ?? action.cast ?? 0,
    recast: action.timing?.recast ?? action.recast ?? 0,
    ...(source.timing || {}),
  });
  const soundEvents = Array.isArray(source.soundEvents)
    ? source.soundEvents.map(cue => Object.freeze({ ...cue }))
    : Array.isArray(action.soundEvents) ? action.soundEvents.map(cue => Object.freeze({ ...cue })) : [];
  const animationId = source.animationId ?? animation.id ?? action.animationId ?? null;
  const animationResourceId = source.animationResourceId
    ?? source.animationAssetId
    ?? animation.resourceId
    ?? action.animationResourceId
    ?? (typeof animationId === 'string' ? animationId : null);
  return Object.freeze({
    id: action.id,
    skillId: source.skillId ?? action.skillId ?? null,
    name: action.name,
    animationId,
    animationResourceId,
    animationState: source.animationState ?? animation.state ?? action.animationState ?? action.id,
    animationClip: source.animationClip ?? animation.clip ?? action.animationClip ?? null,
    castAnimationState: source.castAnimationState ?? action.castAnimationState ?? null,
    castAnimationClip: source.castAnimationClip ?? action.castAnimationClip ?? null,
    vfxId: source.vfxId ?? action.vfxId ?? null,
    soundId: source.soundId ?? action.soundId ?? null,
    soundEvents: Object.freeze(soundEvents),
    castSoundId: source.castSoundId ?? action.castSoundId ?? null,
    castSoundEvents: Object.freeze(Array.isArray(source.castSoundEvents)
      ? source.castSoundEvents.map(cue => Object.freeze({ ...cue }))
      : Array.isArray(action.castSoundEvents) ? action.castSoundEvents.map(cue => Object.freeze({ ...cue })) : []),
    timing,
    provenance: source.provenance || action.provenance || 'demo-action-definition; client presentation mapping unavailable',
  });
}
