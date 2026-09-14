# Babylon Materials, Environment And Color Diagnostics

**Color closure:** repaired pixel comparisons validate the shared correction
on two source models and three whole-map views. Limsa remains an explicit
whole-frame threshold exception, not a fourth passing color result.
Acceptance, limitations and release evidence are recorded in
[BABYLON-COLOR-CLOSURE.md](BABYLON-COLOR-CLOSURE.md).

This document describes the isolated Babylon preview adapter for `e3t1`
(Kugane, territory `628`). It is intentionally scoped to the v4 preview and
does not change the existing Three.js renderer. The shared adapters also serve
the other maps. The color audit supersedes the earlier assumption that every
field named `specular` contains RGB specular color.

## Source Inventory

The inventory below is computed from the pinned map manifest:

`work/asset-performance/packed-all-final/maps/e3t1/manifest_ab686a714791aad26083e35fe8348e409998a6b3c1d970342f9286f9bd0d33b4.json.gz`

| Source field | Count | Babylon treatment |
| --- | ---: | --- |
| Material records | 324 | One source record per material path; cached by path and available vertex channels. |
| `bg.shpk` | 314 | Native PBR dielectric with the packed `_s` map's G roughness channel; no RGB mask tint. |
| `water.shpk` | 6 | Native PBR water approximation with source wave normal where available. |
| `river.shpk` | 1 | Same native PBR approximation; river-specific flow/refraction remains unsupported. |
| `bgprop.shpk` | 1 | Native PBR path. |
| `crystal.shpk` | 2 | Native PBR with source emission; crystal environment effect remains unsupported. |
| Diffuse channel | 317 | `albedoTexture`, sRGB/gamma-space texture. |
| Normal channel | 317 | `bumpTexture`, source UV scale, explicit source Y inversion. |
| Historical `specular` field | 317 | For `bg.shpk`, `_s` is a packed mask, not RGB reflectivity. Other shader families retain their separate handling. |
| Secondary diffuse | 13 | Local `MaterialPluginBase` hook using native PBR lighting, UV1 and `COLOR_0.a` blend weight. |
| Secondary normal | 13 | Reported as unsupported; no old shader is copied into Babylon. |
| Effect textures | 9 | Water waves are used as native bump input when mapped; crystal/environment effects are reported separately. |
| Emissive records | 39 | Source emissive color and diffuse-as-emission link are preserved when no separate emissive sampler exists. |
| Alpha-test records | 32 | `PBRMATERIAL_ALPHATEST` and source `alphaThreshold`. |
| Double-sided records | 8 (`flags = 12`) | `backFaceCulling = false` only for records whose source flag requires it. The remaining 316 records are not forced double-sided. |
| Non-default color UV scale | 1 | Source `colorUVScale` is applied to the relevant Babylon texture. |

The manifest's runtime `textures/*.webp` and `textures/*.png` paths are used
for AssetBridge lookups. The original `.tex` paths remain in
`material.metadata.ffxiv.channels` for diagnostics and provenance.

## Material Mapping

`preview/babylon/MaterialAdapter.js` accepts the v4 `AssetBridge` contract:

```js
const adapter = new MaterialAdapter({ scene, assets });
const material = await adapter.getMaterial(materialPath, mesh, { priority: 10 });
await adapter.upgradeMaterial(material);
```

The adapter never stores Babylon objects in `AssetRuntime`. `BabylonTextureCache`
owns the browser `Texture` objects and obtains only byte payloads from
`assets.texture(path, { preview, priority })`.

### Workflow choice

The serialized field name `specular` does not establish RGB reflectivity.
For `bg.shpk`, `_s` contains independent channels: G is roughness; R/B are
separate specular masks whose precise combination is not reproduced here.
Sampled soil/grass/wood masks have very little blue and substantial green.
Feeding those channels to RGB reflectivity introduces yellow/green specular tint.

The background adapter uses native `PBRMaterial` with `metallic = 0`,
`roughness = 1`, and the existing linear `_s` image in `metallicTexture`.
Only green-channel roughness is enabled. Alpha roughness, blue metallic and
red AO are explicitly disabled. Native neutral dielectric reflectance remains;
no inverse filter or per-map compensation is applied. Albedo and normal
resources are unchanged.

