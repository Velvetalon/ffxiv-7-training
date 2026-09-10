import { defineConfig } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';

// Build only the selected maps, never old or failed local extraction releases.
function selectedPublicAssets() {
  let config;
  return {
    name: 'selected-public-assets',
    apply: 'build',
    configResolved(value) { config = value; },
    async closeBundle() {
      const source = path.join(config.root, 'public');
      const destination = path.resolve(config.root, config.build.outDir);
      for (const item of await fs.readdir(source)) {
        if (item !== 'extracted') await fs.cp(path.join(source, item), path.join(destination, item), { recursive: true });
      }
      const extracted = path.join(source, 'extracted');
      const active = JSON.parse(await fs.readFile(path.join(extracted, 'active.json'), 'utf8'));
      const published = { ...active, scenes: {} };
      for (const id of Object.keys(active.scenes)) {
        const record = active.scenes[id];
        if (!record) throw new Error(`Missing map in active.json: ${id}`);
        const mapSource = path.resolve(extracted, record.base);
        const relative = path.relative(extracted, mapSource);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Map path escaped extracted/: ${id}`);
        const releasePath = `${active.runId}/${id}/`;
        await fs.cp(mapSource, path.join(destination, 'extracted', releasePath), { recursive: true });
        published.scenes[id] = { ...record, base: releasePath };
      }
      await fs.writeFile(path.join(destination, 'extracted', 'active.json'), JSON.stringify(published, null, 2) + '\n');
    },
  };
}

export default defineConfig(({ command }) => ({
  base: './',
  publicDir: command === 'build' ? false : 'public',
  plugins: [selectedPublicAssets()],
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'], icons: ['lucide'] },
      },
    },
  },
}));
