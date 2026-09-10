import * as THREE from 'three';

let worker;
let sequence = 0;
const jobs = new Map();
const cache = new WeakMap();

function requestLevels(geometry) {
  if (cache.has(geometry)) return cache.get(geometry);
  const pending = new Promise((resolve, reject) => {
    if (!worker) {
      worker = new Worker(new URL('./LodWorker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id);
        if (data.error) job.reject(new Error(data.error));
        else job.resolve(data.levels);
      };
      worker.onerror = event => {
        for (const job of jobs.values()) job.reject(new Error(event.message));
        jobs.clear();
        worker.terminate();
        worker = null;
      };
    }
    const position = geometry.attributes.position;
    const positions = new Float32Array(position.count * 3);
    const names = ['normal', 'uv', 'uv1', 'color', 'clientBlend'];
    const inputs = names.map(name => geometry.attributes[name]).filter(Boolean);
    const stride = inputs.reduce((total, attribute) => total + attribute.itemSize, 0);
    const attributes = new Float32Array(position.count * stride);
    const weights = inputs.flatMap(attribute => Array(attribute.itemSize).fill(1));
    for (let vertex = 0; vertex < position.count; vertex++) {
      positions.set([position.getX(vertex), position.getY(vertex), position.getZ(vertex)], vertex * 3);
      let offset = vertex * stride;
      for (const attribute of inputs) {
        for (let component = 0; component < attribute.itemSize; component++) {
          attributes[offset++] = attribute.getComponent(vertex, component);
        }
      }
    }
    const indices = geometry.index
      ? Uint32Array.from(geometry.index.array)
      : Uint32Array.from({ length: position.count }, (_, index) => index);
    const id = ++sequence;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, indices, positions, attributes, stride, weights },
      [indices.buffer, positions.buffer, attributes.buffer]);
  }).then(levels => {
    const variants = levels.map(level => {
      const result = new THREE.BufferGeometry();
      for (const [name, attribute] of Object.entries(geometry.attributes)) result.setAttribute(name, attribute);
      result.setIndex(new THREE.BufferAttribute(level.indices, 1));
      result.boundingBox = geometry.boundingBox?.clone() || null;
      result.boundingSphere = geometry.boundingSphere?.clone() || null;
      result.userData = { assetRuntimeOwned: true, lodError: level.error };
      return result;
    });
    geometry.userData.lodGeometries = variants;
    return variants;
  });
  cache.set(geometry, pending);
  return pending;
}

export function selectLod(distance, previous = 0, distances = [65, 150], hysteresis = 0.12) {
  let level = previous;
  while (level < distances.length && distance > distances[level] * (1 + hysteresis)) level++;
  while (level > 0 && distance < distances[level - 1] * (1 - hysteresis)) level--;
  return level;
}

// One instance belongs to one level. All levels retain the original attributes,
// material and transforms; only the index buffer changes.
export class DistanceLod {
  constructor(group, { distances = [65, 150], hysteresis = 0.12 } = {}) {
    this.group = group;
    this.distances = distances;
    this.hysteresis = hysteresis;
    this.enabled = true;
    this.records = [];
    this.elapsed = 0;
    this.disposed = false;
    this.position = new THREE.Vector3();
    this.inverse = new THREE.Matrix4();
    this.matrix = new THREE.Matrix4();
    this.stats = { meshes: 0, instances: 0, sourceTriangles: 0, drawnTriangles: 0, levels: [0, 0, 0], errors: 0 };
  }

  add(mesh) {
    const geometry = mesh.geometry;
    const count = geometry.index?.count || geometry.attributes.position.count;
    if (count < 600 || mesh.material.transparent || geometry.attributes.skinIndex) return;
    geometry.computeBoundingSphere();
    const record = {
      source: mesh, variants: null, matrices: mesh.instanceMatrix.array.slice(),
      levels: new Uint8Array(mesh.count), centers: [], radii: [], count: mesh.count,
      requested: false,
    };
    mesh.userData.sourceInstanceIndices = Uint32Array.from({ length: mesh.count }, (_, index) => index);
    for (let index = 0; index < mesh.count; index++) {
      this.matrix.fromArray(record.matrices, index * 16);
      const sphere = geometry.boundingSphere.clone().applyMatrix4(this.matrix);
      record.centers.push(sphere.center);
      record.radii.push(sphere.radius);
    }
    this.records.push(record);
  }

  prepare(record) {
    record.requested = true;
    const mesh = record.source;
    void requestLevels(mesh.geometry).then(geometries => {
      if (this.disposed) return;
      record.variants = [mesh, ...geometries.map(variant => {
        const level = new THREE.InstancedMesh(variant, mesh.material, record.count);
        level.name = `${mesh.name}:lod`;
        level.count = 0;
        level.receiveShadow = mesh.receiveShadow;
        level.castShadow = false;
        level.userData = { ...mesh.userData, lod: true, sourceInstanceIndices: new Uint32Array(record.count) };
        this.group.add(level);
        return level;
      })];
      mesh.castShadow = true;
      this.elapsed = 1;
    }).catch(error => {
      this.stats.errors++;
      mesh.userData.lodError = error.message;
    });
  }

  update(dt, camera) {
    this.elapsed += dt;
    if (this.elapsed < 0.25 || this.disposed) return;
    this.elapsed = 0;
    this.group.updateWorldMatrix(true, false);
    this.inverse.copy(this.group.matrixWorld).invert();
    this.position.copy(camera.position).applyMatrix4(this.inverse);
    for (const record of this.records.filter(item => !item.requested).slice(0, 2)) this.prepare(record);
    const stats = { meshes: 0, instances: 0, sourceTriangles: 0, drawnTriangles: 0, levels: [0, 0, 0], errors: this.stats.errors };
    for (const record of this.records) {
      const variants = record.variants;
      if (!variants) continue;
      const counts = [0, 0, 0];
      for (let index = 0; index < record.count; index++) {
        const distance = Math.max(0, this.position.distanceTo(record.centers[index]) - record.radii[index]);
        const level = this.enabled ? selectLod(distance, record.levels[index], this.distances, this.hysteresis) : 0;
        record.levels[index] = level;
        variants[level].userData.sourceInstanceIndices[counts[level]] = index;
        variants[level].instanceMatrix.array.set(record.matrices.subarray(index * 16, index * 16 + 16), counts[level]++ * 16);
      }
      variants.forEach((mesh, level) => {
        mesh.count = counts[level];
        mesh.visible = mesh.count > 0;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.count) {
          mesh.computeBoundingBox();
          mesh.computeBoundingSphere();
        }
        stats.levels[level] += mesh.count;
        stats.drawnTriangles += (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3 * mesh.count;
      });
      stats.meshes++;
      stats.instances += record.count;
      stats.sourceTriangles += (record.source.geometry.index?.count || record.source.geometry.attributes.position.count) / 3 * record.count;
    }
    this.stats = stats;
  }

  dispose() {
    this.disposed = true;
    this.records.length = 0;
  }
}
