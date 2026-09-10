using System.Text.Json;
using System.Text.Json.Serialization;
using Lumina;
using Lumina.Data;
using Lumina.Excel;
using Lumina.Data.Files.Excel;

if (args.Length < 3)
{
    Console.Error.WriteLine("Usage: ActionProbe <client-root> <names.json> <output.json>");
    return 2;
}

var client = Path.GetFullPath(args[0]);
var names = JsonSerializer.Deserialize<string[]>(File.ReadAllText(args[1])) ?? Array.Empty<string>();
var sqpack = Directory.Exists(Path.Combine(client, "game", "sqpack")) ? Path.Combine(client, "game", "sqpack") : Path.Combine(client, "sqpack");
using var game = new GameData(sqpack);
Console.Error.WriteLine($"Action sheet present: {game.Excel.SheetNames.Contains("Action", StringComparer.OrdinalIgnoreCase)}");
var actionHeader = game.GetFile<ExcelHeaderFile>("exd/Action.exh");
Console.Error.WriteLine($"Action header variant: {actionHeader?.Header.Variant}, rows: {actionHeader?.Header.RowCount}, languages: {string.Join(',', actionHeader?.Languages ?? Array.Empty<Lumina.Data.Language>())}");
var sheet = new ExcelSheet<ActionRow>(game.Excel.GetRawSheet("Action", Language.ChineseSimplified));
var actionCastTimelines = new ExcelSheet<ActionCastTimelineRow>(game.Excel.GetRawSheet("ActionCastTimeline"));
var actionCastVfx = new ExcelSheet<ActionCastVfxRow>(game.Excel.GetRawSheet("ActionCastVFX"));
var actionTimelines = new ExcelSheet<ActionTimelineRow>(game.Excel.GetRawSheet("ActionTimeline"));
var vfx = new ExcelSheet<VfxRow>(game.Excel.GetRawSheet("VFX"));
var wanted = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
var rows = sheet.Where(row => wanted.Contains(row.Name)).Select(row => {
    var cast = actionCastTimelines.GetRowOrDefault((uint)Math.Max(0, row.CastTimeline));
    var castVfx = actionCastVfx.GetRowOrDefault((uint)Math.Max(0, row.CastVfx));
    var timeline = actionTimelines.GetRowOrDefault((uint)Math.Max(0, row.ActionTimeline));
    var castVfxRow = castVfx is null ? null : vfx.GetRowOrDefault(castVfx.Value.VfxId);
    var castTimelineRow = cast is null ? null : actionTimelines.GetRowOrDefault(cast.Value.ActionTimelineId);
    var actionVfxRow = cast is null ? null : vfx.GetRowOrDefault(cast.Value.VfxId);
    return new ActionEvidence(
        row.RowId,
        row.Name,
        row.ActionCategory,
        row.ClassJob,
        row.CastTimeline,
        row.CastVfx,
        row.ActionTimeline,
        row.HitTimeline,
        timeline?.Key,
        castTimelineRow?.Key,
        castVfxRow?.Location ?? actionVfxRow?.Location,
        null,
        "Raw EXH columns plus ActionTimeline/VFX EXD references; TMB/audio event timing still unverified",
        "Unknown: Action EXD has no SoundID; link to VFX/TMB/SCD requires a separately verified source row"
    );
}).ToArray();
var missing = names.Where(name => !rows.Any(row => row.Name.Equals(name, StringComparison.OrdinalIgnoreCase))).ToArray();
var result = new ProbeManifest(
    1,
    new ProbeSource("Action EXH/EXD", "Lumina raw typed sheet", "Installed client; no guessed IDs"),
    rows,
    missing,
    new[] { "ActionTimeline path: Unknown (numeric row only; ActionTimeline EXD not yet linked).", "VFX path: Unknown (numeric ActionCastVFX row only).", "SoundID: Unknown until action/VFX/SCD linkage is source-proven." });
File.WriteAllText(Path.GetFullPath(args[2]), JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull }));
Console.WriteLine(JsonSerializer.Serialize(new { matched = rows.Length, missing = missing.Length, output = Path.GetFullPath(args[2]) }));
return 0;

[Sheet("Action")]
readonly struct ActionRow(ExcelPage page, uint offset, uint row) : IExcelRow<ActionRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public string Name => page.ReadString(offset + page.Sheet.GetColumnOffset(0), offset).ToString();
    public long ActionCategory => Read(3);
    public long CastTimeline => Read(5);
    public long CastVfx => Read(6);
    public long ActionTimeline => Read(7);
    public long HitTimeline => Read(8);
    public long ClassJob => Read(10);
    private long Read(int column)
    {
        var definition = page.Sheet.Columns[column];
        var valueOffset = offset + definition.Offset;
        return definition.Type switch
        {
            Lumina.Data.Structs.Excel.ExcelColumnDataType.Int8 => page.ReadInt8(valueOffset),
            Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt8 => page.ReadUInt8(valueOffset),
            Lumina.Data.Structs.Excel.ExcelColumnDataType.Int16 => page.ReadInt16(valueOffset),
            Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt16 => page.ReadUInt16(valueOffset),
            Lumina.Data.Structs.Excel.ExcelColumnDataType.Int32 => page.ReadInt32(valueOffset),
            Lumina.Data.Structs.Excel.ExcelColumnDataType.UInt32 => page.ReadUInt32(valueOffset),
            _ => page.ReadUInt32(valueOffset),
        };
    }
    static ActionRow IExcelRow<ActionRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("ActionCastTimeline")]
readonly struct ActionCastTimelineRow(ExcelPage page, uint offset, uint row) : IExcelRow<ActionCastTimelineRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public uint ActionTimelineId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(0));
    public uint VfxId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(1));
    static ActionCastTimelineRow IExcelRow<ActionCastTimelineRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("ActionCastVFX")]
readonly struct ActionCastVfxRow(ExcelPage page, uint offset, uint row) : IExcelRow<ActionCastVfxRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public uint VfxId => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(0));
    static ActionCastVfxRow IExcelRow<ActionCastVfxRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("ActionTimeline")]
readonly struct ActionTimelineRow(ExcelPage page, uint offset, uint row) : IExcelRow<ActionTimelineRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public string Key => page.ReadString(offset + page.Sheet.GetColumnOffset(6), offset).ToString();
    static ActionTimelineRow IExcelRow<ActionTimelineRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("VFX")]
readonly struct VfxRow(ExcelPage page, uint offset, uint row) : IExcelRow<VfxRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public string Location => page.ReadString(offset + page.Sheet.GetColumnOffset(0), offset).ToString();
    static VfxRow IExcelRow<VfxRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

record ActionEvidence(uint SkillId, string Name, long ActionCategory, long ClassJob, long CastTimeline, long CastVfx, long ActionTimeline, long HitTimeline, string? ActionTimelinePath, string? CastTimelinePath, string? VfxPath, string? SoundId, string FieldConfidence, string SoundProvenance);
record ProbeSource(string Sheet, string Parser, string Note);
record ProbeManifest(int SchemaVersion, ProbeSource Source, ActionEvidence[] Actions, string[] MissingNames, string[] Unknowns);
