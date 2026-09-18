using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Meddle.Formats.Files;
using Meddle.Formats.Files.MdlFile;
using Meddle.Formats;
using Meddle.SqPack;
using Microsoft.Extensions.Logging.Abstractions;
using Model = Meddle.Utils.Export.Model;

var jsonOptions = new JsonSerializerOptions { WriteIndented = true, IncludeFields = true };
var catalogOverride = Environment.GetEnvironmentVariable("MAP_TOOLS_CATALOG");
var catalogPath = string.IsNullOrWhiteSpace(catalogOverride)
    ? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "world-catalog.json"))
    : Path.GetFullPath(catalogOverride);
using var catalog = JsonDocument.Parse(File.ReadAllText(catalogPath));
var targets = catalog.RootElement.GetProperty("scenes").EnumerateArray().ToDictionary(
    entry => entry.GetProperty("id").GetString()!,
    entry => (territory: entry.GetProperty("territoryId").GetInt32(), root: entry.GetProperty("root").GetString()!));
Global.Logger = NullLogger.Instance;
try
{
        if (args.Length == 0 || args[0] is "help" or "--help")
        {
            Console.WriteLine("""
            MapExtract — read-only FFXIV asset inspection
              targets
              lgb <client-root> <catalog-scene-id> <output-directory>
              probe <client-root>
          probe-catalog <client-root>
          extract-map <client-root> <catalog-scene-id> <output-directory>
          collision-map <client-root> <catalog-scene-id> <output-directory>
          raw <client-root> <virtual-path> <output-file>
          model <extracted.mdl> <output.glb>
          model-folder <export-directory>
          selftest <output-directory>

        Writes exports only. Does not modify the game or attach to its process.
        GLB output is geometry-only; raw materials/textures/layout are retained.
        Full scene assembly and collision conversion require validation on client data.
        """);
        return 0;
    }
    if (args[0] == "targets")
    {
        Console.WriteLine(JsonSerializer.Serialize(targets.Select(pair => new { id = pair.Key, territoryId = pair.Value.territory, root = pair.Value.root, seeds = Seeds(pair.Value.root) }), jsonOptions));
        return 0;
    }
    if (args[0] == "selftest")
    {
        var directory = Path.GetFullPath(args[1]); Directory.CreateDirectory(directory);
        GlbWriter.Write(Path.Combine(directory, "synthetic-quad.glb"), [
            new Geometry("synthetic test fixture, NOT game data", [new(-1,0,-1),new(1,0,-1),new(1,0,1),new(-1,0,1)], [0,2,1,0,3,2])
        ]);
        Console.WriteLine("Self-test GLB written. This fixture contains no extracted game data.");
        return 0;
    }
    if (args[0] == "model")
    {
        ConvertModel(File.ReadAllBytes(args[1]), args[1], args[2]);
        return 0;
    }
    if (args[0] == "model-folder")
    {
        var files = Directory.GetFiles(args[1], "*.mdl", SearchOption.AllDirectories);
        foreach (var path in files) ConvertModel(File.ReadAllBytes(path), path, path + ".glb");
        Console.WriteLine($"Converted {files.Length} models with normals, UVs and material references.");
        return 0;
    }
    if (args.Length < 2) throw new ArgumentException("A client directory is required.");
    using var pack = new SqPack(args[1]);
    var gameRoot = Path.GetFileName(Path.TrimEndingDirectorySeparator(args[1])) == "game" ? args[1] : Path.Combine(args[1], "game");
    var versionFile = Path.Combine(gameRoot, "ffxivgame.ver");
    var version = File.Exists(versionFile) ? File.ReadAllText(versionFile).Trim() : "unknown";
    if (args[0] == "probe")
    {
        var report = targets.Select(pair => new
        {
            id = pair.Key, territoryId = pair.Value.territory, gameVersion = version,
            files = Seeds(pair.Value.root).Select(path => new { path, found = pack.FileExists(path, out _) }).ToArray()
        });
        Console.WriteLine(JsonSerializer.Serialize(report, jsonOptions));
        return 0;
    }
    if (args[0] == "probe-catalog")
    {
        var report = targets.Select(pair => new {
            id = pair.Key, territoryId = pair.Value.territory, root = pair.Value.root,
            bg = pack.FileExists($"{pair.Value.root}/level/bg.lgb", out _),
            terrain = pack.FileExists($"{pair.Value.root}/bgplate/terrain.tera", out _),
            collision = pack.FileExists($"{pair.Value.root}/collision/list.pcb", out _),
        }).ToArray();
        Console.WriteLine(JsonSerializer.Serialize(new { gameVersion = version, scenes = report }, jsonOptions));
        return report.All(row => row.bg && row.terrain && row.collision) ? 0 : 2;
    }
    if (args[0] == "raw")
    {
        var file = pack.GetFile(args[2]) ?? throw new FileNotFoundException(args[2]);
        var target = Path.GetFullPath(args[3]); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.WriteAllBytes(target, file.File.RawData.ToArray());
        Console.WriteLine(target); return 0;
    }
    if (args[0] == "lgb")
    {
        if (args.Length < 4) throw new ArgumentException("Usage: lgb <client-root> <catalog-scene-id> <output-directory>");
        if (!targets.TryGetValue(args[2], out var zone2)) throw new ArgumentException("Map must be an id from world-catalog.json.");
        var lgbOutput = Path.GetFullPath(args[3]); Directory.CreateDirectory(lgbOutput);
        var layerSeeds = Seeds(zone2.root).Where(path => path.EndsWith(".lgb") || path.EndsWith(".lvb")).ToArray();
        var lgbReport = new List<object>();
        var firstError2 = "";
        foreach (var path in layerSeeds)
        {
            var file = pack.GetFile(path);
            if (file == null) { lgbReport.Add(new { path, found = false }); continue; }
            var bytes = file.File.RawData.ToArray();
            var isLgb = bytes.Length >= 16 && bytes[0] == (byte)'L' && bytes[1] == (byte)'G' && bytes[2] == (byte)'B' && bytes[3] == (byte)'1' && bytes[12] == (byte)'L' && bytes[13] == (byte)'G' && bytes[14] == (byte)'P' && bytes[15] == (byte)'1';
            if (!isLgb)
            {
                lgbReport.Add(new { path, found = true, parsed = false, error = (string?)($"{bytes[0..4]} / {bytes[12..16]} (not an LGB1/LGP1 container - LVB seeds are parsed via their embedded layer groups by the game, not this tool)"), bytes = bytes.Length });
                continue;
            }
            LgbFile lgb;
            try { lgb = new LgbFile(bytes); }
            catch (Exception error) { lgbReport.Add(new { path, found = true, parsed = false, error = error.Message, bytes = bytes.Length }); if (string.IsNullOrEmpty(firstError2)) firstError2 = $"{path}: {error.Message}"; continue; }
            var objects = new List<object>();
            for (var layer = 0; layer < lgb.Groups.Length; layer++)
            for (var index = 0; index < lgb.Groups[layer].InstanceObjects.Length; index++)
            {
                var instance = lgb.Groups[layer].InstanceObjects[index];
                string? name = null;
                if (instance.Type is LgbFile.LayerEntryType.EnvSet or LgbFile.LayerEntryType.EnvLocation or LgbFile.LayerEntryType.LayLight)
                {
                    // Name strings live in the layer string heap; recover via the
                    // same helper Meddle uses for BG paths (offset field + heap).
                    var layerGroup = lgb.Groups[layer];
                    var reader = new SpanBinaryReader(bytes);
                    var instanceRoot = layerGroup.Offset + (int)layerGroup.Header.InstanceObjectsOffset + (int)layerGroup.InstanceObjectOffsets[index];
                    var nameOffset = BitConverter.ToInt32(bytes, instanceRoot + 8);
                    var nameStart = instanceRoot + 8 + nameOffset;
                    var end = nameStart;
                    while (end < bytes.Length && bytes[end] != 0) end++;
                    name = Encoding.ASCII.GetString(bytes, nameStart, Math.Max(0, end - nameStart));
                    if (instance.Type == LgbFile.LayerEntryType.LayLight)
                    {
                        // Physis v0.7 LightInstanceObject layout (shape i32,
                        // attenuation f32, range f32, point type i32, cone f32,
                        // angle f32, texture offset i32, pad i32, ColorIntensity
                        // rgba+f32, four bool bytes, near f32, skew 2f32, then
                        // Dawntrail tail). Payload begins at instanceRoot+0x30.
                        var p = instanceRoot + 0x30;
                        int shape = BitConverter.ToInt32(bytes, p);
                        var attenuation = BitConverter.ToSingle(bytes, p + 4);
                        var range = BitConverter.ToSingle(bytes, p + 8);
                        // Verified layout (Physis v0.7 LightInstanceObject):
                        // +0 shape i32, +4 attenuation f32, +8 range f32,
                        // +12 point type i32, +16 cone coefficient f32,
                        // +20 spot angle f32, +24 texture path offset i32,
                        // +28 ColorIntensity rgba(4 u8)+intensity f32,
                        // +40 flag bytes x4, +44 shadow near f32,
                        // +48 skew 2f32, then Dawntrail tail (marker at +88).
                        var colorR = bytes[p + 28]; var colorG = bytes[p + 29]; var colorB = bytes[p + 30]; var colorA = bytes[p + 31];
                        var intensity = BitConverter.ToSingle(bytes, p + 32);
                        objects.Add(new
                        {
                            layer = layer, index, instanceId = instance.InstanceId, type = instance.Type.ToString(), name,
                            translation = instance.Translation, rotation = instance.Rotation, scale = instance.Scale,
                            shape, attenuation, range, color = new { r = colorR, g = colorG, b = colorB, a = colorA, intensity },
                            lightPayloadOffset = p
                        });
                        continue;
                    }
                    if (instance.Type == LgbFile.LayerEntryType.EnvSet)
                    {
                        var p = instanceRoot + 0x30;
                        var assetPathOffset = BitConverter.ToInt32(bytes, p);
                        var assetPath = reader.ReadString(p + assetPathOffset);
                        var boundInstanceId = BitConverter.ToUInt32(bytes, p + 4);
                        int shape = BitConverter.ToInt32(bytes, p + 8);
                        var priority = bytes[p + 13];
                        var effectiveRange = BitConverter.ToSingle(bytes, p + 16);
                        var interpolationTime = BitConverter.ToInt32(bytes, p + 20);
                        objects.Add(new
                        {
                            layer = layer, index, instanceId = instance.InstanceId, type = instance.Type.ToString(), name,
                            translation = instance.Translation, rotation = instance.Rotation, scale = instance.Scale,
                            assetPath, boundInstanceId, shape, priority, effectiveRange, interpolationTime,
                            payloadOffset = p
                        });
                        continue;
                    }
                    if (instance.Type == LgbFile.LayerEntryType.EnvLocation)
                    {
                        var p = instanceRoot + 0x30;
                        // Both paths use the BG-style heap rule: the dword at the
                        // field is an offset relative to the field position.
                        var ambientOffset = BitConverter.ToInt32(bytes, p);
                        var ambientPath = reader.ReadString(p + ambientOffset);
                        var envMapOffset = BitConverter.ToInt32(bytes, p + 4);
                        var envMapPath = reader.ReadString(p + 4 + envMapOffset);
                        objects.Add(new
                        {
                            layer = layer, index, instanceId = instance.InstanceId, type = instance.Type.ToString(), name,
                            translation = instance.Translation, rotation = instance.Rotation, scale = instance.Scale,
                            ambientLightAssetPath = ambientPath, envMapAssetPath = envMapPath,
                            payloadOffset = p
                        });
                        continue;
                    }
                }
                objects.Add(new { layer = layer, index, instanceId = instance.InstanceId, type = instance.Type.ToString(), name });
            }
            lgbReport.Add(new { path, found = true, parsed = true, bytes = bytes.Length, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant(), layers = lgb.Groups.Length, objects });
        }
        var manifest2 = new { schemaVersion = 1, map = args[2], root = zone2.root, territoryId = zone2.territory, gameVersion = version, generatedAtUtc = DateTime.UtcNow, parser = "MapExtract lgb command (pinned Meddle LgbFile + Physis v0.7 field layouts)", files = lgbReport };
        var target2 = Path.Combine(lgbOutput, $"{args[2]}-lgb.json");
        File.WriteAllText(target2, JsonSerializer.Serialize(manifest2, jsonOptions));
        Console.WriteLine(target2);
        if (!string.IsNullOrEmpty(firstError2)) { Console.Error.WriteLine(firstError2); return 3; }
        return 0;
    }
    if (args[0] == "collision-map")
    {
        if (!targets.TryGetValue(args[2], out var targetZone)) throw new ArgumentException("Unknown map");
        var listPath = $"{targetZone.root}/collision/list.pcb";
        var list = pack.GetFile(listPath) ?? throw new FileNotFoundException(listPath);
        var bytes = list.File.RawData.ToArray();
        var count = BitConverter.ToUInt32(bytes, 0);
        for (var i = 0; i < count; i++)
        {
            var meshId = BitConverter.ToUInt32(bytes, 32 + i * 32);
            var names = new[] { $"tr{meshId}.pcb", $"tr{meshId:D4}.pcb", $"tr{meshId:D5}.pcb", $"tr{meshId:X4}.pcb", $"tr{meshId:x4}.pcb" };
            var collisionPath = names.Select(name => $"{targetZone.root}/collision/{name}").FirstOrDefault(path => pack.FileExists(path, out _))
                                ?? throw new FileNotFoundException($"Collision chunk {meshId}: {string.Join(", ", names)}");
            var file = pack.GetFile(collisionPath)!;
            var destination = SafeExportPath(Path.GetFullPath(args[3]), collisionPath);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.WriteAllBytes(destination, file.File.RawData.ToArray());
        }
        Console.WriteLine($"Extracted {count} original terrain collision chunks.");
        return 0;
    }
    if (args[0] != "extract-map" || args.Length < 4) throw new ArgumentException("Invalid command. Use --help.");
    if (!targets.TryGetValue(args[2], out var zone)) throw new ArgumentException("Map must be an id from world-catalog.json.");
    var output = Path.GetFullPath(args[3]); Directory.CreateDirectory(output);
    var pending = new Queue<string>(Seeds(zone.root));
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var exported = new List<object>(); var layouts = new List<object>(); var missing = new List<string>(); var errors = new List<object>();
    while (pending.TryDequeue(out var path))
    {
        if (!seen.Add(path)) continue;
        if (seen.Count > 100000) throw new InvalidOperationException("Dependency limit reached. Inspect the partial export before continuing.");
        var file = pack.GetFile(path);
        if (file == null) { missing.Add(path); continue; }
        var data = file.File.RawData.ToArray();
        var destination = SafeExportPath(output, path);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.WriteAllBytes(destination, data);
        exported.Add(new { path, bytes = data.Length });
        foreach (Match match in Regex.Matches(Encoding.ASCII.GetString(data), @"(?:bg|bgcommon)/[A-Za-z0-9_./-]+\.(?:mdl|sgb|lgb|mtrl|tex|pcb|tera|lvb)"))
            if (!match.Value.Contains("..")) pending.Enqueue(match.Value);
        try
        {
            if (path.EndsWith(".lgb"))
            {
                var lgb = new LgbFile(data);
                for (var layer = 0; layer < lgb.Groups.Length; layer++)
                for (var index = 0; index < lgb.Groups[layer].InstanceObjects.Length; index++)
                {
                    var instance = lgb.Groups[layer].InstanceObjects[index];
                    string? model = null; string? collision = null;
                    if (instance.Type == LgbFile.LayerEntryType.BG)
                    {
                        (model, collision, _) = LgbFileExtensions.GetBgInstanceObject(lgb, layer, index);
                        if (!string.IsNullOrEmpty(model)) pending.Enqueue(model);
                        if (!string.IsNullOrEmpty(collision)) pending.Enqueue(collision);
                    }
                    layouts.Add(new { source = path, layer, instance.InstanceId, type = instance.Type.ToString(), translation = instance.Translation, rotation = instance.Rotation, scale = instance.Scale, model, collision });
                }
            }
            else if (path.EndsWith("terrain.tera"))
            {
                var tera = new TeraFile(data);
                for (var i = 0; i < tera.Positions.Length; i++)
                {
                    var model = path.Replace("terrain.tera", $"{i:D4}.mdl");
                    pending.Enqueue(model);
                    var position = tera.GetPlatePosition(i);
                    layouts.Add(new { source = path, type = "TerrainPlate", plateIndex = i, translation = new Vector3(position.X, 0, position.Y), model });
                }
            }
            else if (path.EndsWith(".mdl"))
            {
                ConvertModel(data, path, destination + ".glb");
            }
        }
        catch (Exception error) { errors.Add(new { path, error = error.Message }); }
    }
    var manifest = new { map = args[2], root = zone.root, territoryId = zone.territory, gameVersion = version, exportedAtUtc = DateTime.UtcNow, exported, layouts, missing, errors, limitations = new[] { "Geometry-only GLB; raw material/texture retained.", "Shared-group nesting and collision conversion still need scene-specific validation.", "Not a claim of exact 7.0 data unless the installed client version is 7.0." } };
    File.WriteAllText(Path.Combine(output, "manifest.json"), JsonSerializer.Serialize(manifest, jsonOptions));
    Console.WriteLine($"Exported {exported.Count} files, {layouts.Count} layout entries, {errors.Count} conversion errors.");
    return exported.Count == 0 ? 2 : 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static string[] Seeds(string root)
{
    var code = root.Split('/').Last();
    return [$"{root}/level/{code}.lvb", $"{root}/level/bg.lgb", $"{root}/level/planmap.lgb", $"{root}/level/planevent.lgb", $"{root}/level/sound.lgb", $"{root}/bgplate/terrain.tera"];
}
static string SafeExportPath(string root, string path)
{
    var full = Path.GetFullPath(Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar)));
    if (!full.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Asset path escaped export directory.");
    return full;
}
static void ConvertModel(byte[] data, string name, string destination)
{
    var model = new Model(name, new MdlFile(data), null);
    var geometries = model.Meshes.Select(mesh => new Geometry($"{name}#{mesh.MeshIdx}",
        mesh.Vertices.Select(vertex => vertex.Position ?? Vector3.Zero).ToArray(),
        mesh.Indices.ToArray(),
        mesh.Vertices.Select(vertex => vertex.Normals?.FirstOrDefault() ?? Vector3.UnitY).ToArray(),
        mesh.Vertices.Select(vertex => vertex.TexCoords?.FirstOrDefault() ?? Vector2.Zero).ToArray(),
        mesh.MaterialIdx < model.MtrlFileNames.Count ? model.MtrlFileNames[mesh.MaterialIdx] : null,
        Enumerable.Range(1, Math.Max(0, Math.Min(4, mesh.Vertices.Max(v => v.TexCoords?.Length ?? 0)) - 1))
            .Select(set => mesh.Vertices.Select(v => v.TexCoords is { } uv && uv.Length > set ? uv[set] : Vector2.Zero).ToArray()).ToArray(),
        mesh.Vertices.Any(v => v.Colors?.Length > 0) ? mesh.Vertices.Select(v => v.Colors?.FirstOrDefault() ?? Vector4.One).ToArray() : null
        )).ToArray();
    GlbWriter.Write(destination, geometries);
}
