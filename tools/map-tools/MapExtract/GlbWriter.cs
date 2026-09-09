using System.Numerics;
using System.Text;
using System.Text.Json;

public record Geometry(string Name, Vector3[] Positions, ushort[] Indices, Vector3[]? Normals = null, Vector2[]? UVs = null, string? Material = null, Vector2[][]? AdditionalUVs = null, Vector4[]? Colors = null);

public static class GlbWriter
{
    public static void Write(string path, IReadOnlyList<Geometry> geometries)
    {
        var views = new List<object>(); var accessors = new List<object>(); var meshes = new List<object>(); var nodes = new List<object>();
        using var bin = new MemoryStream(); using var writer = new BinaryWriter(bin, Encoding.UTF8, true);
        foreach (var geometry in geometries)
        {
            if (geometry.Positions.Length == 0 || geometry.Indices.Length == 0) continue;
            Align(writer, 0);
            var vertexOffset = (int)bin.Position;
            var min = new Vector3(float.MaxValue); var max = new Vector3(float.MinValue);
            foreach (var p in geometry.Positions) { writer.Write(p.X); writer.Write(p.Y); writer.Write(p.Z); min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
            views.Add(new { buffer = 0, byteOffset = vertexOffset, byteLength = geometry.Positions.Length * 12, target = 34962 });
            var positionAccessor = accessors.Count;
            accessors.Add(new { bufferView = views.Count - 1, componentType = 5126, count = geometry.Positions.Length, type = "VEC3", min = new[] { min.X, min.Y, min.Z }, max = new[] { max.X, max.Y, max.Z } });
            var attributes = new Dictionary<string, int> { ["POSITION"] = positionAccessor };
            if (geometry.Normals != null)
            {
                var offset = (int)bin.Position;
                foreach (var n in geometry.Normals) { writer.Write(n.X); writer.Write(n.Y); writer.Write(n.Z); }
                views.Add(new { buffer = 0, byteOffset = offset, byteLength = geometry.Normals.Length * 12, target = 34962 });
                attributes["NORMAL"] = accessors.Count;
                accessors.Add(new { bufferView = views.Count - 1, componentType = 5126, count = geometry.Normals.Length, type = "VEC3" });
            }
            if (geometry.UVs != null)
            {
                var offset = (int)bin.Position;
                foreach (var uv in geometry.UVs) { writer.Write(uv.X); writer.Write(uv.Y); }
                views.Add(new { buffer = 0, byteOffset = offset, byteLength = geometry.UVs.Length * 8, target = 34962 });
                attributes["TEXCOORD_0"] = accessors.Count;
                accessors.Add(new { bufferView = views.Count - 1, componentType = 5126, count = geometry.UVs.Length, type = "VEC2" });
            }
            if (geometry.AdditionalUVs != null)
            {
                for (var set = 0; set < geometry.AdditionalUVs.Length; set++)
                {
                    var coordinates = geometry.AdditionalUVs[set];
                    var offset = (int)bin.Position;
                    foreach (var uv in coordinates) { writer.Write(uv.X); writer.Write(uv.Y); }
                    views.Add(new { buffer = 0, byteOffset = offset, byteLength = coordinates.Length * 8, target = 34962 });
                    attributes[$"TEXCOORD_{set + 1}"] = accessors.Count;
                    accessors.Add(new { bufferView = views.Count - 1, componentType = 5126, count = coordinates.Length, type = "VEC2" });
                }
            }
            if (geometry.Colors != null)
            {
                var offset = (int)bin.Position;
                foreach (var color in geometry.Colors) { writer.Write(color.X); writer.Write(color.Y); writer.Write(color.Z); writer.Write(color.W); }
                views.Add(new { buffer = 0, byteOffset = offset, byteLength = geometry.Colors.Length * 16, target = 34962 });
                attributes["COLOR_0"] = accessors.Count;
                accessors.Add(new { bufferView = views.Count - 1, componentType = 5126, count = geometry.Colors.Length, type = "VEC4" });
            }
            Align(writer, 0);
            var indexOffset = (int)bin.Position;
            foreach (var index in geometry.Indices) writer.Write(index);
            views.Add(new { buffer = 0, byteOffset = indexOffset, byteLength = geometry.Indices.Length * 2, target = 34963 });
            var indexAccessor = accessors.Count;
            accessors.Add(new { bufferView = views.Count - 1, componentType = 5123, count = geometry.Indices.Length, type = "SCALAR" });
            meshes.Add(new { name = geometry.Name, primitives = new[] { new { attributes, indices = indexAccessor, material = 0, mode = 4 } } });
            nodes.Add(new { name = geometry.Name, mesh = meshes.Count - 1, extras = new { materialPath = geometry.Material, uvConvention = "client-UV-preserved", uvSets = 1 + (geometry.AdditionalUVs?.Length ?? 0) } });
        }
        Align(writer, 0);
        var document = new { asset = new { version = "2.0", generator = "MapExtract geometry prototype" }, scene = 0, scenes = new[] { new { nodes = Enumerable.Range(0, nodes.Count).ToArray() } }, nodes, meshes, materials = new[] { new { name = "Geometry preview", doubleSided = true, pbrMetallicRoughness = new { baseColorFactor = new[] { .7, .74, .72, 1.0 }, metallicFactor = 0.0, roughnessFactor = .9 } } }, buffers = new[] { new { byteLength = (int)bin.Length } }, bufferViews = views, accessors };
        var json = JsonSerializer.SerializeToUtf8Bytes(document);
        var paddedJson = (json.Length + 3) & ~3;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using var file = new BinaryWriter(File.Create(path));
        file.Write(0x46546C67u); file.Write(2u); file.Write((uint)(12 + 8 + paddedJson + 8 + bin.Length));
        file.Write((uint)paddedJson); file.Write(0x4E4F534Au); file.Write(json);
        for (var i = json.Length; i < paddedJson; i++) file.Write((byte)32);
        file.Write((uint)bin.Length); file.Write(0x004E4942u); file.Write(bin.ToArray());
    }
    private static void Align(BinaryWriter writer, byte padding) { while (writer.BaseStream.Position % 4 != 0) writer.Write(padding); }
}
