function point(value, fallback = [0, 0, 0]) {
  if (Array.isArray(value)) return value.slice(0, 3);
  if (value && typeof value === 'object') return [value.x || 0, value.y || 0, value.z || 0];
  return fallback.slice();
}

function landmark(legacy, name, fallback) {
  const source = Object.values(legacy?.landmarks || {}).find(item => item.name === name);
  return point(source, fallback);
}

function lookAt(position, target) {
  return { position, target };
}

/**
 * Viewpoints are derived from the pinned e3t1 legacy landmarks, not guessed map
 * offsets. The small offsets put the camera above the walkable surface while the
 * target remains the source landmark used for the observation.
 */
export function deriveKuganeViewpoints(legacy) {
  const spawn = point(legacy?.training?.spawn, point(legacy?.spawn, [47.50471, 4.5, -20.28513]));
  const castle = landmark(legacy, 'Kugane Castle', [164.5219, 25, 0]);
  const street = landmark(legacy, 'Kogane Dori', [47.28964, 28.0268, 35.34939]);
  const material = landmark(legacy, 'Kokajiya', [-135.4797, -4.7339, 203.5747]);
  const water = landmark(legacy, 'The Short Pier', [-55.5413, 28.0268, 53.5121]);

  return {
    overlook: {
      label: 'Overlook',
      ...lookAt(
        [castle[0] - 74, castle[1] + 42, castle[2] + 92],
        [castle[0], castle[1] - 3, castle[2]],
      ),
      source: 'Kugane Castle',
    },
    street: {
      label: 'Street',
      ...lookAt(
        [street[0] - 22, Math.max(9, street[1] - 14), street[2] - 34],
        [street[0], street[1] - 14, street[2]],
      ),
      source: 'Kogane Dori',
    },
    material: {
      label: 'Material',
      ...lookAt(
        [material[0] + 30, material[1] + 16, material[2] + 28],
        [material[0], material[1] + 2, material[2]],
      ),
      source: 'Kokajiya',
    },
    water: {
      label: 'Water',
      ...lookAt(
        [water[0] + 38, water[1] - 10, water[2] - 42],
        [water[0], water[1] - 16, water[2]],
      ),
      source: 'The Short Pier',
    },
    spawn: {
      label: 'Spawn',
      ...lookAt(spawn, point(legacy?.training?.dummyPoint, [spawn[0], spawn[1], spawn[2] - 7])),
      source: legacy?.spawnSource?.kind || 'legacy spawn',
    },
  };
}

function genericViewpoint(label, target, offset, source) {
  return {
    label,
    ...lookAt([target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]], target),
    source,
  };
}

/**
 * Every packed map exposes a spawn and usually landmarks. Keep the authored
 * Kugane framing, while giving all other catalog entries stable, data-derived
 * viewpoints without inventing per-map coordinates.
 */
export function deriveMapViewpoints(legacy, { mapId = '' } = {}) {
  if (mapId === 'e3t1') return deriveKuganeViewpoints(legacy);
  const spawn = point(legacy?.training?.spawn, point(legacy?.spawn, [0, 2, 0]));
  const landmarks = Object.values(legacy?.landmarks || {})
    .filter(item => item && typeof item === 'object')
    .map(item => ({ name: item.name || 'Landmark', point: point(item) }));
  const targets = landmarks.length ? landmarks : [{ name: 'Spawn', point: spawn }];
  const viewpoints = {
    overview: genericViewpoint('Overview', spawn, [72, 48, 72], legacy?.spawnSource?.kind || 'spawn'),
    spawn: {
      label: 'Spawn',
      ...lookAt(spawn, point(legacy?.training?.dummyPoint, [spawn[0], spawn[1], spawn[2] - 7])),
      source: legacy?.spawnSource?.kind || 'spawn',
    },
  };
  for (const [index, landmarkEntry] of targets.slice(0, 3).entries()) {
    const label = landmarkEntry.name || `Landmark ${index + 1}`;
    viewpoints[`landmark${index + 1}`] = genericViewpoint(label, landmarkEntry.point, [30, 20, 30], label);
  }
  return viewpoints;
}

export default deriveMapViewpoints;
