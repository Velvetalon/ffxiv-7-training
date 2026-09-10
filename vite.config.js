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
        if (!['extracted', 'sandbox'].includes(item)) await fs.cp(path.join(source, item), path.join(destination, item), { recursive: true });
      }
      const externalSandboxRelease = Boolean(process.env.SANDBOX_RELEASE_DIR);
      const sandboxRoot = path.resolve(process.env.SANDBOX_RELEASE_DIR || path.join(source, 'sandbox'));
      const sandboxPublishPath = path.join(sandboxRoot, 'publish-manifest.json');
      let sandboxPublish;
      try {
        sandboxPublish = JSON.parse(await fs.readFile(sandboxPublishPath, 'utf8'));
      } catch (error) {
        throw new Error(`Sandbox release is missing publish-manifest.json: ${sandboxPublishPath}`, { cause: error });
      }
      if (!Array.isArray(sandboxPublish.files) || !sandboxPublish.entry) {
        throw new Error(`Sandbox publish manifest is incomplete: ${sandboxPublishPath}`);
      }
      const sandboxDestination = path.join(destination, 'sandbox');
      await fs.mkdir(sandboxDestination, { recursive: true });
      const sandboxCdn = process.env.SANDBOX_CDN === '1';
      const manifestName = sandboxCdn ? 'manifest.cdn.json' : (externalSandboxRelease ? sandboxPublish.entry : 'manifest.json');
      const manifestSource = path.join(sandboxRoot, manifestName);
      try {
        await fs.copyFile(manifestSource, path.join(sandboxDestination, 'manifest.json'));
      } catch (error) {
        throw new Error(`Sandbox manifest is missing: ${manifestSource}`, { cause: error });
      }
      if (!sandboxCdn) {
        const files = externalSandboxRelease
          ? sandboxPublish.files.filter(item => item.path !== sandboxPublish.entry)
          : Object.values(JSON.parse(await fs.readFile(manifestSource, 'utf8')).bundles || {}).map(bundle => ({ path: bundle.url }));
        for (const item of files) {
          if (!item || typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) {
            throw new Error(`Sandbox asset path is unsafe: ${item?.path}`);
          }
          const target = path.join(sandboxDestination, item.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(sandboxRoot, item.path), target);
        }
      }
      const extracted = path.join(source, 'extracted');
      const active = JSON.parse(await fs.readFile(path.join(extracted, 'active.json'), 'utf8'));
      const published = { ...active, scenes: {} };
      if (process.env.ASSET_PIPELINE_DIR) {
        const pipeline = path.resolve(process.env.ASSET_PIPELINE_DIR);
        const release = JSON.parse(await fs.readFile(path.join(pipeline, 'publish-manifest.json'), 'utf8'));
        const catalog = JSON.parse(await fs.readFile(path.join(pipeline, release.entry), 'utf8'));
        for (const id of Object.keys(catalog.maps)) {
          if (!active.scenes[id]) throw new Error(`Unknown packed map: ${id}`);
          published.scenes[id] = { ...active.scenes[id], base: `${active.runId}/${id}/` };
        }
        if (process.env.ASSET_CDN_TICKET) {
          published.assetPipeline = { ticket: process.env.ASSET_CDN_TICKET };
          await fs.mkdir(path.join(destination, 'extracted'), { recursive: true });
          await fs.writeFile(path.join(destination, 'extracted', 'active.json'), JSON.stringify(published));
          return;
        }
        const assetDestination = path.join(destination, 'assets', 'world');
        await fs.mkdir(assetDestination, { recursive: true });
        for (const item of release.files) {
          const sourceFile = path.resolve(pipeline, item.path);
          const relative = path.relative(pipeline, sourceFile);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid packed asset path');
          const target = path.join(assetDestination, item.path);
          await fs.mkdir(path.dirname(target), { recursive: true });
          if (process.env.ASSET_PIPELINE_LINKS === '1') {
            await fs.link(sourceFile, target).catch(() => fs.copyFile(sourceFile, target));
          } else await fs.copyFile(sourceFile, target);
        }
        published.assetPipeline = { manifest: `../assets/world/${release.entry}`, base: '../assets/world/' };
        await fs.mkdir(path.join(destination, 'extracted'), { recursive: true });
        await fs.writeFile(path.join(destination, 'extracted', 'active.json'), JSON.stringify(published));
        return;
      }
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
