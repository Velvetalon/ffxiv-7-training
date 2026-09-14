import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';

export const DEBUG_RENDER_MODES = Object.freeze([
  'full',
  'neutral',
  'albedo',
  'albedo-normal',
  'normal',
  'lighting',
  'pbr-no-environment',
]);

const MATERIAL_KEYS = [
  'albedoColor', 'albedoTexture', 'bumpTexture', 'reflectivityTexture', 'reflectivityColor',
  'metallicTexture', 'metallic', 'roughness', 'microSurface', 'emissiveColor', 'emissiveTexture', 'emissiveIntensity',
  'ambientTexture', 'ambientTextureStrength', 'ambientTextureImpactOnAnalyticalLights',
  'lightmapTexture', 'useLightmapAsShadowmap', 'useAmbientOcclusionFromMetallicTextureRed',
  'useMetallnessFromMetallicTextureBlue', 'useRoughnessFromMetallicTextureGreen',
  'useRoughnessFromMetallicTextureAlpha', 'useOnlyMetallicFromMetallicReflectanceTexture',
  'useMicroSurfaceFromReflectivityMapAlpha', 'unlit', 'directIntensity', 'environmentIntensity',
];
const SCENE_KEYS = [
  'fogEnabled', 'fogMode', 'fogColor', 'fogStart', 'fogEnd', 'fogDensity', 'clearColor', 'environmentTexture',
];
const IMAGE_KEYS = [
  'isEnabled', 'applyByPostProcess', 'exposure', 'contrast', 'toneMappingEnabled', 'toneMappingType',
  'colorGradingEnabled', 'colorGradingTexture', 'colorCurvesEnabled', 'colorCurves', 'whiteBalanceEnabled',
  'vignetteEnabled', 'ditheringEnabled', 'skipFinalColorClamp',
];
const LIGHT_KEYS = ['intensity', 'diffuse', 'specular', 'groundColor'];
const MESH_KEYS = ['useVertexColors'];
const CONTRIBUTION_KEYS = ['vertexColors', 'ao', 'extraColor'];

function isColor(value) {
  return value && Number.isFinite(value.r) && Number.isFinite(value.g) && Number.isFinite(value.b);
}

function cloneValue(value) {
  return isColor(value) && typeof value.clone === 'function' ? value.clone() : value;
}

function sameValue(left, right) {
  if (isColor(left) && isColor(right)) {
    return left.r === right.r && left.g === right.g && left.b === right.b && (left.a ?? 1) === (right.a ?? 1);
  }
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function take(target, keys) {
  const state = {};
  if (!target) return state;
  for (const key of keys) {
    if (key in target) state[key] = cloneValue(target[key]);
  }
  return state;
}

function restore(target, state) {
  if (!target || !state) return;
  for (const [key, value] of Object.entries(state)) target[key] = cloneValue(value);
}

function rgb(value) {
  if (!isColor(value)) return null;
  const color = { r: value.r, g: value.g, b: value.b };
  if ('a' in value) color.a = value.a;
  return color;
}

function plain(value, depth = 0) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (isColor(value)) return rgb(value);
  if (Array.isArray(value)) return depth > 3 ? `[${value.length}]` : value.slice(0, 16).map(entry => plain(entry, depth + 1));
  if (typeof value !== 'object') return String(value);
  if (depth > 3) return value.name || value.id || value.uniqueId || value.getClassName?.() || '[object]';
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    if (typeof entry === 'function' || key === 'secondaryPlugin') continue;
    result[key] = plain(entry, depth + 1);
  }
  return result;
}

function textureInfo(texture) {
  if (!texture) return null;
  const internal = texture.getInternalTexture?.();
  return {
    name: texture.name || null,
    url: texture.url || texture._url || null,
    gammaSpace: Boolean(texture.gammaSpace),
    isCube: Boolean(texture.isCube),
    level: Number.isFinite(texture.level) ? texture.level : null,
    coordinatesIndex: Number.isFinite(texture.coordinatesIndex) ? texture.coordinatesIndex : null,
    metadata: plain(texture.metadata),
    internal: internal ? {
      format: internal.format ?? null,
      type: internal.type ?? null,
      width: internal.width ?? null,
      height: internal.height ?? null,
      isReady: typeof internal.isReady === 'function' ? internal.isReady() : Boolean(internal.isReady),
      generateMipMaps: Boolean(internal.generateMipMaps),
      samplingMode: internal.samplingMode ?? null,
      useSRGBBuffer: Boolean(internal._useSRGBBuffer ?? texture._useSRGBBuffer),
    } : null,
  };
}

