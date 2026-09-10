import * as THREE from 'three';
import { createDummy, createNpc } from '../actors.js';
import { mapImageBounds } from './MapCoordinates.js';

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
export function prepareEncounter(manifest, navigation) {
  const [x,y,z] = manifest.spawn || manifest.aetheryte;
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
  // An open-world starting point may be a small landing instead of a city
  // plaza. Search nearby collision ground for a connected training pair.
  if (!spawn) {
    const center = navigation.nearestWalkable(x, z, 30, y);
    if (center) {
      for (const radius of [3, 5, 7]) {
        for (let step = 0; step < 16; step++) {
          const a = step * Math.PI / 8;
          const sx = center.x + Math.sin(a) * radius, sz = center.z + Math.cos(a) * radius;
          const probe = new THREE.Vector3(center.x, center.y, center.z);
          navigation.move(probe, sx - center.x, sz - center.z);
          if (Math.hypot(probe.x - sx, probe.z - sz) > 0.25 || Math.abs(probe.y - center.y) > 1) continue;
          spawn = { x: sx, y: probe.y, z: sz }; dummyPoint = center; angle = a;
          break;
        }
        if (spawn) break;
      }
    }
  }
  // Large crystals can occupy a plinth that is not itself connected to the
  // nearby ground. Look around the source landmark, rather than treating the
  // first downward hit (possibly the plinth) as the only possible starting spot.
  if (!spawn) {
    search: for (const radius of [6, 12, 20, 30, 45]) {
      for (let step = 0; step < 16; step++) {
        const a = step * Math.PI / 8;
        const cx = x + Math.sin(a) * radius, cz = z + Math.cos(a) * radius;
        for (const elevation of [y, y-6, y+6, y-12]) {
          const surface = navigation.surfaceAt(cx, cz, elevation, 5);
          if (!surface || Math.abs(surface.height-y)>16) continue;
          for (let direction = 0; direction < 8; direction++) {
            const heading = direction * Math.PI / 4;
            const dx = Math.sin(heading)*4, dz = Math.cos(heading)*4;
            const probe = new THREE.Vector3(cx,surface.height,cz);
            navigation.move(probe,dx,dz);
            if(Math.hypot(probe.x-cx-dx,probe.z-cz-dz)>0.2 || Math.abs(probe.y-surface.height)>1)continue;
            dummyPoint={x:cx,y:surface.height,z:cz};
            spawn={x:probe.x,y:probe.y,z:probe.z};
            angle=heading;
            break search;
          }
        }
      }
    }
  }
  if (!spawn) throw new Error(`${manifest.scene}: 无法在源地标附近找到相连的练习地面`);
  return { spawn, dummyPoint, angle };
}

export function mountEncounter(world, loaded, navigation, encounter = prepareEncounter(loaded.manifest, navigation)) {
  world.registry.clear();
  const { spawn, dummyPoint, angle } = encounter;
  const [x,y,z] = loaded.manifest.aetheryte || loaded.manifest.spawn;
  navigation.height = spawn.y;
  const register = (id,name,type,object,point,dialogue) => {
    object.position.set(point.x,point.y,point.z);
    loaded.group.add(object);
    world.registry.register({id,name,type,object,baseY:point.y,hp:100,level:100,dialogue});
  };
  const dummy = createDummy();dummy.rotation.y=angle+Math.PI;
  register('wooden-dummy','训练木人','dummy',dummy,dummyPoint,'');
  const npcPoint = navigation.nearestWalkable(spawn.x - 5,spawn.z - 3,12,spawn.y);
  if(npcPoint)register(`${world.sceneId}-guide`,'演武场向导','npc',createNpc(),npcPoint,'沿道路探索这片地区，靠近区域出口后按 F 前往相邻地图。也可以选择木人练习职业循环。');
  world.player.position.set(spawn.x,spawn.y,spawn.z);
  world.trainingAzimuth = angle;
  world.spawn.copy(world.player.position);
  const positionBounds=navigation.bounds;
  const landmarks=(loaded.manifest.landmarks || []).filter(p=>p.name&&!['New Gridania','Limsa Lominsa Lower Decks'].includes(p.name)).map(p=>{
    const name=p.name.replace(/<[^>]*>/g,'');
    return {...p,en:name,name:names[name]||name};
  });
  landmarks.unshift({id:'aetheryte',type:'crystal',name:loaded.manifest.aetheryte ? '以太之光' : '区域入口',x,y,z});
  for (const connection of loaded.manifest.connections || []) {
    const [px, py, pz] = connection.position;
    landmarks.push({ id: `connection:${connection.id}`, name: connection.name, type: 'connection', x: px, y: py, z: pz, targetScene: connection.targetScene });
  }
  return {
    id:world.sceneId,
    bounds:{minX:positionBounds.min.x,maxX:positionBounds.max.x,minZ:positionBounds.min.z,maxZ:positionBounds.max.z},
    landmarks,roads:[],surfaces:[],water:[],
    image:`${loaded.base}map.png`,
    imageBounds:loaded.manifest.imageBounds || mapImageBounds(loaded.manifest.scene),
    sourceVersion:loaded.manifest.sourceVersion,
  };
}
