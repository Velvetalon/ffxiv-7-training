import assert from 'node:assert/strict';
import { LAYOUTS } from '../src/world/terrain/layouts.js';
import { Navigation } from '../src/world/terrain/Navigation.js';

for (const layout of Object.values(LAYOUTS)) {
  const navigation = new Navigation(layout);
  assert(navigation.isWalkable(layout.spawn.x, layout.spawn.z), `${layout.id}: spawn is off the route`);
  assert(navigation.isWalkable(layout.dummy.x, layout.dummy.z), `${layout.id}: dummy is off the route`);
  assert(Math.hypot(layout.spawn.x - layout.dummy.x, layout.spawn.z - layout.dummy.z) <= 8.5, `${layout.id}: initial dummy out of casting range`);
  const bounds = layout.bounds, spacing = 1;
  const width = Math.ceil((bounds.maxX - bounds.minX) / spacing) + 1;
  const height = Math.ceil((bounds.maxZ - bounds.minZ) / spacing) + 1;
  const encode = (ix, iz) => iz * width + ix;
  const cell = (x, z) => [Math.round((x - bounds.minX) / spacing), Math.round((z - bounds.minZ) / spacing)];
  const toWorld = (ix, iz) => ({ x: bounds.minX + ix * spacing, z: bounds.minZ + iz * spacing });
  const walkable = new Uint8Array(width * height);
  for (let iz = 0; iz < height; iz++) for (let ix = 0; ix < width; ix++) {
    const p = toWorld(ix, iz);
    walkable[encode(ix, iz)] = navigation.isWalkable(p.x, p.z) ? 1 : 0;
  }
  const initial = cell(layout.spawn.x, layout.spawn.z);
  const queue = [initial], seen = new Set([encode(...initial)]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [ix, iz] = queue[cursor];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = ix + dx, nz = iz + dz, key = encode(nx, nz);
      if (nx < 0 || nz < 0 || nx >= width || nz >= height || seen.has(key) || !walkable[key]) continue;
      seen.add(key); queue.push([nx, nz]);
    }
  }
  const destinations = [...layout.landmarks, ...layout.exits, ...layout.npcs];
  for (const destination of destinations) {
    const point = navigation.nearestWalkable(destination.x, destination.z);
    assert(point, `${layout.id}: no approach to ${destination.id}`);
    const [ix, iz] = cell(point.x, point.z);
    let reachable = false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (seen.has(encode(ix + dx, iz + dz))) reachable = true;
    assert(reachable, `${layout.id}: disconnected destination ${destination.id}`);
  }
  const all = walkable.reduce((sum, value) => sum + value, 0);
  assert(seen.size / all > 0.97, `${layout.id}: disconnected walkable regions (${seen.size}/${all})`);
  const p = { ...layout.spawn, y: 0 };
  navigation.move(p, 999, 999);
  assert(navigation.isWalkable(p.x, p.z), `${layout.id}: dash escaped route mask`);
  console.log(`${layout.id}: ${layout.roads.length} roads, ${layout.landmarks.length} landmarks; ${destinations.length} reachable destinations; ${(seen.size / all * 100).toFixed(1)}% connected.`);
}