function materialInfo(material, meshes) {
  const ffxiv = material?.metadata?.ffxiv || {};
  const source = ffxiv.source || material?.metadata?.source || null;
  return {
    name: material?.name || null,
    id: material?.id || null,
    className: material?.getClassName?.() || null,
    ffxiv: {
      materialPath: ffxiv.materialPath || null,
      shader: ffxiv.shader || null,
      sourceShader: ffxiv.sourceShader || material?.metadata?.sourceShader || null,
      shaderFamily: ffxiv.shaderFamily || null,
      workflow: ffxiv.workflow || null,
      preview: ffxiv.preview ?? null,
      source: source ? plain(source) : null,
    },
    color: {
      albedo: rgb(material?.albedoColor),
      reflectivity: rgb(material?.reflectivityColor),
      emissive: rgb(material?.emissiveColor),
      emissiveIntensity: material?.emissiveIntensity ?? null,
    },
    maps: {
      albedo: textureInfo(material?.albedoTexture),
      bump: textureInfo(material?.bumpTexture),
      specular: textureInfo(material?.reflectivityTexture),
      ambientOcclusion: textureInfo(material?.ambientTexture),
      lightmap: textureInfo(material?.lightmapTexture),
      emissive: textureInfo(material?.emissiveTexture),
      secondary: textureInfo(ffxiv.secondaryPlugin?.texture),
    },
    pbr: {
      unlit: material?.unlit ?? null,
      metallic: material?.metallic ?? null,
      roughness: material?.roughness ?? null,
      microSurface: material?.microSurface ?? null,
      directIntensity: material?.directIntensity ?? null,
      environmentIntensity: material?.environmentIntensity ?? null,
      aoFromMetallicRed: material?.useAmbientOcclusionFromMetallicTextureRed ?? null,
      lightmapAsShadowmap: material?.useLightmapAsShadowmap ?? null,
    },
    meshVertexColors: meshes
      .filter(mesh => mesh.material === material)
      .slice(0, 12)
      .map(mesh => ({
        name: mesh.name || null,
        enabled: mesh.useVertexColors ?? null,
        hasColor: Boolean(mesh.getVertexBuffer?.('color')),
      })),
  };
}

function profileInfo(adapter) {
  const profile = adapter?.profile || null;
  return {
    raw: profile ? {
      source: plain(profile.source),
      samples: Array.isArray(profile.samples) ? profile.samples.map(sample => plain(sample)) : [],
    } : null,
    current: plain(adapter?.state),
  };
}

/**
 * Native Babylon diagnostic modes. This class owns only temporary property
 * overrides; it neither creates replacement materials nor changes source data.
 */
export class DebugRenderMode {
  constructor({ scene, environmentAdapter } = {}) {
    if (!scene) throw new Error('DebugRenderMode requires a Babylon scene');
    this.scene = scene;
    this.environmentAdapter = environmentAdapter || null;
    this.mode = 'full';
    this.contributions = { vertexColors: null, ao: null, extraColor: null };
    this.disableSecondaryPlugin = false;
    this._sceneOriginal = null;
    this._sceneDebug = null;
    this._imageOriginal = null;
    this._imageDebug = null;
    this._lightOriginal = new Map();
    this._lightDebug = new Map();
    this._meshOriginal = new Map();
    this._meshDebug = new Map();
    this._materialOriginal = new Map();
    this._materialDebug = new Map();
    this._sceneDebugActive = false;
    this._materialDebugActive = false;
    this._debugActive = false;
    this._dirty = false;
    this._lastConfiguration = this._configurationKey();
    this._disposed = false;
  }

  setMode(id) {
    if (!DEBUG_RENDER_MODES.includes(id)) throw new Error(`Unknown debug render mode: ${id}`);
    if (this.mode !== id) this._dirty = true;
    this.mode = id;
    return this;
  }

