import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
roster = json.loads((root / "work/icon-tools/roster.json").read_text(encoding="utf-8"))
mapping = json.loads((root / "src/ui/action-icons.json").read_text(encoding="utf-8"))
title_font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 26)
label_font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 16)
small_font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 12)
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
