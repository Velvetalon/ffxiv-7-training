using System.Numerics;
using System.Text;
using System.Text.Json;
using Meddle.Formats.Files.MdlFile;
using Model = Meddle.Utils.Export.Model;

public sealed record SkeletonBone(int Index, string Name, int Parent, float[] Translation, float[] Rotation, float[] Scale);
public sealed record ModelSource(string GamePath, string LocalPath);
public sealed record AppearanceColors(float[] Skin, float[] Hair, float[] Highlight, float[] RightEye, float[] LeftEye, float[] Lip, float[] FacePaint);
public sealed record AppearanceGeometryConfig(string[] Shapes, float HeightScale, Dictionary<string, float[]> BoneScales);

public static class SkinnedGlbWriter
{
    private const int ArrayBuffer = 34962;
    private const int ElementArrayBuffer = 34963;

    public static void Write(string destination, IReadOnlyList<SkeletonBone> skeleton, AppearanceColors colors, AppearanceGeometryConfig geometryConfig, IReadOnlyDictionary<string, string> materialTextures, IReadOnlyList<ModelSource> sources)
    {
        ValidateSkeleton(skeleton);
        var boneByName = skeleton.ToDictionary(bone => bone.Name, bone => bone.Index, StringComparer.Ordinal);
        var views = new List<object>();
        var accessors = new List<object>();
        var meshes = new List<object>();
        var nodes = BuildBoneNodes(skeleton, geometryConfig);
        var materials = new List<object>();
        var images = new List<object>();
        var textures = new List<object>();
        var textureCache = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var meshNodeIndices = new List<int>();
        var sourceEvidence = new List<object>();
        using var binary = new MemoryStream();
        using var writer = new BinaryWriter(binary, Encoding.UTF8, true);
        int EmbedTexture(string texturePath)
        {
            if (textureCache.TryGetValue(texturePath, out var cached)) return cached;
            Align(writer);
            var png = File.ReadAllBytes(texturePath);
            var imageView = views.Count;
            views.Add(new { buffer = 0, byteOffset = (int)binary.Position, byteLength = png.Length });
            writer.Write(png);
            images.Add(new { name = Path.GetFileName(texturePath), mimeType = "image/png", bufferView = imageView });
            var index = textures.Count;
            textures.Add(new { source = images.Count - 1, sampler = 0 });
            textureCache[texturePath] = index;
            return index;
        }

        foreach (var source in sources)
        {
            var bytes = File.ReadAllBytes(source.LocalPath);
            var model = new Model(source.GamePath, new MdlFile(bytes), null);
            var sourceMeshCount = 0;
            var sourceVertexCount = 0;
            foreach (var geometry in model.Meshes)
            {
                if (geometry.Vertices.Count == 0 || geometry.Indices.Count == 0) continue;
                if (geometry.BoneTable == null) throw new InvalidDataException($"{source.GamePath} mesh {geometry.MeshIdx} has no bone table");
                var jointMap = geometry.BoneTable.Select(name => boneByName.TryGetValue(name, out var index)
                    ? checked((ushort)index)
                    : throw new InvalidDataException($"{source.GamePath} mesh {geometry.MeshIdx} references missing skeleton bone {name}")).ToArray();

                var attributes = new Dictionary<string, int>();
                var positions = geometry.Vertices.Select(vertex => vertex.Position ?? Vector3.Zero).ToArray();
                var normals = geometry.Vertices.Select(vertex => vertex.Normals?.FirstOrDefault() ?? Vector3.UnitY).ToArray();
                var appliedShapes = new List<string>();
                foreach (var shape in model.Shapes.Where(shape => geometryConfig.Shapes.Contains(shape.Name)))
                {
                    var changed = false;
                    foreach (var shapeMesh in shape.Meshes.Where(item => item.Mesh.MeshIdx == geometry.MeshIdx))
                    foreach (var (baseIndex, replacementIndex) in shapeMesh.Values)
                    {
                        if (baseIndex >= geometry.Indices.Count || replacementIndex >= geometry.Vertices.Count) continue;
                        var vertexIndex = geometry.Indices[baseIndex];
                        positions[vertexIndex] = geometry.Vertices[replacementIndex].Position ?? positions[vertexIndex];
                        normals[vertexIndex] = geometry.Vertices[replacementIndex].Normals?.FirstOrDefault() ?? normals[vertexIndex];
                        changed = true;
                    }
                    if (changed) appliedShapes.Add(shape.Name);
                }
                attributes["POSITION"] = WriteVec3(writer, binary, views, accessors, positions, true);
                if (geometry.Vertices.Any(vertex => vertex.Normals?.Length > 0))
                    attributes["NORMAL"] = WriteVec3(writer, binary, views, accessors, normals, false);
                if (geometry.Vertices.Any(vertex => vertex.TexCoords?.Length > 0))
                    attributes["TEXCOORD_0"] = WriteVec2(writer, binary, views, accessors, geometry.Vertices.Select(vertex => vertex.TexCoords?.FirstOrDefault() ?? Vector2.Zero).ToArray());
                var uvSets = Math.Min(4, geometry.Vertices.Max(vertex => vertex.TexCoords?.Length ?? 0));
                for (var uvSet = 1; uvSet < uvSets; uvSet++)
                {
                    var index = uvSet;
                    attributes[$"TEXCOORD_{index}"] = WriteVec2(writer, binary, views, accessors, geometry.Vertices.Select(vertex => vertex.TexCoords is { } coordinates && coordinates.Length > index ? coordinates[index] : Vector2.Zero).ToArray());
                }
                if (materialNameFor(model, geometry).Contains("_iri_", StringComparison.OrdinalIgnoreCase))
                {
                    var eyeColors = positions.Select(position => ToVec4(SquareRgb(position.X < 0 ? colors.LeftEye : colors.RightEye))).ToArray();
                    attributes["COLOR_0"] = WriteVec4(writer, binary, views, accessors, eyeColors);
                }
                else if (geometry.Vertices.Any(vertex => vertex.Colors?.Length > 0))
                    attributes["COLOR_0"] = WriteVec4(writer, binary, views, accessors, geometry.Vertices.Select(vertex => vertex.Colors?.FirstOrDefault() ?? Vector4.One).ToArray());

                var joints = new ushort[geometry.Vertices.Count * 4];
                var weights = new Vector4[geometry.Vertices.Count];
                for (var vertexIndex = 0; vertexIndex < geometry.Vertices.Count; vertexIndex++)
                {
                    var vertex = geometry.Vertices[vertexIndex];
                    if (vertex.BlendIndices == null || vertex.BlendWeights == null)
                        throw new InvalidDataException($"{source.GamePath} mesh {geometry.MeshIdx} vertex {vertexIndex} has no skin data");
                    var count = Math.Min(4, Math.Min(vertex.BlendIndices.Length, vertex.BlendWeights.Length));
                    var sum = 0f;
                    for (var influence = 0; influence < count; influence++) sum += vertex.BlendWeights[influence];
                    if (sum <= 0) sum = 1;
                    var normalized = new float[4];
                    for (var influence = 0; influence < count; influence++)
                    {
                        var localJoint = vertex.BlendIndices[influence];
                        if (localJoint >= jointMap.Length) throw new InvalidDataException($"{source.GamePath} mesh {geometry.MeshIdx} has out-of-range local joint {localJoint}");
                        joints[vertexIndex * 4 + influence] = jointMap[localJoint];
                        normalized[influence] = vertex.BlendWeights[influence] / sum;
                    }
                    weights[vertexIndex] = new Vector4(normalized[0], normalized[1], normalized[2], normalized[3]);
                }
                attributes["JOINTS_0"] = WriteUShort4(writer, binary, views, accessors, joints);
                attributes["WEIGHTS_0"] = WriteVec4(writer, binary, views, accessors, weights);
                var indexAccessor = WriteIndices(writer, binary, views, accessors, geometry.Indices);

                var materialName = materialNameFor(model, geometry);
                var materialIndex = materials.Count;
                var pbr = new Dictionary<string, object>
                {
                    ["baseColorFactor"] = materialTextures.ContainsKey(materialName) && IsBakedHair(materialName, source.GamePath) ? new float[] { 1, 1, 1, 1 } : ComponentColor(source.GamePath, materialName, colors),
                    ["metallicFactor"] = 0f,
                    ["roughnessFactor"] = .85f,
                };
                if (materialTextures.TryGetValue(materialName, out var texturePath))
                {
                    var textureIndex = EmbedTexture(texturePath);
                    pbr["baseColorTexture"] = new { index = textureIndex };
                }
                var material = new Dictionary<string, object>
                {
                    ["name"] = materialName,
                    ["doubleSided"] = true,
                    ["pbrMetallicRoughness"] = pbr,
                    ["extras"] = new { sourceMaterialPath = materialName, status = materialTextures.ContainsKey(materialName) ? "client-base-texture-embedded" : "client-palette-color" },
                };
                if (((float[])pbr["baseColorFactor"])[3] < 1) material["alphaMode"] = "BLEND";
                materials.Add(material);
                var meshIndex = meshes.Count;
                meshes.Add(new { name = $"{Path.GetFileName(source.GamePath)}#{geometry.MeshIdx}", primitives = new[] { new { attributes, indices = indexAccessor, material = materialIndex, mode = 4 } } });
                meshNodeIndices.Add(nodes.Count);
                nodes.Add(new { name = $"mesh:{source.GamePath}#{geometry.MeshIdx}", mesh = meshIndex, skin = 0, extras = new { sourceModelPath = source.GamePath, geometry.MeshIdx, boneTable = geometry.BoneTable, appliedShapes } });
                if (materialName.Contains("_fac_", StringComparison.OrdinalIgnoreCase) && materialTextures.TryGetValue("__facepaint", out var facePaintPath))
                {
                    if (!attributes.ContainsKey("TEXCOORD_1")) throw new InvalidDataException("Face-paint overlay requires MDL UV2/TEXCOORD_1");
                    var overlayAttributes = new Dictionary<string, int>(attributes)
                    {
                        ["POSITION"] = WriteVec3(writer, binary, views, accessors, positions.Select((position, index) => position + normals[index] * .0002f).ToArray(), true),
                    };
                    var overlayMaterialIndex = materials.Count;
                    materials.Add(new Dictionary<string, object>
                    {
                        ["name"] = "FFXIV face paint 14",
                        ["doubleSided"] = true,
                        ["alphaMode"] = "BLEND",
                        ["pbrMetallicRoughness"] = new Dictionary<string, object>
                        {
                            ["baseColorFactor"] = SquareRgb(colors.FacePaint),
                            ["baseColorTexture"] = new { index = EmbedTexture(facePaintPath), texCoord = 1 },
                            ["metallicFactor"] = 0f,
                            ["roughnessFactor"] = .8f,
                        },
                        ["extras"] = new { kind = "ffxiv-face-paint-overlay", sourceTexture = "chara/common/texture/decal_face/_decal_14.tex", uvSet = 1 },
                    });
                    var overlayMesh = meshes.Count;
                    meshes.Add(new { name = "facepaint-14-overlay", primitives = new[] { new { attributes = overlayAttributes, indices = indexAccessor, material = overlayMaterialIndex, mode = 4 } } });
                    meshNodeIndices.Add(nodes.Count);
                    nodes.Add(new { name = "mesh:facepaint-14-overlay", mesh = overlayMesh, skin = 0, extras = new { sourceModelPath = source.GamePath, geometry.MeshIdx } });
                    sourceMeshCount++;
                }
                if (materialName.Contains("_fac_", StringComparison.OrdinalIgnoreCase) && materialTextures.TryGetValue("__lip", out var lipPath))
                {
                    var overlayAttributes = new Dictionary<string, int>(attributes)
                    {
                        ["POSITION"] = WriteVec3(writer, binary, views, accessors, positions.Select((position, index) => position + normals[index] * .0001f).ToArray(), true),
                    };
                    var overlayMaterialIndex = materials.Count;
                    var lipFactor = SquareRgb(colors.Lip);
                    materials.Add(new Dictionary<string, object>
                    {
                        ["name"] = "FFXIV lip color",
                        ["doubleSided"] = true,
                        ["alphaMode"] = "BLEND",
                        ["pbrMetallicRoughness"] = new Dictionary<string, object>
                        {
                            ["baseColorFactor"] = lipFactor,
                            ["baseColorTexture"] = new { index = EmbedTexture(lipPath), texCoord = 0 },
                            ["metallicFactor"] = 0f,
                            ["roughnessFactor"] = .65f,
                        },
                        ["extras"] = new { kind = "ffxiv-lip-overlay", sourceMask = "face skin normal alpha", opacity = colors.Lip[3] },
                    });
                    var overlayMesh = meshes.Count;
                    meshes.Add(new { name = "lip-color-overlay", primitives = new[] { new { attributes = overlayAttributes, indices = indexAccessor, material = overlayMaterialIndex, mode = 4 } } });
                    meshNodeIndices.Add(nodes.Count);
                    nodes.Add(new { name = "mesh:lip-color-overlay", mesh = overlayMesh, skin = 0, extras = new { sourceModelPath = source.GamePath, geometry.MeshIdx } });
                    sourceMeshCount++;
                }
                sourceMeshCount++;
                sourceVertexCount += geometry.Vertices.Count;
            }
            sourceEvidence.Add(new { source.GamePath, bytes = bytes.Length, meshes = sourceMeshCount, vertices = sourceVertexCount });
        }

        var inverseBindAccessor = WriteInverseBindMatrices(writer, binary, views, accessors, skeleton);
        Align(writer);
        var roots = skeleton.Where(bone => bone.Parent == -1).Select(bone => bone.Index).Concat(meshNodeIndices).ToArray();
        var appearanceRoot = nodes.Count;
        nodes.Add(new Dictionary<string, object>
        {
            ["name"] = "appearance-root",
            ["children"] = roots,
            ["scale"] = new[] { geometryConfig.HeightScale, geometryConfig.HeightScale, geometryConfig.HeightScale },
            ["extras"] = new { source = "offline appearance geometry configuration" },
        });
        var document = new
        {
            asset = new { version = "2.0", generator = "FFXIV CharacterTools offline skinned MDL converter" },
            scene = 0,
            scenes = new[] { new { nodes = new[] { appearanceRoot } } },
            nodes,
            meshes,
            skins = new[] { new { name = "FFXIV native skeleton", inverseBindMatrices = inverseBindAccessor, skeleton = skeleton.First(bone => bone.Parent == -1).Index, joints = skeleton.Select(bone => bone.Index).ToArray() } },
            materials,
            images,
            textures,
            samplers = new[] { new { magFilter = 9729, minFilter = 9987, wrapS = 10497, wrapT = 10497 } },
            buffers = new[] { new { byteLength = (int)binary.Length } },
            bufferViews = views,
            accessors,
            extras = new { sourceEvidence, appearanceColors = colors, appearanceGeometry = geometryConfig, skinning = "MDL blend indices -> per-mesh bone table names -> SKLB skeleton nodes", maxInfluences = 4 },
        };
        WriteGlb(destination, document, binary.ToArray());
        Console.WriteLine($"Wrote {destination}: bones={skeleton.Count} meshes={meshes.Count} bytes={new FileInfo(destination).Length}");
    }

