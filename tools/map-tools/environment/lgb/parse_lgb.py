"""Read-only FFXIV LGB/LVB light and environment-object parser.

Byte layout authorities:
- Repository-pinned Meddle commit 7ef61f44f82c6363465d46b46e963a054d431c16,
  Meddle/Meddle.Formats/Files/LgbFile.cs: 0x20-byte container header,
  int32 group offsets at +0x24, layer groups whose name/object offsets live
  at +4/+8 relative to the layer record, 0x30-byte instance headers, and
  object-name offsets relative to the offset field itself.
- xivdev Physis v0.7 sources (src/layer/light.rs, src/layer/env.rs,
  src/layer/mod.rs, src/layer/transformation.rs, src/string_heap.rs): light,
  env-set and env-location payload layouts plus the string-heap rule that an
  offset is relative to the offset field position.

Unknown bytes are preserved as raw offsets and never renamed to guessed
semantics.  The client is never modified; this tool only reads files that the
caller extracted with the existing read-only SqPack tooling.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path

PARSER_VERSION = "1.0.0"
DAWNTRAIL_MARKER = 0x26014CE2
ASSET_PATH_RE = re.compile(rb"(?:bg|bgcommon)/[A-Za-z0-9_./-]+")

LAYER_ENTRY_TYPES = {
    0x00: "Unknown", 0x01: "BgPart", 0x02: "Attribute", 0x03: "Light",
    0x04: "Vfx", 0x05: "PositionMarker", 0x06: "SharedGroup", 0x07: "Sound",
    0x08: "EventNPC", 0x09: "BattleNPC", 0x0A: "RoutePath", 0x0B: "Character",
    0x0C: "Aetheryte", 0x0D: "EnvSet", 0x0E: "Gathering", 0x0F: "HelperObject",
    0x10: "Treasure", 0x11: "Clip", 0x14: "ClipLight", 0x1C: "PopRange",
    0x1D: "ExitRange", 0x1E: "LVB", 0x1F: "MapRange",
    0x20: "NaviMeshRange", 0x21: "EventObject", 0x22: "DemiHuman",
    0x23: "EnvLocation", 0x25: "RestBonusRange", 0x26: "QuestMarker",
    0x27: "Timeline", 0x28: "ObjectBehaviorSet", 0x29: "Movie",
    0x2C: "CollisionBox", 0x2D: "DoorRange", 0x2E: "LineVFX",
    0x2F: "SoundEnvSet", 0x30: "CharaScene", 0x31: "CutAction",
    0x34: "ClientPath", 0x35: "ServerPath", 0x36: "GimmickRange",
    0x37: "TargetMarker", 0x38: "ChairMarker", 0x39: "ClickableRange",
    0x3A: "PrefetchRange", 0x3B: "FateRange", 0x3C: "PartyMember",
    0x3D: "KeepRange", 0x3E: "SphereCastRange", 0x3F: "IndoorObject",
    0x40: "OutdoorObject", 0x41: "EditGroup", 0x42: "StableChocobo",
}
LIGHT_SHAPES = {0: "None", 1: "World", 2: "Point", 3: "Spot", 4: "Flat", 5: "Line", 6: "Specular"}
POINT_LIGHT_TYPES = {0: "Sphere", 1: "Hemisphere"}
ENV_SET_SHAPES = {1: "Ellipsoid", 2: "Cuboid", 3: "Cylinder"}


class Reader:
    def __init__(self, data: bytes):
        self.data = data

    def u8(self, pos: int) -> int:
        return self.data[pos]

    def u32(self, pos: int) -> int:
        return struct.unpack_from("<I", self.data, pos)[0]

    def i32(self, pos: int) -> int:
        return struct.unpack_from("<i", self.data, pos)[0]

    def f32(self, pos: int) -> float:
        return struct.unpack_from("<f", self.data, pos)[0]

    def vec3(self, pos: int) -> list[float]:
        return [round(value, 6) for value in struct.unpack_from("<3f", self.data, pos)]

    def string(self, pos: int) -> str:
        end = self.data.find(b"\x00", pos)
        if end == -1:
            end = len(self.data)
        return self.data[pos:end].decode("utf-8", "replace")


def _heap_string(reader: Reader, offset_field_pos: int) -> str:
    offset = reader.i32(offset_field_pos)
    return reader.string(offset_field_pos + offset)


def _parse_light(reader: Reader, p: int, obj: dict) -> None:
    shape = reader.i32(p)
    texture_field = p + 24
    texture_offset = reader.i32(texture_field)
    obj.update({
        "shape": LIGHT_SHAPES.get(shape, shape),
        "attenuation": reader.f32(p + 4),
        "range": reader.f32(p + 8),
        "pointLightType": POINT_LIGHT_TYPES.get(reader.u32(p + 12), reader.u32(p + 12)),
        "attenuationConeCoefficient": reader.f32(p + 16),
        "spotAngleDegrees": reader.f32(p + 20),
        "color": {
            "hex": "#{:02X}{:02X}{:02X}".format(reader.u8(p + 32), reader.u8(p + 33), reader.u8(p + 34)),
            "alpha": reader.u8(p + 35),
            "intensity": reader.f32(p + 36),
        },
        "enableSpecularHighlights": reader.u8(p + 40) == 1,
        "enableBgPartShadows": reader.u8(p + 41) == 1,
        "enableCharacterShadows": reader.u8(p + 42) == 1,
        "flagByteUnknown": reader.u8(p + 43),
        "shadowPlaneNear": reader.f32(p + 44),
        "flatLightSkewAngle": [reader.f32(p + 48), reader.f32(p + 52)],
        "isDawntrailMarker": reader.u32(p + 56) == DAWNTRAIL_MARKER,
        "confidence": {
            "shape": "SOURCE_DERIVED",
            "attenuation": "SOURCE_DERIVED_BYTES",
            "range": "SOURCE_DERIVED_BYTES_SEMANTICS_UNKNOWN",
            "color": "SOURCE_DERIVED_BYTES",
            "intensity": "SOURCE_DERIVED_BYTES",
            "engineMapping": "INFERRED",
        },
    })
    if shape == 2:
        obj["engineKind"] = "PointLight"
    elif shape == 3:
        obj["engineKind"] = "SpotLight"
        obj["angleRadians"] = round(float(reader.f32(p + 20)) * 3.141592653589793 / 180.0, 6)
        obj["direction"] = {"x": 0.0, "y": -1.0, "z": 0.0}
        obj["directionConfidence"] = "UNKNOWN_DEFAULT_DOWN"
    if texture_offset != 0:
        obj["texturePath"] = _heap_string(reader, texture_field)


def _parse_env_set(reader: Reader, p: int, obj: dict) -> None:
    shape = reader.i32(p + 8)
    obj.update({
        "assetPath": _heap_string(reader, p),
        "boundInstanceId": reader.u32(p + 4),
        "shape": ENV_SET_SHAPES.get(shape, shape),
        "isEnvMapShootingPoint": reader.u8(p + 12) == 1,
        "priority": reader.u8(p + 13),
        "effectiveRange": reader.f32(p + 16),
        "interpolationTime": reader.i32(p + 20),
        "reverb": reader.f32(p + 24),
        "filter": reader.f32(p + 28),
        "soundAssetPath": _heap_string(reader, p + 32),
        "confidence": "SOURCE_DERIVED",
    })


def _parse_env_location(reader: Reader, p: int, obj: dict) -> None:
    obj.update({
        "ambientLightAssetPath": _heap_string(reader, p),
        "envMapAssetPath": _heap_string(reader, p + 4),
        "unknownListOffset": reader.u32(p + 20),
        "unknownListCount": reader.u32(p + 24),
        "confidence": "SOURCE_DERIVED",
    })


def parse_lgb(data: bytes) -> dict:
    if len(data) < 0x24 or data[0:4] != b"LGB1":
        raise ValueError("not an LGB1 file")
    if data[12:16] != b"LGP1":
        raise ValueError("missing LGP1 layer chunk")
    reader = Reader(data)
    group_count = reader.i32(0x20)
    layers_out = []
    totals: dict[str, int] = {}
    attachments = []
    for group_index in range(group_count):
        layer_base = 0x24 + 4 * group_index + reader.i32(0x24 + 4 * group_index)
        if layer_base <= 0 or layer_base >= len(data):
            raise ValueError(f"layer offset out of range: {layer_base}")
        layer_id = reader.u32(layer_base)
        layer_name = reader.string(layer_base + reader.i32(layer_base + 4))
        instances_offset = reader.i32(layer_base + 8)
        instance_count = reader.i32(layer_base + 12)
        festival = struct.unpack_from("<H", data, layer_base + 0x1C)[0]
        festival_phase = struct.unpack_from("<H", data, layer_base + 0x1E)[0]
        objects = []
        for ordinal in range(instance_count):
            relative = reader.i32(layer_base + instances_offset + 4 * ordinal)
            obj_base = layer_base + instances_offset + relative
            type_id = reader.u32(obj_base)
            type_name = LAYER_ENTRY_TYPES.get(type_id, "Unknown_0x{:X}".format(type_id))
            obj = {
                "instanceId": reader.u32(obj_base + 4),
                "name": _heap_string(reader, obj_base + 8),
                "lgbType": type_name,
                "position": dict(zip(("x", "y", "z"), reader.vec3(obj_base + 0x10))),
                "rotation": dict(zip(("x", "y", "z"), reader.vec3(obj_base + 0x1C))),
                "scale": dict(zip(("x", "y", "z"), reader.vec3(obj_base + 0x20))),
                "layer": {
                    "name": layer_name,
                    "id": layer_id,
                    "festival": festival,
                    "festivalPhase": festival_phase,
                },
                "source": {"group": group_index, "ordinal": ordinal, "objectOffset": obj_base},
            }
            payload = obj_base + 0x30
            if type_name == "Light":
                _parse_light(reader, payload, obj)
            elif type_name == "EnvSet":
                _parse_env_set(reader, payload, obj)
            elif type_name == "EnvLocation":
                _parse_env_location(reader, payload, obj)
            for key in ("assetPath", "ambientLightAssetPath", "envMapAssetPath", "texturePath"):
                value = obj.get(key)
                if isinstance(value, str) and ASSET_PATH_RE.search(value.encode("ascii", "ignore")):
                    attachments.append({"from": type_name, "instanceId": obj["instanceId"], "path": value})
            totals[type_name] = totals.get(type_name, 0) + 1
            objects.append(obj)
        layers_out.append({
            "id": layer_id,
            "name": layer_name,
            "festival": festival,
            "festivalPhase": festival_phase,
            "objectCount": instance_count,
            "objects": objects,
        })
    return {
        "header": {"fileSize": reader.i32(4), "groupCount": group_count},
        "layers": layers_out,
        "totalsByType": dict(sorted(totals.items())),
        "attachedAssetPaths": sorted(attachments, key=lambda item: (item["path"], item["instanceId"])),
    }


def build_runtime_payload(scene_id, zone_root, territory_id, client_version,
                          file_records, parsed_files, weather=None, sky_path=None):
    lights = []
    for record in parsed_files:
        for layer in record["parsed"]["layers"]:
            for obj in layer["objects"]:
                if obj["lgbType"] != "Light":
                    continue
                color = obj.get("color", {})
                light = {
                    "instanceId": obj["instanceId"],
                    "name": obj["name"],
                    "engineKind": obj.get("engineKind"),
                    "position": obj["position"],
                    "colorHex": color.get("hex"),
                    "intensity": color.get("intensity"),
                    "range": obj.get("range"),
                    "layer": {
                        "name": layer["name"],
                        "id": layer["id"],
                        "festival": layer["festival"],
                    },
                }
                if obj.get("engineKind") == "SpotLight":
                    light["angleRadians"] = obj.get("angleRadians")
                    light["direction"] = obj.get("direction")
                lights.append(light)
    sky = None
    if sky_path:
        sky = {"assetPath": sky_path, "decoded": False, "status": "reference-only"}
    return {
        "schemaVersion": 1,
        "sceneId": scene_id,
        "territoryId": territory_id,
        "zoneRoot": zone_root,
        "source": {
            "evidence": "source-derived-lgb",
            "parser": "tools/map-tools/environment/lgb/parse_lgb.py",
            "parserVersion": PARSER_VERSION,
            "clientVersion": client_version,
            "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "files": file_records,
        },
        "lights": lights,
        "sky": sky,
        "weather": weather,
    }


def _selftest() -> int:
    def f32(value: float) -> bytes:
        return struct.pack("<f", value)

    name_bytes = b"unit_light\x00"
    payload = struct.pack("<i", 2) + f32(2.0) + f32(1.5)
    payload += struct.pack("<i", 0) + f32(0.5) + f32(45.0)
    payload += struct.pack("<i", 0) + b"\x00\x00\x00\x00"
    payload += bytes((255, 128, 64, 255)) + f32(1.25)
    payload += bytes((1, 1, 0, 0)) + f32(0.1) + f32(0.0) + f32(0.0)
    payload += struct.pack("<I", DAWNTRAIL_MARKER)
    layer_name = b"layer\x00"
    header = struct.pack("<II", 0x30, 0x30 + len(payload) - 8)
    header += bytes(24) + payload + name_bytes
    layer = struct.pack("<IIII", 7, len(layer_name), 0x24, 1)
    layer += bytes((1, 0, 0, 1)) + bytes(4)
    layer += struct.pack("<H", 0) + struct.pack("<H", 0) + bytes(8)
    layer += struct.pack("<i", 0x30) + struct.pack("<i", 0) + header
    layer_start = 0x24
    file_size = layer_start + len(layer)
    lgb = b"LGB1" + struct.pack("<I", file_size) + b"\x00\x00\x00\x00"
    lgb += b"LGP1" + struct.pack("<III", 0, 0, 0)
    lgb += struct.pack("<i", 1)
    lgb += struct.pack("<i", layer_start)
    lgb += layer
    result = parse_lgb(lgb)
    light = next(obj for layer_item in result["layers"] for obj in layer_item["objects"]
                 if obj["lgbType"] == "Light")
    assert light["engineKind"] == "PointLight", light
    assert light["color"]["hex"] == "#FF8040", light
    assert abs(light["color"]["intensity"] - 1.25) < 1e-6, light
    assert light["layer"]["name"] == "layer", light
    print(json.dumps({"selftest": "pass", "light": light}, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse one LGB/LVB file into JSON evidence.")
    parser.add_argument("input", type=Path, nargs="?")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return _selftest()
    if not args.input:
        parser.error("input is required unless --selftest")
    data = args.input.read_bytes()
    parsed = parse_lgb(data)
    report = {
        "schemaVersion": 1,
        "file": str(args.input),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "parsedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **parsed,
    }
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
