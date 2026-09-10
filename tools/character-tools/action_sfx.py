import argparse
import json
import struct
from pathlib import Path


def c_string(data, offset):
    end = data.index(0, offset)
    return data[offset:end].decode("utf-8")


def main():
    parser = argparse.ArgumentParser(description="Extract confirmed animation/VFX/SCD events from an FFXIV action TMB")
    parser.add_argument("tmb")
    parser.add_argument("--action-id", type=int, required=True)
    parser.add_argument("--timeline-id", type=int, required=True)
    parser.add_argument("--timeline-key", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    data = Path(args.tmb).read_bytes()
    magic, file_size, count = struct.unpack_from("<4sII", data)
    if magic != b"TMLB" or file_size != len(data):
        raise ValueError("invalid TMB header")
    events = []
    offset = 12
    for _ in range(count):
        entry_magic, size = struct.unpack_from("<4sI", data, offset)
        if size < 8 or offset + size > len(data):
            raise ValueError(f"invalid TMB entry size at 0x{offset:x}")
        body = offset + 8
        entry_id, time = struct.unpack_from("<hh", data, body)
        record = {"entry": entry_magic.decode("ascii"), "id": entry_id, "timeFrames": time}
        if entry_magic == b"C010":
            path_offset = struct.unpack_from("<I", data, body + 24)[0]
            record.update(kind="animation", path=c_string(data, body + path_offset) + ".pap")
        elif entry_magic == b"C012":
            path_offset = struct.unpack_from("<I", data, body + 12)[0]
            record.update(kind="vfx", path=c_string(data, body + path_offset))
        elif entry_magic == b"C063":
            loop, interrupt, path_offset, sound_index, packed_position = struct.unpack_from("<iiIII", data, body + 4)
            record.update(
                kind="sound",
                path=c_string(data, body + path_offset),
                soundIndex=sound_index,
                loop=loop,
                interrupt=interrupt,
                soundPositionFlags=packed_position & 0xFF,
                bindId=(packed_position >> 8) & 0xFF,
                unknownPosition=(packed_position >> 16) & 0xFFFF,
            )
        else:
            record = None
        if record:
            events.append(record)
        offset += size
    report = {
        "schemaVersion": 1,
        "actionId": args.action_id,
        "actionTimelineId": args.timeline_id,
        "actionTimelineKey": args.timeline_key,
        "tmbPath": f"chara/action/{args.timeline_key}.tmb",
        "tmbBytes": len(data),
        "events": events,
        "timeUnit": {"stored": "TMB frame", "browserSecondsAt30Fps": "timeFrames / 30"},
    }
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