    private static List<object> BuildBoneNodes(IReadOnlyList<SkeletonBone> skeleton, AppearanceGeometryConfig geometryConfig)
    {
        var nodes = new List<object>(skeleton.Count);
        foreach (var bone in skeleton)
        {
            var children = skeleton.Where(candidate => candidate.Parent == bone.Index).Select(candidate => candidate.Index).ToArray();
            var scale = bone.Scale;
            if (geometryConfig.BoneScales.TryGetValue(bone.Name, out var multiplier))
                scale = new[] { scale[0] * multiplier[0], scale[1] * multiplier[1], scale[2] * multiplier[2] };
            var node = new Dictionary<string, object> { ["name"] = bone.Name, ["translation"] = bone.Translation, ["rotation"] = bone.Rotation, ["scale"] = scale, ["extras"] = new { boneIndex = bone.Index } };
            if (children.Length > 0) node["children"] = children;
            nodes.Add(node);
        }
        return nodes;
    }

    private static int WriteVec2(BinaryWriter writer, MemoryStream binary, List<object> views, List<object> accessors, IReadOnlyList<Vector2> values)
    {
        Align(writer); var offset = (int)binary.Position;
        foreach (var value in values) { writer.Write(value.X); writer.Write(value.Y); }
        return AddAccessor(views, accessors, offset, values.Count * 8, 5126, values.Count, "VEC2", ArrayBuffer);
    }

