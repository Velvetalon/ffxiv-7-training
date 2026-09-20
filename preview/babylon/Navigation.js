import { Ray } from '@babylonjs/core/Culling/ray.js';
import { Octree } from '@babylonjs/core/Culling/Octrees/octree.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { decompressGzip } from '../../src/assets/Decompress.js';

const DOWN = new Vector3(0, -1, 0);
const EPSILON = 1e-5;
const STREAM_TRIANGLE_BUDGET = 160000;
const STREAM_PIN_RADIUS = 128;

export function createFallbackNavigation(point, radius = 192) {
  const source = Array.isArray(point)
    ? { x: Number(point[0]) || 0, y: Number(point[1]) || 0, z: Number(point[2]) || 0 }
    : { x: Number(point?.x) || 0, y: Number(point?.y) || 0, z: Number(point?.z) || 0 };
  const extent = Math.max(16, Number(radius) || 192);
  const y = source.y;
  const positions = new Float32Array([
    source.x - extent, y, source.z - extent,
    source.x + extent, y, source.z - extent,
    source.x + extent, y, source.z + extent,
    source.x - extent, y, source.z - extent,
    source.x + extent, y, source.z + extent,
    source.x - extent, y, source.z + extent,
  ]);
  const navigation = new Navigation(positions);
  navigation.fallback = true;
  return navigation;
}

function byteView(value) {
  const source = value?.bytes ?? value;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new TypeError('Collision resource must be an ArrayBuffer or typed array');
}

function intersectsBlock(triangle, block) {
  return triangle.min.x <= block.maxPoint.x && triangle.max.x >= block.minPoint.x
    && triangle.min.y <= block.maxPoint.y && triangle.max.y >= block.minPoint.y
    && triangle.min.z <= block.maxPoint.z && triangle.max.z >= block.minPoint.z;
}

function octreeEntries(selection) {
  if (!selection) return [];
  if (Array.isArray(selection)) return selection;
  return selection.data?.slice(0, selection.length) || [];
}

