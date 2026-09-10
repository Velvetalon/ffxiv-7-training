# Unified Asset Pipeline

The application keeps gameplay code on the web server. Converted resource bytes are published to COS and fetched directly from CDN. Build-time dependency analysis decides what belongs together; the browser follows manifests rather than rediscovering the exported asset graph.

```text
Client extraction / conversion
    → Reference Analyzer
    → Bundle Planner
    → content-hashed packs + map manifests + small catalog
    → incremental COS publisher
    → CDN
    → AssetRuntime
```

## Resource identity and ownership

Binary ResourceIDs include their type and SHA-256. Map-relative filenames are aliases, not identities. Model assembly records preserve the original placement matrices and refer to geometry blobs and material resources separately: the same GLB bytes can be used with different material mappings.

Registry records contain `type`, `hash`, `size`, `dependencies`, runtime metadata, and either a virtual decoder record or a bundle/offset/length location. Decoders are registered by type. The map integration provides GLB, texture, texture-view, material and collision-navigation decoders; future character, animation, mount, audio and VFX importers can emit the same records and register their own decoders.

`load(id)`, `preload(ids)`, `get(id)` and `release(id)` are implemented in `src/assets/AssetRuntime.js`. A successful retained load must be released. Dependencies stay retained while the parent is cached; evicting a parent releases its dependency references. Concurrent consumers share fetch and decode work. Cancelling one consumer does not cancel other consumers.

The runtime tracks encoded pack memory separately from decoded resources. GPU texture views are keyed by source texture, color space and sampler transform, so one material cannot mutate another material's UV settings. Instanced geometry remains shared; scene-specific instance buffers and materials are released when leaving the scene. Do not unconditionally dispose runtime-owned textures or geometry from a gameplay module.

## Reference analysis

```sh
node scripts/assets/reference-analyzer.mjs --scenes gridania,limsa --out work/asset-performance/reference-analysis
```

Omitting `--scenes` selects the active catalog. The analyzer reads actual GLB primitive material paths, source material texture references, geometry accessor bounds and placement transforms. It reports resource types and sizes, dependency edges, reference counts, cross-map sharing, model/material co-occurrence and bootstrap candidates.

Bootstrap membership uses transformed geometry bounds. Using only a model's origin would miss large terrain meshes. Scene/model owner records keep contextual material relationships separate from geometry identity. Analysis files may contain local source paths and belong in ignored build work; published manifests contain no developer filesystem paths.

## Bundle planning

```sh
node scripts/assets/bundle-planner.mjs --analysis work/asset-performance/reference-analysis/reference-analysis.json --out work/asset-performance/packed
```

The heuristic separates shared resources by both their exact set of owning maps and their set of bootstrap users. This avoids pulling unrelated maps' assets through a global shared pack. Map-local bootstrap uses the runtime's 35-unit radius; remaining resources are grouped by spatial location and type. Geometry, textures and collision are not mixed indiscriminately. Target pack size is configurable; the initial experiment uses 8 MiB and records oversized individual resources.

Each pack starts with the eight-byte `AETHPAK1` marker and contains aligned raw resource slices. Offset/length indexes live in the manifests. There is no solid compression stream. Texture files and compressed collision retain their existing encoding and exact bytes.

Every pack URL contains its content hash. A small content-hashed catalog points to per-map content-hashed manifests, so entering one map does not fetch the entire world registry. The publication control file lists exact object paths, sizes and hashes. The publisher must verify this list before upload.

The first implementation exposes a Range policy but leaves it disabled unless measurement supplies thresholds. `AssetRuntime.planResources()` compares requested bytes with bundle size; an enabled policy may select individual verified slices. A server returning the whole pack to a Range request is handled explicitly. Both full-pack and partial-resource reads verify length and SHA-256.

## Loading and profiling

With `active.assetPipeline` present, the map loader uses the registry and packs. Without it, the original extracted-resource path remains available for comparisons and recovery.

The new path loads source collision and builds its BVH in a worker while preparing geometry and materials around the arrival location. After the initial area is ready, it mounts the actual map and enables input; remaining resources stream by distance with lower priority. Movement checks nearby visual and collision coverage while streaming.