    private static int WriteVec3(BinaryWriter writer, MemoryStream binary, List<object> views, List<object> accessors, IReadOnlyList<Vector3> values, bool bounds)
    {
        Align(writer); var offset = (int)binary.Position;
        foreach (var value in values) { writer.Write(value.X); writer.Write(value.Y); writer.Write(value.Z); }
        var view = views.Count; views.Add(new { buffer = 0, byteOffset = offset, byteLength = values.Count * 12, target = ArrayBuffer });
        var index = accessors.Count;
        if (bounds)
        {
            var min = values.Aggregate(new Vector3(float.MaxValue), Vector3.Min); var max = values.Aggregate(new Vector3(float.MinValue), Vector3.Max);
            accessors.Add(new { bufferView = view, componentType = 5126, count = values.Count, type = "VEC3", min = new[] { min.X, min.Y, min.Z }, max = new[] { max.X, max.Y, max.Z } });
        }
        else accessors.Add(new { bufferView = view, componentType = 5126, count = values.Count, type = "VEC3" });
        return index;
    }

    private static int WriteVec4(BinaryWriter writer, MemoryStream binary, List<object> views, List<object> accessors, IReadOnlyList<Vector4> values)
    {
        Align(writer); var offset = (int)binary.Position;
        foreach (var value in values) { writer.Write(value.X); writer.Write(value.Y); writer.Write(value.Z); writer.Write(value.W); }
        return AddAccessor(views, accessors, offset, values.Count * 16, 5126, values.Count, "VEC4", ArrayBuffer);
    }

