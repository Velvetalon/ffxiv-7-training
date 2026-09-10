import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MeshNavigation } from '../src/world/imported/MeshNavigation.js';
import { findArrival, nearestConnection } from '../src/world/imported/ZoneConnections.js';
import { readCollision } from './lib/read-collision.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const root = path.resolve(option('root') || 'public/extracted');
const active = JSON.parse(fs.readFileSync(path.join(root, 'active.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(new URL('../tools/map-tools/world-catalog.json', import.meta.url), 'utf8'));
assert.deepEqual(Object.keys(active.scenes).sort(), catalog.scenes.map(scene=>scene.id).sort(), 'Published maps do not match the complete overworld catalog');
const rawGraph = option('connections') ? JSON.parse(fs.readFileSync(option('connections'),'utf8')) : null;
const manifests = new Map(Object.entries(active.scenes).map(([id, record]) => [
  id, JSON.parse(fs.readFileSync(path.join(root, record.base, 'scene.json'), 'utf8')),
]));
assert(manifests.size > 2, 'Overworld release must include more than the original two cities');
const incoming = new Map([...manifests.keys()].map(id => [id, []]));
for (const [id, manifest] of manifests) {
  assert.equal(manifest.scene, id);
  if(rawGraph) {
    assert.deepEqual((manifest.connections||[]).map(c=>`${c.id}:${c.targetScene}`).sort(),
      (rawGraph.scenes[id]||[]).map(c=>`${c.id}:${c.targetScene}`).sort(),
      `${id}: published connections differ from the source-derived graph`);
    for(const connection of manifest.connections || []) {
      const raw = rawGraph.scenes[id].find(item=>item.id===connection.id);
      assert.equal(connection.targetConnection,raw.targetConnection,`${id}/${connection.id}: target endpoint changed`);
      assert.deepEqual(connection.source,raw.source,`${id}/${connection.id}: source provenance changed`);
      assert.deepEqual(connection.grounding?.rawPosition,raw.position,`${id}/${connection.id}: raw trigger changed`);
      assert.deepEqual(connection.grounding?.rawSpawn,raw.spawn,`${id}/${connection.id}: raw PopRange changed`);
      const nearSource = (point, original, label) => {
        assert(point?.length===3&&point.every(Number.isFinite),`${id}/${connection.id}: invalid ${label}`);
        assert(Math.hypot(point[0]-original[0],point[2]-original[2])<=12.01&&Math.abs(point[1]-original[1])<=16.01,
          `${id}/${connection.id}: ${label} escaped source-grounding bounds`);
      };
      nearSource(connection.spawn,raw.spawn || raw.position,'local arrival');
      nearSource(connection.position,raw.spawn || raw.position,'interaction point');
      assert.equal(Boolean(connection.arrival),Boolean(raw.arrival),`${id}/${connection.id}: arrival mode changed`);
      if(raw.arrival)nearSource(connection.arrival,raw.arrival,'target arrival');
    }
  }
  const ids = new Set();
  for (const connection of manifest.connections || []) {
    assert(!ids.has(connection.id), `${id}: duplicate connection ${connection.id}`);
    ids.add(connection.id);
    assert(connection.source, `${id}/${connection.id}: missing source provenance`);
    const target = manifests.get(connection.targetScene);
    assert(target, `${id}/${connection.id}: missing target map ${connection.targetScene}`);
    const reverse = target.connections?.find(candidate => candidate.id === connection.targetConnection);
    assert(reverse || connection.arrival, `${id}/${connection.id}: no target endpoint or arrival coordinates`);
    if (reverse) {
      assert.equal(reverse.targetScene, id, `${id}/${connection.id}: reverse endpoint targets a different zone`);
      assert.equal(reverse.targetConnection, connection.id, `${id}/${connection.id}: reverse pairing mismatch`);
    }
    incoming.get(connection.targetScene).push({ from: id, connection });
  }
}
let edges = 0;
for (const [id, manifest] of manifests) {
  const navigation = new MeshNavigation(readCollision(path.join(root,active.scenes[id].base),manifest));
  try {
    for (const connection of manifest.connections || []) {
      const [x, y, z] = connection.position;
      const floor = navigation.nearestWalkable(x, z, 3, y);
      assert(floor && Math.abs(floor.y - y) < 4, `${id}/${connection.id}: unsafe source endpoint`);
      assert(nearestConnection([connection], floor), `${id}/${connection.id}: cannot interact from source collision surface`);
      assert(!nearestConnection([connection], { ...floor, y: floor.y + 10 }), `${id}/${connection.id}: interaction crosses floors`);
      edges++;
    }
    for (const { from, connection } of incoming.get(id)) {
      const arrival = findArrival(manifest, navigation, {
        arrivalConnection: connection.targetConnection,
        arrival: connection.arrival,
      });
      assert(arrival, `${from}/${connection.id}: no playable arrival in ${id}`);
      assert(navigation.surfaceAt(arrival.x, arrival.z, arrival.y), `${from}/${connection.id}: arrival not grounded`);
    }
  } finally { navigation.dispose(); }
}
assert(edges > 0, 'No map connections were published');
for (const id of ['gridania', 'limsa']) {
  assert(manifests.get(id)?.connections?.length, `${id}: original city is not connected to the expanded world`);
}
const summary = { maps: manifests.size, directedConnections: edges, isolatedZones: [...manifests].filter(([,m]) => !m.connections?.length).map(([id]) => id), result: 'pass' };
console.log(JSON.stringify(summary, null, 2));
