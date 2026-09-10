import * as THREE from 'three';
import { getEnvironmentProfile, normalizeEnvironmentSamples } from './EnvironmentProfiles.js';

const FULL_DAY = Math.PI * 2;
const sunriseSunset = new THREE.Vector3();

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function smoothstep(min, max, value) {
  const normalized = clamp01((value - min) / (max - min));
  return normalized * normalized * (3 - 2 * normalized);
}

function color(value) {
  return new THREE.Color(value);
}

function copyColor(target, source) {
  if (target?.isColor) target.copy(source);
}

function sampleValue(left, right, ratio, name) {
  if (left[name] === undefined && right[name] === undefined) return undefined;
  if (typeof left[name] !== 'number' || typeof right[name] !== 'number') return ratio < 0.5 ? left[name] : right[name];
  return THREE.MathUtils.lerp(left[name], right[name], ratio);
}

function sampleSource(samples, hour) {
  if (!samples.length) return null;
  const extended = [...samples, { ...samples[0], hour: samples[0].hour + 24 }];
  const target = hour < samples[0].hour ? hour + 24 : hour;
  let rightIndex = extended.findIndex(sample => sample.hour >= target);
  if (rightIndex < 1) rightIndex = 1;
  const right = extended[rightIndex];
  const left = extended[rightIndex - 1];
  const ratio = clamp01((target - left.hour) / Math.max(0.0001, right.hour - left.hour));
  const result = {};
  for (const key of ['sunIntensity', 'ambientIntensity', 'ambientScale', 'exposure', 'fogNear', 'fogFar']) {
    const value = sampleValue(left, right, ratio, key);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ['sunColor', 'ambientSky', 'ambientGround', 'background', 'fogColor']) {
    if (left[key] === undefined && right[key] === undefined) continue;
    const first = color(left[key] ?? right[key]);
    result[key] = first.lerp(color(right[key] ?? left[key]), ratio);
  }
  if (Array.isArray(left.sunDirection) && Array.isArray(right.sunDirection)) {
    result.sunDirection = new THREE.Vector3()
      .fromArray(left.sunDirection)
      .lerp(new THREE.Vector3().fromArray(right.sunDirection), ratio)
      .normalize();
  }
  return result;
}

export function createEnvironmentLights(profile = getEnvironmentProfile()) {
  const baseline = profile.baseline;
  const rig = new THREE.Group();
  rig.name = 'EnvironmentLightRig';
  const ambient = new THREE.HemisphereLight(baseline.ambientSky, baseline.ambientGround, baseline.ambientIntensity);
  ambient.name = 'EnvironmentAmbient';
  const sun = new THREE.DirectionalLight(baseline.directional, baseline.directionalIntensity);
  sun.name = 'EnvironmentSun';
  sun.position.set(-28, 42, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.06;
  rig.add(ambient, sun);
  return { rig, ambient, sun };
}

/**
 * Converts independent WorldTime state into continuous browser-renderer state.
 * It makes no claim that fallback values are decoded FFXIV Envb parameters.
 */
export class EnvironmentRuntime {
  constructor({ zoneId = 'default', profile = getEnvironmentProfile(zoneId), sourceSamples = [] } = {}) {
    this.zoneId = zoneId;
    this.profile = profile;
    this.sourceSamples = normalizeEnvironmentSamples(sourceSamples);
    this.state = null;
    this._sceneDefaults = null;
  }

  setZone(zoneId, profile = getEnvironmentProfile(zoneId)) {
    this.zoneId = zoneId;
    this.profile = profile;
    this._sceneDefaults = null;
  }

  setSourceSamples(samples) {
    this.sourceSamples = normalizeEnvironmentSamples(samples);
  }

  sample(worldTime = { hour: 8 }) {
    const hour = ((Number(worldTime.hour) || 0) % 24 + 24) % 24;
    const baseline = this.profile.baseline;
    const solarAngle = (hour - 6) / 24 * FULL_DAY;
    const solarAltitude = Math.sin(solarAngle);
    const daylight = smoothstep(-0.08, 0.12, solarAltitude);
    const twilight = smoothstep(-0.36, 0.08, solarAltitude);
    const sunDirection = sunriseSunset.set(Math.cos(solarAngle), solarAltitude, Math.sin(solarAngle)).normalize().clone();
    const state = {
      zoneId: this.zoneId,
      hour,
      daylight,
      twilight,
      sunDirection,
      sunIntensity: baseline.directionalIntensity * daylight,
      ambientIntensity: baseline.ambientIntensity * THREE.MathUtils.lerp(0.16, 1, twilight),
      exposure: baseline.exposure * THREE.MathUtils.lerp(0.58, 1, twilight),
      skyEnergy: THREE.MathUtils.lerp(0.07, 1, twilight),
      fogEnergy: THREE.MathUtils.lerp(0.16, 1, twilight),
      shadowEnabled: daylight > 0.03,
      evidence: this.sourceSamples.length ? 'source-sample-adapter' : this.profile.evidence,
    };
    const source = sampleSource(this.sourceSamples, hour);
    if (source) Object.assign(state, source);
    if (source?.ambientScale !== undefined) state.ambientIntensity *= source.ambientScale;
    this.state = state;
    return state;
  }

  apply(scene, renderer, lights = {}, worldTime) {
    const state = this.sample(worldTime || this.state || { hour: 8 });
    const baseline = this.profile.baseline;
    const defaults = this._captureSceneDefaults(scene, baseline);
    const sun = lights.sun || lights.directional;
    const ambient = lights.ambient || lights.hemisphere;
    const source = sampleSource(this.sourceSamples, state.hour);

    if (sun) {
      sun.position.copy(state.sunDirection).multiplyScalar(80);
      sun.intensity = state.sunIntensity;
      copyColor(sun.color, source?.sunColor || color(baseline.directional));
      sun.castShadow = state.shadowEnabled;
    }
    if (ambient) {
      ambient.intensity = state.ambientIntensity;
      copyColor(ambient.color, source?.ambientSky || color(baseline.ambientSky));
      copyColor(ambient.groundColor, source?.ambientGround || color(baseline.ambientGround));
    }
    if (renderer) renderer.toneMappingExposure = state.exposure;

    const background = source?.background || defaults.background.clone().multiplyScalar(state.skyEnergy);
    if (scene?.background?.isColor) scene.background.copy(background);
    else if (scene && !scene.background) scene.background = background.clone();
    if (scene && !scene.fog) scene.fog = new THREE.Fog(defaults.fog, defaults.fogNear, defaults.fogFar);
    if (scene?.fog?.color) {
      const fogColor = source?.fogColor || defaults.fog.clone().multiplyScalar(state.fogEnergy);
      scene.fog.color.copy(fogColor);
      if (scene.fog.isFog) {
        const range = Math.max(1, defaults.fogFar - defaults.fogNear);
        scene.fog.near = source?.fogNear ?? defaults.fogNear;
        scene.fog.far = source?.fogFar > scene.fog.near
          ? source.fogFar : scene.fog.near + range * THREE.MathUtils.lerp(0.56, 1, state.twilight);
      }
    }
    return state;
  }

  _captureSceneDefaults(scene, baseline) {
    if (this._sceneDefaults) return this._sceneDefaults;
    this._sceneDefaults = {
      background: scene?.background?.isColor ? scene.background.clone() : color(baseline.background),
      fog: scene?.fog?.color ? scene.fog.color.clone() : color(baseline.fog),
      fogNear: scene?.fog?.isFog ? scene.fog.near : 180,
      fogFar: scene?.fog?.isFog ? scene.fog.far : 650,
    };
    return this._sceneDefaults;
  }
}
