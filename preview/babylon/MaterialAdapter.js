import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';

const SOURCE_NORMAL_Y_INVERTED = true;
const FALLBACK_MICROSURFACE = 0.15;
const WATER_COLOR = [0.12, 0.39, 0.48];

const COLOR_CHANNELS = new Set(['albedo', 'emissive', 'secondary']);

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, finite(value, 0)));
}

function arrayColor(value, fallback = [1, 1, 1]) {
  const source = Array.isArray(value) && value.length >= 3 ? value : fallback;
  return new Color3(finite(source[0], fallback[0]), finite(source[1], fallback[1]), finite(source[2], fallback[2]));
}

function hasFlag(record, bit) {
  return (finite(record?.flags, 0) & bit) !== 0;
}

function shaderFamily(shader) {
  if (shader === 'water.shpk') return 'water';
  if (shader === 'river.shpk') return 'river';
  if (shader === 'crystal.shpk') return 'crystal';
  if (shader === 'bgprop.shpk') return 'bgprop';
  if (shader === 'bg.shpk') return 'background';
  return 'unknown';
}

function recordRuntimePath(record, field) {
  const value = record?.[field];
  if (!value) return null;
  if (typeof value === 'string' && value.startsWith('textures/')) return value;
  const mapped = record.samplers?.find(sample => sample.path === value)?.map;
  return mapped || value;
}

function sourcePath(record, field) {
  return record?.[field] || null;
}

function channelPresent(record, field) {
  return Boolean(record?.[field] || (Array.isArray(record?.[`${field}s`]) && record[`${field}s`].length));
}

function vertexDataPresent(meshOrInfo, kind) {
  if (!meshOrInfo) return false;
  if (kind === 'uv2' && meshOrInfo.hasUV1 !== undefined) return Boolean(meshOrInfo.hasUV1);
  if (kind === 'color' && meshOrInfo.hasColor !== undefined) return Boolean(meshOrInfo.hasColor);
  if (typeof meshOrInfo.isVerticesDataPresent === 'function') return meshOrInfo.isVerticesDataPresent(kind);
  if (typeof meshOrInfo.geometry?.isVerticesDataPresent === 'function') return meshOrInfo.geometry.isVerticesDataPresent(kind);
  if (meshOrInfo.geometry?.attributes) {
    return Boolean(meshOrInfo.geometry.attributes[kind] || meshOrInfo.geometry.attributes[kind === 'uv2' ? 'uv1' : kind]);
  }
  return false;
}

function bytesAsArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  throw new TypeError('Asset texture decoder returned a non-buffer value');
}

