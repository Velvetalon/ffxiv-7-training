using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Diagnostics;
using Lumina;
using Lumina.Data.Files;
using Lumina.Data.Parsing.Layer;
using Lumina.Data.Parsing.Scd;
using Lumina.Excel;

// Offline SCD reader. Lumina is used for the format parser and its OggVorbis
// decoder; MapExtract.cmd remains the only client-to-raw extraction boundary.
if (args.Length < 4)
{
    Console.Error.WriteLine("Usage: ScdExtract <client-root> <sound.lgb> <out-dir> <scene-id> [--scd <path> ...]");
    return 2;
}

var clientRoot = Path.GetFullPath(args[0]);
var lgbPath = Path.GetFullPath(args[1]);
var outputRoot = Path.GetFullPath(args[2]);
var sceneId = args[3];
var explicitScd = ReadMany(args, "--scd");
var vgaudioPath = ReadOne(args, "--vgaudio");
var oggencPath = ReadOne(args, "--oggenc");
Directory.CreateDirectory(outputRoot);

var sqpack = Directory.Exists(Path.Combine(clientRoot, "game", "sqpack"))
    ? Path.Combine(clientRoot, "game", "sqpack")
    : Directory.Exists(Path.Combine(clientRoot, "sqpack"))
        ? Path.Combine(clientRoot, "sqpack")
        : clientRoot;
if (!Directory.Exists(sqpack)) throw new DirectoryNotFoundException($"sqpack not found below {clientRoot}");

using var game = new GameData(sqpack);
var bgmSheet = game.GetExcelSheet<BgmRow>();
Console.Error.WriteLine($"BGM sheet rows={bgmSheet.Count}, columns={bgmSheet.Columns.Count}");
Console.Error.WriteLine($"BGM-related sheets: {string.Join(',', game.Excel.SheetNames.Where(name => name.Contains("bgm", StringComparison.OrdinalIgnoreCase)))}");
foreach (var row in bgmSheet.Where(row => row.RowId >= 990 && row.RowId <= 1020))
    Console.Error.WriteLine($"BGM nearby {row.RowId}: {row.File}");
foreach (var id in new uint[] { 1003, 1020, 1035 })
    Console.Error.WriteLine($"BGM row {id}: {(bgmSheet.GetRowOrDefault(id)?.File ?? "<missing>" )}");
var territorySheet = game.GetExcelSheet<TerritoryRow>();
foreach (var id in new uint[] { 128, 129, 130, 131, 132, 133 })
    Console.Error.WriteLine($"Territory row {id}: BGM={territorySheet.GetRowOrDefault(id)?.Bgm.ToString() ?? "<missing>"}");
var soundLgb = game.GetFileFromDisk<LgbFile>(lgbPath, $"bg/ffxiv/audio/{sceneId}/level/sound.lgb");
var paths = new HashSet<string>(explicitScd.Select(NormalizePath), StringComparer.OrdinalIgnoreCase);
var references = new List<SoundReference>();

foreach (var layer in soundLgb.Layers)
foreach (var instance in layer.InstanceObjects)
{
    if (instance.Object is not LayerCommon.SoundInstanceObject sound) continue;
    var path = NormalizePath(sound.AssetPath);
    if (!path.EndsWith(".scd", StringComparison.OrdinalIgnoreCase)) continue;
    paths.Add(path);
    references.Add(new SoundReference(sceneId, layer.Name, instance.InstanceId, path, sound.SoundEffectParam, sound.SEParam.SoundEffectType.ToString(), sound.SEParam.AutoPlay != 0));
}

