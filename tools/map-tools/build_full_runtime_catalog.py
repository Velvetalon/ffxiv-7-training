"""Merge public scenes and packaged hidden scenes for Babylon runtime analysis."""

import argparse
import hashlib
import json
from pathlib import Path
import time
import uuid

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-active", type=Path, default=PROJECT / "public/extracted/active.json")
    parser.add_argument("--full-catalog", type=Path, default=PROJECT / "config/duties/full-catalog.json")
    parser.add_argument("--duty-catalog", type=Path, default=PROJECT / "config/duties/duty-catalog.json")
    parser.add_argument("--packed", type=Path, default=PROJECT / "work/duty-build/full/packed")
    parser.add_argument("--output", type=Path, default=PROJECT / "work/duty-build/analysis-active/active.json")
    args = parser.parse_args()

    public = json.loads(args.public_active.read_text(encoding="utf-8"))
    full = json.loads(args.full_catalog.read_text(encoding="utf-8"))
    duties = json.loads(args.duty_catalog.read_text(encoding="utf-8"))
    public_ids = set(public["scenes"])
    hidden_catalog = {item["id"]: item for item in full["scenes"] if item["id"] not in public_ids}
    scenes = {}
    missing = []
    for scene_id, metadata in hidden_catalog.items():
        package_state = args.packed / scene_id / "package-state.json"
        manifest_path = args.packed / scene_id / "scene.json"
        if package_state.is_file() and manifest_path.is_file():
            state = json.loads(package_state.read_text(encoding="utf-8"))
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if state.get("status") != "complete":
                missing.append(scene_id)
                continue
            scenes[scene_id] = {
                "base": f"../full/packed/{scene_id}/",
                "clientVersion": manifest["sourceVersion"],
                "name": metadata["name"],
                "fullSceneName": metadata["name"],
                "en": metadata["en"],
                "region": metadata.get("region") or "Duty",
                "territoryId": metadata["territoryId"],
                "kind": metadata.get("kind", "duty"),
                "expansion": metadata.get("expansion", 0),
                "manifestSha256": sha(manifest_path),
            }
        else:
            missing.append(scene_id)
    if missing:
        raise ValueError(f"{len(missing)} hidden packages are incomplete; first={missing[:10]}")

    for scene_id, record in public["scenes"].items():
        source = args.public_active.parent / record["base"] / "scene.json"
        if not source.is_file():
            raise ValueError(f"Public scene source missing: {scene_id}")
        item = {**record, "base": f"../../public/extracted/{record['base']}"}
        scenes[scene_id] = item

    scene_status = {}
    for scene_id, record in scenes.items():
        if scene_id not in hidden_catalog:
            continue
        manifest = json.loads((args.packed / scene_id / "scene.json").read_text(encoding="utf-8"))
        spawn = manifest.get("spawn")
        scene_status[scene_id] = {
            "rebuildStatus": "built",
            "spawn": {"x": spawn[0], "y": spawn[1], "z": spawn[2]} if spawn else None,
            "manifestSha256": record["manifestSha256"],
        }
    for duty in duties["duties"]:
        scene_key = duty["sceneKeys"][0]
        status = scene_status.get(scene_key)
        if status:
            duty["rebuildStatus"] = "built"
            duty["status"] = {**duty.get("status", {}), **status}

    result = {
        "runId": "duty-full-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()),
        "packagedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scenes": scenes,
    }
    write_json(args.output, result)
    write_json(args.duty_catalog, duties)
    print(json.dumps({
        "publicScenes": len(public["scenes"]),
        "hiddenScenes": len(hidden_catalog),
        "scenes": len(scenes),
        "builtDuties": sum(item.get("rebuildStatus") == "built" for item in duties["duties"]),
        "output": str(args.output),
    }))


if __name__ == "__main__":
    main()
