import { Color3, Vector3, VertexBuffer } from '@babylonjs/core';
import { collectNativeTargets } from './NativeAssetLoader.js';

function scaleAccess(target) {
  if (target?.scaling) {
    return {
      read: () => target.scaling.clone(),
      write: value => target.scaling.copyFrom(value),
    };
  }
  if (target?.getScale && target?.setScale) {
    return {
      read: () => target.getScale(),
      write: value => target.setScale(value),
    };
  }
  return null;
}

function multiplyComponents(target, factor) {
  target.x *= factor.x;
  target.y *= factor.y;
  target.z *= factor.z;
  return target;
}

function divideComponents(target, factor) {
  target.x /= factor.x || 1;
  target.y /= factor.y || 1;
  target.z /= factor.z || 1;
  return target;
}

function inferMaterialRole(name = '') {
  const lower = name.toLowerCase();
  if (lower.includes('_iri_')) return 'iris';
  if (lower.includes('_fac_') || lower.includes('b0001')) return 'skin';
  if (lower.includes('_hir_') || lower.includes('hair')) return 'hair';
  return null;
}

function materialColor(material, property) {
  const aliases = {
    color: ['albedoColor', 'diffuseColor'],
    emissive: ['emissiveColor'],
    emissiveColor: ['emissiveColor'],
    diffuse: ['diffuseColor', 'albedoColor'],
    albedo: ['albedoColor', 'diffuseColor'],
  };
  const direct = material?.[property];
  if (direct?.copyFromFloats || direct instanceof Color3) return direct;
  for (const key of aliases[property] || []) {
    if (material?.[key]?.copyFromFloats) return material[key];
  }
  return null;
}

function setFfxivColor(target, value, source = {}) {
  if (!target || !value) return;
  const squared = source.colorSpace === 'ffxiv-linear' || source.squared === true;
  const rgb = squared ? value.slice(0, 3).map(channel => channel * channel) : value;
  target.copyFromFloats(rgb[0], rgb[1], rgb[2]);
}

function applyIrisVertexColors(mesh, appearance, bindings) {
  if (!mesh?.getVerticesData) return;
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const colors = mesh.getVerticesData(VertexBuffer.ColorKind);
  if (!positions || !colors) return;
  const right = appearance.palette?.rightEye || bindings.palettes?.rightEye?.[appearance.rightEyeColor];
  const left = appearance.palette?.leftEye || bindings.palettes?.leftEye?.[appearance.leftEyeColor];
  if (!right || !left) return;
  if (!mesh.metadata?.ffxivIrisGeometryIsolated) {
    mesh.makeGeometryUnique?.();
    mesh.metadata = { ...(mesh.metadata || {}), ffxivIrisGeometryIsolated: true };
  }
  const result = Float32Array.from(colors);
  const stride = result.length / (positions.length / 3) >= 4 ? 4 : 3;
  for (let index = 0; index < positions.length / 3; index++) {
    const value = positions[index * 3] < 0 ? left : right;
    result[index * stride] = value[0] * value[0];
    result[index * stride + 1] = value[1] * value[1];
    result[index * stride + 2] = value[2] * value[2];
  }
  mesh.updateVerticesData(VertexBuffer.ColorKind, result, false, false);
  mesh.useVertexColors = true;
}

function resolvedPaletteEntry(appearance, bindings, source) {
  const table = bindings.palettes?.[source.palette];
  const indexed = table?.[appearance[source.field]];
  if (indexed) return indexed;
  // Fresh DAT imports carry exact human.cmp colors resolved at parse time;
  // the pre-baked definition palette is the compatibility fallback.
  return appearance.palette?.[source.palette];
}

