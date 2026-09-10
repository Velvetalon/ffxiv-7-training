"""Read-only FFXIV zone-environment reference extractor.

This intentionally discovers references before claiming any Envb field mapping.
It uses the project's MapExtract SqPack reader through its existing `raw`
command and writes only under the caller-selected output directory.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

PATH_RE = re.compile(rb"(?:bg|bgcommon)/[A-Za-z0-9_./-]+", re.IGNORECASE)
ENV_RE = re.compile(r"(?:envb|sky|weather|light|fog|shadow|shpk)", re.IGNORECASE)


def run_raw(extractor: Path, client: Path, virtual_path: str, destination: Path) -> bool:
    destination.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [str(extractor), "raw", str(client), virtual_path, str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    return completed.returncode == 0 and destination.exists()


def catalog_root(catalog: Path, scene_id: str) -> str:
    scenes = json.loads(catalog.read_text(encoding="utf-8"))["scenes"]
    for scene in scenes:
        if scene["id"] == scene_id:
            return scene["root"]
    raise ValueError(f"Unknown catalog scene: {scene_id}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract environment reference candidates without decoding Envb binaries.")
    parser.add_argument("--client", required=True, type=Path, help="FFXIV install or game directory; never modified")
    parser.add_argument("--scene", required=True, help="Scene id from tools/map-tools/world-catalog.json")
    parser.add_argument("--extractor", required=True, type=Path, help="Built MapExtract executable")
    parser.add_argument("--catalog", type=Path, default=Path(__file__).parents[1] / "world-catalog.json")
    parser.add_argument("--output", type=Path, default=Path("public/extracted/sandbox/environment"))
    args = parser.parse_args()

    root = catalog_root(args.catalog, args.scene)
    output = args.output.resolve() / args.scene
    level_paths = [f"{root}/level/{root.rsplit('/', 1)[-1]}.lvb", f"{root}/level/bg.lgb", f"{root}/level/planmap.lgb"]
    references: set[str] = set()
    inspected: list[dict[str, object]] = []
    for virtual_path in level_paths:
        target = output / "level" / Path(virtual_path).name
        found = run_raw(args.extractor, args.client, virtual_path, target)
        inspected.append({"path": virtual_path, "found": found})
        if found:
            references.update(match.decode("ascii") for match in PATH_RE.findall(target.read_bytes()))

    candidates = sorted(path for path in references if ENV_RE.search(path))
    extracted: list[dict[str, object]] = []
    for virtual_path in candidates:
        destination = output / "raw" / virtual_path
        found = run_raw(args.extractor, args.client, virtual_path, destination)
        extracted.append({"path": virtual_path, "found": found, "file": str(destination.relative_to(output)).replace("\\", "/") if found else None})

    manifest = {
        "schemaVersion": 1,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "sceneId": args.scene,
        "zoneRoot": root,
        "evidence": "confirmed-raw-reference-only",
        "limitations": [
            "Candidate paths are printable references in extracted level files.",
            "This tool does not decode Envb or map binary fields to lighting semantics.",
            "No fallback filename is fabricated when the client level files do not reference one.",
        ],
        "inspectedLevelFiles": inspected,
        "candidateReferences": extracted,
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"scene": args.scene, "candidates": len(candidates), "output": str(output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
