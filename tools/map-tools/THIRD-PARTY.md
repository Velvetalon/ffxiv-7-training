# Third-party references

- Meddle: `https://github.com/PassiveModding/Meddle`, fixed by `bootstrap-map-tools.ps1` to commit `7ef61f44f82c6363465d46b46e963a054d431c16` (GitHub Actions, 2026-08-22, `Update repo.json for v0.1.56.0`). MapExtract references its SqPack/Formats projects and links its model parser source. Upstream license: AGPL-3.0; retain `LICENSE-Meddle.txt`, and the bootstrap checkout retains `Meddle/LICENSE.txt`.
- NuGet packages: Meddle's pinned checkout declares exact direct versions (including Microsoft.Extensions 10.0.1, SharpGLTF 1.0.5 and SkiaSharp 3.119.0). Its committed package lock files are honored by `build.ps1` and the batch pipeline through `RestoreLockedMode=true`; restore cannot float to a different resolved graph.
- Lumina: `https://github.com/NotAdam/Lumina`. Reference only for binary LGB/SGB layer and PCB structures; it is neither required by the source bootstrap nor shipped in the source package.
- Physis: `https://github.com/redstrate/Physis`. PCB binary-layout reference only; it is not a runtime dependency.
- three-mesh-bvh: resolved by the trainer workspace's npm installation, not by this tool source package.

Game exports, the Meddle checkout, portable SDK, NuGet cache and built binaries are local/generated artifacts. They are not source-package inputs and are never downloaded from or written to a game installation by bootstrap.
