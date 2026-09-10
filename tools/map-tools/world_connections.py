#!/usr/bin/env python3
"""Build an evidence-preserving FFXIV overworld ExitRange graph.

The script is intentionally independent from MapExtract's C# source.  With
--fetch it invokes its existing read-only ``raw`` command to write only
``<exports>/<catalog-id>/planmap.lgb`` files.  With existing files it parses
them and writes the JSON graph requested by the offline world runtime.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


INSTANCE_HEADER_SIZE = 0x30
EXIT_RANGE = 0x29
POP_RANGE = 0x28
PLAN_FILE = "level/planmap.lgb"


def _unpack(data: bytes, offset: int, fmt: str) -> tuple[Any, ...]:
    return struct.unpack_from("<" + fmt, data, offset)


def _vec3(data: bytes, offset: int) -> list[float]:
    return list(_unpack(data, offset, "fff"))


def _cstring(data: bytes, offset: int) -> str:
    if offset <= 0 or offset >= len(data):
        return ""
    end = data.find(b"\0", offset)
    return data[offset:end if end >= 0 else len(data)].decode("utf-8", "replace")


def parse_planmap(path: Path) -> list[dict[str, Any]]:
    """Parse only LGB ExitRange (0x29) and PopRange (0x28) records.

    Offsets are taken from Meddle's LgbFile generic object header and Lumina's
    LayerCommon ExitRangeInstanceObject / PopRangeInstanceObject readers.
    """
    data = path.read_bytes()
    if len(data) < 36 or data[:4] != b"LGB1" or data[12:16] != b"LGP1":
        raise ValueError(f"{path}: not an LGB1/LGP1 file")
    (group_count,) = _unpack(data, 32, "i")
    if group_count < 0 or 36 + group_count * 4 > len(data):
        raise ValueError(f"{path}: invalid group count {group_count}")

    group_offsets = _unpack(data, 36, "I" * group_count)
    records: list[dict[str, Any]] = []
    for group_index, relative_group_offset in enumerate(group_offsets):
        group = 36 + relative_group_offset
        if group + 16 > len(data):
            raise ValueError(f"{path}: group {group_index} outside file")
        instance_list_relative, instance_count = _unpack(data, group + 8, "II")
        instance_list = group + instance_list_relative
        if instance_list + instance_count * 4 > len(data):
            raise ValueError(f"{path}: group {group_index} invalid instance list")
        object_offsets = _unpack(data, instance_list, "I" * instance_count)
        for ordinal, relative_object_offset in enumerate(object_offsets):
            object_offset = instance_list + relative_object_offset
            if object_offset + INSTANCE_HEADER_SIZE > len(data):
                raise ValueError(f"{path}: object {ordinal} outside file")
            asset_type, instance_id, name_relative = _unpack(data, object_offset, "III")
            if asset_type not in (EXIT_RANGE, POP_RANGE):
                continue

            record: dict[str, Any] = {
                "kind": "exit" if asset_type == EXIT_RANGE else "pop",
                "group": group_index,
                "ordinal": ordinal,
                "objectOffset": object_offset,
                "instanceId": instance_id,
                "name": _cstring(data, object_offset + name_relative) if name_relative else "",
                "position": _vec3(data, object_offset + 12),
                "rotation": _vec3(data, object_offset + 24),
                "scale": _vec3(data, object_offset + 36),
            }
            subtype = object_offset + INSTANCE_HEADER_SIZE
            if asset_type == EXIT_RANGE:
                if subtype + 40 > len(data):
                    raise ValueError(f"{path}: truncated ExitRange at {object_offset}")
                shape, priority, enabled = _unpack(data, subtype, "ihB")
                exit_type, zone_id, territory, index, dest, returned, heading = _unpack(
                    data, subtype + 12, "iHHiIIf"
                )
                record.update(
                    triggerShape=shape,
                    priority=priority,
                    enabled=enabled,
                    exitType=exit_type,
                    zoneId=zone_id,
                    targetTerritoryId=territory,
                    index=index,
                    destInstanceId=dest,
                    returnInstanceId=returned,
                    playerRunningDirection=heading,
                )
            else:
                if subtype + 20 > len(data):
                    raise ValueError(f"{path}: truncated PopRange at {object_offset}")
                pop_type, positions_relative, positions_count, inner_radius, index = _unpack(
                    data, subtype, "iIIfB"
                )
                record.update(
                    popType=pop_type,
                    relativePositionsOffset=positions_relative,
                    relativePositionsCount=positions_count,
                    innerRadiusRatio=inner_radius,
                    index=index,
                )
            records.append(record)
    return records


def _load_catalog(catalog: Path) -> list[dict[str, Any]]:
    data = json.loads(catalog.read_text(encoding="utf-8"))
    scenes = data.get("scenes")
    if not isinstance(scenes, list):
        raise ValueError(f"{catalog}: missing scenes list")
    return scenes


def _plan_path(exports: Path, scene_id: str, plansflat: bool) -> Path:
    return exports / f"{scene_id}-planmap.lgb" if plansflat else exports / scene_id / "planmap.lgb"


def fetch_plans(
    scenes: Iterable[dict[str, Any]], exports: Path, *, client: str, dotnet: str, mapextract: str
) -> dict[str, Any]:
    """Use the existing read-only MapExtract DLL once per catalog scene."""
    exports.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    scene_list = list(scenes)
    for number, scene in enumerate(scene_list, start=1):
        scene_id = scene["id"]
        target = _plan_path(exports, scene_id, plansflat=False)
        target.parent.mkdir(parents=True, exist_ok=True)
        virtual_path = f"{scene['root']}/{PLAN_FILE}"
        command = [dotnet, mapextract, "raw", client, virtual_path, str(target)]
        completed = subprocess.run(command, text=True, capture_output=True)
        status = "ok" if completed.returncode == 0 and target.is_file() else "missing"
        result = {
            "scene": scene_id,
            "ordinal": number,
            "total": len(scene_list),
            "virtualPath": virtual_path,
            "status": status,
            "returnCode": completed.returncode,
        }
        if status != "ok":
            result["detail"] = (completed.stderr or completed.stdout).strip()[-1000:]
        results.append(result)
        print(json.dumps({"progress": result}, ensure_ascii=False), flush=True)
    return {"results": results}


def build_connections(exports: Path, catalog: Path, *, plansflat: bool = False) -> dict[str, Any]:
    """Build {scenes, unresolved, statistics} from raw LGB plans and catalog."""
    catalog_scenes = _load_catalog(catalog)
    by_territory = {scene["territoryId"]: scene for scene in catalog_scenes}
    parsed: dict[str, list[dict[str, Any]]] = {}
    missing: list[dict[str, Any]] = []
    parse_failures: list[dict[str, Any]] = []

    for scene in catalog_scenes:
        scene_id = scene["id"]
        plan = _plan_path(exports, scene_id, plansflat)
        if not plan.is_file():
            missing.append({"kind": "excluded", "reason": "source-planmap-missing", "sourceScene": scene_id, "plan": str(plan)})
            continue
        try:
            parsed[scene_id] = parse_planmap(plan)
        except (OSError, ValueError, struct.error) as error:
            parse_failures.append({"kind": "excluded", "reason": "source-planmap-parse-failed", "sourceScene": scene_id, "plan": str(plan), "detail": str(error)})

    pops: dict[str, dict[int, list[dict[str, Any]]]] = {}
    exits: dict[str, list[dict[str, Any]]] = {}
    for scene_id, records in parsed.items():
        pop_map: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for record in records:
            if record["kind"] == "pop":
                pop_map[record["instanceId"]].append(record)
        pops[scene_id] = dict(pop_map)
        exits[scene_id] = [record for record in records if record["kind"] == "exit"]

    graph_scenes: dict[str, list[dict[str, Any]]] = {scene["id"]: [] for scene in catalog_scenes}
    unresolved: list[dict[str, Any]] = [*missing, *parse_failures]
    counts: Counter[str] = Counter()
    counts["catalogScenes"] = len(catalog_scenes)
    counts["planmapsRead"] = len(parsed)
    counts["planmapsMissing"] = len(missing)
    counts["planmapsParseFailed"] = len(parse_failures)

    for source_scene in catalog_scenes:
        source_id = source_scene["id"]
        if source_id not in parsed:
            continue
        for exit_record in exits[source_id]:
            counts["exitRanges"] += 1
            base = {
                "sourceScene": source_id,
                "sourceFile": PLAN_FILE,
                "exitInstanceId": exit_record["instanceId"],
                "targetTerritoryId": exit_record["targetTerritoryId"],
                "destInstanceId": exit_record["destInstanceId"],
                "returnInstanceId": exit_record["returnInstanceId"],
                "rawPosition": exit_record["position"],
                "rawSpawn": None,
                "targetPopPosition": None,
                "objectOffset": exit_record["objectOffset"],
                "group": exit_record["group"],
                "ordinal": exit_record["ordinal"],
                "index": exit_record["index"],
                "enabled": exit_record["enabled"],
                "exitType": exit_record["exitType"],
                "zoneId": exit_record["zoneId"],
                "playerRunningDirection": exit_record["playerRunningDirection"],
            }
            local_spawn = pops[source_id].get(exit_record["returnInstanceId"], [])
            if len(local_spawn) == 1:
                base["rawSpawn"] = local_spawn[0]["position"]
            elif len(local_spawn) > 1:
                counts["ambiguousLocalSpawn"] += 1

            target_scene = by_territory.get(exit_record["targetTerritoryId"])
            if exit_record["enabled"] == 0:
                counts["excludedDisabled"] += 1
                unresolved.append({"kind": "excluded", "reason": "exit-disabled", **base})
                continue
            if target_scene is None:
                counts["excludedTargetNotCatalogued"] += 1
                unresolved.append({"kind": "excluded", "reason": "target-territory-not-in-catalog", **base})
                continue
            if exit_record["destInstanceId"] == 0:
                counts["excludedZeroDestination"] += 1
                unresolved.append({"kind": "excluded", "reason": "destination-instance-id-zero", "targetScene": target_scene["id"], **base})
                continue
            target_id = target_scene["id"]
            if target_id not in parsed:
                counts["unresolvedTargetPlanMissing"] += 1
                unresolved.append({"kind": "unresolved", "reason": "target-planmap-missing", "targetScene": target_id, **base})
                continue
            target_pops = pops[target_id].get(exit_record["destInstanceId"], [])
            if len(target_pops) != 1:
                reason = "target-poprange-not-found" if not target_pops else "target-poprange-ambiguous"
                counts["unresolvedTargetPop"] += 1
                unresolved.append({"kind": "unresolved", "reason": reason, "targetScene": target_id, "targetPopCount": len(target_pops), **base})
                continue
            base["targetPopPosition"] = target_pops[0]["position"]
            candidates = [
                candidate for candidate in exits[target_id]
                if candidate["enabled"] != 0
                and candidate["targetTerritoryId"] == source_scene["territoryId"]
                and candidate["destInstanceId"] == exit_record["returnInstanceId"]
                and candidate["returnInstanceId"] == exit_record["destInstanceId"]
            ]
            connection: dict[str, Any] = {
                "id": f"exit:{exit_record['instanceId']}",
                "name": f"{source_id} → {target_id}",
                "targetScene": target_id,
                "targetConnection": None,
                "position": exit_record["position"],
                "spawn": base["rawSpawn"],
                "source": base,
            }
            if len(candidates) == 1:
                connection["targetConnection"] = f"exit:{candidates[0]['instanceId']}"
                counts["paired"] += 1
            else:
                connection["arrival"] = target_pops[0]["position"]
                reason = "reciprocal-exit-not-found" if not candidates else "reciprocal-exit-ambiguous"
                counts["unpaired"] += 1
                unresolved.append({
                    "kind": "unresolved", "reason": reason, "targetScene": target_id,
                    "reciprocalCandidateCount": len(candidates), **base,
                })
            if base["rawSpawn"] is None:
                counts["edgesMissingLocalSpawn"] += 1
            graph_scenes[source_id].append(connection)
            counts["edges"] += 1

    statistics = dict(sorted(counts.items()))
    statistics["unresolved"] = sum(1 for item in unresolved if item["kind"] == "unresolved")
    statistics["excluded"] = sum(1 for item in unresolved if item["kind"] == "excluded")
    return {"scenes": graph_scenes, "unresolved": unresolved, "statistics": statistics}


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only ExitRange/PopRange connection graph builder")
    parser.add_argument("--catalog", type=Path, default=Path(__file__).with_name("world-catalog.json"))
    plans = parser.add_mutually_exclusive_group(required=True)
    plans.add_argument("--exports", type=Path, help="directory laid out as <id>/planmap.lgb")
    plans.add_argument("--plansflat", type=Path, help="directory laid out as <id>-planmap.lgb")
    parser.add_argument("--output", type=Path, required=True, help="JSON graph output path")
    parser.add_argument("--fetch", action="store_true", help="raw-read every catalog planmap before building")
    parser.add_argument("--client", help="FFXIV client root; required with --fetch")
    parser.add_argument("--dotnet", default="dotnet", help="dotnet executable for existing MapExtract DLL")
    parser.add_argument("--mapextract", help="existing MapExtract.dll path; required with --fetch")
    args = parser.parse_args()

    exports = args.exports or args.plansflat
    assert exports is not None
    if args.fetch:
        if args.plansflat is not None:
            parser.error("--fetch writes the --exports <id>/planmap.lgb layout, not --plansflat")
        if not args.client or not args.mapextract:
            parser.error("--fetch requires --client and --mapextract")
        fetch_plans(_load_catalog(args.catalog), exports, client=args.client, dotnet=args.dotnet, mapextract=args.mapextract)

    graph = build_connections(exports, args.catalog, plansflat=args.plansflat is not None)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "statistics": graph["statistics"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
