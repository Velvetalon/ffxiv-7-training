# Babylon Client Preview

The initial v4 Kugane experiment is extended to the existing full client.
The deployment remains isolated from the main application.
Application base: `/ff14-web-babylon-preview/`.
Main application `/ff14-web/`, its renderer and `site/` remain unchanged.

## Source And Scope

The Chinese `world-names-zh.json` entry identifies 黄金港 as Territory 628.
The existing world catalog resolves it to `e3t1`,
`bg/ex2/02_est_e3/twn/e3t1`, Map row 370.

Catalog release: `20260909T124255Z-e3ea44`.
The earlier `-preview128` label described packaging, not the catalog release ID.
Pinned map manifest:
`maps/e3t1/manifest_ab686a714791aad26083e35fe8348e409998a6b3c1d970342f9286f9bd0d33b4.json.gz`.
The source contains 807 model records, 4,461 placements, 324 materials and
112 referenced bundles. These are source model/placement counts, not a count
of GPU draw calls or glTF primitives.

The source-position checker passed for this map only. Its inherited source
visibility and Euler conventions remain the same documented limitations;
old screenshots are not treated as independent position ground truth.

## Reuse And Isolation

`preview/babylon/AssetBridge.js` creates a separate instance of the existing
engine-neutral AssetRuntime. It reuses AssetDelivery authentication, registry,
dependencies, scheduler, bundle/range reader, hash verification and cache policy.
No Three.js decoder or renderer is imported by this boundary. Babylon owns
its meshes, materials, textures and GPU lifetimes.

The preview CacheStorage name is `ff14-babylon-preview-packs-v1`.
It registers no service worker. Shared resource URLs/content are unchanged.
Application configuration contains the pinned map references and only the
Kugane environment profile.

Babylon official `core`, `loaders` and `materials` packages are pinned to the
same version, `9.26.0`.

## Commands

Use a current Node runtime (the workspace has Node 24):

```powershell
npm run dev:babylon
npm run build:babylon
npm run preview:babylon
npm run validate:babylon -- --url=http://127.0.0.1:4173/ff14-web-babylon-preview/
```

The independent build output is `site-babylon-preview/`; the ordinary Vite
configuration and main `site/` output are not used.

For local asset reads without copying the world:

```powershell
$env:BABYLON_ASSET_DIR = 'G:/UGit/ffxiv-7-training/work/asset-performance/packed-all-final'
npm run dev:babylon
```

Development mounts that directory read-only under a separate local URL.
Production builds always use the existing `/ff14-assets/ticket` and
`https://img.yuluo.site/ff14-assets/v1/`, not the development mount.

## Full Client And Viewer

The default entry reuses `src/main.js`, its DOM HUD, combat, settings, audio
and panels. The preview-only Vite resolver redirects World, SandboxAssets
and DeveloperRuntime to native Babylon implementations. The build rejects any
Three.js or three-mesh-bvh module. `?viewer=1&scene=e3t1` retains the focused
map-only camera for the original fixed-view comparison.

All 65 catalog entries are available via `?scene=<id>` and the shared map UI.
The source catalog, bundles and versioned resources are unchanged. Sandbox
models, audio and skill icons reuse `/ff14-web/sandbox/` and `/ff14-web/icons/`.
Preview settings and HUD storage use independent keys.

Full-client acceptance uses the existing fast workflow:

```powershell
npm run validate-fast -- --engine=babylon --url=http://127.0.0.1:4173/ff14-web-babylon-preview/
npm run validate-sandbox -- --url=http://127.0.0.1:4173/ff14-web-babylon-preview/
npm run validate-developer -- --url=http://127.0.0.1:4173/ff14-web-babylon-preview/
node scripts/verify-babylon-deployment.mjs
```

One automated all-map smoke pass and the fixed four representative maps are
used; only failures/outliers are investigated. The sandbox/developer checks
cover migrated gameplay systems separately from the map-only v4 check.
Local builds and HTTP 200 alone are not deployment proof. Build metadata,
entry/script/worker hashes, real browser state and main-site preservation
must be checked. See the deployment document and generated reports under
`work/babylon-preview/` for evidence; unrun checks are not implied by this list.

## Model Allocation

Initial bounded tasks use Luna-Max: scene/controls, material/environment
adapter, and additive deployment preparation. The coordinator owns the raw
asset boundary, configuration and integration. Final scene integration was
escalated to Terra-High for full composed-matrix correctness and native LOD.
After a confirmed Luna channel failure, Terra-High is the conversation fallback.
The full-client character and World integration use Sol-High due to native
skinning, animation retargeting and cross-system integration complexity.
