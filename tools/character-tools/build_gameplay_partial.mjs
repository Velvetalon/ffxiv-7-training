import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'public/extracted/sandbox-v2/gameplay');
const output = path.resolve(process.argv[3] || path.join(root, 'manifest.gameplay.partial.json'));
const resources = {};
const read = relative => fs.readFile(path.join(root, relative));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const add = async (relative, type, metadata) => {
  const bytes = await read(relative);
  const digest = hash(bytes);
  const id = `${type}:sha256:${digest}`;
  resources[id] = {
    type,
    hash: digest,
    size: bytes.length,
    source: relative.replaceAll('\\', '/'),
    dependencies: [],
    metadata,
  };
  return id;
};

const skills = [
  {
    key: 'whm-presence-of-mind', actionId: 136, timelineId: 419, timelineKey: 'ability/cnj_white/abl002',
    clip: 'cbbm_abl_sinsoku', state: 'skill-whm-presence-of-mind', pap: 'abl002.pap', tmb: 'abl002.tmb',
    sourcePap: 'chara/human/c0101/animation/a0001/bt_common/ability/cnj_white/abl002.pap',
    sourceTmb: 'chara/action/ability/cnj_white/abl002.tmb',
    scd: 'sound/vfx/ability/SE_VFX_Abi_shinsokuma_t.scd', sound: 'audio/presence-of-mind.pcm.wav',
    animation: 'animations/presence-of-mind.glb', delayFrames: 1,
  },
  {
    key: 'whm-assize', actionId: 3571, timelineId: 3985, timelineKey: 'ability/cnj_white/abl010',
    clip: 'cbbm_abl070', state: 'skill-whm-assize', pap: 'abl010.pap', tmb: 'abl010.tmb',
    sourcePap: 'chara/human/c0101/animation/a0001/bt_common/ability/cnj_white/abl010.pap',
    sourceTmb: 'chara/action/ability/cnj_white/abl010.tmb',
    scd: 'sound/vfx/ability/SE_VFX_Abi_Whm_PBAEDDHeal_c.scd', sound: 'audio/assize.pcm.wav', animation: 'animations/assize.glb', delayFrames: 0,
  },
  {
    key: 'whm-temperance', actionId: 16536, timelineId: 7128, timelineKey: 'ability/cnj_white/abl017',
    clip: 'cbbm_abl236', state: 'skill-whm-temperance', pap: 'abl017.pap', tmb: 'abl017.tmb',
    sourcePap: 'chara/human/c0101/animation/a0001/bt_common/ability/cnj_white/abl017.pap',
    sourceTmb: 'chara/action/ability/cnj_white/abl017.tmb',
    scd: 'sound/vfx/ability/SE_VFX_Abi_Whm_Angelaura_c.scd', sound: 'audio/temperance.pcm.wav', animation: 'animations/temperance.glb', delayFrames: 0,
  },
];

const skillPresentations = {};
const characterAnimations = {};
for (const skill of skills) {
  const animationId = await add(skill.animation, 'glb', {
    kind: 'skill-animation', clip: skill.clip, actionId: skill.actionId, actionTimelineId: skill.timelineId,
    actionTimelineKey: skill.timelineKey, sourcePap: skill.sourcePap, sourceTmb: skill.sourceTmb,
    modelFamily: 'c0801', sourceSkeleton: 'c0101 shared human base skeleton; bound by bone name',
  });
  const soundId = await add(skill.sound, 'audio', {
    mime: 'audio/wav', format: 'PCM16 WAV', sourceFormat: 'MS-ADPCM WAV', conversion: 'MS-ADPCM WAV decoded to browser-compatible PCM16 WAV',
    sourceScd: skill.scd, soundIndex: 0, audioIndex: 0, delayFrames: skill.delayFrames,
  });
  characterAnimations[skill.state] = animationId;
  skillPresentations[skill.key] = {
    skillId: skill.actionId,
    animationId,
    animationState: skill.state,
    soundId,
    soundEvents: [{ role: 'caster', resourceId: soundId, delayFrames: skill.delayFrames, delaySeconds: skill.delayFrames / 30, soundPositionFlags: 1, bindId: 0 }],
    provenance: `Action[${skill.actionId}] -> ActionTimeline[${skill.timelineId}] ${skill.timelineKey} -> ${skill.sourceTmb} C010 ${skill.clip} + C063 ${skill.scd}`,
    sourcePap: skill.sourcePap,
    sourceTmb: skill.sourceTmb,
    sourceScd: skill.scd,
  };
}

const jump = [
  ['jump-start', 'jump-start.glb', 'cbnm_jump_1', 4],
  ['jump-airborne', 'jump-airborne.glb', 'cbnm_jump_2', 5],
  ['jump-land', 'jump-land.glb', 'cbnm_jump_3', 6],
];
const jumpAnimations = {};
for (const [state, file, clip, papIndex] of jump) {
  jumpAnimations[state] = await add(`animations/${file}`, 'glb', {
    kind: 'jump-animation', clip, pap: 'move_a.pap', papAnimationIndex: papIndex,
    sourcePap: 'chara/human/c0801/animation/a0001/bt_common/resident/move_a.pap',
    sourceSkeleton: 'c0801 direct skeleton', modelFamily: 'c0801',
  });
}

const manifest = {
  schemaVersion: 1,
  source: {
    kind: 'gameplay-animation-sfx-partial',
    extractor: 'CharacterTools raw + extract_pap.py + spline_probe_select + build_animation_glb.py + action_sfx.py + ScdExtract + convert-msadpcm.mjs',
    note: 'Additive gameplay resources only; no character model or final packed manifest is overwritten.',
  },
  resources,
  characters: {
    'ffxiv-chara-40': {
      id: 'ffxiv-chara-40',
      animations: { ...characterAnimations, ...jumpAnimations },
    },
  },
  skillPresentations,
  jump: {
    states: jumpAnimations,
    sourcePap: 'chara/human/c0801/animation/a0001/bt_common/resident/move_a.pap',
    clips: ['cbnm_jump_1', 'cbnm_jump_2', 'cbnm_jump_3'],
  },
};
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, resources: Object.keys(resources).length, skills: Object.keys(skillPresentations).length, jumpStates: Object.keys(jumpAnimations).length }));