  setContributions(values = {}) {
    for (const key of CONTRIBUTION_KEYS) {
      if (key in values) {
        const next = values[key] === null ? null : Boolean(values[key]);
        if (this.contributions[key] !== next) this._dirty = true;
        this.contributions[key] = next;
      }
    }
    if ('disableSecondaryPlugin' in values) {
      const next = Boolean(values.disableSecondaryPlugin);
      if (this.disableSecondaryPlugin !== next) this._dirty = true;
      this.disableSecondaryPlugin = next;
    }
    return this;
  }

  apply() {
    if (this._disposed) return this;
    const configuration = this._configurationKey();
    if (configuration !== this._lastConfiguration) this._dirty = true;
    this._lastConfiguration = configuration;
    const sceneActive = this.mode !== 'full';
    const materialActive = sceneActive || this._hasContributionOverride();
    if (!sceneActive && !materialActive && !this._sceneDebugActive && !this._materialDebugActive) return this;
    const materials = this._materials();
    const lights = this._lights();
    const meshes = this._meshes();
    const refreshScene = (sceneActive && (this._dirty || this._sceneNeedsRefresh(lights)))
      || (!sceneActive && this._sceneDebugActive);
    const refreshMaterials = (materialActive && (this._dirty || this._materialsNeedRefresh(materials, meshes)))
      || (!materialActive && this._materialDebugActive);

    if (refreshScene) {
      this._captureSceneBase(lights);
      this._restoreSceneBase(lights);
      if (sceneActive) this._applySceneMode(lights);
      this._recordSceneDebug(sceneActive, lights);
    }
    if (refreshMaterials) {
      this._captureMaterialBase(materials, meshes);
      this._restoreMaterialBase(materials, meshes);
      if (sceneActive) this._applyMaterialMode(materials, meshes);
      if (materialActive) this._applyContributions(materials, meshes);
      this._recordMaterialDebug(materialActive, materials, meshes);
    }
    this._sceneDebugActive = sceneActive;
    this._materialDebugActive = materialActive;
    this._debugActive = sceneActive || materialActive;
    this._dirty = false;
    return this;
  }

  dump({ samples = [] } = {}) {
    const lights = this._lights();
    const selected = this._sampleMaterials(samples);
    return {
      mode: this.mode,
      contributions: { ...this.contributions, disableSecondaryPlugin: this.disableSecondaryPlugin },
      profile: profileInfo(this.environmentAdapter),
      scene: {
        clearColor: rgb(this.scene.clearColor),
        fog: {
          enabled: Boolean(this.scene.fogEnabled),
          mode: this.scene.fogMode ?? null,
          color: rgb(this.scene.fogColor),
          start: this.scene.fogStart ?? null,
          end: this.scene.fogEnd ?? null,
          density: this.scene.fogDensity ?? null,
        },
        environment: textureInfo(this.scene.environmentTexture),
        imageProcessing: this._imageInfo(),
      },
      lights: lights.map(light => ({
        name: light.name || null,
        className: light.getClassName?.() || null,
        intensity: light.intensity ?? null,
        diffuse: rgb(light.diffuse),
        specular: rgb(light.specular),
        groundColor: rgb(light.groundColor),
      })),
      materials: selected.map(material => materialInfo(material, this._meshes())),
    };
  }

  dispose() {
    if (this._disposed) return;
    const materials = this._materials();
    const lights = this._lights();
    this._restoreSceneBase(lights);
    this._restoreMaterialBase(materials, this._meshes());
    this._disposed = true;
    this._lightOriginal.clear();
    this._lightDebug.clear();
    this._meshOriginal.clear();
    this._meshDebug.clear();
    this._materialOriginal.clear();
    this._materialDebug.clear();
  }

  _materials() {
    return [...new Set(this.scene.materials || [])].filter(material => {
      const disposed = typeof material?.isDisposed === 'function' ? material.isDisposed() : material?.isDisposed;
      return material && !disposed && 'albedoColor' in material;
    });
  }

  _lights() {
    const adapterLights = this.environmentAdapter?.lights;
    if (adapterLights) return Object.values(adapterLights).filter(Boolean);
    return (this.scene.lights || []).filter(Boolean);
  }

