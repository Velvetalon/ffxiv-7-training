"""Build scene and duty catalogs for excluded FFXIV territories."""

import argparse
import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent
DATA = ROOT / "data"
DUTY_DATA = DATA / "duties"
SCHEMA = DATA / "schema-cache"


def read_csv(name):
    with (DATA / f"{name}-7.0.csv").open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.reader(stream))
    return [dict(zip(rows[1], row)) for row in rows[3:]]


def read_sheet(name):
    document = json.loads((DUTY_DATA / f"{name}.json").read_text(encoding="utf-8"))
    return {
        language: {int(row_id): values for row_id, values in payload.get("rows", {}).items()}
        for language, payload in document.get("languages", {}).items()
    }


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    temporary.write_text(payload, encoding="utf-8")
    temporary.replace(path)


def integer(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def text(value):
    return value.strip() if isinstance(value, str) else ""


def join_key(value):
    """NFKC, fullwidth-space, and whitespace normalization for stable joins."""
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFKC", value).replace("\u3000", " ").strip()


def source_root(row):
    if not text(row.get("Bg")):
        return None
    return "bg/" + row["Bg"].split("/level/")[0]


def scene_id_for_root(root):
    return root.rstrip("/").rsplit("/", 1)[-1]


def category_for(content_type, root, intended_use):
    if "/pvp/" in root:
        return "pvp"
    if "/hou/" in root:
        return "housing"
    mapping = {2: "dungeon", 3: "raid", 4: "trial", 5: "trial", 6: "alliance", 21: "high_end", 26: "high_end"}
    if content_type in mapping:
        return mapping[content_type]
    if "/dun/" in root:
        return "dungeon"
    if "/rad/" in root:
        return "raid"
    if "/cnt/" in root:
        return "alliance"
    if "/evt/" in root or "/btl/" in root or intended_use in (10, 15, 32, 34):
        return "event"
    if "/ind/" in root:
        return "internal"
    return "other_instance"


ENTRANCE_CFC = {
    "sastasha": 4,
    "tam-tara-deepcroft": 2,
    "haukke-manor": 6,
    "brayfloxs-longstop": 8,
    "copperbell-mines": 3,
    "halatali": 7,
    "toto-rak": 1,
    "aurum-vale": 5,
    "snowcloak": 27,
    "dzemael-darkhold": 13,
    "stone-vigil": 11,
    "great-gubal-library": 31,
    "matoyas-cave": 141,
    "saint-mociannes-arboretum": 41,
    "bardams-mettle": 240,
    "everkeep": 1028,
    "archeo-alexandria": 827,
    "proto-alexandria": 825,
}


def current_territory_record(row_id, row):
    return {
        "#": str(row_id), "Name": row[0] if len(row) > 0 else "",
        "Bg": row[1] if len(row) > 1 else "",
        "PlaceName{Region}": str(row[3]) if len(row) > 3 else "0",
        "PlaceName{Zone}": str(row[4]) if len(row) > 4 else "0",
        "PlaceName": str(row[5]) if len(row) > 5 else "0",
        "Map": str(row[6]) if len(row) > 6 else "0",
        "TerritoryIntendedUse": str(row[9]) if len(row) > 9 else "0",
        "ContentFinderCondition": str(row[10]) if len(row) > 10 else "0",
        "ExVersion": "0", "currentOnly": True,
    }


def current_map_record(row):
    return {
        "Id": row[6] if len(row) > 6 else "",
        "SizeFactor": str(row[7]) if len(row) > 7 else "100",
        "Offset{X}": str(row[8]) if len(row) > 8 else "0",
        "Offset{Y}": str(row[9]) if len(row) > 9 else "0",
    }


def build():
    world = json.loads((ROOT / "world-catalog.json").read_text(encoding="utf-8"))
    territories = {integer(row["#"]): row for row in read_csv("TerritoryType")}
    maps = {integer(row["#"]): row for row in read_csv("Map")}
    place_names = {integer(row["#"]): text(row["Name"]) for row in read_csv("PlaceName")}
    place_name_document = json.loads((DUTY_DATA / "PlaceName.json").read_text(encoding="utf-8"))
    place_names_zh = {
        int(row_id): values[0] if values else ""
        for row_id, values in place_name_document["languages"]["zh"]["rows"].items()
    }
    wiki_names = json.loads((DUTY_DATA / "wiki-names.json").read_text(encoding="utf-8"))
    wiki_duties = {join_key(item["zh"]): item for item in wiki_names.get("duties", []) if item.get("zh")}
    wiki_geography = {join_key(item["zh"]): item for item in wiki_names.get("geography", []) if item.get("zh")}
    current_territories = read_sheet("TerritoryType").get("zh", {})
    current_maps = {
        int(row_id): current_map_record(row)
        for row_id, row in read_sheet("Map").get("zh", {}).items()
    }
    current_by_bg = defaultdict(list)
    for row_id, row in current_territories.items():
        bg = row[1] if len(row) > 1 else ""
        if text(bg):
            current_by_bg[text(bg)].append((row_id, row))
    cfc_rows = read_sheet("ContentFinderCondition").get("zh", {})
    current_by_cfc = {}
    cfc_territory_ids = set()
    for cfc_id, cfc_row in cfc_rows.items():
        current_id = integer(cfc_row[1]) if len(cfc_row) > 1 else 0
        if current_id and current_id in current_territories:
            current_by_cfc.setdefault(cfc_id, (current_id, current_territories[current_id]))
            cfc_territory_ids.add(current_id)
    content_types = read_sheet("ContentType").get("zh", {})

    excluded_ids = [integer(item["territoryId"]) for item in world["excluded"]]
    existing_roots = {scene["root"]: scene for scene in world["scenes"]}
    old_scope_roots = {
        source_root(territories[territory_id]) for territory_id in excluded_ids
        if source_root(territories[territory_id])
    }
    supplementary_ids = []
    for row_id, row in current_territories.items():
        root = source_root({"Bg": row[1] if len(row) > 1 else ""})
        if root and root not in old_scope_roots and root not in existing_roots:
            supplementary_ids.append(integer(row_id))
    scope = [
        (territory_id, territories[territory_id], False)
        for territory_id in excluded_ids
    ] + [
        (territory_id, current_territory_record(territory_id, current_territories[territory_id]), True)
        for territory_id in sorted(supplementary_ids)
    ]
    root_records = {}
    for territory_id, row, current_only in scope:
        root = source_root(row)
        if not root:
            raise ValueError(f"Excluded territory {territory_id} has no Bg source")
        if root in root_records or root in existing_roots:
            continue
        map_id = integer(row.get("Map"))
        map_row = current_maps.get(map_id) if current_only else maps.get(map_id)
        map_texture = None
        if map_row and text(map_row.get("Id")):
            code, floor = map_row["Id"].split("/")
            map_texture = f"ui/map/{code}/{floor}/{code}{floor}_m.tex"
        english_place = place_names.get(integer(row.get("PlaceName")), row["Name"])
        chinese_place = place_names_zh.get(integer(row.get("PlaceName")), english_place)
        root_records[root] = {
            "id": scene_id_for_root(root),
            "territoryId": territory_id,
            "name": chinese_place,
            "en": english_place,
            "region": place_names.get(integer(row.get("PlaceName{Region}")), "Duty"),
            "kind": "duty",
            "expansion": integer(row.get("ExVersion")),
            "root": root,
            "mapId": map_row.get("Id") if map_row else None,
            "mapTexture": map_texture,
            "mapTextureFallback": map_texture is None,
            "sizeFactor": integer(map_row.get("SizeFactor"), 100) if map_row else 100,
            "offsetX": integer(map_row.get("Offset{X}")) if map_row else 0,
            "offsetY": integer(map_row.get("Offset{Y}")) if map_row else 0,
            "source": {
                "table": "TerritoryType-7.0.csv",
                **({"currentOnly": True} if current_only else {}),
                "row": territory_id,
                "intendedUse": integer(row.get("TerritoryIntendedUse")),
                "mapRow": map_id,
                "reason": "excluded territory selected for duty/hidden map reconstruction",
            },
        }

    generated_ids = [scene["id"] for scene in root_records.values()]
    duplicate_ids = [value for value, count in Counter(generated_ids).items() if count > 1]
    if duplicate_ids:
        raise ValueError(f"Duplicate generated scene ids: {duplicate_ids}")

    entrance_document = json.loads((PROJECT / "config/duties/entrances.json").read_text(encoding="utf-8"))
    entrance_alias = {}
    entrance_evidence = {}
    for entrance in entrance_document.get("entrances", []):
        key = text(entrance.get("dutyKey"))
        cfc_id = ENTRANCE_CFC.get(key)
        current_match = current_by_cfc.get(cfc_id) if cfc_id else None
        if not current_match:
            continue
        current_id, current_row = current_match
        root = source_root({"Bg": current_row[1]})
        entrance_alias[key] = root
        entrance_evidence[key] = {
            "currentTerritoryId": current_id,
            "contentFinderConditionId": cfc_id,
            "root": root,
            "mapping": "entrances.json source landmark key -> local ContentFinderCondition row -> current TerritoryType Bg",
        }

    candidates_by_cfc = defaultdict(list)
    for territory_id, row, current_only in scope:
        cfc_id = integer(row.get("ContentFinderCondition"))
        if cfc_id:
            candidates_by_cfc[cfc_id].append((territory_id, row, current_only))
    canonical_territory_by_cfc = {}
    for cfc_id, candidates in candidates_by_cfc.items():
        canonical = next((item for item in candidates if item[2]), None)
        if canonical is None:
            canonical = next((item for item in candidates if item[1]["Name"].endswith("_re")), None)
        if canonical is None:
            canonical = max(candidates, key=lambda item: item[0])
        canonical_territory_by_cfc[cfc_id] = canonical[0]

    duties = []
    for territory_id, row, current_only in scope:
        root = source_root(row)
        scene = existing_roots.get(root) or root_records[root]
        cfc_id = integer(row.get("ContentFinderCondition"))
        current_id, current_row = current_by_cfc.get(cfc_id, (None, {}))
        if not cfc_id:
            zero_cfc_matches = [
                item for item in current_by_bg.get(text(row.get("Bg")), [])
                if item[0] not in cfc_territory_ids
            ]
            if zero_cfc_matches:
                current_id, current_row = min(zero_cfc_matches, key=lambda item: item[0])
            else:
                current_id, current_row = None, {}
        cfc = cfc_rows.get(cfc_id, [])
        content_type_id = integer(cfc[45]) if len(cfc) > 45 else 0
        intended_use = integer(row.get("TerritoryIntendedUse"))
        root_aliases = [key for key, alias_root in entrance_alias.items() if alias_root == root]
        source_entrance = next(
            (
                item for item in entrance_document["entrances"]
                if text(item.get("dutyKey")) in root_aliases
                and current_id == entrance_evidence[text(item.get("dutyKey"))].get("currentTerritoryId")
                and territory_id == canonical_territory_by_cfc.get(integer(row.get("ContentFinderCondition")))
            ),
            None,
        )
        aliases = [text(source_entrance.get("dutyKey"))] if source_entrance else []
        english_place = place_names.get(integer(row.get("PlaceName")), row["Name"])
        chinese_place = place_names_zh.get(integer(row.get("PlaceName")), english_place)
        cfc_name_zh = text(cfc[43]) if len(cfc) > 43 else ""
        wiki_duty = wiki_duties.get(join_key(cfc_name_zh))
        wiki_place = wiki_geography.get(join_key(chinese_place))
        name_zh = cfc_name_zh or chinese_place
        name_en = wiki_duty.get("en") if wiki_duty and wiki_duty.get("en") else (
            wiki_place.get("en") if wiki_place and wiki_place.get("en") else english_place
        )
        name_source = "Huiji Wiki duty title" if wiki_duty and wiki_duty.get("en") else (
            "Huiji Wiki geography title" if wiki_place and wiki_place.get("en") else "TerritoryType PlaceName source table"
        )
        difficulties = ["High End"] if len(cfc) > 30 and cfc[30] else []
        duties.append({
            "dutyKey": f"territory:{row['Name']}",
            "aliases": aliases,
            "sceneKeys": [scene["id"]],
            "territoryId": territory_id,
            "currentTerritoryId": current_id,
            "nameZh": name_zh,
            "nameEn": name_en,
            "nameSource": name_source,
            "territoryName": row["Name"],
            "category": category_for(content_type_id, root, intended_use),
            "contentType": {"id": content_type_id, "name": text(content_types.get(content_type_id, [None])[0])},
            "level": integer(cfc[17]) if len(cfc) > 17 else None,
            "difficulty": difficulties,
            "contentFinderConditionId": cfc_id or None,
            "entranceStatus": text(source_entrance.get("status")) if source_entrance else "unresolved",
            "entrances": [{
                "dutyKey": source_entrance["dutyKey"],
                "fromSceneId": source_entrance["fromSceneId"],
                "position": source_entrance["position"],
                "radius": source_entrance.get("radius", 5),
            }] if source_entrance else [],
            "rebuildStatus": "planned",
            "status": {"rebuildStatus": "planned", "spawn": None},
            "source": {
                "territoryRow": territory_id,
                "currentTerritoryRow": current_id,
                "root": root,
                "intendedUse": intended_use,
                "contentFinderCondition": cfc_id or None,
                "classification": "ContentFinderCondition.ContentType" if content_type_id else "TerritoryIntendedUse/resource path",
            },
        })

    territory_records = [{
        "territoryId": item["territoryId"],
        "dutyKey": item["dutyKey"],
        "sceneKey": item["sceneKeys"][0],
        "root": item["source"]["root"],
        "rebuildStatus": item["rebuildStatus"],
    } for item in duties]

    hidden_catalog = {
        "schemaVersion": 1,
        "kind": "duty-hidden-candidate",
        "scenes": sorted(root_records.values(), key=lambda item: item["id"]),
        "territories": territory_records,
    }
    full_catalog = {
        "schemaVersion": 1,
        "kind": "world-and-duty-full",
        "scenes": [*world["scenes"], *hidden_catalog["scenes"]],
    }
    duty_catalog = {"schemaVersion": 1, "duties": duties, "unavailable": False}
    unmatched = [item["dutyKey"] for item in entrance_document["entrances"] if item["dutyKey"] not in entrance_alias]
    summary = {
        "existingScenes": len(world["scenes"]),
        "excludedTerritories": len(excluded_ids),
        "supplementaryCurrentTerritories": len(supplementary_ids),
        "newRootScenes": len(root_records),
        "fullScenes": len(full_catalog["scenes"]),
        "duties": len(duties),
        "sourceVerifiedEntrances": len(entrance_alias),
        "entranceAliases": len(entrance_alias),
        "unmatchedEntrances": unmatched,
        "categories": dict(sorted(Counter(item["category"] for item in duties).items())),
        "mapTextureFallbackScenes": sum(item["mapTextureFallback"] for item in root_records.values()),
        "contentFinderLinked": sum(item["contentFinderConditionId"] is not None for item in duties),
        "wikiDutyNames": sum(item["nameSource"] == "Huiji Wiki duty title" for item in duties),
        "wikiGeographyNames": sum(item["nameSource"] == "Huiji Wiki geography title" for item in duties),
    }
    expected = {
        "existingScenes": 65,
        "excludedTerritories": 942,
        "newRootScenes": 531,
        "fullScenes": 596,
        "duties": 1072,
        "entranceAliases": 18,
        "sourceVerifiedEntrances": 18,
    }
    failures = {key: (summary[key], value) for key, value in expected.items() if summary[key] != value}
    if failures or unmatched:
        raise ValueError(f"Duty catalog contract failed: {failures}, unmatched={unmatched}")
    return hidden_catalog, full_catalog, duty_catalog, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT / "config/duties")
    args = parser.parse_args()
    hidden, full, duties, summary = build()
    write_json(args.output / "hidden-catalog.json", hidden)
    write_json(args.output / "full-catalog.json", full)
    write_json(args.output / "duty-catalog.json", duties)
    write_json(args.output / "catalog-summary.json", summary)
    digest = hashlib.sha256((args.output / "duty-catalog.json").read_bytes()).hexdigest()
    print(json.dumps({**summary, "dutyCatalogSha256": digest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
