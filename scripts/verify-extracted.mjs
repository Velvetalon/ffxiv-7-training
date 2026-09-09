import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { MeshNavigation } from '../src/world/imported/MeshNavigation.js';

const explicitRoot=process.argv.find(arg=>arg.startsWith('--root='))?.slice(7);
const requested=process.argv.find(arg=>arg.startsWith('--scenes='))?.slice(9).split(',') || ['gridania','limsa'];
const publicRoot=path.resolve(explicitRoot||'public/extracted');
const active=!explicitRoot&&fs.existsSync(path.join(publicRoot,'active.json'))?JSON.parse(fs.readFileSync(path.join(publicRoot,'active.json'),'utf8')):null;
for(const id of requested){
  const root=path.resolve(publicRoot,active?.scenes?.[id]?.base||id);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'scene.json'),'utf8'));
  assert.equal(manifest.scene,id);assert.equal(manifest.errors.length,0);
  let primitives=0,vertices=0,instances=0;
  for(const model of manifest.models){
    const data=fs.readFileSync(path.join(root,model.url));
    assert.equal(data.readUInt32LE(0),0x46546c67);
    assert.equal(data.readUInt32LE(8),data.length);
    const document=JSON.parse(data.subarray(20,20+data.readUInt32LE(12)).toString('utf8'));
    for(const mesh of document.meshes)for(const primitive of mesh.primitives){
      const positions=document.accessors[primitive.attributes.POSITION];
      assert(positions.count>0&&positions.min.every(Number.isFinite)&&positions.max.every(Number.isFinite));
      assert.equal(document.accessors[primitive.indices].count%3,0);
      assert(primitive.attributes.NORMAL!==undefined&&primitive.attributes.TEXCOORD_0!==undefined);
      for(const [semantic,index] of Object.entries(primitive.attributes)){
        assert.equal(document.accessors[index].count,positions.count,`${model.asset}: ${semantic} count`);
      }
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
  const bytes=fs.readFileSync(path.join(root,'collision.bin'));
  const array=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  assert.equal(array.length%9,0);assert(array.every(Number.isFinite));
  const navigation=new MeshNavigation(array);
  const [x,y,z]=manifest.aetheryte;navigation.height=y;
  const spawn=navigation.nearestWalkable(x+4,z+15,20,y);assert(spawn,'No actual collision ground at spawn');
  const p=new THREE.Vector3(spawn.x,spawn.y,spawn.z);navigation.height=p.y;
  navigation.move(p,0,2);assert(navigation.surfaceAt(p.x,p.z,p.y));
  assert(!navigation.surfaceAt(100000,100000,p.y),'Outside map unexpectedly walkable');
  const report=JSON.parse(fs.readFileSync(path.join(root,'collision-report.json'),'utf8'));
  assert.equal(report.errors.length,0);
  console.log(`${id}: ${manifest.models.length} models / ${instances} placements / ${primitives} primitives / ${vertices} vertices; ${array.length/9} original collision triangles. PASS`);
  navigation.dispose();
}
