import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { SphericalHarmonics, SphericalPolynomial } from '@babylonjs/core/Maths/sphericalPolynomial.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { Scene } from '@babylonjs/core/scene.js';

const PRESETS = Object.freeze({ day: 12, dusk: 17.5, night: 22 });
const DEFAULT_IBL_SIZE = 4;
const SHADOW_MAP_SIZE = 1536;
const SHADOW_FRUSTUM_SIZE = 512;
const SHADOW_MIN_Z = 0.5;
const SHADOW_MAX_Z = 900;

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, finite(value, 0)));
}

function wrapHour(value) {
  return ((finite(value, 0) % 24) + 24) % 24;
}

function color(value, fallback = '#000000') {
  if (value instanceof Color3) return value.clone();
  if (Array.isArray(value)) return new Color3(finite(value[0], 0), finite(value[1], 0), finite(value[2], 0));
  const text = typeof value === 'string' ? value.replace('#', '') : fallback.replace('#', '');
  const normalized = text.length === 3 ? text.split('').map(part => `${part}${part}`).join('') : text.padStart(6, '0');
  const number = Number.parseInt(normalized.slice(0, 6), 16);
  if (!Number.isFinite(number)) return Color3.FromHexString(fallback);
  return new Color3(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
}

function mix(left, right, ratio) {
  return left.scale(1 - ratio).add(right.scale(ratio));
}

function saturate(source, amount) {
  const luminance = source.r * 0.2126 + source.g * 0.7152 + source.b * 0.0722;
  const scale = finite(amount, 1);
  return new Color3(
    luminance + (source.r - luminance) * scale,
    luminance + (source.g - luminance) * scale,
    luminance + (source.b - luminance) * scale,
  );
}

function colorHex(source) {
  return source instanceof Color3 ? source.toHexString() : color(source).toHexString();
}

function sampleValue(left, right, ratio, key) {
  const leftValue = left?.[key];
  const rightValue = right?.[key];
  if (leftValue === undefined && rightValue === undefined) return undefined;
  if (typeof leftValue !== 'number' || typeof rightValue !== 'number') return ratio < 0.5 ? leftValue : rightValue;
  return leftValue + (rightValue - leftValue) * ratio;
}

function sampleProfile(samples, hour) {
  if (!samples.length) return null;
  const ordered = samples
    .filter(sample => sample && Number.isFinite(Number(sample.hour)))
    .map(sample => ({ ...sample, hour: wrapHour(sample.hour) }))
    .sort((left, right) => left.hour - right.hour);
  if (!ordered.length) return null;
  const extended = [...ordered, { ...ordered[0], hour: ordered[0].hour + 24 }];
  const targetHour = wrapHour(hour);
  const target = targetHour < ordered[0].hour ? targetHour + 24 : targetHour;
  let rightIndex = extended.findIndex(sample => sample.hour >= target);
  if (rightIndex < 1) rightIndex = 1;
  const right = extended[rightIndex];
  const left = extended[rightIndex - 1];
  const ratio = Math.min(1, Math.max(0, (target - left.hour) / Math.max(0.0001, right.hour - left.hour)));
  const result = { hour: targetHour };
  for (const key of [
    'sourceTimeSeconds', 'sunIntensity', 'moonIntensity', 'ambientSaturation', 'ambientAttenuation',
    'extraAmbientIntensity', 'extraAmbientWeight', 'ambientScale', 'fogIntensity', 'fogNear',
    'fogFar', 'fogDensityPercent', 'fogMinOpacity', 'fogDirectionalInscatteringIntensity',
  ]) {
    const value = sampleValue(left, right, ratio, key);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ['sunColor', 'moonColor', 'extraAmbientColor', 'fogColor']) {
    if (left[key] === undefined && right[key] === undefined) continue;
    result[key] = mix(color(left[key] ?? right[key]), color(right[key] ?? left[key]), ratio);
  }
  result.source = ratio < 0.5 ? left.source || right.source : right.source || left.source;
  return result;
}

function solarDirection(hour) {
  const angle = ((wrapHour(hour) - 6) / 24) * Math.PI * 2;
  const altitude = Math.sin(angle);
  return new Vector3(Math.cos(angle), altitude, Math.sin(angle)).normalize();
}

function byte(value) {
  return Math.round(Math.min(1, Math.max(0, finite(value, 0))) * 255);
}

function faceData(size, faceColor) {
  const data = new Uint8Array(size * size * 4);
  const r = byte(faceColor.r);
  const g = byte(faceColor.g);
  const b = byte(faceColor.b);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
    data[index + 3] = 255;
  }
  return data;
}

