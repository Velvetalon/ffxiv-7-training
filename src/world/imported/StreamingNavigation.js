import * as THREE from 'three';
import { MeshNavigation } from './MeshNavigation.js';

// The queries keep MeshNavigation's original walk/slope/step rules. Each loaded
// chunk contains untouched source triangles; only the search index is partitioned.
export class StreamingNavigation extends MeshNavigation {
  constructor(bounds, chunks, loadChunk) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...bounds.min, ...bounds.max], 3));
    const loaded = new Map();
    const complete = { navigation: null };
    const bvh = {
      raycast(ray, side, near, far) {
        if (complete.navigation) return complete.navigation.bvh.raycast(ray, side, near, far);
        const hits = [];
        for (const chunk of loaded.values()) {
          if (ray.intersectsBox(chunk.bounds)) hits.push(...chunk.navigation.bvh.raycast(ray, side, near, far));
        }
        return hits;
      },
      raycastFirst(ray, side, near, far) {
        if (complete.navigation) return complete.navigation.bvh.raycastFirst(ray, side, near, far);
        let nearest = null;
        for (const chunk of loaded.values()) {
          if (!ray.intersectsBox(chunk.bounds)) continue;
          const hit = chunk.navigation.bvh.raycastFirst(ray, side, near, nearest?.distance ?? far);
          if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
        }
        return nearest;
      },
    };
    super(null, { geometry, bvh });
    this.chunks = chunks.map(chunk => ({
      ...chunk,
      box: new THREE.Box3(new THREE.Vector3(...chunk.bounds.min), new THREE.Vector3(...chunk.bounds.max)),
    }));
    this.loadedChunks = loaded;
    this.pendingChunks = new Map();
    this.loadChunk = loadChunk;
    this.assetRuntimeOwned = true;
    this.completeState = complete;
    this.fullCollisionReady = false;
  }

  within(chunk, point, radius) {
    const { min, max } = chunk.box;
    return min.x <= point[0] + radius && max.x >= point[0] - radius &&
      min.z <= point[2] + radius && max.z >= point[2] - radius;
  }

  async ensure(point, radius = 96, priority = -10) {
    if (this.fullCollisionReady) return;
    const needed = this.chunks.filter(chunk => this.within(chunk, point, radius));
    let cursor = 0;
    const worker = async () => {
      while (cursor < needed.length) await this.load(needed[cursor++], priority);
    };
    await Promise.all(Array.from({ length: Math.min(3, needed.length) }, worker));
  }

  async load(chunk, priority) {
    if (this.loadedChunks.has(chunk.resourceId)) return;
    if (!this.pendingChunks.has(chunk.resourceId)) {
      const work = this.loadChunk(chunk, priority).then(navigation => {
        this.loadedChunks.set(chunk.resourceId, { bounds: chunk.box, navigation });
      }).finally(() => this.pendingChunks.delete(chunk.resourceId));
      this.pendingChunks.set(chunk.resourceId, work);
    }
    return this.pendingChunks.get(chunk.resourceId);
  }

  isReady(point, radius = 24) {
    if (this.fullCollisionReady) return true;
    return this.chunks.every(chunk => !this.within(chunk, point, radius) || this.loadedChunks.has(chunk.resourceId));
  }

  useComplete(navigation) {
    this.completeState.navigation = navigation;
    this.fullCollisionReady = true;
    this.loadedChunks.clear();
  }

  async complete(getPosition, signal) {
    const remaining = new Set(this.chunks.filter(chunk => !this.loadedChunks.has(chunk.resourceId)));
    while (remaining.size) {
      signal.throwIfAborted();
      const position = new THREE.Vector3(...getPosition());
      const chunk = [...remaining].sort((a, b) => a.box.distanceToPoint(position) - b.box.distanceToPoint(position))[0];
      remaining.delete(chunk);
      await this.load(chunk, 10);
    }
  }

  dispose() {
    // Individual navigation resources are released by the scene's retain list.
    this.geometry.dispose();
    this.loadedChunks.clear();
  }
}
