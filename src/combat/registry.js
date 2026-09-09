const jobs = new Map();

export function registerJob(plugin) {
  if (!plugin || !plugin.id || typeof plugin.createState !== 'function') {
    throw new Error('Invalid combat job plugin');
  }
  jobs.set(plugin.id, plugin);
}

export function getJobPlugin(jobId) {
  return jobs.get(jobId);
}

export function hasJobPlugin(jobId) {
  return jobs.has(jobId);
}

