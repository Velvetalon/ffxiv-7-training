import argparse
import json
import os
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
    names = (
        "msyh.ttc", "msyh.ttf", "NotoSansCJK-Regular.ttc", "NotoSansCJK-Regular.otf",
        "NotoSans-Regular.ttf", "DejaVuSans.ttf", "segoeui.ttf", "arial.ttf",
    )
    for directory in directories:
        for name in names:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


def load_font(path: Path | None, size: int):
    return ImageFont.truetype(str(path), size) if path else ImageFont.load_default()


parser = argparse.ArgumentParser(description="Render the local skill icon contact sheet.")
parser.add_argument("--font", help="TTF/TTC/OTF font file to use; defaults to a discovered system font")
args = parser.parse_args()

root = Path(__file__).resolve().parents[1]
roster = json.loads((root / "work/icon-tools/roster.json").read_text(encoding="utf-8"))
mapping = json.loads((root / "src/ui/action-icons.json").read_text(encoding="utf-8"))
font_path = discover_font(args.font)
if font_path is None:
    print("No system TrueType font found; Pillow default font will be used.")
else:
    print(f"Using font: {font_path}")
title_font = load_font(font_path, 26)
label_font = load_font(font_path, 16)
small_font = load_font(font_path, 12)
canvas = Image.new("RGB", (1120, 870), "#132330")
draw = ImageDraw.Draw(canvas)
draw.text((30, 20), "FFXIV 7.0  技能图标对照", font=title_font, fill="#f0dbad")
draw.text((30, 60), "Huiji Wiki file metadata / XIVAPI matching icon-ID images", font=small_font, fill="#9bb5bb")
for job_index, job in enumerate(roster):
    y0 = 98 + job_index * 245
    draw.text((30, y0), f'{job["name"]}  {job["id"]}', font=title_font, fill="#e7d6b1")
    for i, action in enumerate(job["actions"][:12]):
        x, y = 34 + (i % 6) * 180, y0 + 51 + (i // 6) * 87
        icon = Image.open(root / "public" / mapping[action["en"]].lstrip("/")).convert("RGBA").resize((52, 52), Image.Resampling.LANCZOS)
        draw.rectangle((x - 2, y - 2, x + 53, y + 53), outline="#a69160", width=1)
        canvas.paste(icon, (x, y), icon)
        draw.text((x + 61, y + 4), action["name"][:6], font=label_font, fill="#eee8d6")
        en = action["en"]
        words = en.split()
        line, lines = "", []
        for word in words:
            if len(line + " " + word) > 15:
                lines.append(line); line = word
            else: line = (line + " " + word).strip()
        lines.append(line)
        for j, line in enumerate(lines[:2]): draw.text((x + 61, y + 28 + j * 14), line, font=small_font, fill="#a8bec5")
draw.text((30, 837), "Icon artwork © SQUARE ENIX. 116 local icons; historical 7.0 action IDs.", font=small_font, fill="#91a6ab")
out = root / "work" / "skill-icons.png"
canvas.save(out)
print(out)
