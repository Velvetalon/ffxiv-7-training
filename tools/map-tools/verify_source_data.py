"""Independently compare raw exported layout/UV data with a staged scene release."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import struct
from world_catalog import aetheryte_visual, map_root, scene_ids

ROOT = Path(__file__).resolve().parent
SCENES = scene_ids()

def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]

def text(data, offset):
    end = data.find(b"\0", offset)
    return "" if offset <= 0 or end < offset else data[offset:end].decode("utf-8", errors="replace")

def decode_layer(data, offset):
    layer_id, name_offset, objects_offset, count = struct.unpack_from("<IIII", data, offset)
    festival = struct.unpack_from("<H", data, offset + 24)[0]
    objects = []
    for index in range(count):
        item_offset = offset + objects_offset + u32(data, offset + objects_offset + index * 4)
        kind, instance_id, item_name = struct.unpack_from("<III", data, item_offset)
        values = struct.unpack_from("<9f", data, item_offset + 12)
        item = {"kind": kind, "id": instance_id, "name": text(data, item_offset + item_name),
                "position": values[:3], "rotation": values[3:6], "scale": values[6:9]}
        if kind in (1, 6): item["asset"] = text(data, item_offset + u32(data, item_offset + 48))
        objects.append(item)
    return {"id": layer_id, "name": text(data, offset + name_offset), "festival": festival, "objects": objects}

def read_layout(path):
    data = path.read_bytes()
    if data[:4] == b"LGB1":
        count = u32(data, 32)
        return [decode_layer(data, 36 + u32(data, 36 + index * 4)) for index in range(count)]
    if data[:4] == b"SGB1":
        group_offset, group_count = struct.unpack_from("<II", data, 20)
        layers = []
        for group in range(group_count):
            base = 20 + group_offset + group * 4
            _, _, entries_offset, count = struct.unpack_from("<IIII", data, base)
            for index in range(count): layers.append(decode_layer(data, base + entries_offset + u32(data, base + entries_offset + index * 4)))
        return layers
    raise ValueError(f"Unsupported layout header in {path}")

def identity(): return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

def multiply(left, right):
    return [sum(left[k * 4 + row] * right[column * 4 + k] for k in range(4)) for column in range(4) for row in range(4)]

def trs(item):
    x, y, z = item["rotation"]
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    rx = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]
    ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]
    rz = [cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    scale = [item["scale"][0], 0, 0, 0, 0, item["scale"][1], 0, 0, 0, 0, item["scale"][2], 0, 0, 0, 0, 1]
    result = multiply(multiply(multiply(rx, ry), rz), scale)
    result[12:15] = item["position"]
    return result

def expected_matrices(source, scene):
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    main = next((item for item in manifest["layouts"] if item["type"] == "Aetheryte"), None)
    groups, shared = collections.defaultdict(list), {}
    def visit(item, parent, trail=()):
        asset = item.get("asset", "")
        world = multiply(parent, trs(item))
        if item["kind"] == 1 and asset.endswith(".mdl"):
            groups[asset].append(world)
        elif item["kind"] == 6 and asset.endswith(".sgb") and asset not in trail:
            shared.setdefault(asset, read_layout(source / asset))
            for layer in shared[asset]:
                for child in layer["objects"]: visit(child, world, trail + (asset,))
    bg = map_root(source.parent, scene) / "level/bg.lgb"
    for layer in read_layout(bg):
        if layer["festival"] == 0 and not re.search(r"(?:festival|season|event|halloween|christmas)", layer["name"], re.I):
            for item in layer["objects"]: visit(item, identity())
    for item in manifest["layouts"]:
        if item["type"] == "TerrainPlate":
            matrix = identity(); point = item["translation"]
            matrix[12:15] = [point["X"], point["Y"], point["Z"]]
            groups[item["model"]].append(matrix)
    visual=aetheryte_visual(source)
    if main and visual:
        visit({"kind": 6, "asset": visual,
               "position": [main["translation"][axis] for axis in ("X", "Y", "Z")], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, identity())
    return {asset: list({tuple(round(value, 4) for value in matrix): matrix for matrix in matrices}.values())
            for asset, matrices in groups.items() if (source / f"{asset}.glb").is_file()}

def glb_document(path):
    data = path.read_bytes()
    if data[:4] != b"glTF" or u32(data, 8) != len(data): raise ValueError(f"Invalid GLB: {path}")
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A: raise ValueError(f"Missing JSON chunk: {path}")
    document = json.loads(data[20:20 + json_length])
    binary_start = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<II", data, binary_start)
    if binary_type != 0x004E4942: raise ValueError(f"Missing BIN chunk: {path}")
    return data, document, memoryview(data)[binary_start + 8:binary_start + 8 + binary_length]

def floats(document, binary, accessor_index):
    accessor = document["accessors"][accessor_index]
    if accessor["componentType"] != 5126: raise ValueError("Expected float accessor")
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    view = document["bufferViews"][accessor["bufferView"]]
    stride = view.get("byteStride", components * 4)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    for index in range(accessor["count"]): yield struct.unpack_from("<" + "f" * components, binary, offset + index * stride)

def audit_uvs(source, release):
    output = {"models": 0, "byteExact": 0, "attributes": {}}
    scene = json.loads((release / "scene.json").read_text(encoding="utf-8"))
    for model in scene["models"]:
        raw_path, release_path = source / f"{model['asset']}.glb", release / model["url"]
        raw_bytes, raw_doc, raw_bin = glb_document(raw_path)
        release_bytes, release_doc, release_bin = glb_document(release_path)
        output["models"] += 1
        if hashlib.sha256(raw_bytes).digest() != hashlib.sha256(release_bytes).digest():
            raise AssertionError(f"GLB changed during assembly: {model['asset']}")
        output["byteExact"] += 1
        for mesh in raw_doc["meshes"]:
            for primitive in mesh["primitives"]:
                for semantic, accessor in primitive["attributes"].items():
                    if not (semantic.startswith("TEXCOORD_") or semantic == "COLOR_0"): continue
                    release_accessor = release_doc["meshes"][raw_doc["meshes"].index(mesh)]["primitives"][mesh["primitives"].index(primitive)]["attributes"][semantic]
                    values = list(floats(raw_doc, raw_bin, accessor))
                    released = list(floats(release_doc, release_bin, release_accessor))
                    if any(a != b and not (math.isnan(a) and math.isnan(b)) for source_value, target_value in zip(values, released) for a, b in zip(source_value, target_value)): raise AssertionError(f"Numeric attribute mismatch: {model['asset']} {semantic}")
                    stat = output["attributes"].setdefault(semantic, {"primitives": 0, "vertices": 0, "min": [float("inf")] * len(values[0]), "max": [float("-inf")] * len(values[0])})
                    stat["primitives"] += 1; stat["vertices"] += len(values)
                    stat["sourceNonFiniteComponents"] = stat.get("sourceNonFiniteComponents", 0) + sum(not math.isfinite(component) for value in values for component in value)
                    for value in values:
                        stat["min"] = [min(a, b) if math.isfinite(b) else a for a, b in zip(stat["min"], value)]
                        stat["max"] = [max(a, b) if math.isfinite(b) else a for a, b in zip(stat["max"], value)]
    return output

def audit_scene(scene, exports, release):
    source = exports / scene
    expected = expected_matrices(source, scene)
    actual = {model["asset"]: model["matrices"] for model in json.loads((release / scene / "scene.json").read_text(encoding="utf-8"))["models"]}
    if set(expected) != set(actual): raise AssertionError(f"{scene}: model asset sets differ ({len(expected)} expected, {len(actual)} actual)")
    max_error = 0.0; instances = 0
    for asset, matrices in expected.items():
        target = {tuple(round(value, 4) for value in matrix): matrix for matrix in actual[asset]}
        if len(matrices) != len(target) or set(tuple(round(value, 4) for value in matrix) for matrix in matrices) != set(target):
            raise AssertionError(f"{scene}: placement mismatch for {asset}")
        for matrix in matrices:
            released = target[tuple(round(value, 4) for value in matrix)]
            max_error = max(max_error, max(abs(left - right) for left, right in zip(matrix, released)))
            instances += 1
    return {"models": len(expected), "instances": instances, "maxMatrixAbsError": max_error,
            "uv": audit_uvs(source, release / scene)}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exports", type=Path, default=ROOT / "exports")
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--scenes", nargs="+", choices=SCENES, default=list(SCENES))
    args = parser.parse_args()
    result = {scene: audit_scene(scene, args.exports, args.release) for scene in args.scenes}
    print(json.dumps(result, indent=2))
