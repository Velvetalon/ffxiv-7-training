import { Vector3 } from '@babylonjs/core';

export class MovementRuntime {
  constructor(character) {
    this.character = character;
    this.verticalVelocity = 0;
  }

  step(intent, navigation, dt, { speedMultiplier = 1, isReady = () => true } = {}) {
    const object = this.character.root;
    const origin = object.position.clone();
    const direction = intent.direction || Vector3.Zero();
    if (direction.lengthSquared()) {
      const offset = direction.scale((intent.sprint ? 8.5 : 5.4) * speedMultiplier * dt);
      if (isReady(origin.add(offset))) {
        const elevation = object.position.y;
        navigation.move(object.position, offset.x, offset.z);
        if (this.verticalVelocity) object.position.y = elevation;
        object.rotation.y = intent.heading ?? Math.atan2(direction.x, direction.z);
      }
    }
    const floor = navigation.surfaceAt(object.position.x, object.position.z)?.height ?? object.position.y;
    const wasAirborne = this.verticalVelocity !== 0 || object.position.y > floor + 0.001;
    let jumpStarted = false;
    if (this.verticalVelocity || intent.jump) {
      if (!this.verticalVelocity && object.position.y <= floor + 0.001) {
        this.verticalVelocity = 6.2;
        jumpStarted = true;
      }
      this.verticalVelocity -= 18 * dt;
      object.position.y = Math.max(floor, object.position.y + this.verticalVelocity * dt);
      if (object.position.y === floor) this.verticalVelocity = 0;
    }
    const airborne = this.verticalVelocity !== 0 || object.position.y > floor + 0.001;
    const moving = Math.hypot(object.position.x - origin.x, object.position.z - origin.z) > 0.0001;
    this.character.state.airborne = airborne;
    this.character.state.movement = jumpStarted
      ? 'jump-start'
      : airborne ? 'jump-airborne'
        : wasAirborne ? 'jump-land'
          : moving ? intent.sprint ? 'run' : 'walk' : 'idle';
    this.character.syncTransform();
    return {
      moving,
      airborne,
      jumpStarted,
      landed: wasAirborne && !airborne,
      changed: Vector3.DistanceSquared(object.position, origin) > 0.000001,
    };
  }
}
