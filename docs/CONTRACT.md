# Integration Contract

Original offline, level-100, patch-7.0-inspired FFXIV rotation trainer.
All public interfaces use seconds, world distances use yalms, potency (not gear damage).
Use Chinese display labels and English IDs. No React, pure ES modules.

## Combat owner

Owns `src/combat/**`, `scripts/verify.mjs`, `docs/RULES.md`.
Exports from `src/combat/index.js`:

```js
export const JOBS = [
  { id: 'WHM', name: '白魔法师', en: 'WHITE MAGE', role: '治疗职业', color: '#e8e0cf',
    description: '...', resources: [{ key:'lily', name:'治愈百合', max:3, color:'#...' }] }
];
export function createCombat(jobId = 'WHM') { return engine; }
```

Engine methods:
- `setJob(jobId)` resets encounter, returns void.
- `reset()` clears combat, cooldowns, buffs, resources to standard pre-pull defaults.
- `tick(dt, context)` dt seconds; context `{moving:false, distance:8, positional:'rear', target:true, targets:1}`. No three.js dependencies.
- `use(actionId, context)` returns `{ok:boolean, reason?:string}`. Use current context to check range/movement/target. Real skills need reasonable range and target validation.
- `getState()` returns snapshot `{jobId,time,inCombat,gcd,gcdTotal,cast:null|{id,name,remaining,total},animationLock,mp,hp,resources:{key:number},buffs:[{id,name,remaining,stacks}],target:{dot:[]},stats:{potency,gcdCount,ogcdCount,elapsed,pps},log:[{time,name,potency,kind}],combo,queue?}`.
- `getActions()` returns currently available full level100 job+role skill roster including transformed actions `{id,name,en?,icon,kind:'spell'|'weaponskill'|'ability',gcd:boolean,cast:number,recast:number,range:number,potency:number,description:string,color?:string,cooldown:number,charges?:number,maxCharges?:number,enabled:boolean,reason?:string,highlight?:boolean,slot?:number}`. `icon` is a lucide icon name (e.g. 'sparkles', 'sword', 'flame', 'heart', 'palette'), NEVER filesystem path.
- `drainEvents()` returns and clears events `[{type:'hit'|'cast'|'heal'|'buff'|'error',actionId,name,potency,color?,jobId}]` for world effects. `hit` means successful combat action, buffs and healing may also animate.

Additional integration contracts implemented during verification:
- `receiveDamage(amount, context?)` applies incoming damage through job hooks and shields, supporting optional non-lethal healing practice outside the engine.
- State includes `maxHp` and `movementMultiplier`.
- `move` events carry `{kind:'forward'|'backward'|'return',distance,saveReturn?}`.
- `field` events carry `{id,radius,duration,color}`; the world places the field at the player and exposes containing field IDs through `context.fields`.

The first 24 job actions should give useful hotbar order with offensive rotations first. Remaining skills accessible on additional hotbars. Action `description` documents 7.0 costs/requirements. Model mutable transformed slots by stable ID if possible. UI invokes currently displayed action ID, no UI rotation logic.
Buff stacks/lifetimes, oGCD/GCD, cast interruption, mana regen, cooldown charges, DoTs, positional, resources, multi-hit combo, AoE target context, no-target prep, queue must be simulated. Exact patch deviations must be written clearly, not hidden.

## Scene owner

Owns `src/world/**`. Imports `three` and `three/addons/...` freely.
Exports from `src/world/index.js`:

```js
export const SCENES = [
  {id:'gridania',name:'格里达尼亚新街',en:'NEW GRIDANIA',region:'黑衣森林',description:'...',accent:'#b7d794'},
  {id:'limsa',name:'利姆萨·罗敏萨下层甲板',en:'LIMSA LOMINSA',region:'拉诺西亚',description:'...',accent:'#79cbd4'}
];
export class World {
 constructor(canvas, {onTarget, onInteract, onMove}={}) {}
 setScene(id) {} // valid registered scene ID; resets spawn and entities
 setJob(id) {} // WHM/PCT/RPR character weapon/theme
 update(dt) {} // main loop externally owned
 resize(width,height) {}
 getContext() {} // {moving,distance,positional,target,targets}
 getInfo() {} // {position:{x,z},sceneId,target:{id,name,hp,level}|null,entities:[{id,name,type,x,z}],cameraAngle}
 targetNearest() {} // targets dummy; calls onTarget
 clearTarget() {}
 setInputEnabled(boolean) {} // disable move controls during modal
 setQuality('low'|'high') {}
 setCameraMode('orbit'|'follow') {} // optional
 effect(event) {} // plays VFX for combat drainEvents
 moveToDummy() {} // convenient reset to combat range
 moveSkill({kind,distance,saveReturn,gateDuration}) {}
 setMovementSpeed(multiplier) {}
 clearFields() {}
 clearReturnGate() {}
 dispose() {}
}
```

Input WASD movement (camera relative), pointer right/left drag camera rotation and wheel zoom, click dummy selection, Tab nearest target. Avoid typing interference, ignore shortcuts when input/select/textarea focused. Space jump. Canvas must render responsive full bleed. Main UI calls update and resize. Only world owns renderer. NPC is interactable using click/onInteract `{id,name,dialogue}`. Scene architecture supports scene builder registry, entities and monster/NPC registration.

Build lush high-quality stylized original city environments at a human-readable scale, not isolated flat islands: Gridania large trees/wood bridges/lodge buildings/water/giant central glowing crystal; Limsa white maritime arches/tall lighthouse buildings/bridges/banners/ocean/sails/crystal. Real directional light shadows, varied materials, atmospheric fog, detailed paths, animated water/crystal, distinct characters/dummies, responsive performance. Initial spawn should be close enough to target wooden dummy and start casting (8 yalms); target nearest automatically. Obvious ground ring and target marker. Cyan crystal and readable city architecture in initial camera.

## Main owner

Owns `src/main.js`, `src/style.css`, server config, `docs/README` and browser integration. UI uses interfaces above. Does not mutate engine internals. Public debug API `window.__APP__` provides world/combat/action/teleport references for browser verification.
