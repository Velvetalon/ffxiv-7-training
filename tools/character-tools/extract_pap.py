import argparse
import json
import struct
from pathlib import Path


def parse(path: Path):
    data = path.read_bytes()
    if len(data) < 26:
        raise ValueError(f"PAP is truncated: {path}")
    magic, version, count, model_id, model_type, variant, info_offset, havok_offset, footer_offset = struct.unpack_from(
        "<IIHHBBIII", data, 0
    )
    if magic != 0x20706170:
        raise ValueError(f"unexpected PAP magic 0x{magic:08x}: {path}")
    if not (0 < havok_offset < footer_offset <= len(data)):
        raise ValueError(f"invalid PAP payload bounds: {path}")
    animations = []
    for index in range(count):
        offset = 26 + index * 40
        if offset + 40 > len(data):
            raise ValueError(f"PAP animation table is truncated at {index}: {path}")
        name, anim_type, havok_index, is_face = struct.unpack_from("<32sHh?", data, offset)
        animations.append({
            "index": index,
            "name": name.split(b"\0", 1)[0].decode("utf-8"),
            "type": anim_type,
            "havokIndex": havok_index,
            "isFace": is_face,
        })
    return {
        "source": str(path),
        "bytes": len(data),
        "version": version,
        "animationCount": count,
        "modelId": model_id,
        "modelType": model_type,
        "variant": variant,
        "infoOffset": info_offset,
        "havokOffset": havok_offset,
        "footerOffset": footer_offset,
        "havokBytes": footer_offset - havok_offset,
        "animations": animations,
    }, data[havok_offset:footer_offset]


def main():
    parser = argparse.ArgumentParser(description="Extract the Havok tagfile payload from a real FFXIV PAP")
    parser.add_argument("pap")
    parser.add_argument("--tagfile", required=True)
    parser.add_argument("--metadata", required=True)
    args = parser.parse_args()
    metadata, payload = parse(Path(args.pap))
    tagfile = Path(args.tagfile)
    metadata_path = Path(args.metadata)
    tagfile.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    tagfile.write_bytes(payload)
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pap": metadata["source"], "animations": metadata["animations"], "tagfile": str(tagfile)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
