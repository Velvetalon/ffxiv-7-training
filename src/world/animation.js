import * as THREE from 'three';

export class ActorAnimation {
  constructor(player) {
    this.player = player;
    this.action = null;
  }

  setPlayer(player) {
    this.player = player;
    this.action = null;
  }

  trigger(event = {}, jobId = 'WHM') {
    if (event.type === 'error') return;
    this.action = { age: 0, duration: event.type === 'cast' ? 0.7 : 0.46, jobId, type: event.type || 'hit' };
  }

  update(dt, moving, time) {
    const rig = this.player?.userData.rig;
    if (!rig) return;
    const walk = moving ? Math.sin(time * 10) : 0;
    const bob = moving ? Math.abs(Math.sin(time * 10)) * 0.055 : Math.sin(time * 2.1) * 0.012;
    rig.body.position.y = bob;
    rig.leftLeg.rotation.x = walk * 0.58;
    rig.rightLeg.rotation.x = -walk * 0.58;
    rig.leftArm.rotation.x = -walk * 0.33;
    rig.rightArm.rotation.x = walk * 0.33;
    rig.weapon.rotation.set(0, 0, 0);
    if (!this.action) return;
    this.action.age += dt;
    const phase = Math.min(1, this.action.age / this.action.duration);
    const windup = Math.sin(Math.min(phase, 0.5) * Math.PI);
    const strike = Math.sin(phase * Math.PI);
    if (this.action.jobId === 'RPR') {
      rig.rightArm.rotation.z = -0.62 * windup;
      rig.leftArm.rotation.z = 0.34 * windup;
      rig.weapon.rotation.z = -1.9 * strike;
      rig.body.rotation.y = -0.28 * strike;
    } else if (this.action.jobId === 'PCT') {
      rig.rightArm.rotation.z = -0.34 * windup;
      rig.leftArm.rotation.z = 0.22 * windup;
      rig.weapon.rotation.z = -0.75 * strike;
      rig.body.rotation.z = 0.09 * strike;
    } else {
      rig.rightArm.rotation.z = -0.42 * windup;
      rig.leftArm.rotation.z = 0.24 * windup;
      rig.weapon.rotation.z = -0.42 * strike;
      rig.body.rotation.z = 0.06 * strike;
    }
    if (phase < 1) return;
    rig.body.rotation.set(0, 0, 0);
    this.action = null;
  }
}
