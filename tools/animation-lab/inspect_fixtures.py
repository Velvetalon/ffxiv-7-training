import json
import re
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"


def ascii_strings(data: bytes, minimum: int = 4):
    pattern = rb"[\x20-\x7e]{%d,}" % minimum
    return [(m.start(), m.group().decode("ascii")) for m in re.finditer(pattern, data)]


def parse_sklb(path: Path):
    data = path.read_bytes()
    magic, version = struct.unpack_from("<II", data, 0)
    old = version in (0x31313030, 0x31313130, 0x31323030)
    if old:
        layer_offset, havok_offset = struct.unpack_from("<HH", data, 8)
    else:
        layer_offset, havok_offset = struct.unpack_from("<II", data, 8)
    return {
        "path": str(path),
        "bytes": len(data),
        "magic_hex": f"0x{magic:08x}",
        "version_ascii": struct.pack("<I", version).decode("ascii"),
        "old_header": old,
        "layer_offset": layer_offset,
        "havok_offset": havok_offset,
        "havok_bytes": len(data) - havok_offset,
        "havok_prefix_hex": data[havok_offset : havok_offset + 32].hex(" "),
        "strings": ascii_strings(data[havok_offset:]),
    }


def parse_pap(path: Path):
    data = path.read_bytes()
    magic, version, count, model_id, model_type, variant, info_offset, havok_offset, footer_offset = struct.unpack_from(
        "<IIHHBBIII", data, 0
    )
    animations = []
    for index in range(count):
        offset = 26 + index * 40
        name, anim_type, havok_index, is_face = struct.unpack_from("<32sHh?", data, offset)
        animations.append(
            {
                "index": index,
                "name": name.split(b"\0", 1)[0].decode("utf-8"),
                "type": anim_type,
                "havok_index": havok_index,
                "is_face": is_face,
            }
        )
    havok = data[havok_offset:footer_offset]
    return {
        "path": str(path),
        "bytes": len(data),
        "magic_ascii": struct.pack("<I", magic).decode("ascii"),
        "version": version,
        "animation_count": count,
        "model_id": model_id,
        "model_type": model_type,
        "variant": variant,
        "info_offset": info_offset,
        "havok_offset": havok_offset,
        "footer_offset": footer_offset,
        "havok_bytes": len(havok),
        "footer_bytes": len(data) - footer_offset,
        "animations": animations,
        "havok_prefix_hex": havok[:32].hex(" "),
        "strings": ascii_strings(havok),
        "footer_strings": ascii_strings(data[footer_offset:]),
    }


def main():
    sklb_path = FIXTURES / "skl_c1101b0001.sklb"
    pap_path = FIXTURES / "joy.pap"
    result = {"sklb": parse_sklb(sklb_path), "pap": parse_pap(pap_path)}
    sklb_data = sklb_path.read_bytes()
    pap_data = pap_path.read_bytes()
    (FIXTURES / "skeleton.tagfile").write_bytes(sklb_data[result["sklb"]["havok_offset"] :])
    (FIXTURES / "joy.tagfile").write_bytes(
        pap_data[result["pap"]["havok_offset"] : result["pap"]["footer_offset"]]
    )
    output = ROOT / "fixture-report.json"
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(output)
    for kind, info in result.items():
        print(f"\n[{kind}] {info['bytes']} bytes")
        for key, value in info.items():
            if key not in {"strings", "footer_strings"}:
                print(f"{key}: {value}")
        print("class/codec strings:")
        for offset, value in info["strings"]:
            if "hk" in value.lower() or "anim" in value.lower() or "skeleton" in value.lower():
                print(f"  0x{offset:x}: {value}")


if __name__ == "__main__":
    main()
