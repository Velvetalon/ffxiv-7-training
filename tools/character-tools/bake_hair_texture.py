import argparse
import json
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description="Bake FF14 hair.shpk main/highlight colors into a browser texture")
    parser.add_argument("normal")
    parser.add_argument("mask")
    parser.add_argument("colors")
    parser.add_argument("output")
    args = parser.parse_args()
    colors = json.loads(Path(args.colors).read_text(encoding="utf-8-sig"))
    main_color = colors["Hair"] if "Hair" in colors else colors["hair"]
    highlight = colors["Highlight"] if "Highlight" in colors else colors["highlight"]
    normal = Image.open(args.normal).convert("RGBA")
    mask = Image.open(args.mask).convert("RGBA").resize(normal.size)
    output = Image.new("RGBA", normal.size)
    normal_pixels = normal.load()
    mask_pixels = mask.load()
    output_pixels = output.load()
    for y in range(normal.height):
        for x in range(normal.width):
            normal_pixel = normal_pixels[x, y]
            amount = normal_pixel[2] / 255.0
            mask_alpha = mask_pixels[x, y][3] / 255.0
            rgb = [round((main_color[i] * (1 - amount) + highlight[i] * amount) * mask_alpha * 255) for i in range(3)]
            output_pixels[x, y] = (*rgb, normal_pixel[3])
    output.save(args.output)
    print(f"{args.output}: {normal.width}x{normal.height}")


if __name__ == "__main__":
    main()
