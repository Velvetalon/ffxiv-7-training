import { createCharacterAppearanceData } from './CharacterAppearanceData.js'

export const FFXIV_CHARA_MAGIC = 0x2013ff14
export const FFXIV_CHARA_SIZE = 0xd4

function readUtf8Z(bytes, start, length) {
  const field = bytes.subarray(start, start + length)
  const end = field.indexOf(0)
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end))
}

export function parseFfxivCharaDat(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength !== FFXIV_CHARA_SIZE) {
    throw new Error(`FFXIV character DAT must be ${FFXIV_CHARA_SIZE} bytes; received ${bytes.byteLength}`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  if (magic !== FFXIV_CHARA_MAGIC) {
    throw new Error(`Invalid FFXIV character DAT magic 0x${magic.toString(16).padStart(8, '0')}`)
  }

  const data = bytes.subarray(0x10, 0x10 + 26)
  const rawMouth = data[19]
  const rawEyes = data[16]
  return createCharacterAppearanceData({
    source: {
      format: 'FFXIV_CHARA_DAT',
      formatVersion: view.getUint32(4, true),
      storedChecksum: view.getUint32(8, true),
      voiceId: bytes[0x2a],
      timestamp: view.getUint32(0x2c, true),
      description: readUtf8Z(bytes, 0x30, 164),
      rawCustomize: Array.from(data),
    },
    race: data[0],
    sex: data[1],
    ageId: data[2],
    height: data[3],
    tribe: data[4],
    face: data[5],
    hair: data[6],
    highlightsEnabled: data[7] !== 0,
    skinColor: data[8],
    rightEyeColor: data[9],
    hairColor: data[10],
    highlightColor: data[11],
    facialFeatures: data[12],
    facialFeatureColor: data[13],
    eyebrows: data[14],
    leftEyeColor: data[15],
    eyes: rawEyes & 0x7f,
    smallIris: (rawEyes & 0x80) !== 0,
    nose: data[17],
    jaw: data[18],
    mouth: rawMouth & 0x7f,
    lipColorEnabled: (rawMouth & 0x80) !== 0,
    lipColor: data[20],
    tailEarSize: data[21],
    tailEarType: data[22],
    bust: data[23],
    facePaint: data[24],
    facePaintColor: data[25],
  })
}