var resources = new Dictionary<string, Resource>(StringComparer.OrdinalIgnoreCase);
var sceneCandidates = new List<Candidate>();
var errors = new List<object>();
foreach (var path in paths.OrderBy(value => value, StringComparer.OrdinalIgnoreCase))
{
    ScdFile? scd;
    try { scd = game.GetFile<ScdFile>(path); }
    catch (Exception error) { errors.Add(new { path, error = error.Message }); continue; }
    if (scd is null) { errors.Add(new { path, error = "SCD not found in client" }); continue; }

    for (var soundIndex = 0; soundIndex < scd.SoundDataCount; soundIndex++)
    {
        ScdFile.Sound sound;
        try { sound = scd.GetSound(soundIndex); }
        catch (Exception error) { errors.Add(new { path, soundIndex, error = error.Message }); continue; }
        var audioIndices = AudioIndices(sound.TrackInfos).ToArray();
        if (audioIndices.Length == 0) Console.Error.WriteLine($"No track audio indices: {path} sound={soundIndex} tracks={sound.TrackInfos?.GetType().FullName ?? "null"}");
        foreach (var audioIndex in audioIndices)
        {
            if (audioIndex < 0 || audioIndex >= scd.AudioDataCount) continue;
            ScdFile.Audio audio;
            try { audio = scd.GetAudio(audioIndex); }
            catch (Exception error) { errors.Add(new { path, soundIndex, audioIndex, error = error.Message }); continue; }
            if (audio.AudioData.Length == 0) continue;
            var isHca = (int)audio.AudioBasicDesc.Format == 0x1A;
            var extension = isHca && !string.IsNullOrWhiteSpace(vgaudioPath) ? "wav" : Extension(audio.AudioBasicDesc.Format).extension;
            var mime = isHca && !string.IsNullOrWhiteSpace(vgaudioPath) ? "audio/wav" : Extension(audio.AudioBasicDesc.Format).mime;
            if (extension is null) { errors.Add(new { path, soundIndex, audioIndex, format = (int)audio.AudioBasicDesc.Format, formatName = audio.AudioBasicDesc.Format.ToString(), size = audio.AudioData.Length, channel = audio.AudioBasicDesc.Channel, rate = audio.AudioBasicDesc.Rate, loopStart = audio.AudioBasicDesc.LoopStart, loopEnd = audio.AudioBasicDesc.LoopEnd, subInfoSize = audio.AudioBasicDesc.SubInfoSize, flags = (int)audio.AudioBasicDesc.Flg, head = Convert.ToHexString(audio.AudioData.Take(24).ToArray()), error = "unsupported audio format" }); continue; }
            byte[] outputBytes;
            var hcaWasOgg = false;
            try {
                outputBytes = isHca
                    ? DecodeHca(scd, audioIndex, vgaudioPath!, oggencPath, out hcaWasOgg)
                    : audio.AudioBasicDesc.Format == AudioFormat.MsAdpcm ? ToWave(audio) : audio.AudioData;
                if (isHca && hcaWasOgg) { extension = "ogg"; mime = "audio/ogg"; }
            }
            catch (Exception error) {
                errors.Add(new { path, soundIndex, audioIndex, format = (int)audio.AudioBasicDesc.Format, error = error.Message });
                continue;
            }
            var hash = Convert.ToHexString(SHA256.HashData(outputBytes)).ToLowerInvariant();
            var fileName = $"{hash}.{extension}";
            var filePath = Path.Combine(outputRoot, fileName);
            if (!File.Exists(filePath)) File.WriteAllBytes(filePath, outputBytes);
            var resourceId = ResourceId(path, audioIndex);
            var isMusic = sound.SoundBasicDesc.Attribute.HasFlag(SoundAttribute.Music);
            var loopScale = isHca ? 1024 : 1; // HCA stores loop positions in 1024-sample block units.
            var loopStart = audio.AudioBasicDesc.Rate == 0 ? (double?)null : audio.AudioBasicDesc.LoopStart * loopScale / (double)audio.AudioBasicDesc.Rate;
            var loopEnd = audio.AudioBasicDesc.Rate == 0 ? (double?)null : audio.AudioBasicDesc.LoopEnd * loopScale / (double)audio.AudioBasicDesc.Rate;
            if (!resources.ContainsKey(resourceId)) resources[resourceId] = new Resource(
                resourceId,
                "audio",
                hash,
                outputBytes.Length,
                $"./{fileName}",
                new Metadata(mime, loopStart, loopEnd, audio.AudioBasicDesc.Channel, audio.AudioBasicDesc.Rate, isHca ? (hcaWasOgg ? "HCA->OGG (VGAudio+oggenc2)" : "HCA WAV (VGAudio)") : audio.AudioBasicDesc.Format == AudioFormat.MsAdpcm ? "MS-ADPCM WAV" : audio.AudioBasicDesc.Format.ToString()),
                new Source(path, soundIndex, audioIndex, sound.SoundBasicDesc.LocalNumber, (int)sound.SoundBasicDesc.Attribute, sound.SoundBasicDesc.Type.ToString(), isMusic));
            sceneCandidates.Add(new Candidate(resourceId, path, soundIndex, audioIndex, isMusic, sound.SoundBasicDesc.Attribute.HasFlag(SoundAttribute.Loop), loopStart, loopEnd));
        }
    }
}

