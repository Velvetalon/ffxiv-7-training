import * as THREE from 'three';
import { MeshBVH, CENTER } from 'three-mesh-bvh';

const down = new THREE.Vector3(0, -1, 0);
export class MeshNavigation {
  constructor(positions) {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.computeBoundingBox();
    this.bounds = this.geometry.boundingBox.clone();
    this.bvh = new MeshBVH(this.geometry, { strategy: CENTER, targetLeafSize: 12 });
    this.ray = new THREE.Ray();
    this.height = 0;
  }
  surfaceAt(x, z, currentHeight = this.height, reach = 1.1) {
    this.ray.set(new THREE.Vector3(x, currentHeight + reach, z), down);
    const hits = this.bvh.raycast(this.ray, THREE.DoubleSide, 0, reach + 4);
    const floor = hits.filter(hit => Math.abs(hit.face.normal.y) > 0.52).sort((a,b) => a.distance - b.distance)[0];
    return floor ? { height: floor.point.y, id: 'client-collision' } : null;
  }
  isWalkable(x, z) { return !!this.surfaceAt(x, z); }
  nearestWalkable(x, z, maxDistance = 25, elevation = this.height) {
    let surface = this.surfaceAt(x, z, elevation, 5);
    if (surface) return { x, z, y: surface.height };
    for (let r = 0.75; r <= maxDistance; r += 0.75) {
      for (let step = 0; step < 16; step++) {
        const a = step * Math.PI / 8, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        surface = this.surfaceAt(px, pz, elevation, 5);
        if (surface) return { x: px, z: pz, y: surface.height };
      }
    }
    return null;
  }
  clearSegment(position, x, z) {
    const direction = new THREE.Vector3(x-position.x, 0, z-position.z);
    const length = direction.length(); if (!length) return true;
    direction.divideScalar(length);
    for (const height of [0.6, 1.4]) {
      this.ray.set(new THREE.Vector3(position.x,position.y+height,position.z),direction);
      const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0.02, length + 0.22);
      if (hit && Math.abs(hit.face.normal.y) < 0.65) return false;
    }
    return true;
  }
  move(position, dx, dz) {
    const steps = Math.max(1, Math.ceil(Math.hypot(dx,dz)/0.25));
    for (let i=0; i<steps; i++) {
      const x=position.x+dx/steps,z=position.z+dz/steps;
      let floor=this.surfaceAt(x,z,position.y);
      if (floor && this.clearSegment(position,x,z)) position.set(x,floor.height,z);
      else {
        floor=this.surfaceAt(x,position.z,position.y);
        if (floor && this.clearSegment(position,x,position.z)) position.set(x,floor.height,position.z);
        else {
          floor=this.surfaceAt(position.x,z,position.y);
          if (floor && this.clearSegment(position,position.x,z)) position.set(position.x,floor.height,z);
          else break;
        }
      }
    }
    this.height = position.y;
  }
  cameraHit(origin, destination) {
    const direction = destination.clone().sub(origin), distance=direction.length();
    this.ray.set(origin,direction.normalize());
    return this.bvh.raycastFirst(this.ray,THREE.DoubleSide,0.2,distance);
  }
  dispose() { this.geometry.dispose(); }
}
