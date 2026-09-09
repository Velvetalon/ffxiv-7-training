import * as THREE from 'three';
import { createDummy, createNpc } from '../actors.js';

const names = {
  "The Roost": '栖木旅馆', 'Carline Canopy': '魔女咖啡馆', "Quiver's Hold": '弓术师行会',
  "Adders' Nest": '双蛇党军营', 'Oak Atrium': '木工行会', "Figaga's Gift": '水车',
  'The Knot': '圆坛', 'Blue Badger Gate': '蓝獾门', 'White Wolf Gate': '白狼门',
  'The Octant': '八分仪广场', "Hawkers' Alley": '商人街', "East Hawkers' Alley": '东商人街',
  "West Hawkers' Alley": '西商人街', "Mealvaan's Gate": '秘术师行会', "Fisherman's Bottom": '捕鱼人行会',
  'The Astalicia': '阿斯塔利西亚号', 'Bulwark Hall': '壁垒商会', "Crow's Lift": '乌鸦升降机',
  'Zephyr Gate': '和风陆门', 'Ferry Docks': '渡船码头',
  'Chocobokeep': '陆行鸟房', "Carpenters' Guild": '木工行会', 'Acorn Orchard': '橡果园',
  'Gridania Aetheryte Plaza': '格里达尼亚以太广场', 'Limsa Lominsa Aetheryte Plaza': '利姆萨以太广场',
  "Hawkers' Round": '商人圆台', 'Airship Landing': '飞艇坪', 'Lominsan Ferry Docks': '利姆萨渡船码头',
};
export function mountEncounter(world, loaded, navigation) {
  world.registry.clear();
  const [x,y,z] = loaded.manifest.aetheryte;
  navigation.height = y;
  // Pick two connected collision points on the same deck. A downward ray alone
  // can otherwise place the player under Gridania's raised wooden platform.
  let spawn, dummyPoint, angle;
  for (let step = 0; step < 16; step++) {
    const a = step * Math.PI / 8;
    const dx = x + Math.sin(a) * 10, dz = z + Math.cos(a) * 10;
    const dummyFloor = navigation.surfaceAt(dx, dz, y, 4);
    if (!dummyFloor) continue;
    const sx = x + Math.sin(a) * 17, sz = z + Math.cos(a) * 17;
    const spawnFloor = navigation.surfaceAt(sx, sz, dummyFloor.height, 0.6);
    if (!spawnFloor || Math.abs(spawnFloor.height - dummyFloor.height) > 1) continue;
    const probe = new THREE.Vector3(dx, dummyFloor.height, dz);
    navigation.move(probe, sx - dx, sz - dz);
    if (Math.hypot(probe.x - sx, probe.z - sz) > 0.5) continue;
    dummyPoint = { x: dx, y: dummyFloor.height, z: dz };
    spawn = { x: sx, y: spawnFloor.height, z: sz };
    angle = a;
    break;
  }
  if (!spawn) throw new Error('无法在同一可行走平台上找到训练位置');
  navigation.height = spawn.y;
  const register = (id,name,type,object,point,dialogue) => {
    object.position.set(point.x,point.y,point.z);
    loaded.group.add(object);
    world.registry.register({id,name,type,object,baseY:point.y,hp:100,level:100,dialogue});
  };
  const dummy = createDummy();dummy.rotation.y=angle+Math.PI;
  register('wooden-dummy','训练木人','dummy',dummy,dummyPoint,'');
  const npcPoint = navigation.nearestWalkable(spawn.x - 5,spawn.z - 3,12,spawn.y);
  if(npcPoint)register(`${world.sceneId}-guide`,'演武场向导','npc',createNpc(),npcPoint,'此处使用本机客户端提取的城市地形。沿原有道路探索，或选择木人练习职业循环。');
  world.player.position.set(spawn.x,spawn.y,spawn.z);
  world.trainingAzimuth = angle;
  world.spawn.copy(world.player.position);
  const positionBounds=navigation.bounds;
  const landmarks=loaded.manifest.landmarks.filter(p=>p.name&&!['New Gridania','Limsa Lominsa Lower Decks'].includes(p.name)).map(p=>{
    const name=p.name.replace(/<[^>]*>/g,'');
    return {...p,en:name,name:names[name]||name};
  });
  landmarks.unshift({id:'aetheryte',type:'crystal',name:'以太之光',x,y,z});
  return {
    id:world.sceneId,
    bounds:{minX:positionBounds.min.x,maxX:positionBounds.max.x,minZ:positionBounds.min.z,maxZ:positionBounds.max.z},
    landmarks,roads:[],surfaces:[],water:[],
    image:`${loaded.base}map.png`,
    imageBounds:{minX:-512,maxX:512,minZ:-512,maxZ:512},
    sourceVersion:loaded.manifest.sourceVersion,
  };
}
