import { mapAssetRuntime } from './MapAssets.js';

export class SandboxAssets {
  constructor(runtime = mapAssetRuntime) {
    this.runtime = runtime;
    this.manifest = null;
    this.promise = null;
  }

  async initialize(url = `${import.meta.env.BASE_URL}sandbox/manifest.json`) {
    if (!this.promise) this.promise = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Sandbox asset manifest HTTP ${response.status}`);
      const manifest = await response.json();
      this.runtime.configure(manifest, new URL('./', new URL(url, location.href)));
      this.manifest = manifest;
      return manifest;
    })().catch(error => { this.promise = null; throw error; });
    return this.promise;
  }

  async loadCmp(url = `${import.meta.env.BASE_URL}sandbox/human.cmp`) {
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    } catch { return null; }
  }

  getCharacter(appearance) {
    const characters = Object.values(this.manifest?.characters || {});
    return characters.find(character => {
      if (!appearance) return true;
      const match = character.appearanceMatch || character.appearance;
      return match?.race === appearance.race && match?.tribe === appearance.tribe && match?.sex === appearance.sex &&
        (match.face === undefined || match.face === appearance.face) &&
        (match.hair === undefined || match.hair === appearance.hair);
    }) || null;
  }

  get mounts() { return Object.values(this.manifest?.mounts || {}); }
  get skills() { return this.manifest?.skills || {}; }
  get sceneBgm() { return this.manifest?.sceneBgm || {}; }
}