  _meshes() {
    return [...new Set(this.scene.meshes || [])].filter(mesh => {
      const disposed = typeof mesh?.isDisposed === 'function' ? mesh.isDisposed() : mesh?.isDisposed;
      return mesh && !disposed && 'useVertexColors' in mesh;
    });
  }

  _hasContributionOverride() {
    return this.disableSecondaryPlugin || CONTRIBUTION_KEYS.some(key => this.contributions[key] !== null);
  }

  _configurationKey() {
    return `${this.mode}|${this.contributions.vertexColors}|${this.contributions.ao}|${this.contributions.extraColor}|${this.disableSecondaryPlugin}`;
  }

  _sceneNeedsRefresh(lights) {
    if (!this._sceneDebug || !this._imageDebug) return true;
    if (this._stateChanged(this.scene, this._sceneDebug, SCENE_KEYS)
      || this._stateChanged(this.scene.imageProcessingConfiguration, this._imageDebug, IMAGE_KEYS)) return true;
    return lights.some(light => this._stateChanged(light, this._lightDebug.get(light), LIGHT_KEYS));
  }

  _materialsNeedRefresh(materials, meshes) {
    if (materials.some(material => {
      const debug = this._materialDebug.get(material);
      if (this._stateChanged(material, debug, MATERIAL_KEYS)) return true;
      const plugin = material.metadata?.ffxiv?.secondaryPlugin;
      const pluginState = debug?.__secondaryPlugin;
      return Boolean(plugin) !== Boolean(pluginState)
        || Boolean(plugin && (plugin.texture !== pluginState.texture || !sameValue(plugin.color, pluginState.color)));
    })) return true;
    return meshes.some(mesh => this._stateChanged(mesh, this._meshDebug.get(mesh), MESH_KEYS));
  }

  _stateChanged(target, state, keys) {
    if (!target || !state) return true;
    return keys.some(key => key in state && !sameValue(target[key], state[key]));
  }

  _captureSceneBase(lights) {
    this._sceneOriginal = this._refresh(this.scene, SCENE_KEYS, this._sceneOriginal, this._sceneDebug);
    const image = this.scene.imageProcessingConfiguration;
    this._imageOriginal = this._refresh(image, IMAGE_KEYS, this._imageOriginal, this._imageDebug);
    for (const light of lights) {
      this._lightOriginal.set(light, this._refresh(light, LIGHT_KEYS, this._lightOriginal.get(light), this._lightDebug.get(light)));
    }
  }

  _captureMaterialBase(materials, meshes) {
    for (const mesh of meshes) {
      this._meshOriginal.set(mesh, this._refresh(mesh, MESH_KEYS, this._meshOriginal.get(mesh), this._meshDebug.get(mesh)));
    }
    for (const material of materials) {
      const original = this._refresh(
        material,
        MATERIAL_KEYS,
        this._materialOriginal.get(material),
        this._materialDebug.get(material),
      );
      const plugin = material.metadata?.ffxiv?.secondaryPlugin;
      const debugPlugin = this._materialDebug.get(material)?.__secondaryPlugin;
      if (plugin && (!original.__secondaryPlugin || !debugPlugin
        || plugin.texture !== debugPlugin.texture || !sameValue(plugin.color, debugPlugin.color))) {
        original.__secondaryPlugin = { texture: plugin.texture, color: cloneValue(plugin.color) };
      }
      this._materialOriginal.set(material, original);
    }
  }

  _refresh(target, keys, original, debug) {
    if (!original || !debug) return take(target, keys);
    const next = { ...original };
    for (const key of keys) {
      if (key in target && (!(key in debug) || !sameValue(target[key], debug[key]))) {
        next[key] = cloneValue(target[key]);
      }
    }
    return next;
  }

  _restoreSceneBase(lights) {
    restore(this.scene, this._sceneOriginal);
    restore(this.scene.imageProcessingConfiguration, this._imageOriginal);
    for (const light of lights) restore(light, this._lightOriginal.get(light));
  }

  _restoreMaterialBase(materials, meshes) {
    for (const mesh of meshes) restore(mesh, this._meshOriginal.get(mesh));
    for (const material of materials) {
      restore(material, this._materialOriginal.get(material));
      this._restoreSecondaryPlugin(material);
    }
  }