    private static int WriteUShort4(BinaryWriter writer, MemoryStream binary, List<object> views, List<object> accessors, IReadOnlyList<ushort> values)
    {
        Align(writer); var offset = (int)binary.Position;
        foreach (var value in values) writer.Write(value);
        return AddAccessor(views, accessors, offset, values.Count * 2, 5123, values.Count / 4, "VEC4", ArrayBuffer);
    }

    private static int WriteIndices(BinaryWriter writer, MemoryStream binary, List<object> views, List<object> accessors, IReadOnlyList<ushort> values)
    {
        Align(writer); var offset = (int)binary.Position;
        foreach (var value in values) writer.Write(value);
        return AddAccessor(views, accessors, offset, values.Count * 2, 5123, values.Count, "SCALAR", ElementArrayBuffer);
    }

    private static int WriteInverseBindMatrices(BinaryWriter writer, MemoryStream binary, List<object> views, List<object> accessors, IReadOnlyList<SkeletonBone> skeleton)
    {
        var world = new Matrix4x4[skeleton.Count];
        foreach (var bone in skeleton)
        {
            var local = Matrix4x4.CreateScale(ToVec3(bone.Scale)) * Matrix4x4.CreateFromQuaternion(ToQuat(bone.Rotation)) * Matrix4x4.CreateTranslation(ToVec3(bone.Translation));
            world[bone.Index] = bone.Parent == -1 ? local : local * world[bone.Parent];
        }
        Align(writer); var offset = (int)binary.Position;
        foreach (var matrix in world)
        {
            if (!Matrix4x4.Invert(matrix, out var inverse)) throw new InvalidDataException("Skeleton contains a non-invertible bind transform");
            foreach (var value in new[] { inverse.M11,inverse.M12,inverse.M13,inverse.M14,inverse.M21,inverse.M22,inverse.M23,inverse.M24,inverse.M31,inverse.M32,inverse.M33,inverse.M34,inverse.M41,inverse.M42,inverse.M43,inverse.M44 }) writer.Write(value);
        }
        return AddAccessor(views, accessors, offset, skeleton.Count * 64, 5126, skeleton.Count, "MAT4", 0);
    }

