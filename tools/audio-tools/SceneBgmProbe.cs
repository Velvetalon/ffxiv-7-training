using System.Text.Json;
using System.Text.Json.Serialization;
using Lumina;
using Lumina.Excel;
using Lumina.Data.Files.Excel;

if (args.Length < 3)
{
    Console.Error.WriteLine("Usage: SceneBgmProbe <client-root> <world-catalog.json> <output.json>");
    return 2;
}

var client = Path.GetFullPath(args[0]);
var catalogPath = Path.GetFullPath(args[1]);
var outputPath = Path.GetFullPath(args[2]);
var catalog = JsonSerializer.Deserialize<WorldCatalog>(File.ReadAllText(catalogPath)) ?? throw new InvalidDataException("Invalid world catalog");
var sqpack = Directory.Exists(Path.Combine(client, "game", "sqpack")) ? Path.Combine(client, "game", "sqpack") : Path.Combine(client, "sqpack");
using var game = new GameData(sqpack);
var territory = new ExcelSheet<TerritoryRow>(game.Excel.GetRawSheet("TerritoryType"));
var situations = new ExcelSheet<BgmSituationRow>(game.Excel.GetRawSheet("BGMSituation"));
var bgm = new ExcelSheet<BgmRow>(game.Excel.GetRawSheet("BGM"));
var switchHeader = game.GetFile<ExcelHeaderFile>("exd/BGMSwitch.exh");
Console.Error.WriteLine($"BGMSwitch variant={switchHeader?.Header.Variant} languages={string.Join(',', switchHeader?.Languages ?? Array.Empty<Lumina.Data.Language>())}");
var switches = game.GetSubrowExcelSheet<BgmSwitchRow>();
ushort ResolveDaytime(ushort id, HashSet<ushort>? visited = null)
{
    visited ??= new();
    if (!visited.Add(id)) return id;
    if (bgm.GetRowOrDefault(id) is not null) return id;
    var situation = situations.GetRowOrDefault(id);
    if (situation is not null && situation.Value.DaytimeId != 0) return ResolveDaytime(situation.Value.DaytimeId, visited);
    var switchRow = switches?.GetSubrowOrDefault(id, 0);
    if (switchRow is not null && switchRow.Value.BgmId != 0) return ResolveDaytime(switchRow.Value.BgmId, visited);
    return id;
}
var scenes = catalog.Scenes.Select(scene => {
    var territoryRow = territory.GetRowOrDefault((uint)scene.TerritoryId);
    var situationId = territoryRow?.Bgm ?? 0;
    var situation = situations.GetRowOrDefault(situationId);
    var dayId = ResolveDaytime(situation?.DaytimeId ?? situationId);
    var nightId = situation?.NightId ?? 0;
    var battleId = situation?.BattleId ?? 0;
    var dayPath = bgm.GetRowOrDefault(dayId)?.File;
    var nightPath = bgm.GetRowOrDefault(nightId)?.File;
    return new SceneBgm(scene.Id, scene.TerritoryId, situationId, dayId, nightId, battleId, dayPath, nightPath,
        dayPath is null ? "Unknown: BGM row absent" : "Confirmed from installed EXH/EXD rows");
}).ToArray();
var result = new ProbeManifest(1, "Installed client EXH/EXD raw read; no SCD bytes extracted", scenes);
File.WriteAllText(outputPath, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(new { scenes = scenes.Length, confirmed = scenes.Count(scene => scene.DayPath is not null), unknown = scenes.Count(scene => scene.DayPath is null), output = outputPath }));
return 0;

record WorldCatalog([property: JsonPropertyName("scenes")] SceneCatalog[] Scenes);
record SceneCatalog([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("territoryId")] int TerritoryId);
record ProbeManifest(int SchemaVersion, string Source, SceneBgm[] Scenes);
record SceneBgm(string SceneId, int TerritoryId, ushort BgmSituationId, ushort DaytimeBgmId, ushort NightBgmId, ushort BattleBgmId, string? DayPath, string? NightPath, string Status);

[Sheet("TerritoryType")]
readonly struct TerritoryRow(ExcelPage page, uint offset, uint row) : IExcelRow<TerritoryRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public ushort Bgm => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(19));
    static TerritoryRow IExcelRow<TerritoryRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("BGMSituation")]
readonly struct BgmSituationRow(ExcelPage page, uint offset, uint row) : IExcelRow<BgmSituationRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public ushort DaytimeId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(0));
    public ushort NightId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(1));
    public ushort BattleId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(2));
    static BgmSituationRow IExcelRow<BgmSituationRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("BGM")]
readonly struct BgmRow(ExcelPage page, uint offset, uint row) : IExcelRow<BgmRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public string File => page.ReadString(offset, offset).ToString();
    static BgmRow IExcelRow<BgmRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("BGMSwitch")]
readonly struct BgmSwitchRow(ExcelPage page, uint offset, uint row, ushort subrow) : IExcelSubrow<BgmSwitchRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public ushort SubrowId => subrow;
    public ushort BgmId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(3));
    static BgmSwitchRow IExcelSubrow<BgmSwitchRow>.Create(ExcelPage page, uint offset, uint row, ushort subrow) => new(page, offset, row, subrow);
}
