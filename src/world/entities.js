export class EntityRegistry {
  constructor() {
    this.entities = new Map();
  }

  clear() {
    this.entities.clear();
  }

  register(entity) {
    if (!entity?.id || !entity?.object) throw new Error('Entity requires an id and Three.js object');
    this.entities.set(entity.id, entity);
    entity.object.traverse((node) => {
      if (node.isMesh || node.isSprite) node.userData.entityId = entity.id;
    });
    return entity;
  }

  spawn(entity) {
    return this.register(entity);
  }

  get(id) {
    return this.entities.get(id) || null;
  }

  values() {
    return [...this.entities.values()];
  }

  nearestTarget(position) {
    let nearest = null;
    let distance = Infinity;
    this.entities.forEach((entity) => {
      if (entity.type !== 'dummy' && entity.type !== 'monster') return;
      const next = position.distanceTo(entity.object.position);
      if (next < distance) {
        nearest = entity;
        distance = next;
      }
    });
    return nearest;
  }

  pickRoots() {
    return this.values().map((entity) => entity.object);
  }

  setTargetVisual(entity) {
    this.entities.forEach((value) => {
      if (value.type !== 'dummy' && value.type !== 'monster') return;
      const active = value === entity;
      const ring = value.object.getObjectByName('target-ring');
      const marker = value.object.getObjectByName('target-marker');
      if (ring) ring.visible = active;
      if (marker) marker.visible = active;
    });
  }

  getInfo() {
    return this.values().map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      x: Number(entity.object.position.x.toFixed(2)),
      z: Number(entity.object.position.z.toFixed(2)),
    }));
  }
}
