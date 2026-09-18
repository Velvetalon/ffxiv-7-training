"""Build source-light evidence for packaged hidden scenes."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent
LOCK = threading.Lock()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def number(value, fallback=0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def transform(document):
    lights, env_sets, env_locations = [], [], []
    for file in document.get("files", []):
        for item in file.get("objects", []):
            kind = item.get("type")
            common = {
                "instanceId": item.get("instanceId"),
                "layer": item.get("layer"),
            }
            translation = item.get("translation") or {}
            if kind == "LayLight":
                color = item.get("color") or {}
                lights.append({
                    **common,
                    "name": item.get("name"),
                    "engineKind": "PointLight" if item.get("shape") == 2 else "SpotLight" if item.get("shape") == 3 else None,
                    "position": {key.lower(): number(translation.get(key)) for key in ("X", "Y", "Z")},
                    "colorHex": color.get("r") is not None and color.get("g") is not None and color.get("b") is not None
                    and "#{:02X}{:02X}{:02X}".format(int(color["r"]), int(color["g"]), int(color["b"])) or None,
                    "intensity": number(color.get("intensity")),
                    "range": number(item.get("range")),
                })
            elif kind == "EnvSet":
                env_sets.append({
                    **common,
                    "assetPath": item.get("assetPath"),
                    "boundInstanceId": item.get("boundInstanceId"),
                    "shape": item.get("shape"),
                    "priority": item.get("priority"),
                    "effectiveRange": number(item.get("effectiveRange")),
                })
            elif kind == "EnvLocation":
                env_locations.append({
                    **common,
                    "ambientLightAssetPath": item.get("ambientLightAssetPath"),
                    "envMapAssetPath": item.get("envMapAssetPath"),
                })
    return lights, env_sets, env_locations


def probe(scene, args, client_version):
    output = args.probe / f"{scene['id']}-lgb.json"
    if not output.is_file():
        command = [
            args.dotnet, ROOT / "bin/MapExtract.dll", "lgb", args.client, scene["id"], args.probe,
        ]
        env = os.environ.copy()
        env["MAP_TOOLS_CATALOG"] = str(args.catalog.resolve())
        process = subprocess.run([str(item) for item in command], cwd=PROJECT, env=env, capture_output=True)
        if process.returncode or not output.is_file():
            return scene["id"], False, (process.stdout + process.stderr).decode("utf-8", errors="replace")[-1000:]
    document = json.loads(output.read_text(encoding="utf-8"))
    lights, env_sets, env_locations = transform(document)
    payload = {
        "schemaVersion": 1,
        "sceneId": scene["id"],
        "territoryId": scene["territoryId"],
        "zoneRoot": scene["root"],
        "source": {
            "evidence": "SOURCE_DERIVED",
            "parser": document.get("parser"),
            "clientVersion": document.get("gameVersion") or client_version,
            "generatedAtUtc": document.get("generatedAtUtc"),
            "files": [
                {key: file.get(key) for key in ("path", "sha256", "bytes", "parsed", "error")}
                for file in document.get("files", [])
            ],
        },
        "lights": lights,
        "envSets": env_sets,
        "envLocations": env_locations,
        "sky": None,
        "weather": None,
    }
    return scene["id"], payload, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=PROJECT / "config/duties/hidden-catalog.json")
    parser.add_argument("--client", type=Path, required=True)
    parser.add_argument("--probe", type=Path, default=PROJECT / "work/duty-build/environment-probe")
    parser.add_argument("--output", type=Path, default=PROJECT / "work/duty-build/source-lights.hidden.json")
    parser.add_argument("--state", type=Path, default=PROJECT / "work/duty-build/source-lights-state.json")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dotnet", default="dotnet")
    args = parser.parse_args()
    args.probe.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    scenes = catalog["scenes"]
    if args.limit is not None:
        scenes = scenes[:args.limit]
    client_version = (args.client / "game/ffxivgame.ver").read_text(encoding="utf-8-sig").strip()
    state = {"schemaVersion": 1, "scenes": {}, "errors": {}} if not args.state.is_file() else json.loads(args.state.read_text(encoding="utf-8"))
    results = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(probe, scene, args, client_version): scene["id"] for scene in scenes}
        for future in as_completed(futures):
            scene_id = futures[future]
            try:
                result, payload, error = future.result()
                if payload:
                    results[scene_id] = payload
                    state["scenes"][scene_id] = {"status": "complete", "lights": len(payload["lights"])}
                else:
                    state["errors"][scene_id] = error or "unknown probe failure"
                write_json(args.state, state)
                print(json.dumps({"scene": scene_id, "ok": bool(payload), "lights": len(payload["lights"]) if payload else 0}), flush=True)
            except Exception as error:
                state["errors"][scene_id] = str(error)
                write_json(args.state, state)
                print(json.dumps({"scene": scene_id, "ok": False, "error": str(error)}), flush=True)
    write_json(args.output, results)
    state["completedAtUtc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json(args.state, state)
    print(json.dumps({"scenes": len(results), "errors": len(state["errors"])}))


if __name__ == "__main__":
    main()
