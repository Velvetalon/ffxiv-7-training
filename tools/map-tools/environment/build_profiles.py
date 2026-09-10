"""Build browser-facing, source-backed samples from decoded global ENVB files.

This adapter deliberately exposes only fields whose names and binary layout
are described in xivdev/file-formats/imhex/env.hexpat.  The complete decoder
report remains available for review; values such as tone-map parameters are
kept under ``rawChannels`` instead of being guessed as renderer exposure.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from parse_envb import FORMAT_SOURCE, parse_envb


def envset(section: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((value for value in section["envsets"] if value["typeName"] == name), None)


def nearest(frames: list[dict[str, Any]] | None, seconds: float) -> dict[str, Any] | None:
    if not frames:
        return None
    return min(frames, key=lambda frame: abs(float(frame["timeSeconds"]) - seconds))


def to_profile(report: dict[str, Any], scene_id: str, zone_root: str, territory_id: int, client_version: str) -> dict[str, Any]:
    # Owner 1 is retained as a raw owner/weather id.  The report includes all
    # sections so a caller can select another weather without re-extraction.
    sections = []
    for section in report["sections"]:
        lighting = envset(section, "GlobalLighting")
        fog = envset(section, "VerticalFog")
        tone = envset(section, "ToneMapping")
        if not lighting:
            continue
        sections.append(
            {
                "ownerId": section["ownerId"],
                "samples": make_samples(lighting, fog, tone),
                "rawChannels": {
                    "globalLighting": lighting["keyframes"],
                    "verticalFog": fog["keyframes"] if fog else [],
                    "toneMapping": tone["keyframes"] if tone else [],
                },
            }
        )

    default_section = next((section for section in sections if section["ownerId"] == 1), sections[0] if sections else None)
    return {
        "schemaVersion": 1,
        "sceneId": scene_id,
        "territoryId": territory_id,
        "zoneRoot": zone_root,
        "clientVersion": client_version,
        "format": report["format"],
        "formatSource": FORMAT_SOURCE,
        "envb": {
            "file": report["file"],
            "sha256": report["sha256"],
            "bytes": report["bytes"],
            "containerVersion": report["containerVersion"],
            "sectionCount": report["header"]["sectionCount"],
        },
        "evidence": "confirmed-decoded-envb-adapter",
        "selection": {
            "defaultOwnerId": default_section["ownerId"] if default_section else None,
            "ownerIdMeaning": "raw EnvSection.owner_id; this adapter does not rename it to a weather label",
        },
        "sections": sections,
        "samples": default_section["samples"] if default_section else [],
        "limitations": [
            "PackedColorIntensity bytes and intensity are preserved exactly; the upstream format does not state an sRGB/linear transfer for these bytes.",
            "sunColor/sunIntensity, ambientScale, fogColor and fogNear come from fields with matching source names (ambientScale preserves the source multiplier semantics).",
            "fogFar is a documented adapter derivation: fogStartDistance + fogFadeDistance; no source field is renamed to far.",
            "ToneMapping is retained as raw channel data; it is not mislabeled as renderer exposure.",
            "Ambient sky/ground, background sky texture, sun direction and weather labels require additional client/runtime evidence and remain unset.",
        ],
    }


def make_samples(lighting: dict[str, Any], fog: dict[str, Any] | None, tone: dict[str, Any] | None) -> list[dict[str, Any]]:
    fog_frames = fog["keyframes"] if fog else []
    tone_frames = tone["keyframes"] if tone else []
    samples = []
    for frame in lighting["keyframes"]:
        seconds = float(frame["timeSeconds"])
        sun = frame.get("sunlightColor") or {}
        fog_frame = nearest(fog_frames, seconds)
        fog_value = fog_frame.get("v700") if fog_frame else None
        fog_color = fog_frame.get("fogColor") if fog_frame else None
        sample: dict[str, Any] = {
            "hour": round((seconds / 3600.0) % 24.0, 6),
            "sourceTimeSeconds": seconds,
            "sourceOwnerId": None,
            "sunColor": sun.get("hex"),
            "sunIntensity": sun.get("intensity"),
            # The source field is explicitly a scale, not a final renderer
            # intensity.  Keep that distinction at the runtime boundary.
            "ambientScale": frame.get("ambientLightScale"),
            "source": {
                "globalLightingTimeSeconds": seconds,
                "verticalFogTimeSeconds": fog_frame.get("timeSeconds") if fog_frame else None,
                "toneMappingTimeSeconds": nearest(tone_frames, seconds).get("timeSeconds") if tone_frames else None,
            },
        }
        if fog_color:
            sample["fogColor"] = fog_color.get("hex")
        if fog_frame:
            sample["fogNear"] = fog_frame.get("fogStartDistance")
            # fogFadeDistance is a length, not a far plane.  Keep the
            # transparent adapter derivation explicit in the sample.
            if fog_frame.get("fogStartDistance") is not None and fog_frame.get("fogFadeDistance") is not None:
                sample["fogFar"] = round(float(fog_frame["fogStartDistance"]) + float(fog_frame["fogFadeDistance"]), 6)
        if fog_value:
            sample["fogDensityPercent"] = fog_value.get("fogDensityPercent")
            sample["fogMinOpacity"] = fog_value.get("fogMinOpacity")
            sample["fogDirectionalInscatteringIntensity"] = fog_value.get("directionalInscatteringColorIntensity")
        samples.append({key: value for key, value in sample.items() if value is not None})
    return samples


def main() -> int:
    parser = argparse.ArgumentParser(description="Build source-backed environment profiles from ENVB reports")
    parser.add_argument("--scene", required=True)
    parser.add_argument("--zone-root", required=True)
    parser.add_argument("--territory-id", required=True, type=int)
    parser.add_argument("--client-version", required=True)
    parser.add_argument("--envb", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = parse_envb(args.envb)
    profile = to_profile(report, args.scene, args.zone_root, args.territory_id, args.client_version)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(profile, indent=2), encoding="utf-8")
    print(json.dumps({"scene": args.scene, "samples": len(profile["samples"]), "sha256": profile["envb"]["sha256"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
