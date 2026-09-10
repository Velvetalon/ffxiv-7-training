"""Catalog-backed paths and metadata for every supported world scene."""
import json
from functools import lru_cache
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT / "world-catalog.json"


@lru_cache(maxsize=1)
def catalog():
    document = json.loads(CATALOG.read_text(encoding="utf-8"))
    scenes = {entry["id"]: entry for entry in document["scenes"]}
    if len(scenes) != len(document["scenes"]):
        raise ValueError("world-catalog.json contains duplicate scene ids")
    for scene in scenes.values():
        root = PurePosixPath(scene["root"])
        if not str(root).startswith("bg/") or root.suffix:
            raise ValueError(f"{scene['id']}: invalid catalog root {scene['root']!r}")
        if not scene["mapTexture"].startswith("ui/map/"):
            raise ValueError(f"{scene['id']}: invalid catalog mapTexture")
    return document, scenes


def scene_ids():
    return tuple(catalog()[1])


def scene(scene_id):
    try:
        return catalog()[1][scene_id]
    except KeyError as error:
        raise ValueError(f"Unknown catalog scene: {scene_id}") from error


def exported_path(export_root, scene_id, relative):
    """Return an extracted asset path while preventing catalog path escape."""
    root = Path(export_root) / scene_id
    candidate = root.joinpath(*PurePosixPath(relative).parts)
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"{scene_id}: catalog asset escaped export root: {relative}")
    return candidate


def map_root(export_root, scene_id):
    return exported_path(export_root, scene_id, scene(scene_id)["root"])


def aetheryte_visual(source):
    """Return the uniquely exported source Aetheryte SGB, never invent one."""
    source=Path(source)
    directory=source / "bgcommon/world/aet/shared/for_bg"
    generic=directory / "sgbg_w_aet_001_01a.sgb"
    if generic.is_file():return generic.relative_to(source).as_posix()
    candidates=sorted(directory.glob("sgbg_w_aet_*.sgb")) if directory.is_dir() else []
    return candidates[0].relative_to(source).as_posix() if len(candidates)==1 else None


def metadata(scene_id):
    entry = scene(scene_id)
    return {key: entry[key] for key in ("name", "en", "region", "territoryId")}
