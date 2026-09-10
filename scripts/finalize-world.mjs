// Ground source-derived region endpoints in an unpublished conversion directory.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MeshNavigation } from '../src/world/imported/MeshNavigation.js';
import { prepareEncounter } from '../src/world/imported/MountScene.js';
import { readCollision } from './lib/read-collision.mjs';

const argument = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const stage = argument('root');
const graphPath = argument('connections');
if (!stage || !graphPath) throw new Error('Usage: node scripts/finalize-world.mjs --root=<unpublished-directory> --connections=<raw-graph.json>');
const root = path.resolve(stage);
const catalog = JSON.parse(fs.readFileSync(new URL('../tools/map-tools/world-catalog.json', import.meta.url), 'utf8'));
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const output = new Map(), errors = [], arrivals = new Map();

function ground(navigation, coordinate, radius = 12) {
  if (!Array.isArray(coordinate) || coordinate.length !== 3 || !coordinate.every(Number.isFinite)) return null;
  const [x, y, z] = coordinate;
  const candidates = [];
  for (const delta of [0, -4, 4, -8, 8, -12]) {
    const point = navigation.nearestWalkable(x, z, radius, y + delta);
    if (point && Math.abs(point.y - y) <= 16) candidates.push(point);
  }
  candidates.sort((a, b) =>
    Math.hypot(a.x-x, a.z-z, a.y-y) - Math.hypot(b.x-x, b.z-z, b.y-y));
  const nearest = candidates[0];
  return nearest ? [nearest.x, nearest.y, nearest.z] : null;
}

for (const scene of catalog.scenes) {
  const folder = path.join(root, scene.id);
  if (!fs.existsSync(path.join(folder, 'scene.json'))) {
    errors.push(`${scene.id}: converted scene missing`); continue;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'scene.json'), 'utf8'));
  const navigation = new MeshNavigation(readCollision(folder,manifest));
  try {
    const encounter = prepareEncounter(manifest, navigation);
    manifest.training = encounter;
    const connections = [];
    for (const raw of graph.scenes[scene.id] || []) {
      // PopRange is on the inside of a boundary; the trigger box can extend
      // past the walkable mesh. Keep both source coordinates in provenance.
      const spawn = ground(navigation, raw.spawn || raw.position);
      const position = spawn || ground(navigation, raw.position);
      if (!position) { errors.push(`${scene.id}/${raw.id}: no collision ground near source endpoint`); continue; }
      connections.push({
        ...raw, position, spawn: spawn || position,
        name: catalog.scenes.find(scene => scene.id === raw.targetScene)?.name || raw.targetScene,
        grounding: {
          method: 'nearest actual walkable PCB surface to source PopRange',
          rawPosition: raw.position, rawSpawn: raw.spawn,
        },
      });
    }
    manifest.connections = connections;
    for (const [from, fromConnections] of Object.entries(graph.scenes)) {
      for (const connection of fromConnections) {
        if (connection.targetScene !== scene.id || !connection.arrival) continue;
        const arrival = ground(navigation, connection.arrival);
        if (!arrival) errors.push(`${from}/${connection.id}: no collision ground near destination PopRange`);
        else arrivals.set(`${from}:${connection.id}`, arrival);
      }
    }
    output.set(scene.id, manifest);
  } catch (error) {
    errors.push(`${scene.id}: ${error.message}`);
  } finally { navigation.dispose(); }
}
for (const [id, manifest] of output) {
  for (const connection of manifest.connections) {
    const target = output.get(connection.targetScene);
    if (!target) { errors.push(`${id}/${connection.id}: target was not converted`); continue; }
    if (connection.targetConnection && !target.connections.some(item => item.id === connection.targetConnection)) {
      errors.push(`${id}/${connection.id}: target connection missing`);
    }
    if (connection.arrival) connection.arrival = arrivals.get(`${id}:${connection.id}`);
  }
}
const report = {
  maps: output.size, requiredMaps: catalog.scenes.length,
  directedConnections: [...output.values()].reduce((n, scene) => n + scene.connections.length, 0),
  unresolvedSourceRecords: graph.unresolved || [], errors,
};
fs.writeFileSync(path.join(root, 'world-finalization.json'), JSON.stringify(report, null, 2) + '\n');
if (errors.length) throw new Error(`World finalization failed: ${errors.length} issues; see ${root}/world-finalization.json`);
const active = { runId: path.basename(root), publishedAt: new Date().toISOString(), scenes: {} };
for (const [id, manifest] of output) {
  const target = path.join(root, id, 'scene.json');
  const text = JSON.stringify(manifest);
  fs.writeFileSync(`${target}.tmp`, text);
  fs.renameSync(`${target}.tmp`, target);
  const scene = catalog.scenes.find(scene => scene.id === id);
  active.scenes[id] = {
    base: `${id}/`, clientVersion: manifest.sourceVersion,
    manifestSha256: createHash('sha256').update(text).digest('hex'),
    name: scene.name, en: scene.en, region: scene.region, territoryId: scene.territoryId,
    kind: scene.kind, expansion: scene.expansion,
  };
}
fs.writeFileSync(path.join(root, 'active.json.tmp'), JSON.stringify(active, null, 2) + '\n');
fs.renameSync(path.join(root, 'active.json.tmp'), path.join(root, 'active.json'));
console.log(JSON.stringify({ maps: report.maps, directedConnections: report.directedConnections, errors: 0 }));