The preview postprocessor emits a small texture tier, with a maximum dimension of 128 pixels, and gzip map manifests. Even textures already below that limit receive a preview-tier location: otherwise one tiny texture could force an unrelated multi-megabyte full-resolution pack into the initial load. Once interactive, materials progressively switch to the untouched full-resolution textures. `Fully Loaded` waits for these upgrades as well as model loading. This temporary preview tier does not replace source textures in the final scene.

Large collision resources can be split without clipping or simplifying triangles. The collision postprocessor groups source triangles by spatial cell, stores independently compressed chunks in nearby tile packs, and records each chunk's actual triangle bounds. A streaming navigation adapter keeps the same raycast, slope and step rules while querying loaded chunk BVHs. Near chunks enable early interaction; the background loader prepares the original complete collision BVH and then promotes it atomically. This avoids running thousands of tiny BVH worker jobs just to reach full completion. Triangle preservation and representative query parity are checked separately from visual rendering.

`window.__ASSET_PROFILER__.snapshot()` exposes stage marks and long tasks. `window.__ASSET_RUNTIME__.trace` exposes ResourceID, map, priority, request/ready timestamps, fetch bytes, decode duration and cache events. GPU upload queue timing is **CPU submission duration**, not a GPU execution measurement.

For benchmarks, align every event to the same trigger:

- Direct navigation: navigation time origin.
- In-app map selection: timestamp captured before the selection.
- Profiler marks: absolute `event.at`, minus that trigger.

Do not compare a profiler-relative duration that excludes startup with a navigation-relative baseline. Record technical renderer submission, first visible render, input enabled, Interactive and Fully Loaded separately. First visible render and Interactive require the loading overlay to be hidden and non-blocking; a draw behind an opaque loading screen is not user readiness. Background progress must not reopen the loading overlay. A background stream is complete only after all expected models and full texture upgrades finish and no stream error remains. A stale renderer draw-call count does not prove that the new scene has rendered.

Use CDP request IDs for transport counts/bytes and browser ResourceTiming for timings and its cache heuristic. Increase ResourceTiming's buffer before loading. CDP transport bytes, encoded body bytes and decoded bytes are different measurements; report them separately. Include the CDN origin when collecting resource timing, and remove signing query parameters before saving traces.

## COS and CDN

```sh
python scripts/assets/publish-cos.py --dir work/asset-performance/packed --prefix ff14-assets/v1
```

The default invocation verifies locally and performs a dry run. `--apply` uploads missing immutable objects; `--activate` updates the small current pointer only after verification. Credentials are provided through the publisher process environment. Existing objects are skipped only when size and SHA metadata match. Partial publication must never activate an incomplete release.

The current shared CDN uses URL authentication. `scripts/asset-ticket-server.mjs` provides an isolated, small ticket endpoint; it signs only the publication allowlist and never transfers pack bytes. Its secret stays on the server. The browser caches by content identity rather than the changing signature query string. Batch mode returns only catalog/manifest tickets initially; resource tickets are requested in bounded groups for the selected map. An expired authorization can be refreshed without changing the resource's cache identity.

Configuration must preserve other applications sharing the bucket/CDN: merge download CORS with existing upload rules; verify Range, exposed headers and timing access; keep signed query parameters from fragmenting the CDN cache; and give content-hashed objects long-lived caching. Deployment-specific domains, credentials, backups and observed results belong in ignored deployment records.

## Building a standalone packed artifact

Set `ASSET_PIPELINE_DIR` to the planner output before building:

```powershell
$env:ASSET_PIPELINE_DIR = 'G:\path\to\packed'
npm run release
```

This copies only the selected catalog and its publication file list into the build and writes its asset-pipeline pointer. Clear the environment variable to build the legacy extracted artifact. A two-map experiment is not a 65-map release: full publication still requires all catalog entries, source connections and representative arrival checks.

Runtime semantic checks are available via `node scripts/assets/verify-runtime.mjs` and `node scripts/assets/verify-delivery.mjs`; existing combat and camera checks remain applicable. Performance targets require browser measurements from the deployed byte path, not passing unit checks or a more modular source tree.
