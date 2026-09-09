"""Render the explicit source-pixel trace over the reference maps for review."""
import argparse
import json
import os
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def discover_font(requested: str | None) -> Path | None:
    """Use a caller-supplied font first, then find a common system UI font."""
    if requested:
        candidate = Path(requested).expanduser()
        if not candidate.is_file():
            raise SystemExit(f"Font file does not exist: {candidate}")
        return candidate

    directories = [
        Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"),
        Path.home() / ".local/share/fonts",
        Path.home() / ".fonts",
    ]
    if os.environ.get("WINDIR"):
        directories.insert(0, Path(os.environ["WINDIR"]) / "Fonts")
    for directory in directories:
        for name in ("arial.ttf", "segoeui.ttf", "NotoSans-Regular.ttf", "DejaVuSans.ttf"):
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


parser = argparse.ArgumentParser(description="Render source-pixel traces over reference maps.")
parser.add_argument("--font", help="TTF/TTC/OTF font file to use; defaults to a discovered system font")
args = parser.parse_args()

root = Path(__file__).resolve().parents[1]
data = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", "import {TRACE_PIXELS} from './src/world/terrain/layouts.js';console.log(JSON.stringify(TRACE_PIXELS));"], cwd=root, text=True, encoding="utf-8"))
font_path = discover_font(args.font)
if font_path is None:
    print("No system TrueType font found; Pillow default font will be used.")
else:
    print(f"Using font: {font_path}")
label_font = ImageFont.truetype(str(font_path), 20) if font_path else ImageFont.load_default()
for scene, trace in data.items():
    source = Image.open(root / "work/references" / f"{scene}-map.jpg").convert("RGBA")
    layer = Image.new("RGBA", source.size)
    draw = ImageDraw.Draw(layer)
    for area in trace["surfaces"]: draw.polygon([tuple(p) for p in area["points"]], fill=(38, 141, 145, 44), outline=(27, 113, 117, 220), width=2)
    for road in trace["roads"]: draw.line([tuple(p) for p in road["points"]], fill=(201, 60, 37, 225), width=3)
    for i, landmark in enumerate(trace["landmarks"]):
        x,y=landmark["point"]; draw.ellipse((x-8,y-8,x+8,y+8),fill=(30,59,94,230));draw.text((x+10,y-8),str(i+1),fill=(20,40,70,255),font=label_font)
    result=Image.alpha_composite(source,layer)
    crop=(640,870,1400,1310) if scene=="gridania" else (135,875,1120,1465)
    result.crop(crop).convert("RGB").save(root / "work" / f"{scene}-trace-overlay.jpg")
