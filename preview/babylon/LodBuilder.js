const LEVELS = Object.freeze([
  { distance: 65, ratio: 0.55 },
  { distance: 150, ratio: 0.25 },
]);

function copyIndices(indices) {
  const maximum = indices.reduce((value, index) => Math.max(value, index), 0);
  const Type = maximum > 65535 ? Uint32Array : Uint16Array;
  return new Type(indices);
}

/**
 * Runs the existing meshoptimizer-based source LOD rules in a module worker.
 * The returned index buffers deliberately retain the source vertex attributes
 * and material: Babylon only swaps index buffers at each native LOD distance.
 */
export function createLodBuilder({ onError = () => {} } = {}) {
  const worker = new Worker(new URL('../../src/world/imported/LodWorker.js', import.meta.url), { type: 'module' });
  const requests = new Map();
  let nextId = 1;
  let disposed = false;

  worker.onmessage = event => {
    const { id, levels, error } = event.data || {};
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    if (error) request.reject(new Error(error));
    else request.resolve((levels || []).map(level => ({ ...level, indices: copyIndices(level.indices) })));
  };
  worker.onerror = event => {
    const error = new Error(event.message || 'Kugane LOD worker failed');
    for (const request of requests.values()) request.reject(error);
    requests.clear();
    onError(error);
  };

  function simplify(mesh) {
    if (disposed) return Promise.reject(new Error('Kugane LOD builder is disposed'));
    const positions = mesh.getVerticesData?.('position');
    const indices = mesh.getIndices?.();
    if (!positions || !indices || indices.length < 18) return Promise.resolve([]);
    const id = nextId++;
    const positionsCopy = new Float32Array(positions);
    const indicesCopy = copyIndices(indices);
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      worker.postMessage({
        id,
        indices: indicesCopy,
        positions: positionsCopy,
        // The source buffers remain on the Babylon mesh. Positions guide the
        // simplifier while normal, UV, color and tangent buffers remain exact.
        attributes: positionsCopy,
        stride: 3,
        weights: [1, 1, 1],
      }, [indicesCopy.buffer, positionsCopy.buffer]);
    });
  }

  return {
    levels: LEVELS,
    simplify,
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error('Kugane LOD builder disposed before completion');
      for (const request of requests.values()) request.reject(error);
      requests.clear();
      worker.terminate();
    },
  };
}

export default createLodBuilder;
