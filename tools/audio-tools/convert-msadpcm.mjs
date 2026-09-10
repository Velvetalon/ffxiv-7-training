#!/usr/bin/env node
/** Convert MS-ADPCM WAV records to browser-compatible PCM16 WAV files.
 *
 * The client action SCD exports are valid MS-ADPCM, but Chromium's Web Audio
 * decodeAudioData does not accept that codec. This utility keeps the extracted
 * source file untouched and writes an explicit PCM derivative.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const adaptationTable = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const adaptationCoeff1 = [256, 512, 0, 192, 240, 460, 392];
const adaptationCoeff2 = [0, -256, 0, 64, 0, -208, -232];

const { inputs, outputs, manifestPath } = parseArgs(process.argv.slice(2));
if (!inputs.length || inputs.length !== outputs.length) {
  throw new Error('Usage: node tools/audio-tools/convert-msadpcm.mjs --input=source.wav --output=source.pcm.wav [--input=... --output=...] [--manifest=manifest.json]');
}

const manifest = manifestPath ? JSON.parse(await fs.readFile(manifestPath, 'utf8')) : null;
const manifestResources = manifest?.resources || manifest?.Resources || null;
const results = [];
for (let index = 0; index < inputs.length; index++) {
  const inputPath = path.resolve(inputs[index]);
  const outputPath = path.resolve(outputs[index]);
  const source = await fs.readFile(inputPath);
  const decoded = decodeMsAdpcm(source);
  const pcm = encodePcmWav(decoded);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, pcm);
  const hash = crypto.createHash('sha256').update(pcm).digest('hex');
  let manifestResource = null;
  if (manifestResources) {
    manifestResource = findResource(manifestResources, manifestPath, inputPath);
    if (!manifestResource) throw new Error(`No manifest resource points to ${inputPath}`);
    updateManifestResource(manifestResource, hash, pcm.length, decoded, manifestPath, outputPath);
  }
  results.push({ input: inputPath, output: outputPath, hash, bytes: pcm.length, channels: decoded.channels, sampleRate: decoded.sampleRate, duration: decoded.samples.length / decoded.channels / decoded.sampleRate, manifestResource: manifestResource?.id || null });
}
if (manifest) await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ converted: results.length, manifest: manifestPath || null, files: results }, null, 2));

function parseArgs(argv) {
  const inputs = [], outputs = [];
  let manifestPath = null;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    const equal = token.indexOf('=');
    const name = token.slice(2, equal < 0 ? undefined : equal);
    const value = equal >= 0 ? token.slice(equal + 1) : argv[++index];
    if (name === 'input') inputs.push(value);
    else if (name === 'output') outputs.push(value);
    else if (name === 'manifest') manifestPath = path.resolve(value);
    else if (name !== 'help') throw new Error(`Unknown option: ${token}`);
  }
  return { inputs, outputs, manifestPath };
}

function decodeMsAdpcm(input) {
  if (input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Input is not a RIFF/WAVE file');
  const chunks = walkRiffChunks(input);
  const fmtChunk = chunks.find(chunk => chunk.id === 'fmt ');
  const dataChunk = chunks.find(chunk => chunk.id === 'data');
  if (!fmtChunk || !dataChunk) throw new Error('WAV fmt/data chunks are missing');
  const fmt = fmtChunk.dataOffset;
  const format = input.readUInt16LE(fmt);
  const channels = input.readUInt16LE(fmt + 2);
  const sampleRate = input.readUInt32LE(fmt + 4);
  const blockAlign = input.readUInt16LE(fmt + 12);
  const bitsPerSample = input.readUInt16LE(fmt + 14);
  const data = input.subarray(dataChunk.dataOffset, dataChunk.dataOffset + dataChunk.size);
  if (format !== 2 || ![1, 2].includes(channels) || bitsPerSample !== 4 || !blockAlign || data.length < blockAlign) {
    throw new Error(`Unsupported WAV format=${format} channels=${channels} bits=${bitsPerSample} blockAlign=${blockAlign}`);
  }
  const framesPerBlock = Math.floor(((blockAlign - 7 * channels) * 2) / channels) + 2;
  const blocks = Math.floor(data.length / blockAlign);
  const samples = new Int16Array(blocks * framesPerBlock * channels);
  let frame = 0;
  for (let block = 0; block < blocks; block++) {
    let cursor = block * blockAlign;
    const states = Array.from({ length: channels }, () => ({ sample1: 0, sample2: 0, delta: 0, coeff1: 0, coeff2: 0 }));
    for (let channel = 0; channel < channels; channel++) {
      states[channel].predictor = clampPredictor(data[cursor++]);
    }
    for (const state of states) { state.delta = data.readUInt16LE(cursor); cursor += 2; }
    const first = states.map(state => { state.sample1 = data.readInt16LE(cursor); cursor += 2; return state.sample1; });
    const second = states.map(state => { state.sample2 = data.readInt16LE(cursor); cursor += 2; return state.sample2; });
    for (const state of states) { state.coeff1 = adaptationCoeff1[state.predictor]; state.coeff2 = adaptationCoeff2[state.predictor]; }
    // MS-ADPCM stores sample1/sample2 as predictor history. The PCM stream
    // emits the newer sample2 first, then sample1; FFmpeg/NAudio agree.
    writeFrame(samples, frame++, second);
    writeFrame(samples, frame++, first);
    for (let byteIndex = cursor; byteIndex < block * blockAlign + blockAlign; byteIndex++) {
      const byte = data[byteIndex];
      if (channels === 1) {
        writeFrame(samples, frame++, [expand(states[0], byte >> 4)]);
        writeFrame(samples, frame++, [expand(states[0], byte & 0x0f)]);
      } else {
        writeFrame(samples, frame++, [expand(states[0], byte >> 4), expand(states[1], byte & 0x0f)]);
      }
    }
  }
  return { channels, sampleRate, samples };
}

function walkRiffChunks(input) {
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= input.length) {
    const id = input.toString('ascii', offset, offset + 4);
    const advertisedSize = input.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    let size = advertisedSize;
    // A known Lumina MS-ADPCM export advertises a fmt chunk two bytes too
    // long. Derive its real WAVEFORMATEX payload from cbSize and nCoef so the
    // following data chunk is still walked structurally, not found by search.
    if (id === 'fmt ' && dataOffset + 22 <= input.length && input.readUInt16LE(dataOffset) === 2) {
      const cbSize = input.readUInt16LE(dataOffset + 16);
      const coefficientCount = input.readUInt16LE(dataOffset + 20);
      const expected = 18 + cbSize;
      if (coefficientCount > 0 && expected <= advertisedSize && expected <= input.length - dataOffset) size = expected;
    }
    if (dataOffset + size > input.length) throw new Error(`RIFF chunk ${id} exceeds file length`);
    chunks.push({ id, dataOffset, size, advertisedSize });
    offset = dataOffset + size + (size & 1);
  }
  return chunks;
}

function expand(state, nibble) {
  const signed = nibble & 0x08 ? nibble - 0x10 : nibble;
  const value = clamp16(Math.trunc((state.sample1 * state.coeff1 + state.sample2 * state.coeff2) / 256) + signed * state.delta);
  state.sample2 = state.sample1;
  state.sample1 = value;
  state.delta = Math.max(16, (adaptationTable[nibble] * state.delta) >> 8);
  return value;
}

function encodePcmWav({ channels, sampleRate, samples }) {
  const bytes = Buffer.alloc(44 + samples.byteLength);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + samples.byteLength, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.byteLength, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(bytes, 44);
  return bytes;
}

function findResource(resources, manifestFile, inputPath) {
  const base = path.dirname(path.resolve(manifestFile));
  const normalized = path.normalize(inputPath);
  for (const [id, resource] of Object.entries(resources)) {
    for (const key of ['source', 'url', 'assetPath', 'Path']) {
      if (typeof resource[key] !== 'string') continue;
      if (path.normalize(path.resolve(base, resource[key])) === normalized) {
        resource.id = id;
        return resource;
      }
    }
  }
  return null;
}

function updateManifestResource(resource, hash, size, decoded, manifestFile, outputPath) {
  const originalFormat = resource.metadata?.format || resource.metadata?.Format || 'MS-ADPCM WAV';
  const relative = path.relative(path.dirname(path.resolve(manifestFile)), outputPath).replaceAll('\\', '/');
  resource.hash = hash;
  resource.size = size;
  resource.source = resource.url = resource.assetPath = relative.startsWith('.') ? relative : relative;
  resource.metadata = {
    ...(resource.metadata || {}),
    mime: 'audio/wav',
    format: 'PCM16 WAV',
    sourceFormat: resource.metadata?.sourceFormat || originalFormat,
    conversion: 'MS-ADPCM WAV decoded to browser-compatible PCM16 WAV',
    channels: decoded.channels,
    sampleRate: decoded.sampleRate,
    duration: decoded.samples.length / decoded.channels / decoded.sampleRate,
  };
}

function writeFrame(samples, frame, values) {
  for (let channel = 0; channel < values.length; channel++) samples[frame * values.length + channel] = values[channel];
}
function clampPredictor(value) { return Math.max(0, Math.min(6, value)); }
function clamp16(value) { return Math.max(-32768, Math.min(32767, value)); }
