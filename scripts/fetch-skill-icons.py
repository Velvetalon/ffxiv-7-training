"""Fetch publicly available Huiji skill icons, keyed by historical 7.0 action names."""
import concurrent.futures
import csv
import hashlib
import json
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "work" / "icon-tools"
WORK.mkdir(parents=True, exist_ok=True)
DEST = ROOT / "public" / "icons"
DEST.mkdir(parents=True, exist_ok=True)
API = "https://ff14.huijiwiki.com/api.php"
REVISION = "1b6d74360fcb3665dd5ab2f62129144112caf0f8"
data_path = ROOT / "work" / "Action-7.0.csv"
if not data_path.exists():
    response = requests.get(f"https://raw.githubusercontent.com/xivapi/ffxiv-datamining/{REVISION}/csv/Action.csv", timeout=30)
    response.raise_for_status()
    data_path.write_bytes(response.content)

source = "\n".join(p.read_text(encoding="utf-8") for p in [ROOT / "src/combat/data.js", *sorted((ROOT / "src/combat/jobs").glob("*.js"))])
with data_path.open(encoding="utf-8-sig") as stream:
    rows = list(csv.reader(stream))
headers = rows[1]
records = [dict(zip(headers, row)) for row in rows[3:]]
actions = {}
for row in records:
    name = row["Name"]
    if not name or row["IsPvP"] != "False" or int(row["ClassJobLevel"]) < 1:
        continue
    if "'" + name + "'" not in source and '"' + name + '"' not in source:
        continue
    if name not in actions or (actions[name]["iconId"] == 405 and int(row["Icon"]) != 405):
        actions[name] = {"actionId": int(row["#"]), "iconId": int(row["Icon"]), "name": name}

icon_ids = sorted({item["iconId"] for item in actions.values()})
locations = {}
for start in range(0, len(icon_ids), 40):
    titles = "|".join(f"File:{icon_id:06d}.png" for icon_id in icon_ids[start:start + 40])
    response = requests.get(API, params={"action": "query", "titles": titles, "prop": "imageinfo", "iiprop": "url", "format": "json"}, timeout=20)
    response.raise_for_status()
    result = response.json()
    for page in result["query"]["pages"].values():
        if "imageinfo" not in page:
            continue
        icon_id = int(page["title"].split(":")[-1].split(".")[0])
        locations[icon_id] = page["imageinfo"][0]["url"]

def download(item):
    icon_id, url = item
    image_url = f"https://xivapi.com/i/{icon_id // 1000 * 1000:06d}/{icon_id:06d}.png"
    path = DEST / f"{icon_id:06d}.png"
    if not path.exists():
        response = requests.get(image_url, timeout=20)
        response.raise_for_status()
        path.write_bytes(response.content)
    with Image.open(path) as image:
        image.verify()
    return icon_id, {"huijiUrl": url, "imageUrl": image_url, "local": f"/icons/{icon_id:06d}.png", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    downloaded = dict(pool.map(download, locations.items()))
mapping = {}
for name, item in actions.items():
    if item["iconId"] in downloaded:
        mapping[name] = downloaded[item["iconId"]]["local"]
(ROOT / "src/ui/action-icons.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
manifest = {"source": "Huiji public imageinfo API for file metadata; matching icon-ID images downloaded from XIVAPI because Huiji image CDN returned HTTP 567.", "api": API, "rulesRevision": REVISION, "actions": actions, "files": downloaded, "missing": [name for name in actions if name not in mapping]}
(DEST / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"actions": len(mapping), "files": len(downloaded), "missing": manifest["missing"]}))
