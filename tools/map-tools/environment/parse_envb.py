"""Decode the documented ENVB/ENVS environment-set container.

The layout mirrors xivdev/file-formats/imhex/env.hexpat.  This is a
read-only parser for extracted client files; it never opens a SqPack or writes
into the installed client.  The JSON report intentionally keeps the decoded
field names from the format description, while a separate profile command
chooses only fields whose meaning is documented by that source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from pathlib import Path
from typing import Any


FORMAT_SOURCE = {
    "repository": "xivdev/file-formats",
    "commit": "ac1a01571fa7152d521e5d5f8af8e694915466a8",
    "path": "imhex/env.hexpat",
    "url": "https://github.com/xivdev/file-formats/blob/ac1a01571fa7152d521e5d5f8af8e694915466a8/imhex/env.hexpat",
}

TYPE_NAMES = {
    0: "GlobalLighting",
    1: "FakeSpecular",
    2: "Cloud",
    3: "Rain",
    4: "Snow",
    5: "Dust",
    6: "Wind",
    7: "LightShaft",
    8: "Wetness",
    9: "ToneMapping",
    10: "ColorFilter",
    11: "Effect",
    12: "Starfield",
    13: "VerticalFog",
    14: "Unknown14",
    20: "AmbientSoundPaths",
    21: "AmbientSoundFlags",
    29: "ObjectVisibility",
    30: "ObjectTransform",
    31: "ObjectOscillator",
    32: "ObjectRotation",
    33: "ObjectRgbColor",
    34: "ObjectRgbColorPair",
    35: "ObjectRgbaColor",
}

V700_MARKER = 0x56373030


class Reader:
    def __init__(self, data: bytes):
        self.data = data

    def _check(self, offset: int, size: int) -> None:
        if offset < 0 or offset + size > len(self.data):
            raise ValueError(f"offset outside file: 0x{offset:x} (+{size})")

    def u8(self, offset: int) -> int:
        self._check(offset, 1)
        return self.data[offset]

    def u16(self, offset: int) -> int:
        self._check(offset, 2)
        return struct.unpack_from("<H", self.data, offset)[0]

    def u32(self, offset: int) -> int:
        self._check(offset, 4)
        return struct.unpack_from("<I", self.data, offset)[0]

    def i32(self, offset: int) -> int:
        self._check(offset, 4)
        return struct.unpack_from("<i", self.data, offset)[0]

    def f32(self, offset: int) -> float:
        self._check(offset, 4)
        return struct.unpack_from("<f", self.data, offset)[0]

    def magic(self, offset: int, value: bytes) -> None:
        self._check(offset, len(value))
        if self.data[offset : offset + len(value)] != value:
            got = self.data[offset : offset + len(value)].decode("ascii", "replace")
            raise ValueError(f"expected {value!r} at 0x{offset:x}, got {got!r}")


def finite(value: float) -> float | None:
    return round(value, 7) if math.isfinite(value) else None


def packed_color(reader: Reader, offset: int) -> dict[str, Any]:
    reader._check(offset, 8)
    r, g, b, a = reader.data[offset : offset + 4]
    return {
        "rgba": [r, g, b, a],
        "hex": f"#{r:02x}{g:02x}{b:02x}",
        "intensity": finite(reader.f32(offset + 4)),
        "offset": offset,
    }


def relative_color(reader: Reader, base: int, relative: int) -> dict[str, Any] | None:
    target = base + relative
    if relative == 0 and target == base:
        # A zero offset is valid in the format and means the keyframe itself.
        return packed_color(reader, target)
    if target < 0 or target + 8 > len(reader.data):
        return None
    return packed_color(reader, target)


def maybe_marker(reader: Reader, offset: int) -> bool:
    return offset + 4 <= len(reader.data) and reader.u32(offset) == V700_MARKER


def keyframe(reader: Reader, kind: int, offset: int) -> dict[str, Any]:
    """Decode one keyframe using the field order in env.hexpat."""
    out: dict[str, Any] = {"offset": offset, "timeSeconds": finite(reader.f32(offset))}
    if kind == 0:
        sun = reader.i32(offset + 4)
        extra = reader.i32(offset + 20)
        moon = reader.i32(offset + 24)
        out.update(
            sunlightColor=relative_color(reader, offset, sun),
            ambientLightScale=finite(reader.f32(offset + 8)),
            ambientLightSaturation=finite(reader.f32(offset + 12)),
            ambientAttenuation=finite(reader.f32(offset + 16)),
            extraAmbientColor=relative_color(reader, offset, extra),
            moonlightColor=relative_color(reader, offset, moon),
            extraAmbientColorWeight=finite(reader.f32(offset + 28)),
            extraParam=finite(reader.f32(offset + 32)),
            parameter0=finite(reader.f32(offset + 36)),
            parameter1=finite(reader.f32(offset + 40)),
        )
        if maybe_marker(reader, offset + 44):
            out["v700"] = {"hueShift": finite(reader.f32(offset + 48))}
    elif kind == 1:
        c0, c1, c2 = (reader.i32(offset + n) for n in (4, 8, 12))
        out.update(
            color0=relative_color(reader, offset, c0),
            color1=relative_color(reader, offset, c1),
            color2=relative_color(reader, offset, c2),
            elevation0Degrees=finite(reader.f32(offset + 16)),
            elevation1Degrees=finite(reader.f32(offset + 20)),
            elevation2Degrees=finite(reader.f32(offset + 24)),
            rotationDegrees=finite(reader.f32(offset + 28)),
        )
    elif kind == 2:
        diffuse, ambient = reader.i32(offset + 20), reader.i32(offset + 24)
        out.update(
            mainCloud=reader.u32(offset + 4),
            altCloud=reader.u32(offset + 8),
            mainIntensity=finite(reader.f32(offset + 12)),
            altIntensity=finite(reader.f32(offset + 16)),
            diffuseColor=relative_color(reader, offset, diffuse),
            ambientColor=relative_color(reader, offset, ambient),
        )
    elif kind in (3, 4, 5):
        color = reader.i32(offset + 32)
        out.update(
            density=finite(reader.f32(offset + 4)),
            weight=finite(reader.f32(offset + 8)),
            oscillationSpread=finite(reader.f32(offset + 12)),
            oscillationFrequency=finite(reader.f32(offset + 16)),
            distanceResponseProfile=finite(reader.f32(offset + 20)),
            extraParam=finite(reader.f32(offset + 24)),
            modulationRate=finite(reader.f32(offset + 28)),
            flags=reader.u32(offset + 36),
            color=relative_color(reader, offset, color),
        )
    elif kind == 6:
        out.update(
            layer0AzimuthDegrees=finite(reader.f32(offset + 4)),
            unknown=finite(reader.f32(offset + 8)),
            layer0MaxStrength=finite(reader.f32(offset + 12)),
        )
        if maybe_marker(reader, offset + 16):
            out["v700"] = {
                "layer1AzimuthDegrees": finite(reader.f32(offset + 20)),
                "layer0Wavelength": finite(reader.f32(offset + 24)),
                "layer1MaxStrength": finite(reader.f32(offset + 28)),
                "layer1Wavelength": finite(reader.f32(offset + 32)),
                "layer0MinStrength": finite(reader.f32(offset + 36)),
                "layer1MinStrength": finite(reader.f32(offset + 40)),
            }
    elif kind == 7:
        c0, radiance = reader.i32(offset + 8), reader.i32(offset + 12)
        out.update(
            unknown=reader.u32(offset + 4),
            color0=relative_color(reader, offset, c0),
            radianceColor=relative_color(reader, offset, radiance),
            scale=finite(reader.f32(offset + 16)),
            someParam=finite(reader.f32(offset + 20)),
        )
    elif kind == 8:
        out.update(
            unknown=finite(reader.f32(offset + 4)),
            worldWetnessParameter1=finite(reader.f32(offset + 8)),
            worldWetnessParameter0=finite(reader.f32(offset + 12)),
            characterWetness=finite(reader.f32(offset + 16)),
        )
    elif kind == 9:
        out.update(
            adaptationRate=finite(reader.f32(offset + 4)),
            adaptedLuminanceParameterW=finite(reader.f32(offset + 8)),
            adaptedLuminanceParameterX=finite(reader.f32(offset + 12)),
            adaptedLuminanceParameterY=finite(reader.f32(offset + 16)),
            toneMapParameterY=finite(reader.f32(offset + 20)),
            toneMapParameterX=finite(reader.f32(offset + 24)),
        )
    elif kind == 10:
        color = reader.i32(offset + 20)
        out.update(
            hue=finite(reader.f32(offset + 4)),
            saturation=finite(reader.f32(offset + 8)),
            brightness=finite(reader.f32(offset + 12)),
            contrast=finite(reader.f32(offset + 16)),
            filterColor=relative_color(reader, offset, color),
            filterIntensity=finite(reader.f32(offset + 24)),
            sepia=finite(reader.f32(offset + 28)),
            grayscale=finite(reader.f32(offset + 32)),
            negative=finite(reader.f32(offset + 36)),
            lutInputBlackPoint=finite(reader.f32(offset + 40)),
            lutInputWhitePoint=finite(reader.f32(offset + 44)),
            alternateCurveLayout=bool(reader.u8(offset + 48)),
        )
        if maybe_marker(reader, offset + 52):
            tint = reader.i32(offset + 72)
            out["v700"] = {
                "darkFilterSaturation": finite(reader.f32(offset + 56)),
                "darkFilterParameterX": finite(reader.f32(offset + 60)),
                "darkFilterParameterY": finite(reader.f32(offset + 64)),
                "darkFilterTintAmountAndParameterZ": finite(reader.f32(offset + 68)),
                "darkFilterTintColor": relative_color(reader, offset, tint),
            }
    elif kind == 12:
        moon = reader.i32(offset + 20)
        out.update(
            aIntensity=finite(reader.f32(offset + 4)),
            bIntensity=finite(reader.f32(offset + 8)),
            cIntensity=finite(reader.f32(offset + 12)),
            unknown=finite(reader.f32(offset + 16)),
            moonColor=relative_color(reader, offset, moon),
            unknown2=finite(reader.f32(offset + 24)),
            proceduralStarIntensity=finite(reader.f32(offset + 28)),
        )
    elif kind == 13:
        fog = reader.i32(offset + 4)
        out.update(
            fogColor=relative_color(reader, offset, fog),
            fogStartDistance=finite(reader.f32(offset + 8)),
            fogIntensity0=finite(reader.f32(offset + 12)),
            fogFadeDistance=finite(reader.f32(offset + 16)),
            fogIntensity1=finite(reader.f32(offset + 20)),
            fogParameter=finite(reader.f32(offset + 24)),
            fogBlend=finite(reader.f32(offset + 28)),
        )
        if maybe_marker(reader, offset + 32):
            # The offset field is 48 bytes into the V700 tail, i.e. 80 bytes
            # from the keyframe start (the nested color uses that same base).
            directional = reader.i32(offset + 80)
            out["v700"] = {
                "fogDensityPercent": finite(reader.f32(offset + 36)),
                "expFogHeight": finite(reader.f32(offset + 40)),
                "fogHeightFalloff": finite(reader.f32(offset + 44)),
                "startDistance": finite(reader.f32(offset + 48)),
                "fogMinOpacity": finite(reader.f32(offset + 52)),
                "fogDensity2Percent": finite(reader.f32(offset + 56)),
                "expFogHeight2Delta": finite(reader.f32(offset + 60)),
                "fogHeightFalloff2": finite(reader.f32(offset + 64)),
                "directionalInscatteringStartDistance": finite(reader.f32(offset + 68)),
                "directionalInscatteringColorIntensity": finite(reader.f32(offset + 72)),
                "directionalInscatteringExponent": finite(reader.f32(offset + 76)),
                "directionalInscatteringColor": relative_color(reader, offset, directional),
                "useHeightFogUpdate": bool(reader.u8(offset + 116)),
            }
    elif kind == 14:
        for index in range(8):
            out[f"scalar{index}"] = finite(reader.f32(offset + 4 + index * 4))
    elif kind == 21:
        out.update(
            ambientSetting0Enabled=bool(reader.u8(offset + 4)),
            ambientSetting1Enabled=bool(reader.u8(offset + 5)),
        )
    elif kind in (30, 32):
        out["value"] = finite(reader.f32(offset + 4))
    elif kind == 31:
        out.update(phaseRate=finite(reader.f32(offset + 4)), amplitude=finite(reader.f32(offset + 8)))
    elif kind in (33, 35):
        color = reader.i32(offset + 4)
        out["color"] = relative_color(reader, offset, color)
    elif kind == 34:
        c0, c1 = reader.i32(offset + 4), reader.i32(offset + 8)
        out.update(color0=relative_color(reader, offset, c0), color1=relative_color(reader, offset, c1))
    elif kind == 29:
        out.update(transitionDurationCentiseconds=reader.u16(offset + 4), visible=bool(reader.u8(offset + 6)))
    return out


def c_string(reader: Reader, base: int, relative: int) -> str | None:
    target = base + relative
    if relative == 0 or target < 0 or target >= len(reader.data):
        return None
    end = reader.data.find(b"\0", target)
    if end < 0:
        return None
    return reader.data[target:end].decode("utf-8", "replace")


def parse_envb(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    reader = Reader(data)
    reader.magic(0, b"ENVB")
    file_size, container_version = reader.u32(4), reader.u32(8)
    reader.magic(12, b"ENVS")
    graph_base = 12
    header_size = reader.u32(16)
    version = reader.u32(20)
    sections_offset = reader.i32(24)
    section_count = reader.u32(28)
    auxiliary_offset = reader.i32(32)
    if file_size != len(data):
        raise ValueError(f"header file size {file_size} != actual {len(data)}")
    sections_base = 20 + sections_offset
    sections: list[dict[str, Any]] = []
    for section_index in range(section_count):
        section_offset = sections_base + section_index * 16
        envset_table_offset = reader.i32(section_offset)
        envset_count = reader.u32(section_offset + 4)
        owner_id = reader.u32(section_offset + 8)
        footer_offset = reader.i32(section_offset + 12)
        envset_table = section_offset + envset_table_offset
        envsets: list[dict[str, Any]] = []
        for envset_index in range(envset_count):
            envset_offset = envset_table + envset_index * 12
            keyframe_table_offset = reader.i32(envset_offset)
            keyframe_count = reader.u32(envset_offset + 4)
            kind = reader.u32(envset_offset + 8)
            keyframe_table = envset_offset + keyframe_table_offset
            frames = []
            for frame_index in range(keyframe_count):
                ref_offset = keyframe_table + frame_index * 4
                relative_offset = reader.i32(ref_offset)
                # EnvKeyframeReference offsets are relative to the beginning
                # of the keyframe-offset table, not to each four-byte entry.
                frame_offset = keyframe_table + relative_offset
                frames.append(
                    {
                        "index": frame_index,
                        "relativeOffset": relative_offset,
                        **keyframe(reader, kind, frame_offset),
                    }
                )
            footer = section_offset + footer_offset
            envsets.append(
                {
                    "index": envset_index,
                    "type": kind,
                    "typeName": TYPE_NAMES.get(kind, f"Unknown{kind}"),
                    "offset": envset_offset,
                    "keyframeCount": keyframe_count,
                    "keyframes": frames,
                }
            )
        footer = section_offset + footer_offset
        sections.append(
            {
                "index": section_index,
                "ownerId": owner_id,
                "envsetCount": envset_count,
                "envsets": envsets,
                "footer": {
                    "offset": footer,
                    "cycleLengthSeconds": finite(reader.f32(footer)),
                    "sectionParameter": reader.u32(footer + 4),
                    "sectionWeight": finite(reader.f32(footer + 8)),
                    "resourcePath0": c_string(reader, footer, reader.i32(footer + 12)),
                    "resourcePath1": c_string(reader, footer, reader.i32(footer + 16)),
                },
            }
        )
    return {
        "schemaVersion": 1,
        "format": "ENVB/ENVS",
        "formatSource": FORMAT_SOURCE,
        "file": str(path).replace("\\", "/"),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "containerVersion": container_version,
        "header": {
            "headerSize": header_size,
            "version": version,
            "sectionCount": section_count,
            "sectionsOffset": sections_offset,
            "auxiliaryOffset": auxiliary_offset,
        },
        "sections": sections,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Decode an extracted FFXIV ENVB environment set")
    parser.add_argument("paths", nargs="+", type=Path, help="one or more .envb files")
    parser.add_argument("--output", type=Path, help="write one JSON report (or a directory for many files)")
    args = parser.parse_args()
    reports = [parse_envb(path) for path in args.paths]
    if args.output:
        if len(reports) == 1:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(reports[0], indent=2), encoding="utf-8")
        else:
            args.output.mkdir(parents=True, exist_ok=True)
            for path, report in zip(args.paths, reports):
                (args.output / f"{path.stem}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    else:
        print(json.dumps(reports[0] if len(reports) == 1 else reports, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