function buildSphericalPolynomial(state) {
  const harmonics = new SphericalHarmonics();
  const sky = color(state.sunColor).scale(Math.max(0.15, state.sunIntensity)).add(color(state.moonColor).scale(state.moonIntensity));
  const ground = color(state.fogColor).scale(0.42);
  harmonics.addLight(new Vector3(0, 1, 0), sky, 1);
  harmonics.addLight(new Vector3(0, -1, 0), ground, 0.7);
  harmonics.addLight(state.sunVector, color(state.sunColor), Math.max(0.1, state.sunIntensity * 0.2));
  harmonics.addLight(state.moonVector, color(state.moonColor), Math.max(0.05, state.moonIntensity * 0.12));
  harmonics.scaleInPlace(Math.max(0.01, finite(state.ambientScale, 1)));
  harmonics.convertIncidentRadianceToIrradiance();
  harmonics.preScaleForRendering();
  return SphericalPolynomial.FromHarmonics(harmonics);
}

function buildProceduralFaces(state, size) {
  const horizon = color(state.fogColor).scale(Math.max(0.05, finite(state.fogIntensity, 1)));
  const sky = mix(horizon, color(state.sunColor), clamp01(state.sunIntensity / 1.4));
  const ground = mix(horizon.scale(0.5), color(state.moonColor), clamp01(state.moonIntensity * 0.35));
  return [
    faceData(size, mix(horizon, sky, 0.55)),
    faceData(size, sky.scale(1.08)),
    faceData(size, mix(horizon, sky, 0.8)),
    faceData(size, mix(horizon, sky, 0.4)),
    faceData(size, ground),
    faceData(size, mix(horizon, sky, 0.7)),
  ];
}

export class EnvironmentAdapter {
  constructor({
    scene,
    profile,
    directIntensityScale = 1,
    ambientEngineIntensity = 0.8,
    iblIntensity = 1,
    imageProcessingExposure = 1,
    iblSize = DEFAULT_IBL_SIZE,
    onDiagnostic = () => {},
  } = {}) {
    this.scene = scene;
    this.profile = profile || { samples: [], source: { evidence: 'missing-profile' } };
    this.samples = Array.isArray(this.profile.samples) ? this.profile.samples : [];
    this.directIntensityScale = finite(directIntensityScale, 1);
    this.ambientEngineIntensity = finite(ambientEngineIntensity, 0.8);
    this.iblIntensity = finite(iblIntensity, 1);
    this.imageProcessingExposure = finite(imageProcessingExposure, 1);
    this.iblSize = Math.max(1, Math.floor(finite(iblSize, DEFAULT_IBL_SIZE)));
    this.onDiagnostic = onDiagnostic;
    this.iblReadyObservable = new Observable();
    this.lights = null;
    this.environmentTexture = null;
    this.state = null;
    this.environmentProvenance = 'source-tinted-procedural-approx';
    this.proceduralApproximation = true;
    this.unsupported = { 'no-zone-cubemap-or-sky-asset': 1 };
    this.shadowGenerator = null;
    this.shadowSource = null;
    this.shadowCasters = new Set();
    this.shadowConfig = Object.freeze({
      mapSize: SHADOW_MAP_SIZE,
      frustumSize: SHADOW_FRUSTUM_SIZE,
      minZ: SHADOW_MIN_Z,
      maxZ: SHADOW_MAX_Z,
      filter: 'PCF-medium',
      darkness: 0.35,
      bias: 0.0005,
      normalBias: 0.02,
      sourceEquation: 'browser-directional-light-approximation',
    });
  }

  ensureLights() {
    if (this.lights) return this.lights;
    const sun = new DirectionalLight('KuganeSun', new Vector3(0, -1, 0), this.scene);
    const moon = new DirectionalLight('KuganeMoon', new Vector3(0, -1, 0), this.scene);
    const ambient = new HemisphericLight('KuganeAmbient', new Vector3(0, 1, 0), this.scene);
    sun.intensity = 0;
    moon.intensity = 0;
    ambient.intensity = 0;
    this.lights = { sun, moon, ambient };
    return this.lights;
  }

