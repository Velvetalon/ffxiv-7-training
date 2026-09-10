import sourceProfiles from './source-profiles.json' with { type: 'json' };

const FALLBACK_BASELINES = Object.freeze({
  // These values are copied from the pre-existing renderer fallback, not from
  // decoded client Envb data. See docs/ENVIRONMENT-SOURCES.md.
  gridania: Object.freeze({
    directional: '#ffe2b1', ambientSky: '#b9e7d0', ambientGround: '#283627',
    background: '#afc8bb', fog: '#afc8bb', directionalIntensity: 2.2,
    ambientIntensity: 2.1, exposure: 1.08,
  }),
  default: Object.freeze({
    directional: '#fff0cf', ambientSky: '#d6f5ff', ambientGround: '#374e5e',
    background: '#aac4d0', fog: '#aac4d0', directionalIntensity: 2.2,
    ambientIntensity: 2.1, exposure: 1.08,
  }),
});

const FORMAT_SOURCE = Object.freeze({
  repository: 'xivdev/file-formats',
  commit: 'ac1a01571fa7152d521e5d5f8af8e694915466a8',
  path: 'imhex/env.hexpat',
  url: 'https://github.com/xivdev/file-formats/blob/ac1a01571fa7152d521e5d5f8af8e694915466a8/imhex/env.hexpat',
});