This does not claim the source was authored in standard MR format: it is a
native PBR implementation of the supported scalar channel. R/B behavior is
retained in metadata and reported as `bg-specular-mask-rb`, not silently
interpreted as color, AO or metallic. Other shader families are not forcibly
remapped to this background workflow.

Records without a specular channel use a conservative dielectric fallback
(`metallic = 0`, `roughness = 0.82`) and are marked in the material metadata as
`metallic-roughness-fallback`; this is a compatibility fallback, not a claim
that the client source was authored in the MR workflow.

### Texture orientation and color space

- Diffuse, secondary diffuse and emissive textures use sRGB/gamma-space GPU
  storage; normal and specular textures use linear storage.
- All external texture loads use `invertY: false`, matching the existing GLB
  UV orientation and the source runtime's `flipY = false` boundary.
- The source normal Y convention is kept explicit as
  `material.metadata.ffxiv.sourceNormalYInverted = true` and
  `PBRMaterial.invertNormalMapY = true`. This is not Babylon's glTF default;
  it is an isolated FF14 source choice retained from the existing material
  adapter after checking the native Babylon property rather than flipping
  every normal map unconditionally.
- UV scales are applied to the Babylon texture (`uScale`/`vScale`), not baked
  into converted image files.

### Alpha, culling and emission

Source alpha thresholds select Babylon alpha-test mode. Water and river records
select alpha blend mode with a scoped opacity approximation. Source culling
flags select `backFaceCulling`; there is no global double-sided override.
Source emissive colors are applied directly. Where the source record contains
emission but no separate emission sampler, the source diffuse texture is linked
as the emissive texture, matching the existing client-material semantic note.

### Secondary diffuse blend

The 13 records with `colorMap1`/`secondaryMap` use a small
`KuganeSecondaryBlendPlugin`. It injects only:

1. `uv2` as the secondary UV input.
2. `kuganeSecondarySampler` for the second diffuse texture.
3. `COLOR_0.a` as the source blend weight.
4. A blend before Babylon's native PBR lighting stage.

The primary albedo, normal mapping, specular/glossiness response, alpha and
IBL remain Babylon PBR code. Secondary normal blending is reported as
`secondary-normal-blend` because no source proof justifies a larger shader
port.

## Environment Mapping

`preview/babylon/EnvironmentAdapter.js` consumes the `profile` object already
embedded in the v4 `app-config.json`; it does not import the old Three.js
environment runtime or bundle all 65 source profiles.

For e3t1, the confirmed profile source is:

- Evidence: `confirmed-decoded-envb-adapter`
- Territory: `628`
- Zone root: `bg/ex2/02_est_e3/twn/e3t1`
- ENVB: `bgcommon/env/global/ex2_genv/genv_est_e3/genv_e3_twn/genv_e3t1.envb`
- SHA-256: `13aa4d78c88e8cf90677b221a088e738e73d4bcb11cd973cccb30f49a9d53aec`
- Source format: `xivdev/file-formats` commit `ac1a01571fa7152d521e5d5f8af8e694915466a8`, `imhex/env.hexpat`

The adapter interpolates the 13 source owner-1 samples and applies:

- sun and moon colors/intensities;
- source `ambientScale` as a multiplier on a separately named Babylon
  hemispheric-light engine value;
- source ambient saturation, additional ambient color/weight and fog color;
- source fog near/far distances and a linear Babylon fog mode;
- independent direct-light, IBL and image-processing exposure controls.

`toneMappingTimeSeconds` is retained in diagnostics but is not incorrectly
treated as a browser exposure scalar.

### IBL provenance

The e3t1 manifest contains a 128x128 `_n_envmap_004.tex` reference for the
crystal material, but it is a 2D effect texture, not a validated zone cubemap
or prefiltered environment texture. The adapter therefore creates a native
Babylon `RawCubeTexture` from source-tinted sky, horizon and ground colors and
attaches a native `SphericalPolynomial` to it. `scene.environmentTexture` is
set to that cube, so Babylon PBR receives both reflection and diffuse
irradiance contribution.

