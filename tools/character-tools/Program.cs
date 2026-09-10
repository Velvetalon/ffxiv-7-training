using System.Text.Json;
using Meddle.Formats.Files;
using Meddle.SqPack;
using Microsoft.Extensions.Logging.Abstractions;
using Lumina.Excel;
using Meddle.Formats.Files.MdlFile;
using ExportModel = Meddle.Utils.Export.Model;

Global.Logger = NullLogger.Instance;

try
{
    if (args.Length == 0 || args[0] is "help" or "--help")
    {
        Console.WriteLine("""
        CharacterTools - read-only FFXIV character asset conversion
          raw <client-root> <virtual-path> <output-file>
          appearance-map <client-root> <tribe-id> <sex-id> <hair-option> <face-paint-option>
          appearance-colors <client-root> <tribe-id> <sex-id> <skin> <hair> <highlight> <right-eye> <left-eye> <lip> <face-paint>
          reflect-sheet <Mount|ModelChara|MountCustomize>
          inspect-model <extracted.mdl>
          mount-scan <client-root>
          timeline-rows <client-root> <row-id> [...]
          skinned-glb <skeleton.json> <appearance-colors.json> <selected-shapes.json> <material-textures.json> <output.glb> <source-path=extracted.mdl> [...]

        The skeleton JSON is produced from a real SKLB by the repository's
        animation-lab hkxparse path. MDL blend indices are resolved through
        each mesh's native bone table and written as glTF skin attributes.
        """);
        return 0;
    }

    if (args[0] == "raw")
    {
        using var pack = new SqPack(args[1]);
        var file = pack.GetFile(args[2]) ?? throw new FileNotFoundException(args[2]);
        var output = Path.GetFullPath(args[3]);
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.WriteAllBytes(output, file.File.RawData.ToArray());
        Console.WriteLine(output);
        return 0;
    }

    if (args[0] == "appearance-map")
    {
        using var game = new Lumina.GameData(Path.Combine(args[1], "game", "sqpack"));
        var sheet = game.Excel.GetSheet<CharaMakeCustomizeRow>();
        var tribe = int.Parse(args[2]);
        var sex = int.Parse(args[3]);
        var hair = byte.Parse(args[4]);
        var facePaint = byte.Parse(args[5]);
        var hairGroup = tribe <= 2 ? tribe - 1 : ((tribe - 1) / 2) + 1;
        var hairStart = (hairGroup * 2 + sex) * 130;
        var paintStart = 2400 + ((tribe - 1) * 2 + sex) * 50;
        var hairRow = Enumerable.Range(hairStart, 130).Select(row => sheet.GetRow((uint)row)).FirstOrDefault(row => row.FeatureId == hair);
        var paintRow = Enumerable.Range(paintStart, 50).Select(row => sheet.GetRow((uint)row)).FirstOrDefault(row => row.FeatureId == facePaint);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            tribe,
            sex,
            hair = new { option = hair, rowId = hairRow.RowId, assetFeatureId = hairRow.FeatureId, hairRow.FaceType, hairRow.IsPurchasable },
            facePaint = new { option = facePaint, rowId = paintRow.RowId, assetFeatureId = paintRow.FeatureId, paintRow.FaceType, paintRow.IsPurchasable },
        }, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    if (args[0] == "appearance-colors")
    {
        using var pack = new SqPack(args[1]);
        var cmp = pack.GetFile("chara/xls/charamake/human.cmp")?.File.RawData.ToArray()
                  ?? throw new FileNotFoundException("chara/xls/charamake/human.cmp");
        var tribe = int.Parse(args[2]);
        var sex = int.Parse(args[3]);
        var uniqueBase = 0x4800 / 4;
        var tribeSex = ((tribe - 1) * 2) + sex;
        float[] Read(int index) => [cmp[index * 4] / 255f, cmp[index * 4 + 1] / 255f, cmp[index * 4 + 2] / 255f, cmp[index * 4 + 3] / 255f];
        float[] Unique(int palette, int option) => Read(uniqueBase + tribeSex * (0x1400 / 4) + palette * (0x400 / 4) + option);
        float[] Shared(int palette, int option) => Read(palette * (0x400 / 4) + option);
        var lipOption = int.Parse(args[9]);
        var colors = new AppearanceColors(
            Unique(3, int.Parse(args[4])),
            Unique(4, int.Parse(args[5])),
            Shared(1, int.Parse(args[6])),
            Shared(0, int.Parse(args[7])),
            Shared(0, int.Parse(args[8])),
            Shared(13, lipOption < 128 ? lipOption : lipOption),
            Shared(13, int.Parse(args[10])));
        Console.WriteLine(JsonSerializer.Serialize(colors, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    if (args[0] == "reflect-sheet")
    {
        var type = args[1] switch
        {
            "Mount" => typeof(Lumina.Excel.Sheets.Mount),
            "ModelChara" => typeof(Lumina.Excel.Sheets.ModelChara),
            "MountCustomize" => typeof(Lumina.Excel.Sheets.MountCustomize),
            "ActionTimeline" => typeof(Lumina.Excel.Sheets.ActionTimeline),
            "ActionCastTimeline" => typeof(Lumina.Excel.Sheets.ActionCastTimeline),
            _ => throw new ArgumentException("Unknown sheet type"),
        };
        Console.WriteLine(string.Join(Environment.NewLine, type.GetProperties().Select(property => $"{property.PropertyType.Name} {property.Name}")));
        return 0;
    }
    if (args[0] == "inspect-model")
    {
        var model = new ExportModel(args[1], new MdlFile(File.ReadAllBytes(args[1])), null);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            meshes = model.Meshes.Select(mesh => new { mesh.MeshIdx, vertices = mesh.Vertices.Count, indices = mesh.Indices.Count, bones = mesh.BoneTable }),
            shapes = model.Shapes.Select(shape => new { shape.Name, meshes = shape.Meshes.Select(mesh => new { mesh.Mesh.MeshIdx, values = mesh.Values.Count, maxReplacement = mesh.Values.Count > 0 ? mesh.Values.Max(value => value.ReplacedVertexIndex) : 0 }) }),
            materials = model.MtrlFileNames,
        }, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }
    if (args[0] == "mount-scan")
    {
        using var game = new Lumina.GameData(Path.Combine(args[1], "game", "sqpack"));
        var rows = game.Excel.GetSheet<Lumina.Excel.Sheets.Mount>(Lumina.Data.Language.ChineseSimplified)
            .Where(row => row.IsFlying != 0 && row.ModelChara.RowId != 0)
            .Take(30)
            .Select(row => new
            {
                row.RowId,
                name = row.Singular.ToString(),
                modelCharaId = row.ModelChara.RowId,
                model = row.ModelChara.Value.Model,
                type = row.ModelChara.Value.Type,
                @base = row.ModelChara.Value.Base,
                variant = row.ModelChara.Value.Variant,
                row.IsFlying,
                row.IsAirborne,
                row.BaseMotionSpeed_Run,
                row.BaseMotionSpeed_Walk,
                mountCustomizeId = row.MountCustomize.RowId,
                miqoFemaleScale = row.MountCustomize.RowId == 0 ? 100 : row.MountCustomize.Value.MiqoFemaleScale,
                miqoFemaleCameraHeight = row.MountCustomize.RowId == 0 ? 0 : row.MountCustomize.Value.MiqoFemaleCameraHeight,
                row.ExtraSeats,
            });
        Console.WriteLine(JsonSerializer.Serialize(rows, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }
    if (args[0] == "timeline-rows")
    {
        using var game = new Lumina.GameData(Path.Combine(args[1], "game", "sqpack"));
        var language = Lumina.Data.Language.ChineseSimplified;
        var timeline = game.Excel.GetSheet<Lumina.Excel.Sheets.ActionTimeline>(language);
        var cast = game.Excel.GetSheet<Lumina.Excel.Sheets.ActionCastTimeline>(language);
        var rows = args[2..].Select(uint.Parse).Select(id => new
        {
            id,
            timeline = timeline.TryGetRow(id, out var value) ? new { value.RowId, key = value.Key.ToString(), value.ResidentPap, value.Resident, value.IsLoop, value.StartAttach, value.Type, value.Slot, value.LoadType } : null,
            cast = cast.TryGetRow(id, out var castValue) ? new { castValue.RowId, nameTimelineId = castValue.Name.RowId, vfxId = castValue.VFX.RowId } : null,
        });
        Console.WriteLine(JsonSerializer.Serialize(rows, new JsonSerializerOptions { WriteIndented = true }));
        return 0;
    }

    if (args[0] == "skinned-glb" && args.Length >= 7)
    {
        var skeleton = JsonSerializer.Deserialize<SkeletonBone[]>(File.ReadAllText(args[1]), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidDataException("Skeleton JSON is empty");
        var colors = JsonSerializer.Deserialize<AppearanceColors>(File.ReadAllText(args[2]), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidDataException("Appearance colors JSON is empty");
        var geometryConfig = JsonSerializer.Deserialize<AppearanceGeometryConfig>(File.ReadAllText(args[3]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                             ?? throw new InvalidDataException("Appearance geometry JSON is empty");
        var materialTextures = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(args[4]))
                               ?? throw new InvalidDataException("Material texture JSON is empty");
        var sources = args[6..].Select(ParseSource).ToArray();
        SkinnedGlbWriter.Write(args[5], skeleton, colors, geometryConfig, materialTextures, sources);
        return 0;
    }

    throw new ArgumentException("Invalid command. Use --help.");
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static ModelSource ParseSource(string value)
{
    var separator = value.IndexOf('=');
    if (separator <= 0 || separator == value.Length - 1)
        throw new ArgumentException($"Model source must be virtual-path=local-file: {value}");
    return new ModelSource(value[..separator], Path.GetFullPath(value[(separator + 1)..]));
}
