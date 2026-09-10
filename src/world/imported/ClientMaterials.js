import * as THREE from 'three';

// Source image cache is independent of per-material sampler transforms.
// Reusing one mutable Texture across materials can change another material's UV scale.
export class ClientMaterials {
  constructor(base, manifest, { runtime, paths, signal, mapId, priority = 0 } = {}) {
    this.base = base;
    this.manifest = manifest;
    this.loader = new THREE.TextureLoader();
    this.images = new Map();
    this.materials = new Map();
    this.runtime = runtime;
    this.paths = paths;
    this.options = { signal, mapId, priority };
    this.retained = new Map();
    this.upgrades = new WeakMap();
  }
  async texture(url, colorSpace, scale = [1, 1], priority = this.options.priority) {
    if (!url) return null;
    if (this.runtime) {
      const fullResource = this.paths[url];
      const previewResource = this.runtime.registry.get(fullResource).metadata?.preview;
      const fullId = `texture-view:${fullResource}:${colorSpace}:${scale.join(',')}`;
      this.runtime.registry.register(fullId, {
        type: 'texture-view', hash: fullId, virtual: true, dependencies: [fullResource], size: 0,
        metadata: { resource: fullResource, colorSpace, scale },
      });
      const preview = runtimeHasFull(this.runtime, fullId, fullResource) ? null : previewResource;
      const id = preview ? `${fullId}:preview:${preview}` : fullId;
      if (preview) this.runtime.registry.register(id, {
        type: 'texture-view', hash: id, virtual: true, dependencies: [preview], size: 0,
        metadata: { resource: preview, colorSpace, scale },
      });
      if (!this.retained.has(id)) {
        this.retained.set(id, this.runtime.load(id, { ...this.options, priority }));
      }
      const texture = await this.retained.get(id);
      if (preview) texture.userData.fullVariant = fullId;
      return texture;
    }
    if (!this.images.has(url)) this.images.set(url, this.loader.loadAsync(this.base + url));
    const source = await this.images.get(url);
    const texture = source.clone();
    texture.colorSpace = colorSpace;
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(scale[0] ?? 1, scale[1] ?? 1);
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    texture.userData.sceneOwned = true;
    return texture;
  }
  release() {
    if (!this.runtime) return;
    for (const [id, ready] of this.retained) ready.then(() => this.runtime.release(id)).catch(() => {});
    this.retained.clear();
  }
  releasePreviews() {
    for (const [id, ready] of this.retained) {
      if (!id.includes(':preview:')) continue;
      ready.then(() => this.runtime.release(id)).catch(() => {});
      this.retained.delete(id);
    }
  }
  upgradeMaterial(material, renderer, priority = 20) {
    if (!this.runtime) return Promise.resolve();
    if (this.upgrades.has(material)) return this.upgrades.get(material);
    const work = (async () => {
      const slots = Object.entries(material).filter(([, texture]) => texture?.isTexture && texture.userData.fullVariant);
      for (const [index, texture] of (material.userData.ownedTextures || []).entries()) {
        if (texture.userData.fullVariant) slots.push([`owned:${index}`, texture]);
      }
      await Promise.all(slots.map(async ([slot, preview]) => {
        const id = preview.userData.fullVariant;
        if (!this.retained.has(id)) this.retained.set(id, this.runtime.load(id, { ...this.options, priority }));
        const full = await this.retained.get(id);
        this.options.signal?.throwIfAborted();
        await this.runtime.gpu.enqueue(() => renderer.initTexture(full), {
          signal: this.options.signal, priority,
          onTiming: cpuMs => this.runtime.event({ event: 'gpu-upload-cpu', resourceId: id, mapId: this.options.mapId, cpuMs }),
        });
        if (slot.startsWith('owned:')) {
          const index = Number(slot.slice(6));
          material.userData.ownedTextures[index] = full;
          if (index === 0 && material.userData.clientUniforms) material.userData.clientUniforms.clientMap1.value = full;
        } else material[slot] = full;
      }));
    })();
    this.upgrades.set(material, work);
    return work;
  }
  get(path, geometry, priority = this.options.priority) {
    const record = this.manifest.materials[path] || {};
    const canBlend = !!record.secondaryMap && !!geometry.attributes.uv1;
    const vertexColor = record.keys?.[0x4f4f0636] === 0xbd94649a && !!geometry.attributes.color;
    const key = `${path}:${canBlend}:${vertexColor}`;
    if (!this.materials.has(key)) this.materials.set(key, this.create(path, record, canBlend, vertexColor, priority));
    return this.materials.get(key);
  }
  async create(path, record, canBlend, vertexColor, priority) {
    const [map, normalMap, specularMap, secondaryMap] = await Promise.all([
      this.texture(record.map, THREE.SRGBColorSpace, record.colorUVScale?.slice(0, 2), priority),
      this.texture(record.normalMap, THREE.NoColorSpace, record.normalUVScale?.slice(0, 2), priority),
      this.texture(record.specularMap, THREE.NoColorSpace, record.specularUVScale?.slice(0, 2), priority),
      canBlend ? this.texture(record.secondaryMap, THREE.SRGBColorSpace, record.colorUVScale?.slice(2, 4), priority) : null,
    ]);
    const water = /(?:water|river)\.shpk/.test(record.shader || '');
    const foliage = /(?:tre[ea]|leaf|grass|shiba|kus[ae]|plant)/i.test(path || '');
    const color = record.diffuseColor || [1, 1, 1];
    const emissive = record.emissiveColor || [0, 0, 0];
    const normalScale = record.normalScale ?? 1;
    const material = new THREE.MeshPhysicalMaterial({
      map, normalMap, normalScale: new THREE.Vector2(normalScale, -normalScale),
      // The client's specular-color image is not a roughness image.
      specularColorMap: specularMap, specularIntensity: specularMap ? 0.45 : 0,
      color: map ? new THREE.Color(...color) : water ? '#6dabae' : '#abb4a9',
      emissive: new THREE.Color(...emissive),
      roughness: water ? 0.22 : 0.85, metalness: 0,
      side: (record.flags & 1) ? THREE.FrontSide : THREE.DoubleSide,
      vertexColors: vertexColor,
      alphaTest: record.alphaThreshold || (foliage ? 0.4 : 0),
      transparent: water, opacity: water ? 0.7 : 1,
    });
    material.name = path || 'unmapped';
    material.userData.client = { materialPath: path, samplerIds: record.samplers?.map(s => s.id), colorUVScale: record.colorUVScale, secondaryUV: canBlend ? 1 : null, flipY: false };
    if (secondaryMap) {
      material.userData.ownedTextures = [secondaryMap];
      const multiColor = new THREE.Color(...(record.multiDiffuseColor || [1, 1, 1]));
      // Source UV1 and source vertex alpha drive two-layer diffuse blending.
      // Height/detail shader branches remain explicitly approximate.
      material.onBeforeCompile = shader => {
        shader.uniforms.clientMap1 = { value: material.userData.ownedTextures[0] };
        shader.uniforms.clientScale1 = { value: secondaryMap.repeat };
        shader.uniforms.clientColor1 = { value: multiColor };
        material.userData.clientUniforms = shader.uniforms;
        shader.vertexShader = `attribute float clientBlend; varying vec2 vClientUv1; varying float vClientBlend;\n${shader.vertexShader}`
          .replace('#include <uv_vertex>', '#include <uv_vertex>\nvClientUv1 = uv1; vClientBlend = clientBlend;');
        shader.fragmentShader = `uniform sampler2D clientMap1; uniform vec2 clientScale1; uniform vec3 clientColor1; varying vec2 vClientUv1; varying float vClientBlend;\n${shader.fragmentShader}`
          .replace('#include <map_fragment>', `
            #ifdef USE_MAP
              vec4 baseLayer = texture2D(map, vMapUv);
              vec4 secondLayer = texture2D(clientMap1, vClientUv1 * clientScale1);
              secondLayer.rgb *= clientColor1;
              diffuseColor *= mix(baseLayer, secondLayer, clamp(vClientBlend, 0.0, 1.0));
            #endif`);
      };
      material.customProgramCacheKey = () => `client-two-layer-v1:${vertexColor}`;
      material.defines = { USE_UV1: '' };
    }
    return material;
  }
}

function runtimeHasFull(runtime, viewId, resourceId) {
  return Boolean(runtime.get(viewId) || runtime.get(resourceId));
}