Diagnostics label this as:

```text
source-tinted-procedural-approx
```

This is an explicit approximation and is not claimed to be the game's sky or
cubemap parity. The adapter does not use Babylon's public playground/default
environment as an unlabelled Kugane source. A future validated zone cubemap
can be supplied through `setEnvironmentTexture(texture, { provenance })`.

Spherical harmonics follow Babylon's normalization sequence: incident radiance
to irradiance, then Lambertian radiance, then spherical polynomial. Babylon
performs the rendering pre-scale when needed. The old adapter omitted the
Lambertian `1/pi`: its uploaded coefficients were uniformly pi times the native
cubemap reference. The corrected coefficients match that reference. This is
an energy correction, not a green-channel filter.

## Debug Render Modes

The viewer controls and the full client's developer Environment tab expose:

- `full`: final rendering with source settings.
- `neutral`: canonical base material, white lights and neutral clear color,
  without fog, IBL or image-processing effects.
- `albedo`: unlit base/albedo view.
- `albedo-normal`: neutral-light base/albedo plus normals.
- `normal`: unlit diagnostic RGB view of the normal-map input, with fog, IBL and image processing disabled.
- `lighting`: white-albedo PBR lighting-only view using source direct lights, IBL, normal maps, metallic/reflectivity maps, roughness/microSurface and source intensities; albedo/emissive/AO/lightmap/secondary-color textures and vertex colors are disabled, with fog and image processing disabled.
- `pbr-no-environment`: PBR/direct-light path without IBL, fog or image effects.

Vertex color, AO and extra-color contributions can be disabled independently.
Untouched switches inherit source settings; restoring a switch does not force
vertex colors onto all meshes. Extra-color isolation includes base-color
multipliers, emission, lightmaps and secondary diffuse.

```js
const debug = window.__BABYLON_PREVIEW__?.renderDebug
  || window.__APP__.world.renderDebug;
debug.setMode('neutral').apply();
debug.setMode('full').setContributions({ vertexColors: false }).apply();
const parameters = debug.dump();
debug.setContributions({ vertexColors: null, ao: null, extraColor: null }).apply();
```

The controller restores original scene/material state and tracks streamed
resource changes without re-dirtying stable PBR definitions every frame.

The scoped audit extends the existing validator; it does not run all maps:

```powershell
node scripts/validate-babylon.mjs --color-audit --url=<preview-base-url> `
  --label=before --maps=e3t1,limsa,gridania,d2t1 --out=work/color-audit
```

Before/after runs must share camera, viewport, time, sample ResourceIDs,
material resolution and foreground masks. Lower raw green values alone do
not prove hue correction: retain RGB/parameter dumps and compare
brightness-normalized chroma.

## Diagnostics Contract

`MaterialAdapter.diagnostics()` returns source shader/flag/channel counts,
created and upgraded material counts, texture bytes, known unsupported
categories, missing material/texture/channel records, and normal-map
orientation metadata.

`EnvironmentAdapter.diagnostics()` returns the active source sample, sun/moon,
ambient and fog values, IBL provenance/readiness, image-processing exposure,
and unsupported environment categories. `knownUnsupported` and `missing` are
separate objects so a missing CDN/resource request is not presented as a
shader limitation.

## Babylon API Evidence

The implementation is pinned to `@babylonjs/core`, `@babylonjs/loaders` and
`@babylonjs/materials` `9.26.0`. The native API surfaces used here are:

- `PBRMaterial.metallic`, `roughness`, `reflectivityTexture`,
  `reflectivityColor`, `microSurface`, `invertNormalMapY`,
  `environmentIntensity`, `directIntensity`, `transparencyMode` and
  `alphaCutOff`.
- `Texture` creation with `invertY: false`, `useSRGBBuffer`, UV scale and
  wrap controls.
- `MaterialPluginBase` custom-code hooks around the native PBR shader.
- `RawCubeTexture` plus `SphericalPolynomial` assigned to
  `scene.environmentTexture`.

Primary package source and declarations were checked from the exact
`@babylonjs/core@9.26.0` package before implementation. No custom whole-client
shader is used.