function applyMaterialRole(material, role, binding, mesh, appearance, bindings) {
  material.metadata = { ...(material.metadata || {}), ffxivRole: role };
  if (role === 'iris') {
    materialColor(material, 'color')?.copyFromFloats(1, 1, 1);
    if ('roughness' in material) material.roughness = binding.roughness ?? 0.42;
    if ('metallic' in material) material.metallic = binding.metalness ?? 0;
    applyIrisVertexColors(mesh, appearance, bindings);
  } else if (role === 'skin') {
    if ('roughness' in material) material.roughness = binding.roughness ?? 0.76;
    if ('metallic' in material) material.metallic = binding.metalness ?? 0;
  } else if (role === 'hair') {
    if ('roughness' in material) material.roughness = binding.roughness ?? 0.85;
    if ('metallic' in material) material.metallic = binding.metalness ?? 0;
  }
  if (binding.normalScale && material.bumpTexture) {
    material.bumpTexture.level = Math.max(Math.abs(binding.normalScale[0]), Math.abs(binding.normalScale[1]));
  }
  if (binding.opacity !== undefined) material.alpha = binding.opacity;
}

export class AppearanceRuntime {
  constructor(data) {
    this.data = data ? structuredClone(data) : null;
    this.modelScales = new WeakMap();
    this.boneBindings = new WeakMap();
  }

  setData(data) { this.data = data ? structuredClone(data) : null; }
  serialize() { return this.data ? structuredClone(this.data) : null; }

  apply(model, bindings = {}) {
    if (!this.data || !model) return;
    const appearance = this.data;
    const targets = collectNativeTargets(model);
    if (!this.boneBindings.has(model)) {
      const controls = [];
      for (const name of bindings.bustBones || []) {
        const target = targets.nodes.get(name) || targets.bones.get(name);
        const access = scaleAccess(target);
        if (!access || !bindings.bustScale) continue;
        const factor = Vector3.FromArray(bindings.bustScale);
        const sampled = divideComponents(access.read(), factor);
        access.write(sampled);
        controls.push({ access, factor, sampled });
      }
      if (bindings.tailBone && bindings.tailScale) {
        const target = targets.nodes.get(bindings.tailBone) || targets.bones.get(bindings.tailBone);
        const access = scaleAccess(target);
        if (access) {
          const factor = new Vector3(bindings.tailScale, bindings.tailScale, bindings.tailScale);
          const sampled = divideComponents(access.read(), factor);
          access.write(sampled);
          controls.push({ access, factor, sampled });
        }
      }
      this.boneBindings.set(model, controls);
    }
    if (bindings.heightRange) {
      const [minimum, maximum] = bindings.heightRange;
      const height = minimum + (maximum - minimum) * appearance.height / 100;
      if (!this.modelScales.has(model)) this.modelScales.set(model, model.scaling.clone());
      const authoredScale = bindings.heightAppliedToModelRoot ? bindings.heightScale : 1;
      model.scaling.copyFrom(this.modelScales.get(model)).scaleInPlace(height / (bindings.referenceHeight || 1) / authoredScale);
    }
    for (const [name, scaleBinding] of Object.entries(bindings.bones || {})) {
      const target = targets.nodes.get(name) || targets.bones.get(name);
      const access = scaleAccess(target);
      if (!access) continue;
      const factor = scaleBinding.min + (scaleBinding.max - scaleBinding.min) * appearance[scaleBinding.field] / 100;
      access.write(Vector3.FromArray(scaleBinding.referenceScale).scale(factor));
    }
    const materials = new Set();
    for (const mesh of model.getChildMeshes?.(false) || []) {
      const meshMaterials = mesh.material?.subMaterials || (mesh.material ? [mesh.material] : []);
      for (const material of meshMaterials) {
        if (!material) continue;
        materials.add(material);
        const binding = bindings.materials?.[material.name] || {};
        const role = binding.shader || binding.role || inferMaterialRole(material.name);
        if (role) applyMaterialRole(material, role, binding, mesh, appearance, bindings);
        for (const [property, source] of Object.entries(binding.colors || {})) {
          const value = resolvedPaletteEntry(appearance, bindings, source);
          if (value) setFfxivColor(materialColor(material, property), value, source);
        }
      }
    }
    for (const material of materials) material.markDirty?.();
  }

  beforeAnimation(model) {
    for (const item of this.boneBindings.get(model) || []) item.access.write(item.sampled);
  }

  afterAnimation(model) {
    for (const item of this.boneBindings.get(model) || []) {
      item.sampled.copyFrom(item.access.read());
      item.access.write(multiplyComponents(item.sampled.clone(), item.factor));
    }
  }
}