  _restoreSecondaryPlugin(material) {
    const original = this._materialOriginal.get(material)?.__secondaryPlugin;
    if (!original) return;
    const plugin = material.metadata?.ffxiv?.secondaryPlugin;
    if (!plugin) return;
    plugin.texture = original.texture;
    if (isColor(original.color)) plugin.color = original.color.clone();
  }

  _applySceneMode(lights) {
    if (this.mode !== 'lighting') this.scene.environmentTexture = null;
    this.scene.fogEnabled = false;
    this._disableImageProcessing();
    if (this.mode === 'neutral' || this.mode === 'albedo-normal' || this.mode === 'normal') {
      this.scene.clearColor = new Color4(0.5, 0.5, 0.5, 1);
      this._setNeutralLights(lights);
    }
  }

  _applyMaterialMode(materials, meshes) {
    for (const material of materials) this._applyMaterial(material);
    if (this.mode === 'lighting') {
      // Lighting diagnostics must expose source normal/PBR response without
      // vertex-color contribution; an explicit contribution override can
      // still opt back in below.
      for (const mesh of meshes) mesh.useVertexColors = false;
    }
  }

  _applyMaterial(material) {
    const isCanonical = this.mode === 'neutral' || this.mode === 'albedo' || this.mode === 'albedo-normal';
    if (this.mode === 'albedo' || this.mode === 'normal') material.unlit = true;
    if (this.mode === 'neutral' || this.mode === 'albedo-normal' || this.mode === 'lighting') material.unlit = false;
    if (this.mode !== 'full' && this.mode !== 'lighting') material.environmentIntensity = 0;

    if (isCanonical) {
      material.metallic = 0;
      material.roughness = 1;
      material.microSurface = 1;
      material.metallicTexture = null;
      material.reflectivityTexture = null;
      material.reflectivityColor = new Color3(0, 0, 0);
      material.useMetallnessFromMetallicTextureBlue = false;
      material.useRoughnessFromMetallicTextureGreen = false;
      material.useRoughnessFromMetallicTextureAlpha = false;
      material.useOnlyMetallicFromMetallicReflectanceTexture = false;
      material.useMicroSurfaceFromReflectivityMapAlpha = false;
      material.useAmbientOcclusionFromMetallicTextureRed = false;
      if (this.mode !== 'albedo-normal') material.bumpTexture = null;
    }

    if (this.mode === 'albedo') {
      material.directIntensity = 1;
      material.bumpTexture = null;
    }

    if (this.mode === 'normal') {
      // Normal-map RGB is displayed as an unlit albedo. The source texture is
      // restored by the normal debug transaction when the mode changes.
      const normalTexture = material.bumpTexture;
      material.unlit = true;
      material.albedoColor = normalTexture ? new Color3(1, 1, 1) : new Color3(0.5, 0.5, 1);
      material.albedoTexture = normalTexture || null;
      material.bumpTexture = null;
      material.metallic = 0;
      material.roughness = 1;
      material.microSurface = 1;
      material.directIntensity = 1;
      material.emissiveColor = new Color3(0, 0, 0);
      material.emissiveTexture = null;
      material.emissiveIntensity = 0;
      material.ambientTexture = null;
      material.ambientTextureStrength = 0;
      material.ambientTextureImpactOnAnalyticalLights = 0;
      this._disableSecondaryPlugin(material);
    }

    if (this.mode === 'lighting') {
      // Keep the source lights and IBL, but remove surface color/emission
      // inputs so the remaining image is a lighting-only PBR diagnostic.
      material.albedoColor = new Color3(1, 1, 1);
      material.albedoTexture = null;
      material.emissiveColor = new Color3(0, 0, 0);
      material.emissiveTexture = null;
      material.emissiveIntensity = 0;
      material.lightmapTexture = null;
      material.useLightmapAsShadowmap = false;
      material.ambientTexture = null;
      material.ambientTextureStrength = 0;
      material.ambientTextureImpactOnAnalyticalLights = 0;
      material.useAmbientOcclusionFromMetallicTextureRed = false;
      this._disableSecondaryPlugin(material);
    }

  }

