import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { MeshNavigation } from '../../src/world/imported/MeshNavigation.js';
import { StreamingNavigation } from '../../src/world/imported/StreamingNavigation.js';

const root = process.cwd();
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const releaseRoot = path.resolve(root, option('dir') || 'work/asset-performance/packed-all-locality');
const patchPath = path.resolve(root, option('chunks') || 'work/collision-analysis-tiled/x6f2/collision-chunks.json');
const checks = Number(option('checks') || 500);
if (!Number.isInteger(checks) || checks < 1) throw new Error('--checks must be a positive integer');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
async function readSlice(file, offset, length) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error(`Short read ${bytesRead}/${length}`);
    return buffer;
  } finally { await handle.close(); }
}
const rng = (() => { let state = 0x6d2b79f5; return () => { state |= 0; state = state + 0x6d2b79f5 | 0; let value = Math.imul(state ^ state >>> 15, 1 | state); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; })();
const close = (left, right, epsilon = 1e-4) => left === null && right === null || left !== null && right !== null && Math.abs(left - right) <= epsilon;

const patch = await readJson(patchPath);
const manifest = await readJson(path.join(releaseRoot, patch.source.manifest));
const legacy = manifest.resources[patch.source.legacyCollisionResourceId];
const legacyPack = manifest.bundles[legacy.bundle];
const legacyCompressed = await readSlice(path.join(releaseRoot, legacyPack.url), legacy.offset, legacy.length);
if (sha256(legacyCompressed) !== legacy.hash) throw new Error('Legacy collision SHA mismatch');
const legacyRaw = zlib.gunzipSync(legacyCompressed);
const legacyNavigation = new MeshNavigation(new Float32Array(legacyRaw.buffer, legacyRaw.byteOffset, legacyRaw.length / 4));

const chunkNavigations = new Map();
for (const chunk of patch.mapPatch.collisionChunks) {
  const resource = patch.resources[chunk.resourceId];
  const bundle = patch.bundles[resource.bundle];
  const compressed = await readSlice(path.join(path.dirname(patchPath), bundle.url), resource.offset, resource.length);
  if (sha256(compressed) !== resource.hash) throw new Error(`Chunk SHA mismatch ${chunk.resourceId}`);
  const raw = zlib.gunzipSync(compressed);
  if (raw.length !== resource.metadata.rawBytes) throw new Error(`Chunk raw byte mismatch ${chunk.resourceId}`);
  chunkNavigations.set(chunk.resourceId, new MeshNavigation(new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)));
}
const streaming = new StreamingNavigation(patch.mapPatch.collisionBounds, patch.mapPatch.collisionChunks, async chunk => chunkNavigations.get(chunk.resourceId));
// Exercise the public lifecycle rather than passing raw manifest records to the
// internal loader: the constructor adds the Box3 used by the BVH broad phase.
await streaming.complete(() => patch.bootstrap.point, { throwIfAborted() {} });

const bounds = patch.mapPatch.collisionBounds;
const randomPoint = () => new THREE.Vector3(
  bounds.min[0] + rng() * (bounds.max[0] - bounds.min[0]),
  bounds.min[1] + rng() * (bounds.max[1] - bounds.min[1]),
  bounds.min[2] + rng() * (bounds.max[2] - bounds.min[2]),
);
const results = { raycast: { checks: 0, mismatches: 0 }, ground: { checks: 0, mismatches: 0 }, cameraBoundary: { checks: 0, mismatches: 0 } };
for (let index = 0; index < checks; index++) {
  const origin = randomPoint();
  const destination = randomPoint();
  const direction = destination.clone().sub(origin);
  const distance = direction.length();
  if (distance) {
    const ray = new THREE.Ray(origin, direction.normalize());
    const full = legacyNavigation.bvh.raycastFirst(ray, THREE.DoubleSide, 0, distance);
    const chunked = streaming.bvh.raycastFirst(ray, THREE.DoubleSide, 0, distance);
    results.raycast.checks++;
    if (!close(full?.distance ?? null, chunked?.distance ?? null)) results.raycast.mismatches++;
  }
  const triangle = Math.floor(rng() * (legacyRaw.length / 36));
  const floats = new Float32Array(legacyRaw.buffer, legacyRaw.byteOffset + triangle * 36, 9);
  const x = (floats[0] + floats[3] + floats[6]) / 3;
  const z = (floats[2] + floats[5] + floats[8]) / 3;
  const height = Math.max(floats[1], floats[4], floats[7]) + 1;
  const fullGround = legacyNavigation.surfaceAt(x, z, height);
  const chunkGround = streaming.surfaceAt(x, z, height);
  results.ground.checks++;
  if (!close(fullGround?.height ?? null, chunkGround?.height ?? null)) results.ground.mismatches++;

  // Exact cell boundaries are the awkward case for the spatial index: rays travel
  // down through a randomly selected XZ boundary, where either neighbouring chunk
  // may own the centroid-assigned triangle.
  const chunk = patch.mapPatch.collisionChunks[Math.floor(rng() * patch.mapPatch.collisionChunks.length)];
  const edgeX = rng() < .5 ? chunk.bounds.min[0] : chunk.bounds.max[0];
  const edgeZ = rng() < .5 ? chunk.bounds.min[2] : chunk.bounds.max[2];
  const cameraOrigin = new THREE.Vector3(edgeX, bounds.max[1] + 20, edgeZ);
  const cameraDestination = new THREE.Vector3(edgeX, bounds.min[1] - 20, edgeZ);
  const fullCamera = legacyNavigation.cameraHit(cameraOrigin, cameraDestination);
  const chunkCamera = streaming.cameraHit(cameraOrigin, cameraDestination);
  results.cameraBoundary.checks++;
  if (!close(fullCamera?.distance ?? null, chunkCamera?.distance ?? null)) results.cameraBoundary.mismatches++;
}
const mismatches = Object.values(results).reduce((sum, result) => sum + result.mismatches, 0);
const report = { schemaVersion: 1, checks, chunks: patch.mapPatch.collisionChunks.length, results, passed: mismatches === 0 };
await fs.writeFile(path.join(path.dirname(patchPath), 'parity-report.json'), `${JSON.stringify(report, null, 2)}\n`);
streaming.dispose();
legacyNavigation.dispose();
for (const navigation of chunkNavigations.values()) navigation.dispose();
console.log(JSON.stringify(report, null, 2));
if (mismatches) process.exitCode = 1;