// Generated from ownerId=1 GlobalLighting + VerticalFog keyframes in the
// installed 2026.09.01.0000.0000 client.  These are packed client colour
// bytes, intentionally not transformed to sRGB/linear without source proof.
// The internal ambientIntensity spelling is converted to runtime ambientScale
// below because the source field is a multiplier, not a final light energy.
const SOURCE_SAMPLE_TABLES = Object.freeze({
  shroud: [
    { hour: 3, sourceTimeSeconds: 10800, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#03080c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 5, sourceTimeSeconds: 18000, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#132d4c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 5.95, sourceTimeSeconds: 21420, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#627d8c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 6, sourceTimeSeconds: 21600, sunColor: '#b2daff', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#627d8c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 6.016667, sourceTimeSeconds: 21660, sunColor: '#ffc9b2', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#627d8c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 8, sourceTimeSeconds: 28800, sunColor: '#fff4e5', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#6ba1b2', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 10, sourceTimeSeconds: 36000, sunColor: '#fff9f2', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#4c88bf', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 14, sourceTimeSeconds: 50400, sunColor: '#fff9f2', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#4c88bf', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 16, sourceTimeSeconds: 57600, sunColor: '#ffe4cc', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#828c86', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 17.95, sourceTimeSeconds: 64620, sunColor: '#ffd2b2', sunIntensity: 1.2, ambientIntensity: 1, fogColor: '#44494c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 18, sourceTimeSeconds: 64800, sunColor: '#b2daff', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#44494c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 18.05, sourceTimeSeconds: 64980, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#44494c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
    { hour: 20, sourceTimeSeconds: 72000, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#091a26', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.1, fogDirectionalInscatteringIntensity: 1 },
  ],
  limsa: [
    { hour: 3, sourceTimeSeconds: 10800, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#03080c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 5, sourceTimeSeconds: 18000, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#132d4c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 5.95, sourceTimeSeconds: 21420, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#627d8c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 6, sourceTimeSeconds: 21600, sunColor: '#b2daff', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#627d8c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 6.016667, sourceTimeSeconds: 21660, sunColor: '#ffc9b2', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#627d8c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 8, sourceTimeSeconds: 28800, sunColor: '#fff4e5', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#6ba1b2', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 10, sourceTimeSeconds: 36000, sunColor: '#fff9f2', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#236db2', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 14, sourceTimeSeconds: 50400, sunColor: '#fff9f2', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#236db2', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 16, sourceTimeSeconds: 57600, sunColor: '#ffe4cc', sunIntensity: 1.4, ambientIntensity: 1, fogColor: '#828c86', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 17.95, sourceTimeSeconds: 64620, sunColor: '#ffd2b2', sunIntensity: 1.2, ambientIntensity: 1, fogColor: '#44494c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 18, sourceTimeSeconds: 64800, sunColor: '#b2daff', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#44494c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 18.05, sourceTimeSeconds: 64980, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#44494c', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
    { hour: 20, sourceTimeSeconds: 72000, sunColor: '#000000', sunIntensity: 0.1, ambientIntensity: 1, fogColor: '#091a26', fogNear: 100, fogFar: 1100, fogDensityPercent: 0.5, fogDirectionalInscatteringIntensity: 1 },
  ],
});

function runtimeSamples(samples) {
  return Object.freeze(samples.map(({ ambientIntensity, ...sample }) => Object.freeze({ ...sample, ambientScale: ambientIntensity })));
}

const SOURCE_RUNTIME_SAMPLES = Object.freeze({
  shroud: runtimeSamples(SOURCE_SAMPLE_TABLES.shroud),
  limsa: runtimeSamples(SOURCE_SAMPLE_TABLES.limsa),
});

const SOURCE_PROFILES = Object.freeze({
  limsa: Object.freeze({
    baseline: Object.freeze({ ...FALLBACK_BASELINES.default, directional: '#fff9f2', directionalIntensity: 1.4, fog: '#6ba1b2' }),
    samples: SOURCE_RUNTIME_SAMPLES.limsa,
    source: Object.freeze({
      evidence: 'confirmed-decoded-envb-adapter',
      clientVersion: '2026.09.01.0000.0000', territoryId: 129,
      zoneRoot: 'bg/ffxiv/sea_s1/twn/s1t2', defaultOwnerId: 1,
      envbPath: 'bgcommon/env/global/ffxiv_genv/genv_sea_s1/genv_s1_twn/genv_s1t2.envb',
      sha256: '4b06c34073f48c3ded35837f91fdc8b3ee85d49bdfc4933449b58203ba5c6eff', bytes: 22687,
      format: FORMAT_SOURCE,
    }),
  }),
  gridania: Object.freeze({
    baseline: Object.freeze({ ...FALLBACK_BASELINES.gridania, directional: '#fff9f2', directionalIntensity: 1.4, fog: '#6ba1b2' }),
    samples: SOURCE_RUNTIME_SAMPLES.shroud,
    source: Object.freeze({
      evidence: 'confirmed-decoded-envb-adapter',
      clientVersion: '2026.09.01.0000.0000', territoryId: 132,
      zoneRoot: 'bg/ffxiv/fst_f1/twn/f1t1', defaultOwnerId: 1,
      envbPath: 'bgcommon/env/global/ffxiv_genv/genv_fst_f1/genv_f1_twn/genv_f1t1.envb',
      sha256: '4f24bd9334084ee0053f9dd48271cf1eb8bf07249f5790429cd79f8d5a4426e3', bytes: 22879,
      format: FORMAT_SOURCE,
    }),
  }),
  f1f1: Object.freeze({
    baseline: Object.freeze({ ...FALLBACK_BASELINES.default, directional: '#fff9f2', directionalIntensity: 1.4, fog: '#6ba1b2' }),
    samples: SOURCE_RUNTIME_SAMPLES.shroud,
    source: Object.freeze({
      evidence: 'confirmed-decoded-envb-adapter',
      clientVersion: '2026.09.01.0000.0000', territoryId: 148,
      zoneRoot: 'bg/ffxiv/fst_f1/fld/f1f1', defaultOwnerId: 1,
      envbPath: 'bgcommon/env/global/ffxiv_genv/genv_fst_f1/genv_f1_fld/genv_f1f1.envb',
      sha256: 'a3447fe8c4d9b20155328bfe1ab59ab7eee6bcf8b1affe67ca8c569fb026af02', bytes: 30659,
      format: FORMAT_SOURCE,
    }),
  }),
});

export function getEnvironmentProfile(zoneId) {
  const sourceProfile = sourceProfiles[zoneId] || SOURCE_PROFILES[zoneId];
  const baseline = sourceProfile?.baseline || FALLBACK_BASELINES[zoneId] || FALLBACK_BASELINES.default;
  return Object.freeze({
    zoneId,
    baseline,
    samples: sourceProfile?.samples || [],
    evidence: sourceProfile?.source.evidence || 'project-baseline',
    source: sourceProfile?.source || 'src/world/renderer.js pre-environment fallback',
  });
}

/**
 * Runtime samples are a small, documented adapter boundary.  The source
 * profile only contains fields whose names are explicit in env.hexpat; raw
 * ToneMapping/sky/ambient channels remain in the external parser report.
 */
export function normalizeEnvironmentSamples(samples = []) {
  return samples
    .filter(sample => sample && Number.isFinite(Number(sample.hour)))
    .map(sample => ({ ...sample, hour: ((Number(sample.hour) % 24) + 24) % 24 }))
    .sort((left, right) => left.hour - right.hour);
}