  _applyContributions(materials, meshes) {
    const vertexColors = this.contributions.vertexColors;
    const ao = this.contributions.ao;
    const extraColor = this.contributions.extraColor;
    if (vertexColors !== null) {
      for (const mesh of meshes) mesh.useVertexColors = vertexColors;
    }
    if (ao === false) {
      for (const material of materials) {
      material.ambientTexture = null;
      material.useAmbientOcclusionFromMetallicTextureRed = false;
      material.ambientTextureStrength = 0;
      material.ambientTextureImpactOnAnalyticalLights = 0;
      }
    }
    if (extraColor === false) {
      for (const material of materials) {
      material.albedoColor = new Color3(1, 1, 1);
      material.emissiveColor = new Color3(0, 0, 0);
      material.emissiveTexture = null;
      material.emissiveIntensity = 0;
      material.lightmapTexture = null;
      material.useLightmapAsShadowmap = false;
      this._disableSecondaryPlugin(material);
      }
    }
    if (this.disableSecondaryPlugin) {
      for (const material of materials) this._disableSecondaryPlugin(material);
    }
  }

  _disableSecondaryPlugin(material) {
    const plugin = material.metadata?.ffxiv?.secondaryPlugin;
    if (plugin) plugin.texture = null;
  }

  _disableImageProcessing() {
    const image = this.scene.imageProcessingConfiguration;
    if (!image) return;
    image.isEnabled = false;
    image.applyByPostProcess = false;
    image.toneMappingEnabled = false;
    image.colorGradingEnabled = false;
    image.colorCurvesEnabled = false;
    image.whiteBalanceEnabled = false;
    image.vignetteEnabled = false;
    image.ditheringEnabled = false;
  }

  _setNeutralLights(lights) {
    for (const light of lights) {
      light.intensity = 1;
      if ('diffuse' in light) light.diffuse = new Color3(1, 1, 1);
      if ('specular' in light) light.specular = new Color3(1, 1, 1);
      if ('groundColor' in light) light.groundColor = new Color3(1, 1, 1);
    }
  }

  _recordSceneDebug(active, lights) {
    if (!active) {
      this._sceneDebug = null;
      this._imageDebug = null;
      this._lightDebug.clear();
      return;
    }
    this._sceneDebug = take(this.scene, SCENE_KEYS);
    this._imageDebug = take(this.scene.imageProcessingConfiguration, IMAGE_KEYS);
    for (const light of lights) this._lightDebug.set(light, take(light, LIGHT_KEYS));
  }

  _recordMaterialDebug(active, materials, meshes) {
    if (!active) {
      this._meshDebug.clear();
      this._materialDebug.clear();
      return;
    }
    for (const mesh of meshes) this._meshDebug.set(mesh, take(mesh, MESH_KEYS));
    for (const material of materials) {
      const state = take(material, MATERIAL_KEYS);
      const plugin = material.metadata?.ffxiv?.secondaryPlugin;
      if (plugin) state.__secondaryPlugin = { texture: plugin.texture, color: cloneValue(plugin.color) };
      this._materialDebug.set(material, state);
    }
  }

  _sampleMaterials(samples) {
    const all = this._materials();
    if (!Array.isArray(samples) || !samples.length) return all.slice(0, 6);
    const selected = [];
    for (const sample of samples.slice(0, 16)) {
      const material = typeof sample === 'number'
        ? all[sample]
        : typeof sample === 'string'
          ? all.find(item => item.name === sample || item.id === sample)
          : sample;
      if (material && all.includes(material) && !selected.includes(material)) selected.push(material);
    }
    return selected;
  }

  _imageInfo() {
    const image = this.scene.imageProcessingConfiguration;
    if (!image) return null;
    return {
      enabled: Boolean(image.isEnabled),
      applyByPostProcess: Boolean(image.applyByPostProcess),
      exposure: image.exposure ?? null,
      contrast: image.contrast ?? null,
      toneMappingEnabled: Boolean(image.toneMappingEnabled),
      toneMappingType: image.toneMappingType ?? null,
      colorGradingEnabled: Boolean(image.colorGradingEnabled),
      colorGradingTexture: textureInfo(image.colorGradingTexture),
      colorCurvesEnabled: Boolean(image.colorCurvesEnabled),
      whiteBalanceEnabled: Boolean(image.whiteBalanceEnabled),
      vignetteEnabled: Boolean(image.vignetteEnabled),
      ditheringEnabled: Boolean(image.ditheringEnabled),
    };
  }
}

export default DebugRenderMode;
