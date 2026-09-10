import * as THREE from 'three';

// Orbit and obstruction checks share one player pivot. Enemy selection never moves it.
export class FollowCamera {
  constructor(camera) {
    this.camera = camera;
    this.pivot = new THREE.Vector3();
    this.offset = new THREE.Vector3();
    this.desiredPosition = new THREE.Vector3();
    this.currentDistance = null;
    this.zoomDistance = null;
    this.lastPlayerPosition = new THREE.Vector3();
    this.ready = false;
  }
  reset() { this.currentDistance = null; this.zoomDistance = null; this.ready = false; }
  update(player, { azimuth, polar, distance, navigation, focusHeight = 1.45 }, dt) {
    player.getWorldPosition(this.pivot);
    const jumped = !this.ready || this.pivot.distanceToSquared(this.lastPlayerPosition) > 36;
    this.lastPlayerPosition.copy(this.pivot);
    this.pivot.y += focusHeight;
    if (jumped || this.zoomDistance === null) this.zoomDistance = distance;
    else this.zoomDistance += (distance - this.zoomDistance) * (dt > 0 ? 1 - Math.exp(-10 * dt) : 1);
    const horizontal = Math.sin(polar);
    this.offset.set(Math.sin(azimuth) * horizontal, Math.cos(polar), Math.cos(azimuth) * horizontal);
    this.desiredPosition.copy(this.pivot).addScaledVector(this.offset, this.zoomDistance);
    const hit = navigation?.cameraHit?.(this.pivot, this.desiredPosition);
    const safeDistance = hit ? Math.max(0.3, Math.min(this.zoomDistance, hit.distance - 0.25)) : this.zoomDistance;
    if (jumped || this.currentDistance === null || safeDistance < this.currentDistance) {
      this.currentDistance = safeDistance;
    } else {
      this.currentDistance += (safeDistance - this.currentDistance) * (dt > 0 ? 1 - Math.exp(-12 * dt) : 1);
    }
    this.camera.position.copy(this.pivot).addScaledVector(this.offset, this.currentDistance);
    this.camera.lookAt(this.pivot);
    this.camera.updateMatrixWorld(true);
    this.ready = true;
  }
}
