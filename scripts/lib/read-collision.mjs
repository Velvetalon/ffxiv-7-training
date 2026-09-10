import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function readCollision(root, manifest) {
  const stored = fs.readFileSync(path.join(root, manifest.collisionFile || 'collision.bin'));
  const bytes = manifest.collisionEncoding === 'gzip' ? gunzipSync(stored) : stored;
  if (bytes.length % 36 !== 0 || (manifest.collisionBytes && bytes.length !== manifest.collisionBytes)) {
    throw new Error(`${manifest.scene}: collision length does not match manifest`);
  }
  if (manifest.collisionSha256 && createHash('sha256').update(bytes).digest('hex') !== manifest.collisionSha256) {
    throw new Error(`${manifest.scene}: lossless collision checksum mismatch`);
  }
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
