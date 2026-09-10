import { simplifyLevels } from './LodSimplifier.js';

self.onmessage = async ({ data }) => {
  try {
    const levels = await simplifyLevels(data);
    self.postMessage({ id: data.id, levels }, levels.map(level => level.indices.buffer));
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
