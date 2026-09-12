import { Quaternion, Vector3 } from '@babylonjs/core';

function asVector(value) {
  return value?.clone ? value.clone() : new Vector3(value?.[0] || 0, value?.[1] || 0, value?.[2] || 0);
}

function setCameraTarget(camera, target) {
  if (typeof camera.setTarget === 'function') {
    camera.setTarget(asVector(target));
    return;
  }
  const direction = asVector(target).subtract(camera.position).normalize();
  camera.rotation.y = Math.atan2(direction.x, direction.z);
  camera.rotation.x = Math.asin(-direction.y);
}

export function createFreeFlyControls({
  camera,
  canvas,
  scene,
  viewpoints = {},
  defaultSpeed = 0.65,
  onViewpoint = () => {},
} = {}) {
  if (!camera || !canvas || !scene) throw new Error('createFreeFlyControls requires camera, canvas and scene');

  camera.speed = defaultSpeed;
  camera.angularSensibility = 3500;
  camera.inertia = 0.15;
  camera.keysUp = [87];
  camera.keysDown = [83];
  camera.keysLeft = [65];
  camera.keysRight = [68];
  camera.attachControl(canvas, true);

  const vertical = { up: false, down: false };
  const keydown = event => {
    if (event.code === 'Space' || event.code === 'KeyE') vertical.up = true;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.code === 'KeyQ') vertical.down = true;
  };
  const keyup = event => {
    if (event.code === 'Space' || event.code === 'KeyE') vertical.up = false;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.code === 'KeyQ') vertical.down = false;
  };
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);

  const beforeRender = scene.onBeforeRenderObservable.add(() => {
    const delta = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
    const amount = camera.speed * 2.4 * delta;
    if (vertical.up) camera.position.y += amount;
    if (vertical.down) camera.position.y -= amount;
  });

  function setSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) return camera.speed;
    camera.speed = Math.max(0.05, Math.min(20, speed));
    return camera.speed;
  }

  function setViewpoint(name) {
    const viewpoint = viewpoints[name];
    if (!viewpoint) return false;
    camera.position.copyFrom(asVector(viewpoint.position));
    camera.rotationQuaternion = Quaternion.Identity();
    setCameraTarget(camera, viewpoint.target);
    camera.metadata = { ...(camera.metadata || {}), viewpoint: name };
    onViewpoint(name, viewpoint);
    return true;
  }

  function reset() {
    return setViewpoint('spawn') || setViewpoint(Object.keys(viewpoints)[0]);
  }

  reset();

  return {
    camera,
    setSpeed,
    getSpeed: () => camera.speed,
    setViewpoint,
    reset,
    dispose() {
      scene.onBeforeRenderObservable.remove(beforeRender);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      camera.detachControl();
    },
  };
}

export default createFreeFlyControls;
