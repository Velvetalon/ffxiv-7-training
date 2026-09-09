export function insidePolygon(x, z, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, az] = points[i], [bx, bz] = points[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

export function segmentProjection(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared)) : 0;
  return { distance: Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz), t };
}

export class Navigation {
  constructor(layout) {
    this.layout = layout;
    this.solids = layout.landmarks.filter(item => ['inn', 'guild', 'tower'].includes(item.type)).map(item => ({
      x: item.x, z: item.z - Math.min(item.d || 10, 15) * 0.47,
      w: Math.min(item.w || 12, 22) * 0.66, d: Math.min(item.d || 10, 15) * 0.66,
    }));
  }
  surfaceAt(x, z) {
    let surface = null;
    for (const area of this.layout.surfaces) {
      if (insidePolygon(x, z, area.points)) surface = { height: area.height || 0, id: area.id };
    }
    for (const road of this.layout.roads) {
      for (let i = 1; i < road.points.length; i++) {
        const nearest = segmentProjection(x, z, road.points[i - 1], road.points[i]);
        if (nearest.distance <= road.width / 2 - 0.25) {
          const progress = (i - 1 + nearest.t) / (road.points.length - 1);
          surface = { height: (road.height || 0) + ((road.endHeight ?? road.height ?? 0) - (road.height || 0)) * progress, id: road.id };
        }
      }
    }
    return surface;
  }
  isWalkable(x, z) {
    const b = this.layout.bounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ &&
      !this.solids.some(solid => Math.abs(x - solid.x) < solid.w / 2 && Math.abs(z - solid.z) < solid.d / 2) && !!this.surfaceAt(x, z);
  }
  nearestWalkable(x, z, maxDistance = 25) {
    if (this.isWalkable(x, z)) return { x, z };
    for (let radius = 0.5; radius <= maxDistance; radius += 0.5) {
      for (let step = 0; step < 32; step++) {
        const angle = step / 32 * Math.PI * 2;
        const px = x + Math.cos(angle) * radius, pz = z + Math.sin(angle) * radius;
        if (this.isWalkable(px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  }
  move(position, dx, dz) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.3));
    for (let i = 0; i < steps; i++) {
      const x = position.x + dx / steps, z = position.z + dz / steps;
      if (this.isWalkable(x, z)) { position.x = x; position.z = z; }
      else if (this.isWalkable(x, position.z)) position.x = x;
      else if (this.isWalkable(position.x, z)) position.z = z;
      else break;
    }
    position.y = this.surfaceAt(position.x, position.z)?.height || 0;
  }
}
