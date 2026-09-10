import * as THREE from 'three';

export class MovementRuntime {
  constructor(character) {
    this.character = character;
    this.verticalVelocity = 0;
  }

  step(intent, navigation, dt, { speedMultiplier = 1, isReady = () => true } = {}) {
    const object = this.character.root;
    const origin = object.position.clone();
    const direction = intent.direction || new THREE.Vector3();
    if (direction.lengthSq()) {
      const offset = direction.clone().multiplyScalar((intent.sprint ? 8.5 : 5.4) * speedMultiplier * dt);
      if (isReady(origin.clone().add(offset))) {
        const elevation = object.position.y;
        navigation.move(object.position, offset.x, offset.z);
        if (this.verticalVelocity) object.position.y = elevation;
        object.rotation.y = intent.heading ?? Math.atan2(direction.x, direction.z);
      }
    }
    const floor = navigation.surfaceAt(object.position.x, object.position.z)?.height ?? object.position.y;
    if (this.verticalVelocity || intent.jump) {
      if (!this.verticalVelocity && object.position.y <= floor + 0.001) this.verticalVelocity = 6.2;
      this.verticalVelocity -= 18 * dt;
      object.position.y = Math.max(floor, object.position.y + this.verticalVelocity * dt);
      if (object.position.y === floor) this.verticalVelocity = 0;
    }
    const moving = Math.hypot(object.position.x - origin.x, object.position.z - origin.z) > 0.0001;
    this.character.state.movement = moving ? intent.sprint ? 'run' : 'walk' : 'idle';
    this.character.syncTransform();
    return { moving, changed: object.position.distanceToSquared(origin) > 0.000001 };
  }
}
