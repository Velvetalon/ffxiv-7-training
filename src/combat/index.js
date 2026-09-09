import { CombatEngine } from './engine.js';
import { JOBS } from './data.js';
import { registerJob, hasJobPlugin } from './registry.js';
import whm from './jobs/whm.js';
import pct from './jobs/pct.js';
import rpr from './jobs/rpr.js';

[whm, pct, rpr].forEach(registerJob);

export { JOBS };

export function createCombat(jobId = 'WHM') {
  return new CombatEngine(hasJobPlugin(jobId) ? jobId : 'WHM');
}
