/**
 * Slot-based profile resolver. Profiles bind semantic events to slots with
 * replace / append-layer / suppress semantics; explicit fallbacks only.
 */
export class ProfileResolver {
  constructor() {
    this.bindings = new Map();
    this.nextId = 1;
  }

  bindProfiles(entityRef, profileRefs = []) {
    const handle = { id: this.nextId++, entityRef, profiles: [...profileRefs], context: {}, revision: 0 };
    this.bindings.set(handle.id, handle);
    return handle;
  }

  unbind(handleOrRef) {
    for (const [id, handle] of this.bindings) {
      if (handle === handleOrRef || handle.entityRef === handleOrRef) { this.bindings.delete(id); return true; }
    }
    return false;
  }

  updateContext(handle, context = {}) {
    if (!handle || !this.bindings.has(handle.id)) return false;
    Object.assign(handle.context, context);
    handle.revision++;
    return true;
  }

  compatible(rule, context) {
    if (!rule.conditions) return true;
    return Object.entries(rule.conditions).every(([key, expected]) => {
      const actual = context[key];
      return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
    });
  }

  resolve(event, context = {}) {
    const matched = [];
    const suppressed = [];
    const conflicts = [];
    const slots = new Map();
    for (const handle of this.bindings.values()) {
      if (handle.entityRef !== event.ownerId && handle.entityRef !== event.ownerRef) continue;
      const merged = { ...handle.context, ...context };
      for (const profile of handle.profiles) {
        const rules = profile?.rules || [];
        for (const rule of rules) {
          if (rule.event !== event.type) continue;
          if (!this.compatible(rule, merged)) continue;
          matched.push({ profile: profile.id || 'anonymous', rule });
        }
      }
    }
    for (const hit of matched) {
      const rule = hit.rule;
      if (rule.suppress) { suppressed.push(hit); continue; }
      const slot = rule.slot || 'primary';
      const mode = rule.mode || 'replace';
      if (mode === 'append-layer') {
        if (!slots.has(slot)) slots.set(slot, []);
        const layerId = rule.layerId || rule.cue?.id || 'layer';
        const bucket = slots.get(slot);
        if (bucket.some(layer => layer.layerId === layerId)) continue;
        bucket.push({ layerId, rule, profile: hit.profile });
      } else {
        const existing = slots.get(slot);
        const candidate = { layerId: 'replace', rule, profile: hit.profile, priority: rule.priority ?? 0 };
        if (!existing) slots.set(slot, candidate);
        else if (candidate.priority > (existing.priority ?? 0)) slots.set(slot, candidate);
        else if (candidate.priority === (existing.priority ?? 0) && existing.rule !== candidate.rule) {
          conflicts.push({ slot, a: existing, b: candidate });
        }
      }
    }
    const layers = [];
    for (const [slot, value] of slots) {
      if (Array.isArray(value)) for (const layer of value) layers.push({ slot, ...layer });
      else layers.push({ slot, ...value });
    }
    const fallback = !layers.length && !suppressed.length
      ? { used: false, reason: 'no-compatible-rule' }
      : null;
    if (suppressed.length) layers.length = 0;
    return { event, layers, suppressed, conflicts, fallback, explain: this.explain({ layers, suppressed, conflicts, fallback }) };
  }

  explain({ layers, suppressed, conflicts, fallback }) {
    const lines = [];
    for (const layer of layers) lines.push(`slot ${layer.slot} -> ${layer.rule.cue?.id || layer.rule.cue} (${layer.profile})`);
    for (const hit of suppressed) lines.push(`suppressed by ${hit.rule.cue?.id || hit.rule.cue} (${hit.profile})`);
    for (const conflict of conflicts) lines.push(`conflict in slot ${conflict.slot}: ${conflict.a.rule.cue} vs ${conflict.b.rule.cue}`);
    if (fallback?.used === false) lines.push(`fallback not used: ${fallback.reason}`);
    return lines;
  }
}

export default ProfileResolver;
