#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UNIQUE_BASE = 0x4800 / 4;
const UNIQUE_STRIDE = 0x1400 / 4;
const UNIQUE_PALETTE_STRIDE = 0x400 / 4;
const SHARED_PALETTE_STRIDE = 0x400 / 4;

function readQuat(cmp, index) {
  return [
    cmp[index * 4] / 255,
    cmp[index * 4 + 1] / 255,
    cmp[index * 4 + 2] / 255,
    cmp[index * 4 + 3] / 255,
  ];
}

export function resolveDatPalette({ datBytes, cmpBytes, sourceDescription = '' } = {}) {
  if (datBytes?.byteLength !== 212) throw new Error('DAT must be 212 bytes');
  const view = new DataView(datBytes.buffer, datBytes.byteOffset, datBytes.byteLength);
  if (view.getUint32(0, true) !== 0x2013ff14) throw new Error('DAT magic mismatch');
  const customize = datBytes.subarray(0x10, 0x10 + 26);
  const sex = customize[1];
  const tribe = customize[4];
  const paletteIndex = {
    skin: customize[8],
    hair: customize[10],
    highlight: customize[11],
    rightEye: customize[9],
    leftEye: customize[15],
    lip: customize[20],
    facePaint: customize[25],
  };
  const tribeSex = (tribe - 1) * 2 + sex;
  const unique = (palette, option) =>
    readQuat(cmpBytes, UNIQUE_BASE + tribeSex * UNIQUE_STRIDE + palette * UNIQUE_PALETTE_STRIDE + option);
  const shared = (palette, option) => readQuat(cmpBytes, palette * SHARED_PALETTE_STRIDE + option);
  const values = {
    skin: unique(3, paletteIndex.skin),
    hair: unique(4, paletteIndex.hair),
    highlight: shared(1, paletteIndex.highlight),
    rightEye: shared(0, paletteIndex.rightEye),
    leftEye: shared(0, paletteIndex.leftEye),
    lip: shared(13, paletteIndex.lip),
    facePaint: shared(13, paletteIndex.facePaint),
  };
  const cmpSha256 = crypto.createHash('sha256').update(cmpBytes).digest('hex');
  const datSha256 = crypto.createHash('sha256').update(datBytes).digest('hex');
  return {
    schemaVersion: 1,
    source: {
      datSha256,
      cmpSha256,
      description: sourceDescription,
      layoutAuthority: 'tools/character-tools/Program.cs appearance-colors',
    },
    customize: Array.from(customize),
    paletteIndex,
    palette: values,
  };
}

export function main() {
  const [datPath, cmpPath, outputPath] = process.argv.slice(2);
  if (!datPath || !cmpPath || !outputPath) {
    console.error('Usage: resolve_dat_palette.mjs <FFXIV_CHARA_40.dat> <human.cmp> <output.json>');
    process.exitCode = 2;
    return;
  }
  const datBytes = new Uint8Array(fs.readFileSync(datPath));
  const cmpBytes = new Uint8Array(fs.readFileSync(cmpPath));
  const resolved = resolveDatPalette({ datBytes, cmpBytes });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(resolved, null, 2) + '\n');
  console.log(JSON.stringify({ output: outputPath, palettes: Object.keys(resolved.palette) }));
}
