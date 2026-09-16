using System.Text.Json;
using Lumina;
using Lumina.Excel.Sheets;
using Lumina.Data;

var clientRoot = args.Length > 0 ? args[0] : throw new ArgumentException("client-root required");
using var game = new GameData(Path.Combine(clientRoot, "game", "sqpack"));
var language = Language.ChineseSimplified;
var mounts = game.GetExcelSheet<Mount>(language)!;
var bgm = game.GetExcelSheet<BGM>(language)!;
var rows = new List<object>();
foreach (var row in mounts)
{
    if (row.ModelChara.RowId == 0) continue;
    var rideBgmId = row.RideBGM.RowId;
    string? rideBgmPath = null;
    if (rideBgmId != 0 && bgm.TryGetRow(rideBgmId, out var bgmRow))
    {
        rideBgmPath = bgmRow.File.ToString();
        if (string.IsNullOrWhiteSpace(rideBgmPath)) rideBgmPath = null;
    }
    rows.Add(new
    {
        rowId = row.RowId,
        name = row.Singular.ToString(),
        modelCharaId = row.ModelChara.RowId,
        isFlying = row.IsFlying != 0,
        whistlePath = (string?)null,
        dismountPath = (string?)null,
        rideBgmId,
        rideBgmPath,
    });
}
var version = System.IO.File.ReadAllText(Path.Combine(clientRoot, "game", "ffxivgame.ver")).Trim();
Console.WriteLine(JsonSerializer.Serialize(new { clientVersion = version, count = rows.Count, mounts = rows }, new JsonSerializerOptions { WriteIndented = true }));