var chosen = sceneCandidates
    .OrderByDescending(candidate => candidate.IsMusic)
    .ThenByDescending(candidate => candidate.Loop)
    .ThenBy(candidate => candidate.Path, StringComparer.OrdinalIgnoreCase)
    .ThenBy(candidate => candidate.AudioIndex)
    .FirstOrDefault();
var manifest = new Manifest(
    1,
    new SourceInfo("Lumina", "2.4.2", "SCD OggVorbis decryption/format parser; source client read through MapExtract.cmd raw", sceneId),
    new Dictionary<string, SceneBgm> { [sceneId] = chosen is null ? new SceneBgm(null, "Unknown", null) : new SceneBgm(chosen.ResourceId, "Confirmed from sound.lgb -> SCD -> SoundBasicDesc", chosen.LoopEnd is > 0 ? chosen.LoopEnd : null) },
    resources,
    references,
    errors);
var json = JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
File.WriteAllText(Path.Combine(outputRoot, "audio-source-manifest.json"), json);
Console.WriteLine(JsonSerializer.Serialize(new { sceneId, scdPaths = paths.Count, references = references.Count, resources = resources.Count, chosen = chosen?.ResourceId, errors = errors.Count }));
return 0;

static IEnumerable<int> AudioIndices(object tracks)
{
    return tracks switch
    {
        TrackInfo[] items => items.Select(item => (int)item.AudioDataIndex),
        RandomTrackInfo[] items => items.Select(item => (int)item.BaseInfo.AudioDataIndex),
        List<TrackInfo> items => items.Select(item => (int)item.AudioDataIndex),
        List<RandomTrackInfo> items => items.Select(item => (int)item.BaseInfo.AudioDataIndex),
        _ => Array.Empty<int>(),
    };
}

static (string? extension, string mime) Extension(AudioFormat format) => format switch
{
    AudioFormat.OggVorbis => ("ogg", "audio/ogg"),
    AudioFormat.Mp3 => ("mp3", "audio/mpeg"),
    AudioFormat.MsAdpcm => ("wav", "audio/wav"),
    AudioFormat.Atrac9 => (null, "audio/atrac9"),
    _ => (null, "application/octet-stream"),
};

static string NormalizePath(string? path) => (path ?? string.Empty).Trim().Replace('\\', '/').TrimStart('/');

static string ResourceId(string path, int audioIndex)
{
    var safe = new string(path.Select(value => char.IsLetterOrDigit(value) ? char.ToLowerInvariant(value) : '_').ToArray()).Trim('_');
    return $"audio.scd.{safe}.a{audioIndex}";
}

static IEnumerable<string> ReadMany(string[] args, string key)
{
    for (var index = 0; index < args.Length - 1; index++)
        if (args[index].Equals(key, StringComparison.OrdinalIgnoreCase)) yield return args[++index];
}

static string? ReadOne(string[] args, string key) => ReadMany(args, key).FirstOrDefault();

static byte[] ToWave(ScdFile.Audio audio)
{
    if (audio.AudioDataHeader is not AdpcmWaveFormat format)
        throw new InvalidDataException("MS-ADPCM audio has no format header");
    using var stream = new MemoryStream();
    using var writer = new BinaryWriter(stream, Encoding.ASCII, leaveOpen: true);
    writer.Write(Encoding.ASCII.GetBytes("RIFF"));
    writer.Write(0);
    writer.Write(Encoding.ASCII.GetBytes("WAVE"));
    writer.Write(Encoding.ASCII.GetBytes("fmt "));
    writer.Write(52);
    writer.Write(format.FormatTag);
    writer.Write(format.Channels);
    writer.Write(format.SamplesPerSec);
    writer.Write(format.AvgBytesPerSec);
    writer.Write(format.BlockAlign);
    writer.Write(format.BitsPerSample);
    writer.Write((short)32);
    writer.Write(format.SamplesPerBlock);
    writer.Write(format.NumCoef);
    unsafe
    {
        for (var i = 0; i < 14; i++) writer.Write(format.Coef[i]);
    }
    writer.Write(Encoding.ASCII.GetBytes("data"));
    writer.Write(audio.AudioData.Length);
    writer.Write(audio.AudioData);
    writer.Flush();
    var bytes = stream.ToArray();
    BitConverter.GetBytes(bytes.Length - 8).CopyTo(bytes, 4);
    return bytes;
}

