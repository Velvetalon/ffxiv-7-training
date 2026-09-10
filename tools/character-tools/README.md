# CharacterTools

Offline, read-only conversion tools for FFXIV character and mount assets. The tools never attach to or modify the game process.

## Inputs

- Installed client SqPack files, read through Meddle/Lumina.
- SKLB/PAP tagfile dumps and spline samples produced by the existing `tools/animation-lab` hkxparse/HavokLib bridge.
- Extracted MDL files and a merged skeleton JSON.

## Build

The default `MeddleRoot` is `../map-tools/Meddle/Meddle`, populated by the map-tools bootstrap. A separate checkout can be supplied without changing the project:

```powershell
dotnet build .\tools\character-tools\CharacterTools.csproj `
  -p:MeddleRoot=G:\FFXIV-MapTools\Meddle\Meddle
```

## Commands

```text
CharacterTools raw <client-root> <virtual-path> <output-file>
CharacterTools appearance-map <client-root> <tribe> <sex> <hair> <face-paint>
CharacterTools appearance-colors <client-root> <tribe> <sex> <skin> <hair> <highlight> <right-eye> <left-eye> <lip> <face-paint>
CharacterTools skinned-glb <skeleton.json> <colors.json> <geometry.json> <material-textures.json> <output.glb> <game-path=mdl> [...]
CharacterTools inspect-model <extracted.mdl>
CharacterTools mount-scan <client-root>
```

`build_skeleton_json.py` merges the base and partial SKLB skeletons by their shared bone names. `spline_probe.cpp` is the existing animation-lab bridge with one addition: selecting a PAP Havok animation index and its matching binding. `build_animation_glb.py` packages the samples into a bone-name-addressable animation GLB.

`bake_hair_texture.py` implements the `hair.shpk` baseline documented by Penumbra's `MaterialExporter`: interpolate main/highlight color by normal blue and apply mask alpha. `convert_tex.py` covers BC4/BC5 character decal TEX files that the map texture converter does not need.

The converter truncates skinning to the first four MDL influences and renormalizes them because the current Three.js material path uses four influences. It records this in GLB extras.
