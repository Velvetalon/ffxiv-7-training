using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Lumina;
using Lumina.Data;
using Lumina.Data.Structs.Excel;
using Lumina.Excel;

const string Usage = "DutySheetProbe --client=CLIENT --out=DIR";
var options = ParseOptions(args);
if (options.ContainsKey("help") || !options.TryGetValue("client", out var client) || !options.TryGetValue("out", out var outputDirectory))
{
    Console.WriteLine(Usage);
    return 1;
}

var sqpack = ResolveSqPack(client);
var gameVersion = ReadGameVersion(client);
using var game = new GameData(sqpack);
var jsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};
Directory.CreateDirectory(outputDirectory);

var requestedSheets = new[]
{
    "ContentFinderCondition", "ContentType", "ContentUICategory", "TerritoryType",
    "TerritoryIntendedUse", "InstanceContent", "PartyContent", "PublicContent", "Map", "PlaceName",
};
var languages = new Dictionary<string, Lumina.Data.Language>
{
    ["zh"] = Lumina.Data.Language.ChineseSimplified,
    ["en"] = Lumina.Data.Language.English,
};
var dumped = new Dictionary<string, object>();
var languageErrors = new Dictionary<string, string[]>();

foreach (var sheetName in requestedSheets)
{
    var sheetDumps = new Dictionary<string, object>();
    foreach (var (languageKey, language) in languages)
    {
        try
        {
            var rows = ReadRawRows(game, sheetName, language);
            var first = rows.Values.First();
            sheetDumps[languageKey] = new
            {
                language = language.ToString(),
                rowCount = rows.Count,
                columnCount = first.Columns.Count,
                columns = first.Columns.Select(column => new { column.Type, column.Offset }).ToArray(),
                rows = rows.ToDictionary(
                    pair => pair.Value.RowId.ToString(),
                    pair => pair.Value.Columns.Select((_, index) => ReadColumnValue(pair.Value, index)).ToArray()),
            };
        }
        catch (Exception exception) when (exception is InvalidOperationException or InvalidDataException or IOException or Lumina.Excel.Exceptions.UnsupportedLanguageException)
        {
            languageErrors[$"{sheetName}:{languageKey}"] = new[] { exception.GetType().Name, exception.Message };
        }
    }

    if (sheetDumps.Count == 0)
        throw new InvalidDataException($"No language could be read for sheet {sheetName}.");
    dumped[sheetName] = sheetDumps;
    var sheetFile = Path.Combine(outputDirectory, $"{sheetName}.json");
    File.WriteAllText(sheetFile, JsonSerializer.Serialize(new
    {
        schemaVersion = 1,
        sheet = sheetName,
        clientVersion = gameVersion,
        languages = sheetDumps,
        languageErrors = languageErrors.Where(pair => pair.Key.StartsWith(sheetName + ":", StringComparison.Ordinal))
            .ToDictionary(pair => pair.Key, pair => pair.Value),
    }, jsonOptions) + Environment.NewLine);
    Console.WriteLine($"{sheetName}: {sheetDumps.Count} language dumps -> {sheetFile}");
}

var summary = new
{
    schemaVersion = 1,
    client = Path.GetFullPath(client),
    sqpack = Path.GetFullPath(sqpack),
    clientVersion = gameVersion,
    outputDirectory = Path.GetFullPath(outputDirectory),
    sheets = dumped.Keys.OrderBy(value => value, StringComparer.Ordinal),
    languageErrors,
};
File.WriteAllText(Path.Combine(outputDirectory, "probe-summary.json"), JsonSerializer.Serialize(summary, jsonOptions) + Environment.NewLine);
return 0;

static object? ReadColumnValue(RawRow row, int index)
{
    var column = row.Columns[index];
    return column.Type switch
    {
        ExcelColumnDataType.String => row.ReadStringColumn(index).ToString(),
        ExcelColumnDataType.Bool => row.ReadBoolColumn(index),
        ExcelColumnDataType.Int8 => row.ReadInt8Column(index),
        ExcelColumnDataType.UInt8 => row.ReadUInt8Column(index),
        ExcelColumnDataType.Int16 => row.ReadInt16Column(index),
        ExcelColumnDataType.UInt16 => row.ReadUInt16Column(index),
        ExcelColumnDataType.Int32 => row.ReadInt32Column(index),
        ExcelColumnDataType.UInt32 => row.ReadUInt32Column(index),
        ExcelColumnDataType.Float32 => row.ReadFloat32Column(index),
        ExcelColumnDataType.Int64 => row.ReadInt64Column(index),
        ExcelColumnDataType.UInt64 => row.ReadUInt64Column(index),
        _ => row.ReadUInt32Column(index),
    };
}

static Dictionary<string, RawRow> ReadRawRows(GameData game, string sheetName, Lumina.Data.Language language)
{
    var sheet = game.Excel.GetRawSheet(sheetName, language);
    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
    var lookupTable = (Array)(sheet.GetType().GetField("_rowOffsetLookupTable", flags)?.GetValue(sheet)
        ?? throw new InvalidDataException($"{sheetName}: Lumina row index is unavailable."));
    var pages = (Array)(sheet.GetType().GetField("_pages", flags)?.GetValue(sheet)
        ?? throw new InvalidDataException($"{sheetName}: Lumina page index is unavailable."));
    var rows = new Dictionary<string, RawRow>();
    foreach (var lookup in lookupTable)
    {
        var type = lookup.GetType();
        var rowId = (uint)(type.GetProperty("RowId")?.GetValue(lookup) ?? throw new InvalidDataException($"{sheetName}: row ID is unavailable."));
        var offset = (uint)(type.GetProperty("Offset")?.GetValue(lookup) ?? throw new InvalidDataException($"{sheetName}: row offset is unavailable."));
        var pageIndex = (ushort)(type.GetProperty("PageIndex")?.GetValue(lookup) ?? throw new InvalidDataException($"{sheetName}: page index is unavailable."));
        var page = (Lumina.Excel.ExcelPage)(pages.GetValue(pageIndex) ?? throw new InvalidDataException($"{sheetName}: missing page {pageIndex}."));
        rows[rowId.ToString()] = new RawRow(page, offset, rowId);
    }
    return rows;
}

static Dictionary<string, string> ParseOptions(IEnumerable<string> args) => args
    .Where(value => value.StartsWith("--", StringComparison.Ordinal))
    .Select(value => value[2..].Split('=', 2))
    .ToDictionary(parts => parts[0], parts => parts.Length == 1 ? "true" : parts[1], StringComparer.OrdinalIgnoreCase);

static string ResolveSqPack(string client)
{
    var full = Path.GetFullPath(client);
    if (Path.GetFileName(full).Equals("sqpack", StringComparison.OrdinalIgnoreCase)) return full;
    if (Path.GetFileName(full).Equals("game", StringComparison.OrdinalIgnoreCase)) return Path.Combine(full, "sqpack");
    return Path.Combine(full, "game", "sqpack");
}

static string? ReadGameVersion(string client)
{
    var full = Path.GetFullPath(client);
    var game = Path.GetFileName(full).Equals("game", StringComparison.OrdinalIgnoreCase) ? full : Path.Combine(full, "game");
    var file = Path.Combine(game, "ffxivgame.ver");
    return File.Exists(file) ? File.ReadAllText(file).Trim() : null;
}
