import argparse
import json
import re
from pathlib import Path


def indentation(line):
    return len(line) - len(line.lstrip(" "))


def parse_vector(line):
    return [float(value) for value in re.search(r"\(([^)]+)\)", line).group(1).split()]


def parse_skeletons(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    starts = [
        index
        for index, line in enumerate(lines)
        if line.strip() == "STRUCT:hkBaseObject -> hkReferencedObject -> hkaSkeleton"
    ]
    result = []
    for start in starts:
        struct_indent = indentation(lines[start])
        end = next(
            (index for index in range(start + 1, len(lines)) if indentation(lines[index]) < struct_indent),
            len(lines),
        )
        block = lines[start:end]
        parent_start = next(i for i, line in enumerate(block) if line.strip() == "parentIndices = ARRAY")
        bones_start = next(i for i, line in enumerate(block) if line.strip() == "bones = ARRAY")
        pose_start = next(i for i, line in enumerate(block) if line.strip() == "referencePose = ARRAY")
        parents = [int(line.strip()) for line in block[parent_start + 1:bones_start] if re.fullmatch(r"-?\d+", line.strip())]
        names = []
        for line in block[bones_start + 1:pose_start]:
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
        if len(parents) == len(names) == len(poses):
            result.append([{"index": i, "name": names[i], "parent": parents[i], **poses[i]} for i in range(len(names))])
    return result


def merge_skeletons(skeletons):
    merged = []
    by_name = {}
    for source_index, skeleton in enumerate(skeletons):
        remap = {}
        for bone in skeleton:
            existing = by_name.get(bone["name"])
            if existing is not None:
                remap[bone["index"]] = existing
                continue
            parent = -1 if bone["parent"] == -1 else remap[bone["parent"]]
            index = len(merged)
            merged.append({**bone, "index": index, "parent": parent, "sourceSkeleton": source_index})
            by_name[bone["name"]] = index
            remap[bone["index"]] = index
    return merged


def main():
    parser = argparse.ArgumentParser(description="Convert hkxparse skeleton dumps to merged JSON")
    parser.add_argument("dump", nargs="+")
    parser.add_argument("--indices", required=True, help="comma-separated hkaSkeleton index for each dump")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    indices = [int(value) for value in args.indices.split(",")]
    if len(indices) != len(args.dump):
        raise ValueError("--indices count must match dump count")
    selected = []
    for path, index in zip(args.dump, indices):
        skeletons = parse_skeletons(Path(path))
        selected.append(skeletons[index])
    merged = merge_skeletons(selected)
    Path(args.output).write_text(json.dumps(merged, indent=2), encoding="utf-8")
    print(f"sources={len(selected)} bones={len(merged)} output={args.output}")


if __name__ == "__main__":
    main()
