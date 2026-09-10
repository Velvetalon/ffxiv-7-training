export const CharacterRace = Object.freeze({
  1: 'hyur',
  2: 'elezen',
  3: 'lalafell',
  4: 'miqote',
  5: 'roegadyn',
  6: 'aura',
  7: 'hrothgar',
  8: 'viera',
})

export const CharacterTribe = Object.freeze({
  1: 'midlander',
  2: 'highlander',
  3: 'wildwood',
  4: 'duskwight',
  5: 'plainsfolk',
  6: 'dunesfolk',
  7: 'seekerOfTheSun',
  8: 'keeperOfTheMoon',
  9: 'seaWolf',
  10: 'hellsguard',
  11: 'raen',
  12: 'xaela',
  13: 'helions',
  14: 'theLost',
  15: 'rava',
  16: 'veena',
})

export const CharacterSex = Object.freeze({
  0: 'masculine',
  1: 'feminine',
})

const HUMAN_MODEL_FAMILIES = Object.freeze({
  '1:1:0': 'c0101',
  '1:1:1': 'c0201',
  '1:2:0': 'c0301',
  '1:2:1': 'c0401',
  '2:3:0': 'c0501',
  '2:3:1': 'c0601',
  '2:4:0': 'c0501',
  '2:4:1': 'c0601',
  '3:5:0': 'c1101',
  '3:5:1': 'c1201',
  '3:6:0': 'c1101',
  '3:6:1': 'c1201',
  '4:7:0': 'c0701',
  '4:7:1': 'c0801',
  '4:8:0': 'c0701',
  '4:8:1': 'c0801',
  '5:9:0': 'c0901',
  '5:9:1': 'c1001',
  '5:10:0': 'c0901',
  '5:10:1': 'c1001',
  '6:11:0': 'c1301',
  '6:11:1': 'c1401',
  '6:12:0': 'c1301',
  '6:12:1': 'c1401',
  '7:13:0': 'c1501',
  '7:13:1': 'c1801',
  '7:14:0': 'c1501',
  '7:14:1': 'c1801',
  '8:15:0': 'c1701',
  '8:15:1': 'c1601',
  '8:16:0': 'c1701',
  '8:16:1': 'c1601',
})

export function resolveHumanModelFamily(appearance) {
  return HUMAN_MODEL_FAMILIES[`${appearance.race}:${appearance.tribe}:${appearance.sex}`] ?? null
}

export function createCharacterAppearanceData(values) {
  const appearance = {
    schemaVersion: 1,
    ...values,
  }
  appearance.raceName = CharacterRace[appearance.race] ?? 'unknown'
  appearance.tribeName = CharacterTribe[appearance.tribe] ?? 'unknown'
  appearance.sexName = CharacterSex[appearance.sex] ?? 'unknown'
  appearance.modelFamily = resolveHumanModelFamily(appearance)
  return appearance
}
