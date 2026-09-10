export class ResourceRegistry {
  constructor() {
    this.resources = new Map();
    this.aliases = new Map();
  }

  register(id, record) {
    const previous = this.resources.get(id);
    if (previous && previous.hash !== record.hash) throw new Error(`Resource identity collision: ${id}`);
    if (!previous) this.resources.set(id, { dependencies: [], ...record, id });
    return this.resources.get(id);
  }

  addManifest(manifest) {
    for (const [id, record] of Object.entries(manifest.resources)) this.register(id, record);
    for (const [alias, id] of Object.entries(manifest.aliases || {})) this.aliases.set(alias, id);
    // Check references here, not repeatedly while a scene is being assembled.
    for (const [id, record] of this.resources) {
      for (const dependency of record.dependencies) {
        if (!this.resources.has(dependency)) throw new Error(`Missing dependency ${dependency} of ${id}`);
      }
    }
    const visited = new Set(), visiting = new Set();
    const visit = id => {
      if (visiting.has(id)) throw new Error(`Cyclic asset dependency: ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.resources.get(id).dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of this.resources.keys()) visit(id);
  }

  get(id) {
    const record = this.resources.get(this.aliases.get(id) || id);
    if (!record) throw new Error(`Unknown resource: ${id}`);
    return record;
  }
}