  sample(hour = 12) {
    const source = sampleProfile(this.samples, hour) || {
      hour: wrapHour(hour),
      sourceTimeSeconds: wrapHour(hour) * 3600,
      sunColor: Color3.FromHexString('#fff9f2'),
      sunIntensity: 1,
      moonColor: Color3.FromHexString('#b2daff'),
      moonIntensity: 0,
      ambientSaturation: 1,
      ambientScale: 1,
      extraAmbientColor: Color3.FromHexString('#000000'),
      extraAmbientIntensity: 1,
      extraAmbientWeight: 0,
      fogColor: Color3.FromHexString('#6ca4d8'),
      fogIntensity: 1,
      fogNear: 100,
      fogFar: 900,
      fogDensityPercent: 0,
      source: null,
    };
    const sunVector = solarDirection(source.hour);
    const state = {
      ...source,
      sunColor: color(source.sunColor, '#fff9f2'),
      moonColor: color(source.moonColor, '#b2daff'),
      extraAmbientColor: color(source.extraAmbientColor, '#000000'),
      fogColor: color(source.fogColor, '#6ca4d8'),
      sunVector,
      moonVector: sunVector.scale(-1),
      direct: {
        sunIntensity: Math.max(0, finite(source.sunIntensity, 0)) * this.directIntensityScale,
        moonIntensity: Math.max(0, finite(source.moonIntensity, 0)) * this.directIntensityScale,
      },
      ibl: { intensity: this.iblIntensity, source: this.environmentProvenance, approximation: this.proceduralApproximation },
      imageProcessing: {
        exposure: this.imageProcessingExposure,
        sourceToneMappingTimeSeconds: source.source?.toneMappingTimeSeconds,
        mapped: false,
      },
    };
    this.state = state;
    return state;
  }

  setTime(hour, { apply = true } = {}) {
    const state = this.sample(hour);
    if (apply) this.apply(state);
    return state;
  }

  setPreset(name, options = {}) {
    if (!(name in PRESETS)) throw new Error(`Unknown Kugane environment preset: ${name}`);
    return this.setTime(PRESETS[name], options);
  }

  apply(state = this.state || this.sample(12)) {
    const lights = this.ensureLights();
    const sunDirection = state.sunVector.scale(-1);
    const moonDirection = state.moonVector.scale(-1);
    lights.sun.direction.copyFrom(sunDirection);
    lights.moon.direction.copyFrom(moonDirection);
    lights.sun.diffuse.copyFrom(state.sunColor);
    lights.moon.diffuse.copyFrom(state.moonColor);
    lights.sun.intensity = state.direct.sunIntensity;
    lights.moon.intensity = state.direct.moonIntensity;
    this._applyShadows(state);

    const fillColor = state.sunIntensity > 0.01 ? state.sunColor : state.moonColor;
    const ambientColor = saturate(fillColor, finite(state.ambientSaturation, 1));
    const extra = state.extraAmbientColor.scale(
      finite(state.extraAmbientIntensity, 1) * finite(state.extraAmbientWeight, 0),
    );
    lights.ambient.diffuse = ambientColor.add(extra);
    lights.ambient.specular = ambientColor.add(extra);
    lights.ambient.groundColor = state.fogColor.scale(0.45);
    lights.ambient.intensity = this.ambientEngineIntensity * Math.max(0, finite(state.ambientScale, 1));

    this.scene.fogEnabled = true;
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = state.fogColor.clone();
    this.scene.fogStart = Math.max(0, finite(state.fogNear, 100));
    this.scene.fogEnd = Math.max(this.scene.fogStart + 1, finite(state.fogFar, 900));
    this.scene.clearColor = new Color4(state.fogColor.r, state.fogColor.g, state.fogColor.b, 1);
    if (this.scene.imageProcessingConfiguration) {
      // ENVB toneMappingTimeSeconds is a time channel, not an exposure value.
      this.scene.imageProcessingConfiguration.exposure = this.imageProcessingExposure;
    }
    this._updateProceduralEnvironment(state);
    return state;
  }

  _applyShadows(state) {
    const sunActive = state.direct.sunIntensity > 0.01;
    const moonActive = state.direct.moonIntensity > 0.01;
    const nextSource = !sunActive && !moonActive
      ? null
      : state.direct.sunIntensity >= state.direct.moonIntensity ? 'sun' : 'moon';
    const lights = this.ensureLights();
    lights.sun.shadowEnabled = nextSource === 'sun';
    lights.moon.shadowEnabled = nextSource === 'moon';
    if (nextSource === this.shadowSource && this.shadowGenerator) return;
    this.shadowGenerator?.dispose();
    this.shadowGenerator = null;
    this.shadowSource = nextSource;
    if (!nextSource) return;

    const light = lights[nextSource];
    light.shadowMinZ = SHADOW_MIN_Z;
    light.shadowMaxZ = SHADOW_MAX_Z;
    light.shadowFrustumSize = SHADOW_FRUSTUM_SIZE;
    const generator = new ShadowGenerator(SHADOW_MAP_SIZE, light);
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    generator.darkness = 0.35;
    generator.bias = 0.0005;
    generator.normalBias = 0.02;
    generator.transparencyShadow = false;
    this.shadowGenerator = generator;
    for (const caster of this.shadowCasters) this._attachShadowCaster(caster);
  }

  _isTransparentCaster(mesh) {
    const materials = Array.isArray(mesh?.material) ? mesh.material : [mesh?.material];
    return materials.some(material => {
      const metadata = material?.metadata?.ffxiv;
      return metadata?.shaderFamily === 'water'
        || metadata?.shaderFamily === 'river'
        || material?.transparencyMode === PBRMaterial.PBRMATERIAL_ALPHABLEND
        || (material?.alpha !== undefined && material.alpha < 0.999 && material.transparencyMode !== PBRMaterial.PBRMATERIAL_ALPHATEST);
    });
  }

