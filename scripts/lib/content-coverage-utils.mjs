import fs from 'node:fs/promises';
import path from 'node:path';

export const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function normaliseSlashes(value) {
  return String(value || '').replaceAll('\\', '/');
}

export function relativePath(root, file) {
  if (!file) return null;
  const relative = path.relative(root, file);
  return normaliseSlashes(relative || '.');
}

export async function exists(file) {
  if (!file) return false;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function readJsonIfExists(file) {
  if (!(await exists(file))) return null;
  return readJson(file);
}

export async function readGzipJson(file) {
  const { gunzipSync } = await import('node:zlib');
  return JSON.parse(gunzipSync(await fs.readFile(file)).toString('utf8'));
}

export async function statIfExists(file) {
  if (!(await exists(file))) return null;
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

export async function readRange(file, offset, length) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    const result = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

const MAX_GLTF_JSON_BYTES = 64 * 1024 * 1024;

/**
 * Read only the GLB header and JSON chunk. BIN/image bytes are deliberately
 * never read, keeping coverage scans bounded even for large model bundles.
 */
export async function readGlbJson(file, offset = 0, length = null) {
  const available = length == null ? Number.MAX_SAFE_INTEGER : length;
  if (available < 20) return { status: 'invalid', reason: 'short-glb-resource' };
  const header = await readRange(file, offset, Math.min(32, available));
  if (header.length < 20 || header.toString('ascii', 0, 4) !== 'glTF') {
    return { status: 'invalid', reason: 'invalid-glb-header' };
  }
  const version = header.readUInt32LE(4);
  const declaredLength = header.readUInt32LE(8);
  const jsonLength = header.readUInt32LE(12);
  const jsonType = header.toString('ascii', 16, 20);
  if (version !== 2 || jsonType !== 'JSON') {
    return { status: 'invalid', reason: 'unsupported-glb-json-chunk', version, jsonType };
  }
  if (!Number.isInteger(jsonLength) || jsonLength < 2 || jsonLength > MAX_GLTF_JSON_BYTES || jsonLength > available - 20) {
    return { status: 'invalid', reason: 'invalid-glb-json-length', jsonLength, available };
  }
  const jsonBytes = await readRange(file, offset + 20, jsonLength);
  try {
    const text = jsonBytes.toString('utf8').replace(/[\u0000\u0020]+$/g, '');
    const json = JSON.parse(text);
    return {
      status: 'parsed',
      version,
      declaredLength,
      jsonLength,
      json,
      counts: {
        materials: Array.isArray(json.materials) ? json.materials.length : 0,
        skins: Array.isArray(json.skins) ? json.skins.length : 0,
        animations: Array.isArray(json.animations) ? json.animations.length : 0,
        meshes: Array.isArray(json.meshes) ? json.meshes.length : 0,
        nodes: Array.isArray(json.nodes) ? json.nodes.length : 0,
      },
    };
  } catch (error) {
    return { status: 'invalid', reason: 'invalid-glb-json', message: error.message };
  }
}

export async function readHeader(file, offset, length = 16) {
  return readRange(file, offset, Math.min(length, 64));
}

export function audioHeaderStatus(header, metadata = {}) {
  if (!header || header.length < 4) return { status: 'unknown', reason: 'empty-header' };
  const mime = String(metadata.mime || metadata.Mime || '').toLowerCase();
  const format = String(metadata.format || metadata.Format || '').toLowerCase();
  const riff = header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
  const ogg = header.toString('ascii', 0, 4) === 'OggS';
  if (mime.includes('ogg') || format.includes('ogg')) return ogg ? { status: 'ok', codec: 'ogg' } : { status: 'invalid', reason: 'expected-ogg-header' };
  if (mime.includes('wav') || format.includes('wav') || format.includes('pcm')) return riff ? { status: 'ok', codec: 'wav' } : { status: 'invalid', reason: 'expected-wav-header' };
  if (ogg) return { status: 'ok', codec: 'ogg' };
  if (riff) return { status: 'ok', codec: 'wav' };
  return { status: 'unknown', reason: 'unrecognised-audio-header' };
}

export function sortIssues(items) {
  return [...items].sort((a, b) => {
    for (const key of ['severity', 'kind', 'map', 'resource', 'source', 'recommendation']) {
      const av = a?.[key] == null ? '' : String(a[key]);
      const bv = b?.[key] == null ? '' : String(b[key]);
      const result = av.localeCompare(bv);
      if (result) return result;
    }
    return 0;
  });
}

export function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(sortObject(value), null, 2)}\n`, 'utf8');
}
