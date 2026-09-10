import * as THREE from 'three';

export class AppearanceRuntime {
  constructor(data) {
    this.data = data ? structuredClone(data) : null;
    this.modelScales = new WeakMap();
    this.boneBindings = new WeakMap();
  }

  setData(data) { this.data = structuredClone(data); }
  serialize() { return this.data ? structuredClone(this.data) : null; }

  apply(model, bindings = {}) {
    if (!this.data) return;
    const appearance = this.data;
    if (!this.boneBindings.has(model)) {
      const controls = [];
      for (const name of bindings.bustBones || []) {
        const bone = model.getObjectByName(name);
        if (!bone || !bindings.bustScale) continue;
        const factor = new THREE.Vector3(...bindings.bustScale);
        const sampled = bone.scale.clone().divide(factor);
        bone.scale.copy(sampled);
        controls.push({ bone, factor, sampled });
      }
      if (bindings.tailBone && bindings.tailScale) {
        const bone = model.getObjectByName(bindings.tailBone);
        if (bone) {
          const factor = new THREE.Vector3().setScalar(bindings.tailScale);
          const sampled = bone.scale.clone().divide(factor);
          bone.scale.copy(sampled);
          controls.push({ bone, factor, sampled });
        }
      }
      this.boneBindings.set(model, controls);
    }
    // Bindings are emitted by the client-data converter, never inferred from
    // material order or a local character filename.
    if (bindings.heightRange) {
      const [minimum, maximum] = bindings.heightRange;
      const height = THREE.MathUtils.lerp(minimum, maximum, appearance.height / 100);
      if (!this.modelScales.has(model)) this.modelScales.set(model, model.scale.clone());
      const authoredScale = bindings.heightAppliedToModelRoot ? bindings.heightScale : 1;
      model.scale.copy(this.modelScales.get(model)).multiplyScalar(height / (bindings.referenceHeight || 1) / authoredScale);
    }
    model.traverse(node => {
      const scaleBinding = bindings.bones?.[node.name];
      if (scaleBinding) {
        const factor = THREE.MathUtils.lerp(scaleBinding.min, scaleBinding.max, appearance[scaleBinding.field] / 100);
        node.scale.copy(new THREE.Vector3(...scaleBinding.referenceScale)).multiplyScalar(factor);
      }
      for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
        const binding = bindings.materials?.[material.name];
        if (!binding) continue;
        for (const [property, source] of Object.entries(binding.colors || {})) {
          const value = bindings.palettes?.[source.palette]?.[appearance[source.field]];
          if (value && material[property]?.isColor) {
            material[property].setRGB(value[0], value[1], value[2], source.colorSpace === 'linear' ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);
          }
        }
      }
    });
  }

  beforeAnimation(model) {
    for (const item of this.boneBindings.get(model) || []) item.bone.scale.copy(item.sampled);
  }

  afterAnimation(model) {
    for (const item of this.boneBindings.get(model) || []) {
      item.sampled.copy(item.bone.scale);
      item.bone.scale.multiply(item.factor);
    }
  }
}
