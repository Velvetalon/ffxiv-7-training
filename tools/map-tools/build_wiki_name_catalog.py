"""Build a compact name catalog from cached Huiji FF14 Wiki API evidence."""

import hashlib
import html
import json
import re
from pathlib import Path
import unicodedata

ROOT = Path(__file__).resolve().parent
EVIDENCE = ROOT.parent.parent / "work/wiki"
BASELINE_EVIDENCE = ROOT.parent.parent / "work"
OUTPUT = ROOT / "data/duties/wiki-names.json"


def load(name):
    path = EVIDENCE / name
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def load_json_worklist(kind):
    """Read the tracked e741a548f name catalog exported to work as legacy recovery evidence."""
    path = BASELINE_EVIDENCE / "wiki-names-baseline.json"
    if not path.is_file():
        return []
    document = json.loads(path.read_text(encoding="utf-8"))
    if kind == "wiki-names-baseline-duties":
        return document.get("duties", [])
    if kind == "wiki-names-baseline-rendered":
        return [{"parsed": {"id": item.get("wikiDutyId"), "head": [None, None, item.get("zh"), item.get("ja"), item.get("en")]}} for item in document.get("duties", [])]
    if kind == "wiki-names-baseline-geography":
        return document.get("geography", [])
    return []


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
    return {
        name: hashlib.sha256((EVIDENCE / name).read_bytes()).hexdigest()
        for name in files
        if (EVIDENCE / name).is_file()
    }


def key(value):
    """NFKC, fullwidth-space, and whitespace normalization; display text is preserved."""
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFKC", value).replace("\u3000", " ").strip()


def display_text(value):
    """Normalize join key, preserving original CJK display text from source evidence."""
    if not isinstance(value, str):
        return ""
    return value.strip()


def english_text(value):
    """Normalize join key, preserving original English display text from source evidence."""
    if not isinstance(value, str):
        return ""
    return re.sub(r"\{\{Italic\|([^}]+)\}\}", r"\1", value).strip()


def structured_instance_entries():
    """Normalize structured Data:Instance pages without joining IDs to CFC."""
    path = EVIDENCE / "huiji-instance-data-current.json"
    if not path.is_file():
        return []
    document = json.loads(path.read_text(encoding="utf-8"))
    entries = {}
    for page in document.get("pages", []):
        payload = page.get("payload")
        if not isinstance(payload, dict):
            continue
        chinese_key = key(payload.get("中文名"))
        if not chinese_key or chinese_key in entries:
            continue
        entries[chinese_key] = {
            "zh": display_text(payload.get("中文名")),
            "ja": display_text(payload.get("日文名")) or None,
            "en": english_text(payload.get("英文名")) or None,
            "huijiInstancePageId": payload.get("ID"),
            "source": "Huiji structured Data Instance page",
        }
    return entries


def merge_duties(legacy_duties, structured_entries):
    """Structured evidence wins only when a field is non-empty; keep legacy data otherwise."""
    merged = dict(legacy_duties)
    for normalized_key, structured in structured_entries.items():
        legacy = merged.get(normalized_key)
        if not legacy:
            merged[normalized_key] = structured
            continue
        overrides = {
            field: value
            for field, value in structured.items()
            if field != "zh" and value not in (None, "")
        }
        merged[normalized_key] = {
            **legacy,
            **overrides,
            "zh": structured["zh"],
            "source": structured["source"],
        }
    return merged


def build():
    legacy_duties = {}
    search = load("huiji-duty-category-search.json").get("query", {}).get("search", [])
    if not search:
        search = load_json_worklist("wiki-names-baseline-duties")
    for item in search:
        title = item.get("zh") or item.get("title") or ""
        japanese = item.get("ja")
        english = item.get("en")
        if not japanese and not english and item.get("snippet"):
            japanese, english = split_duty_localization(title, item["snippet"])
        legacy_duties[key(title)] = {"zh": title, "ja": japanese, "en": english, "source": item.get("source", "Category:副本 search snippet")}

    rendered = load("huiji-entrance-rendered.json")
    if not rendered:
        rendered = load_json_worklist("wiki-names-baseline-rendered")
    for item in rendered:
        parsed = item.get("parsed") or {}
        head = parsed.get("head") or []
        if len(head) < 5:
            continue
        legacy_duties[key(head[2])] = {
            "zh": head[2], "ja": head[3], "en": head[4],
            "wikiDutyId": parsed.get("id"), "source": "rendered duty page infobox",
        }

    geography = {}
    geography_search = load("huiji-geography-search.json").get("query", {}).get("search", [])
    if not geography_search:
        geography_search = load_json_worklist("wiki-names-baseline-geography")
    for item in geography_search:
        title = item.get("zh") or item.get("title") or ""
        geography[key(title)] = {
            "zh": title,
            "ja": item.get("ja"),
            "en": item.get("en"),
            "source": item.get("source", "Category:地理 search snippet"),
        }

    document = {
        "schemaVersion": 1,
        "source": {
            "site": "https://ff14.huijiwiki.com/",
            "api": "MediaWiki action=query / action=parse",
            "retrievedAtUtc": "2026-09-18",
            "structuredEvidence": "work/wiki/huiji-instance-data-current.json",
            "structuredPagesFetched": len(structured_instance_entries()),
            "sourceSha256": source_sha(),
            "joinRule": "Duty names join by exact Chinese title. Wiki duty IDs are page/InstanceContent-style IDs and must not be joined to ContentFinderCondition.",
        },
        "duties": sorted(merge_duties(legacy_duties, structured_instance_entries()).values(), key=lambda item: item["zh"]),
        "geography": sorted(geography.values(), key=lambda item: item["zh"]),
    }
    return document


def main():
    document = build()
    OUTPUT.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"duties": len(document["duties"]), "geography": len(document["geography"])}))


if __name__ == "__main__":
    main()
