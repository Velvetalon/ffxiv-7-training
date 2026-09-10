"""Run the read-only environment reference probe for every catalog scene.

The wrapper keeps all raw exports under a caller-selected directory outside the
repository.  Each scene uses the exact same probe and SqPack ``raw`` command;
the summary is intentionally compact so a 65-scene run is auditable without
checking normal map logs into Git.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe environment references for all world-catalog scenes")
    parser.add_argument("--client", required=True, type=Path)
    parser.add_argument("--extractor", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--scene", action="append", help="limit to one or more scene ids; default is all catalog scenes")
    args = parser.parse_args()

    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    by_id = {scene["id"]: scene for scene in catalog["scenes"]}
    scene_ids = args.scene or list(by_id)
    unknown = sorted(set(scene_ids) - set(by_id))
    if unknown:
        parser.error(f"unknown scene ids: {', '.join(unknown)}")

    args.output.mkdir(parents=True, exist_ok=True)
    probe = Path(__file__).with_name("probe_environment.py")
    results: list[dict[str, object]] = []
    for scene_id in scene_ids:
        destination = args.output / scene_id
        command = [
            sys.executable,
            str(probe),
            "--client",
            str(args.client),
            "--scene",
            scene_id,
            "--extractor",
            str(args.extractor),
            "--catalog",
            str(args.catalog),
            "--output",
            str(args.output),
        ]
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
        manifest_path = destination / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
        results.append(
            {
                "sceneId": scene_id,
                "territoryId": by_id[scene_id]["territoryId"],
                "kind": by_id[scene_id].get("kind"),
                "returnCode": completed.returncode,
                "candidateCount": len(manifest["candidateReferences"]) if manifest else 0,
                "manifest": str(manifest_path).replace("\\", "/") if manifest else None,
                "stderr": completed.stderr.strip()[-1000:] if completed.returncode else None,
            }
        )
        print(json.dumps(results[-1], ensure_ascii=False))

    summary = {
        "schemaVersion": 1,
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "client": str(args.client),
        "extractor": str(args.extractor),
        "catalog": str(args.catalog),
        "sceneCount": len(results),
        "successCount": sum(result["returnCode"] == 0 for result in results),
        "failureCount": sum(result["returnCode"] != 0 for result in results),
        "candidateReferenceCount": sum(int(result["candidateCount"]) for result in results),
        "results": results,
    }
    (args.output / "batch-manifest.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ("sceneCount", "successCount", "failureCount", "candidateReferenceCount")}, indent=2))
    return 0 if summary["failureCount"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