function plainCounts(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(counter, key, amount = 1) {
  if (!key) return;
  counter[key] = (counter[key] || 0) + amount;
}

function emptyStats() {
  return {
    created: 0,
    cacheHits: 0,
    upgrades: 0,
    textures: { loads: 0, cacheHits: 0, preview: 0, full: 0, bytes: 0 },
    unsupported: Object.create(null),
    missing: { materials: Object.create(null), textures: Object.create(null), vertexChannels: Object.create(null) },
  };
}

/**
 * Babylon-owned texture cache. The shared AssetRuntime only supplies bytes;
 * every Texture in this cache is a Babylon object owned by this adapter.
 */
export class BabylonTextureCache {
  constructor({ scene, assets, onDiagnostic = () => {} } = {}) {
    this.scene = scene;
    this.assets = assets;
    this.onDiagnostic = onDiagnostic;
    this.entries = new Map();
    this.pending = new Map();
  }

  async load(runtimePath, semantic, { preview = true, priority = 0, sourcePath: source = runtimePath, uvScale = [1, 1] } = {}) {
    if (!runtimePath) return null;
    const scaleKey = [finite(uvScale?.[0], 1), finite(uvScale?.[1], 1)].join(',');
    const key = `${runtimePath}:${semantic}:${preview ? 'preview' : 'full'}:${scaleKey}`;
    if (this.entries.has(key)) return this.entries.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const work = this._load(key, runtimePath, semantic, { preview, priority, source, uvScale });
    this.pending.set(key, work);
    try {
      const entry = await work;
      this.entries.set(key, entry);
      return entry;
    } finally {
      this.pending.delete(key);
    }
  }

  async _load(key, runtimePath, semantic, { preview, priority, source, uvScale }) {
    if (!this.assets?.texture) throw new Error('BabylonTextureCache requires AssetBridge.texture');
    const payload = await this.assets.texture(runtimePath, { preview, priority });
    const texture = await this._decode(payload.bytes, payload.mimeType, runtimePath, semantic);
    texture.uScale = finite(uvScale?.[0], 1);
    texture.vScale = finite(uvScale?.[1], 1);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 4;
    texture.name = `ffxiv:${semantic}:${runtimePath}`;
    texture.metadata = {
      ...(texture.metadata || {}),
      ffxiv: { runtimePath, sourcePath: source, semantic, preview, resourceId: payload.resourceId, fullResourceId: payload.fullResourceId },
    };
    return {
      key,
      texture,
      runtimePath,
      sourcePath: source,
      semantic,
      preview,
      resourceId: payload.resourceId,
      fullResourceId: payload.fullResourceId,
      bytes: payload.bytes?.byteLength ?? payload.bytes?.length ?? 0,
    };
  }

  _decode(bytes, mimeType, runtimePath, semantic) {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Blob === 'undefined') {
      throw new Error('Babylon texture decode requires browser Blob URL support');
    }
    const gammaSpace = COLOR_CHANNELS.has(semantic);
    const objectUrl = URL.createObjectURL(new Blob([bytesAsArrayBuffer(bytes)], { type: mimeType || 'application/octet-stream' }));
    return new Promise((resolve, reject) => {
      let texture;
      const cleanup = () => URL.revokeObjectURL(objectUrl);
      const onLoad = () => {
        cleanup();
        texture.gammaSpace = gammaSpace;
        resolve(texture);
      };
      const onError = (message, exception) => {
        cleanup();
        reject(exception || new Error(message || `Texture decode failed: ${runtimePath}`));
      };
      try {
        texture = new Texture(objectUrl, this.scene, {
          invertY: false,
          noMipmap: false,
          samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
          useSRGBBuffer: gammaSpace,
          onLoad,
          onError,
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  dispose() {
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
    this.pending.clear();
  }
}

/**
 * Small native-PBR hook for source records that carry a secondary diffuse
 * channel. The source blend weight is preserved in COLOR_0 alpha by the GLB
 * exporter; the base PBR shader still owns lighting, normals, alpha and IBL.
 */
export class KuganeSecondaryBlendPlugin extends MaterialPluginBase {
  constructor(material, { texture, color = [1, 1, 1] } = {}) {
    super(material, 'KuganeSecondaryBlend', 145, {
      KUGANE_SECONDARY_BLEND: false,
      KUGANE_SECONDARY_GAMMA: false,
      KUGANE_BLEND_ALPHA: false,
    }, true, true);
    this.texture = texture;
    this.color = arrayColor(color);
  }

  isCompatible(shaderLanguage) {
    return shaderLanguage === 0;
  }

  prepareDefines(defines, _scene, mesh) {
    defines.KUGANE_SECONDARY_BLEND = Boolean(
      this.texture && vertexDataPresent(mesh, 'uv2') && vertexDataPresent(mesh, 'color'),
    );
    defines.KUGANE_SECONDARY_GAMMA = Boolean(this.texture?.gammaSpace);
    defines.KUGANE_BLEND_ALPHA = mesh?.getVertexBuffer?.('color')?.getSize() === 4;
  }

  getAttributes(attributes, _scene, mesh) {
    if (vertexDataPresent(mesh, 'uv2') && !attributes.includes('uv2')) attributes.push('uv2');
    if (vertexDataPresent(mesh, 'color') && !attributes.includes('color')) attributes.push('color');
  }

  getSamplers(samplers) {
    samplers.push('kuganeSecondarySampler');
  }

  getUniforms() {
    return { ubo: [
      { name: 'kuganeSecondaryColor', size: 3, type: 'vec3' },
      { name: 'kuganeSecondaryUVScale', size: 2, type: 'vec2' },
    ] };
  }

  bindForSubMesh(uniformBuffer, scene) {
    uniformBuffer.updateFloat3('kuganeSecondaryColor', this.color.r, this.color.g, this.color.b);
    uniformBuffer.updateFloat2('kuganeSecondaryUVScale', this.texture?.uScale ?? 1, this.texture?.vScale ?? 1);
    if (scene.texturesEnabled && this.texture) uniformBuffer.setTexture('kuganeSecondarySampler', this.texture);
  }

  hasTexture(texture) {
    return this.texture === texture;
  }

  getActiveTextures(activeTextures) {
    if (this.texture) activeTextures.push(this.texture);
  }

  getCustomCode(shaderType) {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vKuganeSecondaryUV;
varying float vKuganeBlendWeight;
#if defined(KUGANE_SECONDARY_BLEND) && !defined(VERTEXCOLOR)
attribute vec4 color;
#endif`,
        CUSTOM_VERTEX_MAIN_END: `#ifdef KUGANE_SECONDARY_BLEND
  vKuganeSecondaryUV = uv2;
  vKuganeBlendWeight = 0.0;
#ifdef KUGANE_BLEND_ALPHA
  vKuganeBlendWeight = color.a;
#endif
#endif`,
      };
    }
    if (shaderType === 'fragment') {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: 'uniform sampler2D kuganeSecondarySampler; varying vec2 vKuganeSecondaryUV; varying float vKuganeBlendWeight;',
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef KUGANE_SECONDARY_BLEND
  vec3 kuganeSecondary = texture2D(kuganeSecondarySampler, vKuganeSecondaryUV * kuganeSecondaryUVScale).rgb;
#ifdef KUGANE_SECONDARY_GAMMA
  kuganeSecondary = toLinearSpace(kuganeSecondary);
#endif
  kuganeSecondary *= kuganeSecondaryColor;
  float kuganeBlendWeight = clamp(vKuganeBlendWeight, 0.0, 1.0);
  surfaceAlbedo = mix(surfaceAlbedo, kuganeSecondary, kuganeBlendWeight);
#endif`,
      };
    }
    return null;
  }

  getClassName() {
    return 'KuganeSecondaryBlendPlugin';
  }
}

export class MaterialAdapter {
  constructor({ scene, assets, map = assets?.map, textureCache, onDiagnostic = () => {} } = {}) {
    this.scene = scene;
    this.assets = assets;
    this.map = map;
    this.records = map?.legacyManifest?.materials || map?.materials || {};
    this.onDiagnostic = onDiagnostic;
    this.stats = emptyStats();
    this.materials = new Map();
    this.textureCache = textureCache || new BabylonTextureCache({
      scene,
      assets,
      onDiagnostic,
    });
  }

  getMaterial(source, meshOrInfo, { priority = 0, preview = true } = {}) {
    const path = typeof source === 'string' ? source : source?.path;
    const record = typeof source === 'string' ? this.records[source] : source;
    if (!record) {
      increment(this.stats.missing.materials, path || 'unmapped');
      throw new Error(`Missing Kugane material record: ${path || 'unmapped'}`);
    }
    const hasUV1 = vertexDataPresent(meshOrInfo, 'uv2');
    const hasColor = vertexDataPresent(meshOrInfo, 'color');
    if (meshOrInfo && 'useVertexColors' in meshOrInfo) {
      meshOrInfo.useVertexColors = record.keys?.[0x4f4f0636] === 0xbd94649a && hasColor;
    }
    const key = `${path || record.name || 'material'}:${hasUV1 ? 1 : 0}:${hasColor ? 1 : 0}:${preview ? 1 : 0}`;
    if (this.materials.has(key)) {
      this.stats.cacheHits += 1;
      return this.materials.get(key);
    }
    const work = this._createMaterial(path || record.name || 'material', record, { hasUV1, hasColor, priority, preview });
    this.materials.set(key, work);
    return work;
  }

  async _createMaterial(path, record, { hasUV1, hasColor, priority, preview }) {
    const family = shaderFamily(record.shader);
    const material = new PBRMaterial(`Kugane:${path}`, this.scene);
    const channels = {
      diffuse: sourcePath(record, 'diffuse'),
      normal: sourcePath(record, 'normal'),
      specular: sourcePath(record, 'specular'),
      secondary: sourcePath(record, 'colorMap1'),
      secondaryNormal: sourcePath(record, 'normalMap1Path'),
      emissive: sourcePath(record, 'emissiveMap'),
    };
    const uvScales = {
      albedo: Array.isArray(record.colorUVScale) ? record.colorUVScale.slice(0, 2) : [1, 1],
      secondary: Array.isArray(record.colorUVScale) ? record.colorUVScale.slice(2, 4) : [1, 1],
      normal: Array.isArray(record.normalUVScale) ? record.normalUVScale.slice(0, 2) : [1, 1],
      specular: Array.isArray(record.specularUVScale) ? record.specularUVScale.slice(0, 2) : [1, 1],
    };

    const mapPath = recordRuntimePath(record, 'map');
    const normalPath = recordRuntimePath(record, 'normalMap');
    const specularPath = recordRuntimePath(record, 'specularMap');
    const secondaryPath = recordRuntimePath(record, 'secondaryMap') || recordRuntimePath(record, 'colorMap1');
    const secondaryNormalPath = recordRuntimePath(record, 'secondaryNormalMap') || recordRuntimePath(record, 'normalMap1Path');
    const [albedo, normal, specular, secondary] = await Promise.all([
      this._safeTexture(mapPath, 'albedo', channels.diffuse, { preview, priority, uvScale: uvScales.albedo }),
      this._safeTexture(normalPath, 'normal', channels.normal, { preview, priority, uvScale: uvScales.normal }),
      this._safeTexture(specularPath, 'specular', channels.specular, { preview, priority, uvScale: uvScales.specular }),
      secondaryPath
        ? this._safeTexture(secondaryPath, 'secondary', channels.secondary, { preview, priority, uvScale: uvScales.secondary })
        : null,
    ]);

    const effectTextures = [];
    for (const effectPath of record.effectTextures || []) {
      const runtimePath = record.samplers?.find(sample => sample.path === effectPath)?.map || (effectPath.startsWith('textures/') ? effectPath : null);
      if (!runtimePath) {
        increment(this.stats.unsupported, 'effect-texture-unmapped');
        continue;
      }
      const effect = await this._safeTexture(runtimePath, family === 'water' || family === 'river' ? 'normal' : 'color', effectPath, {
        preview,
        priority,
        uvScale: [1, 1],
      });
      if (effect) effectTextures.push(effect);
    }

    material.albedoColor = arrayColor(record.diffuseColor, family === 'water' || family === 'river' ? WATER_COLOR : [1, 1, 1]);
    if (albedo) material.albedoTexture = albedo.texture;
    const normalLevel = Math.max(0, finite(record.normalScale, 1));
    if (normal) {
      material.bumpTexture = normal.texture;
      normal.texture.level = normalLevel;
      material.invertNormalMapY = SOURCE_NORMAL_Y_INVERTED;
    }

    const backgroundMask = family === 'background' && Boolean(specular);
    const isSpecularGlossiness = !backgroundMask && Boolean(specular || record.specular || record.reflectivityTexture);
    if (backgroundMask) {
      // bg.shpk _s is channel data, not colored specular reflectance.
      // G carries roughness; R/B specular masks have no proven PBR equivalent.
      material.metallic = 0;
      material.roughness = 1;
      material.metallicTexture = specular.texture;
      material.useRoughnessFromMetallicTextureGreen = true;
      material.useRoughnessFromMetallicTextureAlpha = false;
      material.useMetallnessFromMetallicTextureBlue = false;
      material.useAmbientOcclusionFromMetallicTextureRed = false;
      material.useMicroSurfaceFromReflectivityMapAlpha = false;
      increment(this.stats.unsupported, 'bg-specular-mask-rb');
    } else if (isSpecularGlossiness) {
      material.metallic = null;
      material.roughness = null;
      if (specular) material.reflectivityTexture = specular.texture;
      material.reflectivityColor = arrayColor(record.reflectivityColor, [1, 1, 1]);
      material.microSurface = clamp01(record.microSurface ?? FALLBACK_MICROSURFACE);
      material.useMicroSurfaceFromReflectivityMapAlpha = true;
    } else {
      material.metallic = 0;
      material.roughness = family === 'water' || family === 'river' ? 0.18 : 0.82;
    }

    const emissiveColor = arrayColor(record.emissiveColor, [0, 0, 0]);
    material.emissiveColor = emissiveColor;
    material.emissiveIntensity = 1;
    if (record.emissiveMap) {
      const emissive = await this._safeTexture(recordRuntimePath(record, 'emissiveMap'), 'emissive', record.emissiveMap, {
        preview,
        priority,
        uvScale: uvScales.albedo,
      });
      if (emissive) material.emissiveTexture = emissive.texture;
    } else if (emissiveColor.r > 0 || emissiveColor.g > 0 || emissiveColor.b > 0) {
      // The source material has no separate emission sampler. The client
      // shader uses the diffuse sampler for these records, so keep that link.
      if (albedo) material.emissiveTexture = albedo.texture;
    }

    const alphaThreshold = finite(record.alphaThreshold, 0);
    const waterLike = family === 'water' || family === 'river';
    if (waterLike) {
      const wave = effectTextures.find(entry => entry.semantic === 'normal');
      if (wave && !material.bumpTexture) {
        material.bumpTexture = wave.texture;
        wave.texture.level = Math.max(0.1, finite(record.normalScale, 1));
        material.invertNormalMapY = SOURCE_NORMAL_Y_INVERTED;
      }
      material.albedoColor = arrayColor(record.diffuseColor, WATER_COLOR);
      material.alpha = 0.72;
      material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      material.useAlphaFromAlbedoTexture = false;
      increment(this.stats.unsupported, `${record.shader}-native-approx`);
    } else if (alphaThreshold > 0) {
      material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
      material.alphaCutOff = alphaThreshold;
      material.useAlphaFromAlbedoTexture = Boolean(albedo);
    } else {
      material.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    }

    material.backFaceCulling = hasFlag(record, 1);
    material.twoSidedLighting = !material.backFaceCulling;
    material.unlit = false;
    material.directIntensity = 1;
    material.environmentIntensity = 1;
    material.maxSimultaneousLights = 4;

    if (family === 'crystal') increment(this.stats.unsupported, 'crystal-envmap-effect');
    if (family === 'unknown') increment(this.stats.unsupported, `unknown-shader:${record.shader || 'missing'}`);
    if (secondaryNormalPath) increment(this.stats.unsupported, 'secondary-normal-blend');

    let secondaryPlugin = null;
    if (secondary && hasUV1 && hasColor) {
      secondaryPlugin = new KuganeSecondaryBlendPlugin(material, {
        texture: secondary.texture,
        color: record.multiDiffuseColor || [1, 1, 1],
      });
    } else if (secondaryPath) {
      if (!hasUV1) increment(this.stats.missing.vertexChannels, 'secondary-blend:uv1');
      if (!hasColor) increment(this.stats.missing.vertexChannels, 'secondary-blend:color0');
    }

    const textureSlots = [
      { property: 'albedoTexture', semantic: 'albedo', runtimePath: mapPath, sourcePath: channels.diffuse, uvScale: uvScales.albedo },
      { property: 'bumpTexture', semantic: 'normal', runtimePath: normalPath, sourcePath: channels.normal, uvScale: uvScales.normal, level: normalLevel },
      { property: backgroundMask ? 'metallicTexture' : 'reflectivityTexture', semantic: 'specular', runtimePath: specularPath, sourcePath: channels.specular, uvScale: uvScales.specular },
      { property: 'emissiveTexture', semantic: 'emissive', runtimePath: recordRuntimePath(record, 'emissiveMap'), sourcePath: record.emissiveMap, uvScale: uvScales.albedo },
    ].filter(slot => slot.runtimePath);
    if (secondaryPlugin) textureSlots.push({ property: 'secondaryTexture', semantic: 'secondary', runtimePath: secondaryPath, sourcePath: channels.secondary, uvScale: uvScales.secondary });
    material.metadata = material.metadata || {};
    material.metadata.ffxiv = {
      materialPath: path,
      shader: record.shader,
      shaderFamily: family,
      flags: finite(record.flags, 0),
      workflow: backgroundMask ? 'background-packed-mask-dielectric' : isSpecularGlossiness ? 'specular-glossiness' : 'metallic-roughness-fallback',
      channelMapping: backgroundMask ? {
        source: record.specular,
        r: 'specular-mask-A-unmapped',
        g: 'roughness',
        b: 'specular-mask-B-unmapped',
        a: 'unused',
        metallic: 0,
        specularTint: 'neutral-native-dielectric',
      } : null,
      sourceNormalYInverted: SOURCE_NORMAL_Y_INVERTED,
      preview,
      channels,
      runtimePaths: { mapPath, normalPath, specularPath, secondaryPath, secondaryNormalPath },
      textureSlots,
      secondaryPlugin,
      effectTextureCount: effectTextures.length,
      alphaThreshold,
      unsupported: waterLike ? [`${record.shader}-native-approx`] : [],
    };
    if (secondaryNormalPath) material.metadata.ffxiv.unsupported.push('secondary-normal-blend');
    if (family === 'crystal') material.metadata.ffxiv.unsupported.push('crystal-envmap-effect');
    if (backgroundMask) material.metadata.ffxiv.unsupported.push('bg-specular-mask-rb');
    material.name = `Kugane:${path}`;
    this.stats.created += 1;
    return material;
  }

  async _safeTexture(runtimePath, semantic, source, options) {
    if (!runtimePath) return null;
    try {
      const entry = await this.textureCache.load(runtimePath, semantic, { ...options, sourcePath: source });
      this.stats.textures.loads += 1;
      this.stats.textures[options.preview === false ? 'full' : 'preview'] += 1;
      this.stats.textures.bytes += entry.bytes || 0;
      return entry;
    } catch (error) {
      increment(this.stats.missing.textures, source || runtimePath);
      this.onDiagnostic({ type: 'missing-texture', runtimePath, sourcePath: source, error: error.message });
      return null;
    }
  }

  async upgradeMaterial(material, { priority = 20 } = {}) {
    const info = material?.metadata?.ffxiv;
    if (!info || !info.preview) return material;
    const replacements = await Promise.all(info.textureSlots.map(async slot => {
      if (!slot.runtimePath) return null;
      const entry = await this._safeTexture(slot.runtimePath, slot.semantic, slot.sourcePath, {
        preview: false,
        priority,
        uvScale: slot.uvScale,
      });
      return entry ? { slot, entry } : null;
    }));
    for (const replacement of replacements.filter(Boolean)) {
      const { slot, entry } = replacement;
      if (slot.level !== undefined) entry.texture.level = slot.level;
      if (slot.property === 'secondaryTexture') {
        if (info.secondaryPlugin) info.secondaryPlugin.texture = entry.texture;
      } else {
        material[slot.property] = entry.texture;
      }
    }
    info.preview = false;
    this.stats.upgrades += 1;
    return material;
  }

  sourceInventory() {
    const entries = Object.entries(this.records);
    const shaders = Object.create(null);
    const flags = Object.create(null);
    const channels = {
      diffuse: 0,
      normal: 0,
      specular: 0,
      secondaryDiffuse: 0,
      secondaryNormal: 0,
      effectTextures: 0,
      emissive: 0,
      alphaTest: 0,
      nonDefaultColorUV: 0,
    };
    for (const [, record] of entries) {
      increment(shaders, record.shader || 'unknown');
      increment(flags, String(finite(record.flags, 0)));
      if (record.diffuse) channels.diffuse += 1;
      if (record.normal) channels.normal += 1;
      if (record.specular) channels.specular += 1;
      if (record.secondaryMap || record.colorMap1) channels.secondaryDiffuse += 1;
      if (record.secondaryNormalMap || record.normalMap1Path) channels.secondaryNormal += 1;
      if (record.effectTextures?.length) channels.effectTextures += 1;
      if (record.emissiveColor?.some(value => finite(value, 0) > 0)) channels.emissive += 1;
      if (finite(record.alphaThreshold, 0) > 0) channels.alphaTest += 1;
      if (record.colorUVScale?.some(value => finite(value, 1) !== 1)) channels.nonDefaultColorUV += 1;
    }
    return { total: entries.length, shaders: plainCounts(shaders), flags: plainCounts(flags), channels };
  }

  diagnostics() {
    return {
      source: this.sourceInventory(),
      createdMaterials: this.stats.created,
      materialCacheHits: this.stats.cacheHits,
      upgrades: this.stats.upgrades,
      textures: { ...this.stats.textures },
      knownUnsupported: plainCounts(this.stats.unsupported),
      missing: {
        materials: plainCounts(this.stats.missing.materials),
        textures: plainCounts(this.stats.missing.textures),
        vertexChannels: plainCounts(this.stats.missing.vertexChannels),
      },
      normalMapping: { sourceNormalYInverted: SOURCE_NORMAL_Y_INVERTED, textureInvertY: false },
    };
  }

  dispose() {
    for (const materialPromise of this.materials.values()) {
      materialPromise.then(material => material.dispose(true)).catch(() => {});
    }
    this.materials.clear();
    this.textureCache.dispose();
  }
}

export default MaterialAdapter;
