using System.Text.Json;
using Lumina;

var clientRoot = args.Length > 0 ? args[0] : throw new ArgumentException("client-root required");
var candidatesFile = args.Length > 1 ? args[1] : throw new ArgumentException("candidates file required");
using var game = new GameData(Path.Combine(clientRoot, "game", "sqpack"));
var candidates = File.ReadAllLines(candidatesFile)
    .Select(line => line.Trim())
    .Where(line => line.Length > 0 && !line.StartsWith('#'))
    .ToList();
var found = new List<string>();
var missing = new List<string>();
foreach (var candidate in candidates)
{
    if (game.FileExists(candidate)) found.Add(candidate);
    else missing.Add(candidate);
}
Console.WriteLine(JsonSerializer.Serialize(new { total = candidates.Count, foundCount = found.Count, found, missing }, new JsonSerializerOptions { WriteIndented = true }));