static byte[] DecodeHca(ScdFile scd, int audioIndex, string vgaudioPath, string? oggencPath, out bool encodedOgg)
{
    encodedOgg = false;
    var bytes = scd.Data;
    if (bytes.Length < 0x40) throw new InvalidDataException("SCD header is truncated");
    var audioTable = BitConverter.ToUInt32(bytes, 0x3c);
    var audioOffset = BitConverter.ToUInt32(bytes, checked((int)audioTable + audioIndex * 4));
    var dataLength = BitConverter.ToInt32(bytes, checked((int)audioOffset));
    var subInfoSize = BitConverter.ToInt32(bytes, checked((int)audioOffset + 0x18));
    var subInfo = checked((int)audioOffset + 0x20);
    var headerSize = BitConverter.ToInt16(bytes, subInfo + 2);
    var blockSize = BitConverter.ToInt16(bytes, subInfo + 4);
    var plainText = bytes[subInfo + 13] != 0;
    if (headerSize <= 0 || blockSize <= 0 || subInfoSize < 24 + headerSize || dataLength < 0) throw new InvalidDataException("Invalid HCA sub-info");
    var hcaHeaderOffset = subInfo + 24;
    var hcaDataOffset = hcaHeaderOffset + headerSize;
    var encoded = bytes.AsSpan(hcaDataOffset, dataLength).ToArray();
    if (!plainText) {
        var hcaXorTable = Convert.FromHexString("3A323232037E12F7B2E2A267323222323252161B3CA1547B1B97A6931A4BAAA67A7B1B97A6F702BBAAA6BBF72A51BE03F42A51BE03F42A51BE1206562732323632B21A3BBC91D47B58FC0B552A15BC40920B5B7C0A951235B863D20B3BF0C714515C948694595CFC1B173A3F6B3732323032727A13B726607A13B72650BA13B42A50BA13B52E40FA1395AE4038189A92B03800FA12B17E00DB96A17C08DB9A91BC08D81A86E270391F86E0787E03E764519C8F346F4E41FC0BD5AE41FC0BD5AE41FC3B70716433321232323670342B5622703A13B72660BA1B94AA403800FAB2E2A26732321232B23232323275A3267B8326F9832EFFE3167DC01E632107E301");
        var v47 = dataLength & 0x3F;
        var v48 = dataLength & 0x7F;
        var currentBlockStart = 0;
        for (var pos = 0; pos + blockSize <= encoded.Length; pos += blockSize) {
            for (var i = 0; i < blockSize; i++) {
                var tableIndex = (0xA0 + i + currentBlockStart + v47) & 0xFF;
                encoded[pos + i] = (byte)(encoded[pos + i] ^ hcaXorTable[tableIndex] ^ v48);
            }
            currentBlockStart = (currentBlockStart + blockSize) & 0xFF;
        }
    }
    var hca = new byte[headerSize + encoded.Length];
    Buffer.BlockCopy(bytes, hcaHeaderOffset, hca, 0, headerSize);
    Buffer.BlockCopy(encoded, 0, hca, headerSize, encoded.Length);
    if (hca.Length < 4 || Encoding.ASCII.GetString(hca, 0, 3) != "HCA") throw new InvalidDataException("HCA cipher decode did not produce an HCA header");

    var stem = Path.Combine(Path.GetTempPath(), $"ffxiv-audio-{Guid.NewGuid():N}");
    var hcaPath = stem + ".hca";
    var wavPath = stem + ".wav";
    try {
        File.WriteAllBytes(hcaPath, hca);
        var startInfo = new ProcessStartInfo {
            FileName = vgaudioPath,
            UseShellExecute = false,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        startInfo.ArgumentList.Add(hcaPath);
        startInfo.ArgumentList.Add(wavPath);
        var process = Process.Start(startInfo);
        if (process is null) throw new InvalidOperationException("Unable to start VGAudioCli");
        var processOutput = process.StandardOutput.ReadToEndAsync();
        var processError = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        processOutput.GetAwaiter().GetResult();
        var processErrorText = processError.GetAwaiter().GetResult();
        if (process.ExitCode != 0 || !File.Exists(wavPath)) throw new InvalidDataException($"VGAudioCli failed ({process.ExitCode}): {processErrorText}");
        var wav = File.ReadAllBytes(wavPath);
        if (string.IsNullOrWhiteSpace(oggencPath)) return wav;
        var oggPath = stem + ".ogg";
        var encodeInfo = new ProcessStartInfo { FileName = oggencPath, UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true };
        encodeInfo.ArgumentList.Add("-s"); encodeInfo.ArgumentList.Add("0");
        encodeInfo.ArgumentList.Add("--resample"); encodeInfo.ArgumentList.Add("44100");
        encodeInfo.ArgumentList.Add("-q"); encodeInfo.ArgumentList.Add("4");
        encodeInfo.ArgumentList.Add("-o"); encodeInfo.ArgumentList.Add(oggPath);
        encodeInfo.ArgumentList.Add(wavPath);
        var encoder = Process.Start(encodeInfo) ?? throw new InvalidOperationException("Unable to start oggenc2");
        var encoderOutput = encoder.StandardOutput.ReadToEndAsync();
        var encoderError = encoder.StandardError.ReadToEndAsync();
        encoder.WaitForExit();
        encoderOutput.GetAwaiter().GetResult();
        var encoderErrorText = encoderError.GetAwaiter().GetResult();
        if (encoder.ExitCode != 0 || !File.Exists(oggPath)) throw new InvalidDataException($"oggenc2 failed ({encoder.ExitCode}): {encoderErrorText}");
        encodedOgg = true;
        var ogg = File.ReadAllBytes(oggPath);
        try { File.Delete(oggPath); } catch { }
        return ogg;
    }
    finally {
        try { File.Delete(hcaPath); } catch { }
        try { File.Delete(wavPath); } catch { }
    }
}


record SoundReference(string SceneId, string Layer, uint InstanceId, string ScdPath, int SoundEffectParam, string SoundEffectType, bool AutoPlay);
record Candidate(string ResourceId, string Path, int SoundIndex, int AudioIndex, bool IsMusic, bool Loop, double? LoopStart, double? LoopEnd);
record Source(string ScdPath, int SoundIndex, int AudioIndex, ushort LocalNumber, int Attribute, string SoundType, bool IsMusic);
record Metadata(string Mime, double? LoopStart, double? LoopEnd, uint Channels, uint Rate, string Format);
record Resource(string Id, string Type, string Hash, int Size, string Path, Metadata Metadata, Source Source);
record SceneBgm(string? Id, string Evidence, double? LoopEnd);
record SourceInfo(string Library, string LibraryVersion, string Method, string SceneId);
record Manifest(int SchemaVersion, SourceInfo Source, Dictionary<string, SceneBgm> SceneBgm, Dictionary<string, Resource> Resources, List<SoundReference> References, List<object> Errors);

[Sheet("BGM")]
readonly struct BgmRow(ExcelPage page, uint offset, uint row) : IExcelRow<BgmRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public string File => page.ReadString(offset, offset).ToString();
    static BgmRow IExcelRow<BgmRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}

[Sheet("TerritoryType")]
readonly struct TerritoryRow(ExcelPage page, uint offset, uint row) : IExcelRow<TerritoryRow>
{
    public ExcelPage ExcelPage => page;
    public uint RowOffset => offset;
    public uint RowId => row;
    public ushort Bgm => page.ReadUInt16(offset + page.Sheet.GetColumnOffset(19));
    static TerritoryRow IExcelRow<TerritoryRow>.Create(ExcelPage page, uint offset, uint row) => new(page, offset, row);
}
