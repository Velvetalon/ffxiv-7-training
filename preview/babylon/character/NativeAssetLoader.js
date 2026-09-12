import { AnimationGroup, Quaternion, SceneLoader, TransformNode, Vector3 } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';

function bytesView(value) {
  const bytes = value?.bytes ?? value;
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError('Babylon native assets require an ArrayBuffer or typed-array resource');
}

function targetName(target) {
  return target?.name || target?.id || target?._linkedTransformNode?.name || null;
}

function targetClass(target) {
  return target?.getClassName?.() || target?.constructor?.name || '';
}

export function collectNativeTargets(root, skeletons = []) {
  const nodes = new Map();
  const bones = new Map();
  const addNode = node => {
    if (!node) return;
    if (node.name && !nodes.has(node.name)) nodes.set(node.name, node);
    if (node.id && !nodes.has(node.id)) nodes.set(node.id, node);
  };
  addNode(root);
  for (const node of root?.getDescendants?.(false) || []) addNode(node);
  for (const skeleton of skeletons) {
    for (const bone of skeleton?.bones || []) {
      if (bone.name && !bones.has(bone.name)) bones.set(bone.name, bone);
      addNode(bone.getTransformNode?.());
    }
  }
  for (const mesh of root?.getChildMeshes?.(false) || []) {
    for (const bone of mesh.skeleton?.bones || []) {
      if (bone.name && !bones.has(bone.name)) bones.set(bone.name, bone);
      addNode(bone.getTransformNode?.());
    }
  }
  return { nodes, bones };
}

export function retargetAnimationGroup(source, root, {
  name = source?.name || 'animation',
  skeletons = [],
  cloneAnimations = true,
} = {}) {
  if (!source?.targetedAnimations?.length || !root) return null;
  const scene = root.getScene();
  const targets = collectNativeTargets(root, skeletons);
  const group = new AnimationGroup(name, scene, source.weight, source.playOrder);
  const missingTargets = [];
  for (const targeted of source.targetedAnimations) {
    const oldTarget = targeted.target;
    const oldName = targetName(oldTarget);
    const wantsBone = targetClass(oldTarget).includes('Bone');
    const target = wantsBone
      ? targets.bones.get(oldName) || targets.nodes.get(oldName)
      : targets.nodes.get(oldName) || targets.bones.get(oldName);
    if (!target) {
      if (oldName) missingTargets.push(oldName);
      continue;
    }
    const animation = cloneAnimations ? targeted.animation.clone(true) : targeted.animation;
    group.addTargetedAnimation(animation, target);
  }
  if (!group.targetedAnimations.length) {
    group.dispose();
    return null;
  }
  group.from = source.from;
  group.to = source.to;
  group.speedRatio = source.speedRatio;
  group.loopAnimation = source.loopAnimation;
  group.isAdditive = source.isAdditive;
  group.enableBlending = source.enableBlending;
  group.blendingSpeed = source.blendingSpeed;
  group.metadata = { ...(source.metadata || {}), ffxivRetargetMissing: [...new Set(missingTargets)] };
  return group;
}

export async function loadNativeContainer(scene, assetRuntime, resourceId, {
  priority = 0,
  retain = true,
  signal,
} = {}) {
  if (!scene) throw new Error('loadNativeContainer requires a Babylon scene');
  if (!assetRuntime?.load) throw new Error('loadNativeContainer requires an AssetRuntime');
  const value = await assetRuntime.load(resourceId, { priority, retain, signal });
  let released = false;
  let container;
  try {
    if (value?.instantiateModelsToScene && value?.rootNodes) container = value;
    else container = await SceneLoader.LoadAssetContainerAsync('data:', bytesView(value), scene, undefined, '.glb');
  } catch (error) {
    if (retain) assetRuntime.release?.(resourceId);
    throw error;
  }
  return {
    resourceId,
    scene,
    container,
    retained: retain,
    release() {
      if (released) return;
      released = true;
      if (retain) assetRuntime.release?.(resourceId);
    },
    dispose() {
      container?.dispose?.();
      this.release();
    },
  };
}

export function instantiateNativeAsset(loaded, scene = loaded?.scene, {
  name = loaded?.resourceId || 'native-asset',
  cloneMaterials = true,
  parent = null,
  pickable = true,
  ownSource = true,
} = {}) {
  const container = loaded?.container || loaded;
  if (!container?.instantiateModelsToScene) throw new Error('instantiateNativeAsset requires a Babylon AssetContainer');
  if (!scene) throw new Error('instantiateNativeAsset requires a Babylon scene');
  // Joint and transform names are semantic animation bindings in the exported
  // FFXIV assets. Keep them unchanged; the wrapper root supplies instance identity.
  const entries = container.instantiateModelsToScene(sourceName => sourceName, cloneMaterials, {
    doNotInstantiate: true,
  });
  const root = new TransformNode(name, scene);
  root.parent = parent;
  for (const node of entries.rootNodes || []) node.parent = root;
  for (const skeleton of entries.skeletons || []) skeleton.useTextureToStoreBoneMatrices = true;
  for (const mesh of root.getChildMeshes(false)) {
    mesh.isPickable = pickable;
    mesh.receiveShadows = true;
    mesh.metadata = { ...(mesh.metadata || {}), ffxiv: { ...(mesh.metadata?.ffxiv || {}), nativeAsset: name } };
  }
  for (const group of entries.animationGroups || []) group.stop();
  const sourceOwner = ownSource ? loaded : null;
  let disposed = false;
  return {
    root,
    rootNodes: entries.rootNodes || [],
    skeletons: entries.skeletons || [],
    animationGroups: entries.animationGroups || [],
    source: sourceOwner,
    findNode(nodeName) {
      return collectNativeTargets(root, entries.skeletons).nodes.get(nodeName) || null;
    },
    setTransform({ position, heading, scaling, rotationQuaternion } = {}) {
      if (position) root.position.copyFrom(position.clone ? position : Vector3.FromArray(position));
      if (heading !== undefined) root.rotation.y = heading;
      if (scaling !== undefined) {
        if (Number.isFinite(scaling)) root.scaling.setAll(scaling);
        else root.scaling.copyFrom(scaling.clone ? scaling : Vector3.FromArray(scaling));
      }
      if (rotationQuaternion) root.rotationQuaternion = rotationQuaternion.clone
        ? rotationQuaternion.clone() : Quaternion.FromArray(rotationQuaternion);
      return this;
    },
    dispose({ disposeAnimationGroups = true } = {}) {
      if (disposed) return;
      disposed = true;
      if (disposeAnimationGroups) for (const group of entries.animationGroups || []) group.dispose();
      root.dispose(false, true);
      sourceOwner?.dispose?.();
    },
  };
}

export async function loadRetargetedAnimation(scene, assetRuntime, resourceId, root, {
  name,
  priority = 0,
  signal,
  skeletons = [],
} = {}) {
  const loaded = await loadNativeContainer(scene, assetRuntime, resourceId, { priority, retain: true, signal });
  try {
    const source = loaded.container.animationGroups?.[0];
    if (!source) return null;
    return retargetAnimationGroup(source, root, { name: name || source.name, skeletons, cloneAnimations: true });
  } finally {
    loaded.dispose();
  }
}