async function collisionFloats(assets) {
  const legacy = assets?.legacy || assets?.map?.legacyManifest;
  const resourceId = assets?.map?.paths?.[legacy?.collisionFile];
  if (!legacy || !resourceId) throw new Error(`Collision resource is unavailable for ${assets?.mapId || 'map'}`);
  const compressed = byteView(await assets.load(resourceId, { priority: 0 }));
  let bytes = compressed;
  if (legacy.collisionEncoding === 'gzip') {
    const gzip = compressed[0] === 0x1f && compressed[1] === 0x8b;
    if (gzip) bytes = new Uint8Array(await decompressGzip(compressed));
  }
  if (bytes.byteLength % 36 !== 0) throw new Error('Collision resource length is not a triangle array');
  if (legacy.collisionBytes && bytes.byteLength !== legacy.collisionBytes) {
    throw new Error(`Collision resource length mismatch: ${bytes.byteLength} != ${legacy.collisionBytes}`);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

async function resourceFloats(assets, resourceId, expectedTriangles = null, priority = 0) {
  let bytes = byteView(await assets.load(resourceId, { priority }));
  const metadata = assets.runtime.registry.get(resourceId).metadata || {};
  if (metadata.encoding === 'gzip') bytes = new Uint8Array(await decompressGzip(bytes));
  if (bytes.byteLength % 36 !== 0) throw new Error(`Collision chunk ${resourceId} is not a triangle array`);
  if (metadata.rawBytes && bytes.byteLength !== metadata.rawBytes) throw new Error(`Collision chunk ${resourceId} decoded byte count mismatch`);
  if (expectedTriangles && bytes.byteLength !== expectedTriangles * 36) {
    throw new Error(`Collision chunk ${resourceId} length mismatch`);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function boxDistanceSquared(bounds, point) {
  const dx = point.x < bounds.min.x ? bounds.min.x - point.x : point.x > bounds.max.x ? point.x - bounds.max.x : 0;
  const dy = point.y < bounds.min.y ? bounds.min.y - point.y : point.y > bounds.max.y ? point.y - bounds.max.y : 0;
  const dz = point.z < bounds.min.z ? bounds.min.z - point.z : point.z > bounds.max.z ? point.z - bounds.max.z : 0;
  return dx * dx + dy * dy + dz * dz;
}

export class Navigation {
  static async load(assets, initialPoint = null) {
    if (assets?.map?.collisionChunks?.length) {
      const streaming = new StreamingNavigation(assets);
      const training = initialPoint || assets.legacy?.training?.spawn || assets.map?.spawn?.point;
      if (training) await streaming.ensure(training, 96, -10);
      return streaming;
    }
    return new Navigation(await collisionFloats(assets));
  }

  constructor(positions) {
    if (!positions || positions.length % 9 !== 0) throw new Error('Navigation requires unindexed triangle positions');
    this.height = 0;
    this.ray = new Ray(Vector3.Zero(), DOWN.clone(), 1);
    this.triangles = [];
    const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    for (let index = 0; index < positions.length; index += 9) {
      const a = new Vector3(positions[index], positions[index + 1], positions[index + 2]);
      const b = new Vector3(positions[index + 3], positions[index + 4], positions[index + 5]);
      const c = new Vector3(positions[index + 6], positions[index + 7], positions[index + 8]);
      const min = Vector3.Minimize(a, Vector3.Minimize(b, c));
      const max = Vector3.Maximize(a, Vector3.Maximize(b, c));
      const normal = Vector3.Cross(b.subtract(a), c.subtract(a));
      if (normal.lengthSquared() <= EPSILON) continue;
      normal.normalize();
      this.triangles.push({ a, b, c, min, max, normal });
      minimum.minimizeInPlace(min);
      maximum.maximizeInPlace(max);
    }
    if (!this.triangles.length) throw new Error('Collision resource contains no usable triangles');
    this.bounds = {
      min: minimum,
      max: maximum,
      getSize: target => (target || new Vector3()).copyFrom(maximum).subtractInPlace(minimum),
    };
    this.octree = new Octree((triangle, block) => {
      if (intersectsBlock(triangle, block)) block.entries.push(triangle);
    }, 128, 4);
    this.octree.update(minimum, maximum, this.triangles);
  }

  raycast(origin, direction, length, predicate = null) {
    const distance = Math.max(0, Number(length) || 0);
    if (!distance || direction.lengthSquared() <= EPSILON) return null;
    this.ray.origin.copyFrom(origin);
    this.ray.direction.copyFrom(direction).normalize();
    this.ray.length = distance;
    let nearest = null;
    for (const triangle of octreeEntries(this.octree.intersectsRay(this.ray))) {
      if (predicate && !predicate(triangle)) continue;
      const hit = this.ray.intersectsTriangle(triangle.a, triangle.b, triangle.c);
      if (!hit || hit.distance < 0.001 || hit.distance > distance) continue;
      if (!nearest || hit.distance < nearest.distance) {
        nearest = {
          distance: hit.distance,
          point: origin.add(this.ray.direction.scale(hit.distance)),
          normal: triangle.normal,
          triangle,
        };
      }
    }
    return nearest;
  }

  surfaceAt(x, z, currentHeight = this.height, reach = 1.1) {
    const origin = new Vector3(x, currentHeight + reach, z);
    const hit = this.raycast(origin, DOWN, reach + 4, triangle => Math.abs(triangle.normal.y) > 0.52);
    return hit ? { height: hit.point.y, id: 'client-collision', normal: hit.normal } : null;
  }

  isWalkable(x, z) {
    return Boolean(this.surfaceAt(x, z));
  }

  nearestWalkable(x, z, maxDistance = 25, elevation = this.height) {
    let surface = this.surfaceAt(x, z, elevation, 5);
    if (surface) return { x, y: surface.height, z };
    for (let radius = 0.75; radius <= maxDistance; radius += 0.75) {
      for (let step = 0; step < 16; step += 1) {
        const angle = step * Math.PI / 8;
        const px = x + Math.cos(angle) * radius;
        const pz = z + Math.sin(angle) * radius;
        surface = this.surfaceAt(px, pz, elevation, 5);
        if (surface) return { x: px, y: surface.height, z: pz };
      }
    }
    return null;
  }

  clearSegment(position, x, z) {
    const direction = new Vector3(x - position.x, 0, z - position.z);
    const length = direction.length();
    if (!length) return true;
    direction.scaleInPlace(1 / length);
    for (const height of [0.6, 1.4]) {
      const origin = new Vector3(position.x, position.y + height, position.z);
      const hit = this.raycast(origin, direction, length + 0.22, triangle => Math.abs(triangle.normal.y) < 0.65);
      if (hit && hit.distance >= 0.02) return false;
    }
    return true;
  }

  move(position, dx, dz) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.25));
    for (let index = 0; index < steps; index += 1) {
      const x = position.x + dx / steps;
      const z = position.z + dz / steps;
      let floor = this.surfaceAt(x, z, position.y);
      if (floor && this.clearSegment(position, x, z)) position.set(x, floor.height, z);
      else {
        floor = this.surfaceAt(x, position.z, position.y);
        if (floor && this.clearSegment(position, x, position.z)) position.set(x, floor.height, position.z);
        else {
          floor = this.surfaceAt(position.x, z, position.y);
          if (floor && this.clearSegment(position, position.x, z)) position.set(position.x, floor.height, z);
          else break;
        }
      }
    }
    this.height = position.y;
  }

  cameraHit(origin, destination) {
    const direction = destination.subtract(origin);
    const distance = direction.length();
    return this.raycast(origin, direction, distance);
  }

  diagnostics() {
    return {
      implementation: 'babylon-ray-octree',
      triangleCount: this.triangles.length,
      octreeBlocks: this.octree.blocks.length,
      bounds: { min: this.bounds.min.asArray(), max: this.bounds.max.asArray() },
    };
  }

  dispose() {
    this.triangles.length = 0;
    this.octree.blocks.length = 0;
    this.octree.dynamicContent.length = 0;
  }
}

export class StreamingNavigation extends Navigation {
  constructor(assets) {
    super(new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 0, 1,
    ]));
    this.assets = assets;
    this.triangles.length = 0;
    this.octree.blocks.length = 0;
    this.chunks = assets.map.collisionChunks.map(chunk => ({
      ...chunk,
      bounds: {
        min: Vector3.FromArray(chunk.bounds.min),
        max: Vector3.FromArray(chunk.bounds.max),
      },
    }));
    const sourceBounds = assets.map.collisionBounds;
    this.bounds = {
      min: Vector3.FromArray(sourceBounds.min),
      max: Vector3.FromArray(sourceBounds.max),
      getSize: target => (target || new Vector3()).copyFromFloats(
        sourceBounds.max[0] - sourceBounds.min[0],
        sourceBounds.max[1] - sourceBounds.min[1],
        sourceBounds.max[2] - sourceBounds.min[2],
      ),
    };
    this.loadedChunks = new Map();
    this.pendingChunks = new Map();
    this.fullCollisionReady = false;
    this.disposed = false;
    this.streaming = true;
    this.tick = 0;
    this.activePoint = Vector3.Zero();
    this.triangleBudget = STREAM_TRIANGLE_BUDGET;
  }

  within(chunk, point, radius) {
    const source = Array.isArray(point)
      ? { x: point[0], y: point[1], z: point[2] }
      : point;
    const { min, max } = chunk.bounds;
    return min.x <= source.x + radius && max.x >= source.x - radius
      && min.z <= source.z + radius && max.z >= source.z - radius;
  }

  async ensure(point, radius = 96, priority = -10) {
    if (this.disposed) throw new DOMException('Navigation disposed', 'AbortError');
    const source = Array.isArray(point) ? Vector3.FromArray(point) : point;
    this.activePoint.copyFrom(source);
    const needed = this.chunks
      .filter(chunk => this.within(chunk, source, radius))
      .sort((left, right) => boxDistanceSquared(left.bounds, source) - boxDistanceSquared(right.bounds, source));
    let cursor = 0;
    const worker = async () => {
      while (cursor < needed.length) await this.loadChunk(needed[cursor++], priority);
    };
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, needed.length)) }, worker));
    this.evictDistant(source, Math.max(STREAM_PIN_RADIUS, radius));
  }

  async loadChunk(chunk, priority = 0) {
    if (this.disposed) throw new DOMException('Navigation disposed', 'AbortError');
    if (this.loadedChunks.has(chunk.resourceId)) return this.loadedChunks.get(chunk.resourceId);
    if (!this.pendingChunks.has(chunk.resourceId)) {
      const pending = resourceFloats(this.assets, chunk.resourceId, chunk.triangles, priority)
        .then(positions => {
          const navigation = new Navigation(positions);
          if (this.disposed) {
            navigation.dispose();
            throw new DOMException('Navigation disposed', 'AbortError');
          }
          this.loadedChunks.set(chunk.resourceId, { chunk, navigation, lastUsed: ++this.tick });
          return navigation;
        })
        .finally(() => this.pendingChunks.delete(chunk.resourceId));
      this.pendingChunks.set(chunk.resourceId, pending);
    }
    return this.pendingChunks.get(chunk.resourceId);
  }

  isReady(point, radius = 24) {
    if (this.fullCollisionReady) return true;
    return this.chunks.every(chunk => !this.within(chunk, point, radius) || this.loadedChunks.has(chunk.resourceId));
  }

  complete() {
    // Full source coverage remains addressable through ensure(); retaining every
    // large-map octree at once would exceed the browser memory budget.
    return Promise.resolve(this.diagnostics());
  }

  evictDistant(point = this.activePoint, pinRadius = STREAM_PIN_RADIUS) {
    let triangles = [...this.loadedChunks.values()].reduce((sum, entry) => sum + entry.navigation.triangles.length, 0);
    if (triangles <= this.triangleBudget) return;
    const candidates = [...this.loadedChunks.entries()]
      .filter(([, entry]) => !this.within(entry.chunk, point, pinRadius))
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [resourceId, entry] of candidates) {
      if (triangles <= this.triangleBudget) break;
      triangles -= entry.navigation.triangles.length;
      entry.navigation.dispose();
      this.loadedChunks.delete(resourceId);
    }
  }

  raycast(origin, direction, length, predicate = null) {
    let nearest = null;
    for (const entry of this.loadedChunks.values()) {
      const { chunk, navigation } = entry;
      const probe = new Ray(origin, direction.normalizeToNew(), length);
      const intersects = probe.intersectsBoxMinMax(chunk.bounds.min, chunk.bounds.max);
      if (!intersects) continue;
      const hit = navigation.raycast(origin, direction, nearest?.distance ?? length, predicate);
      if (hit) entry.lastUsed = ++this.tick;
      if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
    }
    return nearest;
  }

  diagnostics() {
    return {
      implementation: 'babylon-streaming-ray-octree',
      chunkCount: this.chunks.length,
      loadedChunks: this.loadedChunks.size,
      totalChunks: this.chunks.length,
      pendingChunks: this.pendingChunks.size,
      fullCollisionReady: this.fullCollisionReady,
      triangleCount: [...this.loadedChunks.values()].reduce((sum, value) => sum + value.navigation.triangles.length, 0),
      triangleBudget: this.triangleBudget,
      residencyPolicy: 'near-player-lru-reloadable',
      fullSourceCoverage: true,
      bounds: { min: this.bounds.min.asArray(), max: this.bounds.max.asArray() },
    };
  }

  dispose() {
    this.disposed = true;
    for (const { navigation } of this.loadedChunks.values()) navigation.dispose();
    this.loadedChunks.clear();
    this.pendingChunks.clear();
    this.fullCollisionReady = false;
  }
}

export default Navigation;
