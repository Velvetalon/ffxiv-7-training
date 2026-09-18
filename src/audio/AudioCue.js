/**
 * Declarative playback descriptions and their validation.
 *
 * A cue is a small tree of ops: clip, sequence, parallel and loop. Structure
 * problems never throw; they surface as issues with the cue flagged partial.
 */

export const CUE_KINDS = ['one-shot', 'loop', 'sequence', 'parallel'];
export const LAYER_OPS = ['clip', 'sequence', 'parallel', 'loop'];
const MAX_GAIN = 4;

function num(value, fallback, min = -Infinity, max = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function seedNumber(seed) {
  const numeric = Number(seed);
  return Number.isFinite(numeric) ? Math.trunc(numeric) >>> 0 : Math.floor(Math.random() * 0x100000000) >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeLayer(raw, path, issues) {
  if (!raw || typeof raw !== 'object') {
    issues.push({ path, code: 'invalid-layer', message: 'Layer must be an object' });
    return null;
  }
  const op = raw.op ?? (raw.clip != null ? 'clip' : undefined);
  const gain = num(raw.gain, 1, 0, MAX_GAIN);
  if (raw.gain !== undefined && Number(raw.gain) !== gain) {
    issues.push({ path: path + '.gain', code: 'invalid-gain', message: 'Gain must be a number between 0 and ' + MAX_GAIN });
  }
  if (op === 'clip') {
    if (typeof raw.clip !== 'string' || !raw.clip) {
      issues.push({ path, code: 'missing-clip', message: 'Clip layer requires a clip id' });
      return null;
    }
    return {
      op: 'clip',
      clip: raw.clip,
      gain,
      delay: num(raw.delay, 0, 0),
      offset: num(raw.offset, 0, 0),
      loop: raw.loop === true,
      loopStart: Number.isFinite(Number(raw.loopStart)) ? Math.max(0, Number(raw.loopStart)) : null,
      loopEnd: Number.isFinite(Number(raw.loopEnd)) ? Math.max(0, Number(raw.loopEnd)) : null,
    };
  }
  if (op === 'sequence' || op === 'parallel') {
    const layers = normalizeLayers(raw.layers, path + '.layers', issues);
    return { op, layers, gain, delay: num(raw.delay, 0, 0) };
  }
  if (op === 'loop') {
    const layers = normalizeLayers(raw.layers, path + '.layers', issues);
    const region = {};
    if (Number.isFinite(Number(raw.region?.start))) region.start = Math.max(0, Number(raw.region.start));
    if (Number.isFinite(Number(raw.region?.end))) region.end = Math.max(0, Number(raw.region.end));
    return { op: 'loop', layers, region, gain, delay: num(raw.delay, 0, 0) };
  }
  issues.push({ path, code: 'unknown-op', message: 'Unknown audio op: ' + String(op) });
  return null;
}

function normalizeLayers(raw, path, issues) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path, code: 'invalid-layers', message: 'Layers must be an array' });
    return [];
  }
  return raw.map((item, index) => normalizeLayer(item, path + '[' + index + ']', issues)).filter(Boolean);
}

