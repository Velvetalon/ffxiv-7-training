"""Build a compact name catalog from cached Huiji FF14 Wiki API evidence."""

import hashlib
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT.parent.parent / "work/wiki"
OUTPUT = ROOT / "data/duties/wiki-names.json"


def load(name):
    return json.loads((EVIDENCE / name).read_text(encoding="utf-8"))


def clean_snippet(value):
    value = html.unescape(re.sub(r"<[^>]+>", " ", value))
    return value.replace("\u3000", " ")


def split_duty_localization(title, snippet):
    text = clean_snippet(snippet)
    tail = text[text.find(title) + len(title):] if title in text else text
    segment = tail.split(" 基本信息", 1)[0].strip()
    for index, character in enumerate(segment):
        if not character.isascii() or not character.isalpha():
            continue
        if index and not segment[index - 1].isspace():
            continue
        previous = index - 1
        while previous >= 0 and segment[previous].isspace():
            previous -= 1
        if previous >= 0 and segment[previous] == "(":
            continue
        english = segment[index:].strip()
        if all(character.isascii() for character in english):
            return segment[:index].strip(), english
    return None, None


def source_sha():
    files = [
        "huiji-duty-category-search.json",
        "huiji-geography-search.json",
        "huiji-entrance-rendered.json",
    ]
    return {name: hashlib.sha256((EVIDENCE / name).read_bytes()).hexdigest() for name in files}


def build():
    duties = {}
    search = load("huiji-duty-category-search.json")["query"]["search"]
    for item in search:
        title = item["title"]
        japanese, english = split_duty_localization(title, item["snippet"])
        duties[title] = {"zh": title, "ja": japanese, "en": english, "source": "Category:副本 search snippet"}

    rendered = load("huiji-entrance-rendered.json")
    for item in rendered:
        parsed = item.get("parsed") or {}
        head = parsed.get("head") or []
        if len(head) < 5:
            continue
        duties[head[2]] = {
            "zh": head[2], "ja": head[3], "en": head[4],
            "wikiDutyId": parsed.get("id"), "source": "rendered duty page infobox",
        }

    geography = {}
    for item in load("huiji-geography-search.json")["query"]["search"]:
        snippet = clean_snippet(item["snippet"])
        japanese = re.search(r"日文[︰:]\s*([^）)]+)[）)]", snippet)
        english = re.search(r"英文[︰:]\s*([^）)]+)[）)]", snippet)
        geography[item["title"]] = {
            "zh": item["title"],
            "ja": japanese.group(1).strip() if japanese else None,
            "en": english.group(1).strip() if english else None,
            "source": "Category:地理 search snippet",
        }

    document = {
        "schemaVersion": 1,
        "source": {
            "site": "https://ff14.huijiwiki.com/",
            "api": "MediaWiki action=query / action=parse",
            "retrievedAtUtc": "2026-09-18",
            "sourceSha256": source_sha(),
            "joinRule": "Duty names join by exact Chinese title. Wiki duty IDs are page/InstanceContent-style IDs and must not be joined to ContentFinderCondition.",
        },
        "duties": sorted(duties.values(), key=lambda item: item["zh"]),
        "geography": sorted(geography.values(), key=lambda item: item["zh"]),
    }
    return document


def main():
    document = build()
    OUTPUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"duties": len(document["duties"]), "geography": len(document["geography"])}))


if __name__ == "__main__":
    main()
