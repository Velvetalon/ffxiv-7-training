import assert from 'node:assert/strict';
import { DutyTransport } from '../../src/world/duties/DutyTransport.js';
import { normalizeDutyEntrances } from '../../src/world/duties/entranceGates.js';

const duty = {
  dutyKey: 'sastasha',
  sceneKeys: ['s1f4'],
  entrance: { x: 1, y: 2, z: 3 },
};
const catalog = { schemaVersion: 1, duties: [duty], unavailable: false };

function createTransport() {
  const changes = [];
  return {
    changes,
    transport: new DutyTransport({
      scenes: [{ id: 's1f4' }],
      catalog,
      getPosition: () => ({ x: 10, y: 20, z: 30 }),
      setPosition: point => changes.push({ ...point }),
      saveCamera: () => ({ azimuth: 1, polar: 2, distance: 3 }),
      restoreCamera: () => {},
      teleport: () => ({ ok: true }),
      getSceneId: () => 'limsa',
      timeoutMs: 1000,
    }),
  };
}

{
  const { transport, changes } = createTransport();
  assert.equal(transport.canEnter('missing').ready, false);
  assert.equal(transport.canEnter('sastasha').ready, true);
  const result = transport.enter('sastasha');
  assert.equal(result.ok, true);
  assert.equal(transport.complete('s1f4'), true);
  assert.deepEqual(changes, [{ x: 1, y: 2, z: 3 }]);
  assert.equal(transport.snapshot().returnStack.length, 1);
}

{
  const inactive = new DutyTransport({
    scenes: [{ id: 'limsa' }],
    catalog: { duties: [{ ...duty, sceneKeys: ['hidden-dungeon'] }] },
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    setPosition: () => {},
    saveCamera: () => ({}),
    restoreCamera: () => {},
    teleport: () => ({ ok: true }),
    getSceneId: () => 'limsa',
  });
  assert.equal(inactive.canEnter('sastasha').reason, '场景未构建');
}

{
  const { transport } = createTransport();
  transport.enter(duty);
  transport.sync(true);
  assert.equal(transport.pending, null);
  assert.equal(transport.snapshot().returnStack.length, 0);
}

{
  const entrances = normalizeDutyEntrances({
    entrances: [{
      dutyKey: ' sastasha ',
      fromSceneId: 's1f4',
      position: { x: '1', y: 2, z: 3 },
      radius: '5',
    }, { dutyKey: 'broken' }],
  });
  assert.equal(entrances.length, 1);
  assert.equal(entrances[0].dutyKey, 'sastasha');
  assert.equal(entrances[0].radius, 5);
}