/** Validate a descriptor and build the normalized cue; never throws. */
export function validateCue(desc) {
  const issues = [];
  if (!desc || typeof desc !== 'object') {
    return { ok: false, cue: null, issues: [{ path: '', code: 'invalid-cue', message: 'Cue must be an object' }] };
  }
  const kind = desc.kind ?? 'one-shot';
  if (!CUE_KINDS.includes(kind)) {
    issues.push({ path: '.kind', code: 'unknown-kind', message: 'Unknown cue kind: ' + String(kind) });
    return { ok: false, cue: null, issues };
  }
  let layers = normalizeLayers(desc.layers, '.layers', issues);
  if (!layers.length && desc.clip != null) {
    layers = normalizeLayers([{ op: 'clip', clip: desc.clip, gain: desc.gain, delay: desc.delay }], '.layers', issues);
  }
  const candidates = [];
  if (desc.candidates !== undefined) {
    if (!Array.isArray(desc.candidates)) {
      issues.push({ path: '.candidates', code: 'invalid-candidates', message: 'Candidates must be an array' });
    } else {
      desc.candidates.forEach((entry, index) => {
        const path = '.candidates[' + index + ']';
        if (!entry || typeof entry !== 'object' || (entry.id == null && entry.cue == null)) {
          issues.push({ path, code: 'invalid-candidate', message: 'Candidate requires id or cue' });
          return;
        }
        const weight = num(entry.weight, 1, 0);
        if (entry.weight !== undefined && Number(entry.weight) !== weight) {
          issues.push({ path: path + '.weight', code: 'invalid-weight', message: 'Weight must be a non-negative number' });
        }
        candidates.push({ id: entry.id ?? null, cue: entry.cue ?? null, weight });
      });
    }
    if (!candidates.length && !issues.some(issue => issue.path.startsWith('.candidates'))) {
      issues.push({ path: '.candidates', code: 'empty-candidates', message: 'Candidates must not be empty' });
    }
  }
  const playable = layers.length > 0 || candidates.length > 0;
  if (!playable) {
    issues.push({ path: '', code: 'empty-cue', message: 'Cue has no playable layers or candidates' });
    return { ok: false, cue: null, issues };
  }
  if (kind === 'sequence' || kind === 'parallel' || kind === 'loop') {
    layers = [normalizeLayer({ op: kind, layers, region: desc.region }, '', issues)].filter(Boolean);
  }
  const cue = new AudioCue({
    id: typeof desc.id === 'string' && desc.id ? desc.id : 'cue-' + seedNumber(desc.seed ?? Math.random()),
    kind,
    layers,
    gain: num(desc.gain, 1, 0, MAX_GAIN),
    delay: num(desc.delay, 0, 0),
    bus: typeof desc.bus === 'string' && desc.bus ? desc.bus : 'action',
    stopPolicy: ['cancel', 'replace', 'play-through'].includes(desc.stopPolicy) ? desc.stopPolicy : 'cancel',
    candidates,
    seed: desc.seed != null ? seedNumber(desc.seed) : null,
    issues,
  });
  return { ok: true, cue, issues };
}

/** Immutable, validated playback description. */
export class AudioCue {
  constructor({ id, kind, layers, gain, delay, bus, stopPolicy, candidates, seed, issues }) {
    this.id = id;
    this.kind = kind;
    this.layers = layers;
    this.gain = gain;
    this.delay = delay;
    this.bus = bus;
    this.stopPolicy = stopPolicy;
    this.candidates = candidates;
    this.seed = seed;
    this.validation = { issues, partial: issues.length > 0 };
    Object.freeze(this);
  }

  get partial() {
    return this.validation.partial;
  }

  /** Deterministic weighted pick; pass a seed for reproducible selection. */
  selectCandidate({ seed } = {}) {
    if (!this.candidates.length) return null;
    const rng = mulberry32(seed != null ? seedNumber(seed) : this.seed ?? seedNumber(undefined));
    const total = this.candidates.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = rng() * total;
    for (const entry of this.candidates) {
      roll -= entry.weight;
      if (roll <= 0) return entry;
    }
    return this.candidates[this.candidates.length - 1];
  }

  static create(desc) {
    return validateCue(desc);
  }
}

/**
 * Flatten a cue into clip events with start offsets in seconds.
 * Sequence advances by each child's delay plus its resolved duration;
 * loop layers return Infinity, so later sequence siblings overlap them.
 */
export function flattenCue(cue, { durationOf = () => 0 } = {}) {
  const events = [];
  walkLayers(cue.layers, 0, cue.gain, null);
  return events;

  function walkLayers(layers, offset, gainMul, loopCtx) {
    let maxEnd = offset;
    for (const layer of layers) {
      const duration = walkLayer(layer, offset, gainMul, loopCtx);
      const end = offset + layer.delay + (Number.isFinite(duration) ? duration : 0);
      maxEnd = Math.max(maxEnd, end);
    }
    return maxEnd - offset;
  }

  function walkLayer(layer, offset, gainMul, loopCtx) {
    const gain = layer.gain * gainMul;
    if (layer.op === 'clip') {
      const loop = layer.loop || loopCtx?.loop === true;
      events.push({
        clipId: layer.clip,
        offset: offset + layer.delay + layer.offset,
        gain,
        loop,
        loopStart: layer.loopStart ?? loopCtx?.region?.start ?? 0,
        loopEnd: layer.loopEnd ?? loopCtx?.region?.end ?? null,
      });
      if (loop) return Infinity;
      return durationOf(layer.clip);
    }
    if (layer.op === 'loop') {
      return walkLayers(layer.layers, offset, gain, { loop: true, region: layer.region });
    }
    if (layer.op === 'sequence') {
      let cursor = offset;
      for (const child of layer.layers) {
        const duration = walkLayer(child, cursor, gain, loopCtx);
        cursor += child.delay + (Number.isFinite(duration) ? duration : 0);
      }
      return cursor - offset;
    }
    if (layer.op === 'parallel') {
      return walkLayers(layer.layers, offset, gain, loopCtx);
    }
    return 0;
  }
}
