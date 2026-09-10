using System.Reflection;
using System.Text.Json;
using Lumina;
using Lumina.Data;
using Lumina.Excel;

const string Usage = "MapNameProbe --client=CLIENT --catalog=CATALOG [--names-out=FILE] [--regions-out=FILE] [--metadata-out=FILE]";
var options = ParseOptions(args);
if (options.ContainsKey("help") || options.Count == 0)
{
    Console.WriteLine(Usage);
    return 0;
}

var client = Required(options, "client");
var catalogPath = Required(options, "catalog");
var namesOutput = options.GetValueOrDefault("names-out");
var regionsOutput = options.GetValueOrDefault("regions-out");
var metadataOutput = options.GetValueOrDefault("metadata-out");
var sqpack = ResolveSqPack(client);
var gameVersion = ReadGameVersion(client);
using var game = new GameData(sqpack);
var language = Language.ChineseSimplified;
var map = ReadRawRows(game, "Map", language);
var placeNames = ReadRawRows(game, "PlaceName", language);
ValidateMapColumns(map);
ValidatePlaceNameColumns(placeNames);

var mapById = map.Values
    .Where(row => row.Columns.Count > 16)
    .GroupBy(row => row.ReadStringColumn(6).ToString(), StringComparer.Ordinal)
    .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
using var catalog = JsonDocument.Parse(File.ReadAllText(catalogPath));
var territories = new Dictionary<string, object>(StringComparer.Ordinal);
foreach (var scene in catalog.RootElement.GetProperty("scenes").EnumerateArray())
{
    var id = scene.GetProperty("id").GetString()!;
    var territoryId = scene.GetProperty("territoryId").GetUInt32();
    var mapId = scene.GetProperty("mapId").GetString()!;
    if (!mapById.TryGetValue(mapId, out var row))
    {
        row = map.Values.FirstOrDefault(candidate => ReadUInt(candidate, 16) == territoryId);
        if (row.RowId == 0) throw new InvalidDataException($"Map row not found for {id} ({mapId}, territory {territoryId}).");
    }
    var nameId = ReadUInt(row, 11);
    var regionId = ReadUInt(row, 10);
    var name = ReadPlaceName(placeNames, nameId, id, "PlaceName");
    var region = ReadPlaceName(placeNames, regionId, id, "PlaceNameRegion");
    territories[territoryId.ToString()] = new
    {
        id,
        mapId,
        territoryId,
        name,
        region,
        placeNameId = nameId,
        placeNameRegionId = regionId,
    };
}

var source = new
{
    client = Path.GetFullPath(client),
    gameVersion,
    language = language.ToString(),
    sheets = new
    {
        map = new { name = "Map", mapIdColumn = 6, placeNameRegionColumn = 10, placeNameColumn = 11, territoryColumn = 16, columnCount = map.Values.First().Columns.Count },
        placeName = new { name = "PlaceName", nameColumn = 0, columnCount = placeNames.Values.First().Columns.Count },
    },
};
var metadata = new { schemaVersion = 1, source, territories };
var jsonOptions = new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
WriteIfRequested(metadataOutput, metadata, jsonOptions);
WriteIfRequested(namesOutput, territories.ToDictionary(pair => pair.Key, pair => ((JsonElement)JsonSerializer.SerializeToElement(pair.Value)).GetProperty("name").GetString()), jsonOptions);
WriteIfRequested(regionsOutput, territories.ToDictionary(pair => pair.Key, pair => ((JsonElement)JsonSerializer.SerializeToElement(pair.Value)).GetProperty("region").GetString()), jsonOptions);
Console.WriteLine(JsonSerializer.Serialize(new { scenes = territories.Count, clientVersion = gameVersion, namesOutput, regionsOutput, metadataOutput }, jsonOptions));
return 0;

