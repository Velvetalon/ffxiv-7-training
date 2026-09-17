import struct, os, zlib, json

# ============ AVFX Parser (v1) ============
# Container: TLV of 4-char tags (little-endian), names stored reversed.
# Sections: Ptcl / Emit / TmLn / Bind / Tex / Modl / Schd.
# Values: 4-byte fields decoded as u32/f32; curves contain KeyC/BvPr/BvPo/RanT/Keys.
# Keys are packed f32 triples (x,y,z or t,value,behaviors).

def read_tags(data, start, end):
    items = []
    pos = start
    while pos + 8 <= end:
        tag = data[pos:pos+4]
        size = struct.unpack_from('<I', data, pos+4)[0]
        payload_start = pos + 8
        if payload_start + size > end:
            break
        items.append((tag, payload_start, size))
        pos = payload_start + size
        pos = (pos + 3) & ~3
    return items

class Node:
    def __init__(self, tag):
        self.tag = tag
        self.name = tag[::-1].decode('ascii', 'replace').rstrip('\\x00')
        self.fields = {}
        self.children = []

    def field_name(self, tag):
        return tag[::-1].decode('ascii', 'replace')

    def to_dict(self):
        return { 'name': self.name, 'fields': self.fields, 'children': [c.to_dict() for c in self.children] }

def _decode_value(tag, body):
    if len(body) == 4:
        u, = struct.unpack_from('<I', body, 0)
        f, = struct.unpack_from('<f', body, 0)
        return { 'u32': u, 'f32': round(f, 6) }
    if len(body) == 1:
        return { 'u8': body[0] }
    return { 'bytes': body.hex() }

def walk_tree(payload, node):
    pos = 0
    while pos + 8 <= len(payload):
        tag = payload[pos:pos+4]
        size = struct.unpack_from('<I', payload, pos+4)[0]
        if pos + 8 + size > len(payload):
            break
        body = payload[pos+8:pos+8+size]
        nested = False
        if size > 8:
            q = 0
            ok = True
            while q + 8 <= len(body):
                inner_tag = body[q:q+4]
                if not all((65 <= c <= 90) or (97 <= c <= 122) for c in inner_tag):
                    ok = False; break
                ss = struct.unpack_from('<I', body, q+4)[0]
                q += 8 + ss
                q = (q+3) & ~3
            if ok and q == len(body):
                nested = True
        if nested:
            child = Node(tag)
            walk_tree(body, child)
            node.children.append(child)
        else:
            node.fields[node.field_name(tag)] = _decode_value(tag, body)
        pos += 8 + size
        pos = (pos + 3) & ~3

def parse(path):
    raw = open(path, 'rb').read()
    if raw[:4] != b'XFVA': raise ValueError('bad magic')
    doc = { 'fileSize': struct.unpack_from('<I', raw, 4)[0], 'sections': {} }
    pos = 0x14
    end = len(raw)
    while pos + 8 <= end:
        tag = raw[pos:pos+4]
        size = struct.unpack_from('<I', raw, pos+4)[0]
        if pos + 8 + size > end:
            break
        body = raw[pos+8:pos+8+size]
        name = tag[::-1].decode('ascii', 'replace').rstrip('\\x00')
        if name in ('Ptcl', 'Emit', 'TmLn', 'Bind', 'Tex', 'Modl', 'Schd'):
            node = Node(tag)
            walk_tree(body, node)
            doc['sections'].setdefault(name, []).append(node.to_dict())
        pos += 8 + size
        pos = (pos + 3) & ~3
    return doc

if __name__ == '__main__':
    import glob, sys
    outdir = sys.argv[1] if len(sys.argv) > 1 else 'C:/Users/LXN/Documents/Codex/2026-09-17/e-code-ffxiv-7-training/work/avfx-mid'
    for path in sorted(glob.glob(outdir + '/*.avfx'))[:10]:
        try:
            doc = parse(path)
            print(os.path.basename(path), 'sections:', {k: len(v) for k, v in doc['sections'].items()})
        except Exception as e:
            print(os.path.basename(path), 'ERROR', e)