  _attachShadowCaster(mesh) {
    if (!this.shadowGenerator || !mesh || typeof mesh.getTotalVertices !== 'function' || this._isTransparentCaster(mesh)) return false;
    this.shadowGenerator.addShadowCaster(mesh, false);
    return true;
  }

  addShadowCaster(mesh) {
    if (!mesh) return false;
    this.shadowCasters.add(mesh);
    let attached = this._attachShadowCaster(mesh);
    for (const child of mesh.getChildMeshes?.() || []) attached = this._attachShadowCaster(child) || attached;
    return attached;
  }

  removeShadowCaster(mesh) {
    if (!mesh) return false;
    this.shadowCasters.delete(mesh);
    if (this.shadowGenerator && !this._isTransparentCaster(mesh)) {
      this.shadowGenerator.removeShadowCaster(mesh, false);
    }
    for (const child of mesh.getChildMeshes?.() || []) {
      if (!this._isTransparentCaster(child)) this.shadowGenerator?.removeShadowCaster(child, false);
    }
    return true;
  }

  _updateProceduralEnvironment(state) {
    const faces = buildProceduralFaces(state, this.iblSize);
    const next = new RawCubeTexture(
      this.scene,
      faces,
      this.iblSize,
      Constants.TEXTUREFORMAT_RGBA,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
      true,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
    next.name = 'KuganeSourceTintedIBL-Approx';
    next.gammaSpace = true;
    next.sphericalPolynomial = buildSphericalPolynomial(state);
    if (this.environmentTexture && this.environmentTexture !== next) this.environmentTexture.dispose();
    this.environmentTexture = next;
    this.scene.environmentTexture = next;
    this.iblReadyObservable.notifyObservers(next);
    return next;
  }

  setEnvironmentTexture(texture, { provenance = 'source-cubemap', approximation = false } = {}) {
    if (!texture?.isCube) {
      this.onDiagnostic({ type: 'unsupported-environment-texture', reason: 'expected-cubemap', texture });
      return false;
    }
    if (this.environmentTexture && this.environmentTexture !== texture) this.environmentTexture.dispose();
    this.environmentTexture = texture;
    this.environmentProvenance = provenance;
    this.proceduralApproximation = Boolean(approximation);
    delete this.unsupported['no-zone-cubemap-or-sky-asset'];
    this.scene.environmentTexture = texture;
    if (this.state) {
      this.state.ibl = { intensity: this.iblIntensity, source: provenance, approximation: this.proceduralApproximation };
    }
    this.iblReadyObservable.notifyObservers(texture);
    return true;
  }

  applyToMaterial(material) {
    if (!material) return material;
    if ('environmentIntensity' in material) material.environmentIntensity = this.iblIntensity;
    if ('directIntensity' in material) material.directIntensity = this.directIntensityScale;
    return material;
  }

  diagnostics() {
    const state = this.state;
    return {
      profileSource: this.profile.source || null,
      sampleCount: this.samples.length,
      currentHour: state?.hour ?? null,
      sourceTimeSeconds: state?.sourceTimeSeconds ?? null,
      lights: state ? {
        sun: { color: colorHex(state.sunColor), intensity: state.direct.sunIntensity },
        moon: { color: colorHex(state.moonColor), intensity: state.direct.moonIntensity },
        ambient: { scale: finite(state.ambientScale, 1), engineIntensity: this.ambientEngineIntensity },
        fog: { color: colorHex(state.fogColor), near: state.fogNear, far: state.fogFar, densityPercent: state.fogDensityPercent },
      } : null,
      ibl: {
        source: this.environmentProvenance,
        approximation: this.proceduralApproximation,
        intensity: this.iblIntensity,
        ready: Boolean(this.environmentTexture),
      },
      shadows: {
        ...this.shadowConfig,
        activeSource: this.shadowSource,
        casterCount: this.shadowCasters.size,
        ready: Boolean(this.shadowGenerator),
      },
      imageProcessing: state?.imageProcessing || { exposure: this.imageProcessingExposure, mapped: false },
      knownUnsupported: { ...this.unsupported },
    };
  }

  dispose() {
    this.shadowGenerator?.dispose();
    this.shadowGenerator = null;
    this.shadowSource = null;
    this.shadowCasters.clear();
    if (this.environmentTexture) this.environmentTexture.dispose();
    this.environmentTexture = null;
    for (const light of Object.values(this.lights || {})) light.dispose();
    this.lights = null;
  }
}

export { PRESETS as KUGANE_ENVIRONMENT_PRESETS };
export default EnvironmentAdapter;
