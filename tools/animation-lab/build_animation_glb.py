import csv
import json
import math
import re
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def indentation(line):
    return len(line) - len(line.lstrip(" "))


def parse_vector(line):
    return [float(value) for value in re.search(r"\(([^)]+)\)", line).group(1).split()]


def parse_skeleton_dump(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    skeleton_starts = [
        index
        for index, line in enumerate(lines)
        if line.strip() == "STRUCT:hkBaseObject -> hkReferencedObject -> hkaSkeleton"
    ]
    if len(skeleton_starts) < 2:
        raise ValueError("expected mapper source and target skeletons")
    start = skeleton_starts[1]
    struct_indent = indentation(lines[start])
    end = next(
        (index for index in range(start + 1, len(lines)) if indentation(lines[index]) < struct_indent),
        len(lines),
    )
    block = lines[start:end]

    parent_start = next(i for i, line in enumerate(block) if line.strip() == "parentIndices = ARRAY")
    bones_start = next(i for i, line in enumerate(block) if line.strip() == "bones = ARRAY")
    pose_start = next(i for i, line in enumerate(block) if line.strip() == "referencePose = ARRAY")

    parents = [int(line.strip()) for line in block[parent_start + 1 : bones_start] if re.fullmatch(r"-?\d+", line.strip())]
    names = []
    for line in block[bones_start + 1 : pose_start]:
        match = re.search(r'name = "(.*)"', line)
        if match:
            names.append(match.group(1))

    poses = []
    index = pose_start + 1
    while index < len(block):
        if block[index].strip() != "Matrix3":
            index += 1
            continue
        values = [parse_vector(block[index + offset]) for offset in (1, 2, 3)]
        poses.append({"translation": values[0][:3], "rotation": values[1], "scale": values[2][:3]})
        index += 4

    if not (len(parents) == len(names) == len(poses)):
        raise ValueError(f"skeleton array mismatch parents={len(parents)} names={len(names)} poses={len(poses)}")
    return [{"index": i, "name": names[i], "parent": parents[i], **poses[i]} for i in range(len(names))]


class Buffer:
    def __init__(self):
        self.data = bytearray()
        self.views = []
        self.accessors = []

    def align(self):
        while len(self.data) % 4:
            self.data.append(0)

    def floats(self, values, components, include_bounds=False):
        self.align()
        offset = len(self.data)
        flat = [component for value in values for component in value]
        self.data.extend(struct.pack("<" + "f" * len(flat), *flat))
        view = len(self.views)
        self.views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(flat) * 4})
        accessor = {
            "bufferView": view,
            "componentType": 5126,
            "count": len(values),
            "type": {1: "SCALAR", 3: "VEC3", 4: "VEC4"}[components],
        }
        if include_bounds:
            accessor["min"] = [min(value[i] for value in values) for i in range(components)]
            accessor["max"] = [max(value[i] for value in values) for i in range(components)]
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def load_tracks(path):
    tracks = {}
    with path.open(newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            track = int(row["track"])
            item = tracks.setdefault(track, {"bone": int(row["bone"]), "time": [], "translation": [], "rotation": [], "scale": []})
            item["time"].append([float(row["time"])])
            item["translation"].append([float(row[key]) for key in ("tx", "ty", "tz")])
            rotation = [float(row[key]) for key in ("qx", "qy", "qz", "qw")]
            norm = math.sqrt(sum(value * value for value in rotation))
            item["rotation"].append([value / norm for value in rotation])
            item["scale"].append([float(row[key]) for key in ("sx", "sy", "sz")])
    return tracks


def build_glb(skeleton, tracks, destination):
    nodes = []
    for bone in skeleton:
        node = {
            "name": bone["name"],
            "translation": bone["translation"],
            "rotation": bone["rotation"],
            "scale": bone["scale"],
        }
        children = [item["index"] for item in skeleton if item["parent"] == bone["index"]]
        if children:
            node["children"] = children
        nodes.append(node)

    buffer = Buffer()
    animations = [{"name": "cbem_joy", "samplers": [], "channels": []}]
    animation = animations[0]
    for track in tracks.values():
        time_accessor = buffer.floats(track["time"], 1, include_bounds=True)
        for path, components in (("translation", 3), ("rotation", 4), ("scale", 3)):
            output_accessor = buffer.floats(track[path], components)
            sampler = len(animation["samplers"])
            animation["samplers"].append({"input": time_accessor, "output": output_accessor, "interpolation": "LINEAR"})
            animation["channels"].append({"sampler": sampler, "target": {"node": track["bone"], "path": path}})

    roots = [bone["index"] for bone in skeleton if bone["parent"] == -1]
    document = {
        "asset": {"version": "2.0", "generator": "FFXIV animation-lab offline PAP proof 2026-09-09"},
        "scene": 0,
        "scenes": [{"nodes": roots}],
        "nodes": nodes,
        "animations": animations,
        "buffers": [{"byteLength": len(buffer.data)}],
        "bufferViews": buffer.views,
        "accessors": buffer.accessors,
        "extras": {
            "sourcePapAnimation": "cbem_joy",
            "sourceSkeleton": "c1101_0:mdl:n_root",
            "trackCount": len(tracks),
            "frameCount": len(next(iter(tracks.values()))["time"]),
            "note": "Animation-only proof; node hierarchy and real local TRS tracks, no mesh or skin.",
        },
    }
    json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    buffer.align()
    total = 12 + 8 + len(json_bytes) + 8 + len(buffer.data)
    with destination.open("wb") as output:
        output.write(struct.pack("<III", 0x46546C67, 2, total))
        output.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        output.write(json_bytes)
        output.write(struct.pack("<II", len(buffer.data), 0x004E4942))
        output.write(buffer.data)


def main():
    skeleton = parse_skeleton_dump(ROOT / "skeleton-dump.txt")
    tracks = load_tracks(ROOT / "joy-tracks.csv")
    if max(track["bone"] for track in tracks.values()) >= len(skeleton):
        raise ValueError("animation binding exceeds skeleton")
    (ROOT / "skeleton-c1101.json").write_text(json.dumps(skeleton, indent=2), encoding="utf-8")
    destination = ROOT / "cbem_joy.animation.glb"
    build_glb(skeleton, tracks, destination)
    print(f"bones={len(skeleton)} tracks={len(tracks)} glb={destination} bytes={destination.stat().st_size}")


if __name__ == "__main__":
    main()
