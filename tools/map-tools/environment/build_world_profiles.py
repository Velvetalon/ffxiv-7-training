"""Generate runtime samples only for zones with one unambiguous global ENVB."""
import argparse
import json
from pathlib import Path
from build_profiles import to_profile
from parse_envb import parse_envb


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--client-version", required=True)
    args = parser.parse_args()
    batch = json.loads(args.batch.read_text(encoding="utf-8"))
    profiles, unavailable = {}, []
    for scene in batch["results"]:
        source_file = Path(scene["manifest"])
        references = json.loads(source_file.read_text(encoding="utf-8"))
        candidates = [item for item in references["candidateReferences"]
                      if item.get("found") and "/env/global/" in item["path"] and item["path"].endswith(".envb")]
        if len(candidates) != 1:
            unavailable.append({"id": scene["sceneId"], "reason": "global ENVB reference is absent or ambiguous"})
            continue
        candidate = candidates[0]
        try:
            report = parse_envb(source_file.parent / candidate["file"])
            decoded = to_profile(report, scene["sceneId"], references["zoneRoot"], scene["territoryId"], args.client_version)
            if not decoded["samples"]:
                raise ValueError("no GlobalLighting samples")
            profiles[scene["sceneId"]] = {
                "samples": decoded["samples"],
                "source": {
                    "evidence": decoded["evidence"], "clientVersion": args.client_version,
                    "territoryId": scene["territoryId"], "zoneRoot": references["zoneRoot"],
                    "envbPath": candidate["path"], "sha256": report["sha256"],
                    "defaultOwnerId": decoded["selection"]["defaultOwnerId"],
                    "format": decoded["formatSource"],
                },
            }
        except (ValueError, KeyError, IndexError) as error:
            unavailable.append({"id": scene["sceneId"], "reason": str(error)})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(profiles, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"profiles": len(profiles), "scenes": batch["sceneCount"], "unavailable": unavailable}))


if __name__ == "__main__":
    main()
