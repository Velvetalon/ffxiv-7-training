import argparse
import io
import struct
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description="Convert FF14 TEX formats used by character decals")
    parser.add_argument("source")
    parser.add_argument("output")
    args = parser.parse_args()
    data = Path(args.source).read_bytes()
    fmt = struct.unpack_from("<I", data, 4)[0]
    width, height = struct.unpack_from("<HH", data, 8)
    offset = struct.unpack_from("<I", data, 28)[0]
    dxgi, block_bytes = {0x6120: (80, 8), 0x6230: (83, 16)}[fmt]
    required = max(1, (width + 3) // 4) * max(1, (height + 3) // 4) * block_bytes
    header = [124, 0x00081007, height, width, required, 0, 1] + [0] * 11
    header += [32, 4, int.from_bytes(b"DX10", "little"), 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0]
    dds = b"DDS " + struct.pack("<31I", *header) + struct.pack("<5I", dxgi, 3, 0, 1, 0)
    image = Image.open(io.BytesIO(dds + data[offset:offset + required])).convert("RGBA")
    if fmt == 0x6120:
        alpha = image.getchannel("R")
        image = Image.merge("RGBA", (Image.new("L", image.size, 255),) * 3 + (alpha,))
    image.save(args.output)
    print(f"{args.output}: format=0x{fmt:x} {width}x{height}")


if __name__ == "__main__":
    main()
