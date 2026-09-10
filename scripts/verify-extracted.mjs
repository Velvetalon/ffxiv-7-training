import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { MeshNavigation } from '../src/world/imported/MeshNavigation.js';
import { prepareEncounter } from '../src/world/imported/MountScene.js';
import { readCollision } from './lib/read-collision.mjs';

const explicitRoot=process.argv.find(arg=>arg.startsWith('--root='))?.slice(7);
const requestedArgument=process.argv.find(arg=>arg.startsWith('--scenes='))?.slice(9).split(',');
const publicRoot=path.resolve(explicitRoot||'public/extracted');
const active=fs.existsSync(path.join(publicRoot,'active.json'))?JSON.parse(fs.readFileSync(path.join(publicRoot,'active.json'),'utf8')):null;
const requested=requestedArgument || (active ? Object.keys(active.scenes) : fs.readdirSync(publicRoot).filter(id=>fs.existsSync(path.join(publicRoot,id,'scene.json'))));
assert(requested.length>0,'No maps selected for verification');
for(const id of requested){
  const root=path.resolve(publicRoot,active?.scenes?.[id]?.base||id);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'scene.json'),'utf8'));
  assert.equal(manifest.scene,id);assert.equal(manifest.errors.length,0);
  assert(fs.existsSync(path.join(root,'map.png')),`${id}: missing area map image`);
  let primitives=0,vertices=0,instances=0;
  for(const model of manifest.models){
    const data=fs.readFileSync(path.join(root,model.url));
    assert.equal(data.readUInt32LE(0),0x46546c67);
    assert.equal(data.readUInt32LE(8),data.length);
    const jsonLength=data.readUInt32LE(12);
    const document=JSON.parse(data.subarray(20,20+jsonLength).toString('utf8'));
    const binaryStart=28+jsonLength;
    for(const mesh of document.meshes)for(const primitive of mesh.primitives){
      const positions=document.accessors[primitive.attributes.POSITION];
      assert(positions.count>0&&positions.min.every(Number.isFinite)&&positions.max.every(Number.isFinite));
      assert.equal(document.accessors[primitive.indices].count%3,0);
      assert(primitive.attributes.NORMAL!==undefined&&primitive.attributes.TEXCOORD_0!==undefined);
      for(const [semantic,index] of Object.entries(primitive.attributes)){
        const accessor=document.accessors[index],view=document.bufferViews[accessor.bufferView];
        assert.equal(accessor.count,positions.count,`${model.asset}: ${semantic} count`);
        const dimensions={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[accessor.type];
        assert(dimensions,`${model.asset}: unsupported vertex attribute dimensions`);
        assert.equal(accessor.componentType,5126,`${model.asset}: expected float vertex attribute`);
        const start=binaryStart+(view.byteOffset||0)+(accessor.byteOffset||0),stride=view.byteStride||dimensions*4;
        assert(start+(accessor.count-1)*stride+dimensions*4<=data.length,`${model.asset}: ${semantic} buffer exceeds GLB`);
        if(semantic==='POSITION'||semantic==='NORMAL') {
          for(let vertex=0;vertex<accessor.count;vertex++)for(let component=0;component<dimensions;component++)
            assert(Number.isFinite(data.readFloatLE(start+vertex*stride+component*4)),`${model.asset}: non-finite ${semantic}`);
        }
      }
      const indices=document.accessors[primitive.indices],indexView=document.bufferViews[indices.bufferView];
      const indexBytes={5123:2,5125:4}[indices.componentType];
      assert(indexBytes,`${model.asset}: unsupported index component type`);
      const indexStart=binaryStart+(indexView.byteOffset||0)+(indices.byteOffset||0);
      assert(indexStart+indices.count*indexBytes<=data.length,`${model.asset}: index buffer exceeds GLB`);
      for(let i=0;i<indices.count;i++)assert(
        (indexBytes===2?data.readUInt16LE(indexStart+i*2):data.readUInt32LE(indexStart+i*4))<positions.count,
        `${model.asset}: index references a missing vertex`);
      primitives++;vertices+=positions.count;
    }
    for(const matrix of model.matrices)assert(matrix.length===16&&matrix.every(Number.isFinite));
    instances+=model.matrices.length;
  }
  for(const material of Object.values(manifest.materials)){
    for(const field of ['map','normalMap','specularMap','secondaryMap','secondaryNormalMap']){
      if(material[field])assert(fs.existsSync(path.join(root,material[field])));
    }
    if(material.colorUVScale)assert(material.colorUVScale.length===4&&material.colorUVScale.every(Number.isFinite));
    if(material.samplers)for(const sampler of material.samplers){
      assert(sampler.index<material.textures.length||sampler.index===255);
      if(sampler.path)assert.equal(sampler.path,material.textures[sampler.index]);
    }
  }
  const array=readCollision(root,manifest);
  assert.equal(array.length%9,0);assert(array.every(Number.isFinite));
  const navigation=new MeshNavigation(array);
  const {spawn}=prepareEncounter(manifest,navigation);
  const p=new THREE.Vector3(spawn.x,spawn.y,spawn.z);navigation.height=p.y;
  navigation.move(p,0,2);assert(navigation.surfaceAt(p.x,p.z,p.y));
  assert(!navigation.surfaceAt(100000,100000,p.y),'Outside map unexpectedly walkable');
  const ids=new Set();
  for(const connection of manifest.connections || []){
    assert(connection.id&&!ids.has(connection.id),`${id}: duplicate/missing connection id`);
    ids.add(connection.id);
    assert(connection.targetScene&&connection.targetScene!==id,`${id}: invalid connection destination`);
    assert(connection.position?.length===3&&connection.position.every(Number.isFinite),`${id}: invalid connection position`);
    assert(connection.source,`${id}: connection missing source evidence`);
    const [cx,cy,cz]=connection.position;
    assert(navigation.nearestWalkable(cx,cz,3,cy),`${id}: connection is not on reachable ground`);
    if(active)assert(active.scenes[connection.targetScene],`${id}: destination is not published`);
  }
  const report=JSON.parse(fs.readFileSync(path.join(root,'collision-report.json'),'utf8'));
  assert.equal(report.errors.length,0);
  console.log(`${id}: ${manifest.models.length} models / ${instances} placements / ${primitives} primitives / ${vertices} vertices; ${array.length/9} original collision triangles. PASS`);
  navigation.dispose();
}