static Dictionary<string, RawRow> ReadRawRows(GameData game, string sheetName, Language language)
{
    var sheet = game.Excel.GetRawSheet(sheetName, language);
    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
    var lookupTable = (Array)(sheet.GetType().GetField("_rowOffsetLookupTable", flags)?.GetValue(sheet)
        ?? throw new InvalidDataException($"{sheetName}: Lumina row index is unavailable."));
    var pages = (Array)(sheet.GetType().GetField("_pages", flags)?.GetValue(sheet)
        ?? throw new InvalidDataException($"{sheetName}: Lumina page index is unavailable."));
    var rows = new Dictionary<string, RawRow>(StringComparer.Ordinal);
    foreach (var lookup in lookupTable)
    {
        var type = lookup.GetType();
        var rowId = (uint)(type.GetProperty("RowId")?.GetValue(lookup) ?? throw new InvalidDataException($"{sheetName}: row ID is unavailable."));
        var offset = (uint)(type.GetProperty("Offset")?.GetValue(lookup) ?? throw new InvalidDataException($"{sheetName}: row offset is unavailable."));
        var pageIndex = (ushort)(type.GetProperty("PageIndex")?.GetValue(lookup) ?? throw new InvalidDataException($"{sheetName}: page index is unavailable."));
        var page = (ExcelPage)(pages.GetValue(pageIndex) ?? throw new InvalidDataException($"{sheetName}: missing page {pageIndex}."));
        rows[$"{rowId}:{rows.Count}"] = new RawRow(page, offset, rowId);
    }
    return rows;
}

static void ValidateMapColumns(IReadOnlyDictionary<string, RawRow> rows)
{
    var columns = rows.Values.FirstOrDefault().Columns;
    if (columns.Count <= 16 || columns[6].Type != Lumina.Data.Structs.Excel.ExcelColumnDataType.String ||
        columns[10].Type != Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt16 ||
        columns[11].Type != Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt16 ||
        columns[16].Type != Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt16)
        throw new InvalidDataException("Map schema does not match expected current-client columns (Id=6, PlaceNameRegion=10, PlaceName=11, TerritoryType=16).");
}

static void ValidatePlaceNameColumns(IReadOnlyDictionary<string, RawRow> rows)
{
    var columns = rows.Values.FirstOrDefault().Columns;
    if (columns.Count == 0 || columns[0].Type != Lumina.Data.Structs.Excel.ExcelColumnDataType.String)
        throw new InvalidDataException("PlaceName schema does not expose Name at column 0.");
}

static uint ReadUInt(RawRow row, int column) => row.Columns[column].Type switch
{
    Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt16 => row.ReadUInt16Column(column),
    Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt32 => row.ReadUInt32Column(column),
    _ => throw new InvalidDataException($"Unexpected unsigned column type at {column}: {row.Columns[column].Type}"),
};

static string ReadPlaceName(IReadOnlyDictionary<string, RawRow> rows, uint id, string scene, string field)
{
    var row = rows.Values.FirstOrDefault(candidate => candidate.RowId == id);
    if (row.RowId != id) throw new InvalidDataException($"{scene}: {field} row {id} is missing.");
    return row.ReadStringColumn(0).ToString();
}

static Dictionary<string, string> ParseOptions(IEnumerable<string> args) => args
    .Where(value => value.StartsWith("--", StringComparison.Ordinal))
    .Select(value => value[2..].Split('=', 2))
    .ToDictionary(parts => parts[0], parts => parts.Length == 1 ? "true" : parts[1], StringComparer.OrdinalIgnoreCase);

static string Required(IReadOnlyDictionary<string, string> options, string name) => options.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
    ? value
    : throw new ArgumentException($"Missing --{name}. {Usage}");

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

static void WriteIfRequested<T>(string? file, T value, JsonSerializerOptions options)
{
    if (string.IsNullOrWhiteSpace(file)) return;
    var full = Path.GetFullPath(file);
    Directory.CreateDirectory(Path.GetDirectoryName(full)!);
    File.WriteAllText(full, JsonSerializer.Serialize(value, options) + Environment.NewLine);
}