    private static int AddAccessor(List<object> views, List<object> accessors, int offset, int length, int componentType, int count, string type, int target)
    {
        var view = views.Count;
        if (target == 0) views.Add(new { buffer = 0, byteOffset = offset, byteLength = length });
        else views.Add(new { buffer = 0, byteOffset = offset, byteLength = length, target });
        accessors.Add(new { bufferView = view, componentType, count, type });
        return accessors.Count - 1;
    }

    private static string materialNameFor(Model model, Meddle.Utils.Export.Mesh geometry) => geometry.MaterialIdx < model.MtrlFileNames.Count ? model.MtrlFileNames[geometry.MaterialIdx] : "unknown";
    private static float[] ComponentColor(string path, string material, AppearanceColors colors)
    {
        if (material.Contains("_iri_", StringComparison.OrdinalIgnoreCase)) return [1, 1, 1, 1];
        if (material.Contains("_fac_", StringComparison.OrdinalIgnoreCase) || material.Contains("b0001", StringComparison.OrdinalIgnoreCase)) return SquareRgb(colors.Skin);
        if (path.Contains("/hair/", StringComparison.OrdinalIgnoreCase) || path.Contains("/tail/", StringComparison.OrdinalIgnoreCase) || material.Contains("_hir_", StringComparison.OrdinalIgnoreCase)) return SquareRgb(colors.Hair);
        if (path.Contains("/face/", StringComparison.OrdinalIgnoreCase) && material.Contains("_etc_a", StringComparison.OrdinalIgnoreCase)) return SquareRgb(colors.Hair);
        if (path.Contains("/face/", StringComparison.OrdinalIgnoreCase) && material.Contains("_etc_b", StringComparison.OrdinalIgnoreCase)) return [0, 0, 0, 0];
        return [1, 1, 1, 1];
    }
    private static float[] SquareRgb(float[] value) => [value[0] * value[0], value[1] * value[1], value[2] * value[2], value[3]];
    private static bool IsBakedHair(string material, string path) => material.Contains("_hir_", StringComparison.OrdinalIgnoreCase) || material.Contains("t0005", StringComparison.OrdinalIgnoreCase) || path.Contains("/face/", StringComparison.OrdinalIgnoreCase) && material.Contains("_etc_a", StringComparison.OrdinalIgnoreCase);
    private static Vector3 ToVec3(float[] value) => new(value[0], value[1], value[2]);
    private static Vector4 ToVec4(float[] value) => new(value[0], value[1], value[2], value[3]);
    private static Quaternion ToQuat(float[] value) => Quaternion.Normalize(new Quaternion(value[0], value[1], value[2], value[3]));
    private static void Align(BinaryWriter writer) { while (writer.BaseStream.Position % 4 != 0) writer.Write((byte)0); }

    private static void ValidateSkeleton(IReadOnlyList<SkeletonBone> skeleton)
    {
        if (skeleton.Count == 0 || skeleton.Count(bone => bone.Parent == -1) != 1) throw new InvalidDataException("Skeleton must have exactly one root");
        for (var i = 0; i < skeleton.Count; i++)
        {
            if (skeleton[i].Index != i) throw new InvalidDataException("Skeleton bone indices must be dense and ordered");
            if (skeleton[i].Parent >= i) throw new InvalidDataException($"Skeleton parent must precede child at bone {i}");
        }
    }

    private static void WriteGlb(string path, object document, byte[] binary)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(document);
        var paddedJson = (json.Length + 3) & ~3;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using var file = new BinaryWriter(File.Create(path));
        file.Write(0x46546c67u); file.Write(2u); file.Write((uint)(12 + 8 + paddedJson + 8 + binary.Length));
        file.Write((uint)paddedJson); file.Write(0x4e4f534au); file.Write(json);
        for (var i = json.Length; i < paddedJson; i++) file.Write((byte)32);
        file.Write((uint)binary.Length); file.Write(0x004e4942u); file.Write(binary);
    }
}
