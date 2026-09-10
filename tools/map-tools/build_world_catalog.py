"""Build the complete public 7.0 world catalog from the committed source tables."""
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"


def table(name):
    with (DATA / f"{name}-7.0.csv").open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.reader(stream))
    return [dict(zip(rows[1], row)) for row in rows[3:]]


def build():
    names = {row["#"]: row["Name"] for row in table("PlaceName")}
    maps = {row["#"]: row for row in table("Map")}
    translations = json.loads((DATA / "world-names-zh.json").read_text(encoding="utf-8"))
    scenes, excluded = [], []
    for row in table("TerritoryType"):
        if not row["Bg"]:
            continue
        territory = int(row["#"])
        use = int(row["TerritoryIntendedUse"])
        root = "bg/" + row["Bg"].split("/level/")[0]
        if use not in (0, 1) or "/hou/" in root or "/pvp/" in root or int(row["ExVersion"]) > 5:
            excluded.append({
                "territoryId": territory, "name": names.get(row["PlaceName"], row["Name"]),
                "intendedUse": use,
                "reason": "housing" if "/hou/" in root else "pvp" if "/pvp/" in root else "not a normal public city or overworld zone",
            })
            continue
        map_row = maps[row["Map"]]
        code, floor = map_row["Id"].split("/")
        english = names.get(row["PlaceName"], row["Name"])
        scenes.append({
            "id": {129: "limsa", 132: "gridania"}.get(territory, row["Name"]),
            "territoryId": territory, "name": translations.get(str(territory), english),
            "en": english, "region": names.get(row["PlaceName{Region}"], "World"),
            "expansion": int(row["ExVersion"]), "kind": "overworld" if use == 1 else "city",
            "root": root, "mapId": map_row["Id"],
            "mapTexture": f"ui/map/{code}/{floor}/{code}{floor}_m.tex",
            "sizeFactor": int(map_row["SizeFactor"]),
            "offsetX": int(map_row["Offset{X}"]), "offsetY": int(map_row["Offset{Y}"]),
            "source": {
                "table": "TerritoryType-7.0.csv", "row": territory,
                "intendedUse": use, "mapRow": int(row["Map"]),
                "reason": "normal public overworld" if use == 1 else "public city or hub connecting overworld",
            },
        })
    sources = [{
        "file": f"{name}-7.0.csv",
        "sha256": hashlib.sha256((DATA / f"{name}-7.0.csv").read_bytes()).hexdigest(),
    } for name in ("TerritoryType", "Map", "PlaceName")]
    return {
        "schemaVersion": 1, "rulesVersion": "7.0",
        "clientVersionPolicy": "Read installed client; do not claim historical 7.0 assets",
        "sources": sources, "scenes": scenes, "excluded": excluded,
    }


if __name__ == "__main__":
    result = build()
    (ROOT / "world-catalog.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "included": len(result["scenes"]),
        "outdoor": sum(scene["kind"] == "overworld" for scene in result["scenes"]),
        "hubs": sum(scene["kind"] == "city" for scene in result["scenes"]),
        "excluded": len(result["excluded"]),
    }))
