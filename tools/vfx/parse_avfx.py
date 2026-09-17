import struct, os, zlib, json, hashlib
# AVFX parser - reads the binary AVFX into a normalized EffectDefinition tree
# Reference: VFXEditor AvfxParser.cs structure

KNOWN_SECTIONS = {
    'PFDb': 'particles',
    'EMDb': 'emitters',
    'TXTb': 'textures',
    'MDLb': 'models',
    'TIMb': 'timelines',
    'CLVB': 'curves',
    'CFGb': 'config',
}

def read_items(data, start, end):
    items = []
    pos = start
    while pos + 8 <= end:
        name = bytes(data[pos:pos+4])
        size = struct.unpack_from('<I', data, pos+4)[0]
        if pos + 8 + size > end:
            break
        items.append((name, size, pos + 8))
        pos += 8 + size
        pos = (pos + 3) // 4 * 4  # align to 4 bytes
    return items

class AvfxParser:
    def __init__(self, data):
        self.data = data
        assert data[:4] == b'XFVA', 'bad magic'
        self.size, = struct.unpack_from('<I', data, 4)
        self.version = struct.unpack_from('<H', data, 12)[0]
        self.date = struct.unpack_from('<I', data, 16)[0]
        self.particles = []
        self.emitters = []
        self.textures = []
        self._walk()

    def _walk(self):
        pos = 0x14
        end = len(self.data)
        while pos + 8 <= end:
            name = bytes(self.data[pos:pos+4])
            size = struct.unpack_from('<I', self.data, pos+4)[0]
            if pos + 8 + size > end:
                break
            body = self.data[pos+8:pos+8+size]
            section = KNOWN_SECTIONS.get(name.decode('ascii', 'replace'))
            if section == 'particles':
                self._parse_container(body, self.particles, 'particle')
            elif section == 'emitters':
                self._parse_container(body, self.emitters, 'emitter')
            elif section == 'textures':
                self._parse_container(body, self.textures, 'texture')
            pos += 8 + size
            pos = (pos + 3) // 4 * 4

    def _parse_container(self, body, target, kind):
        # Container = u32 version? u32 count, then count entries
        # Entry = 4-char name + u32 size + payload (nested TLVs)
        if len(body) < 8: return
        # try count at 4
        # Walk items inside body
        items = read_items(body, 0, len(body))
        # each item is one node
        for name, size, payload_start in items:
            payload = body[payload_start:payload_start+size]
            node = self._parse_node(name, payload, kind)
            if node: target.append(node)

    def _parse_node(self, name, payload, kind):
        node = { 'kind': kind, 'name': name.rstrip(b'\\x00').decode('ascii', 'replace'), 'fields': {} }
        for cname, csize, cstart in read_items(payload, 0, len(payload)):
            cdata = payload[cstart:cstart+csize]
            key = cname.rstrip(b'\\x00').decode('ascii', 'replace')
            # decode known field types by size
            if csize == 4:
                (ival,) = struct.unpack('<I', cdata)
                (fval,) = struct.unpack('<f', cdata)
                node['fields'][key] = { 'u32': ival, 'f32': round(fval, 6), 'bytes': cdata.hex() }
            elif csize == 8:
                (v0, v1) = struct.unpack_from('<II', cdata, 0)
                node['fields'][key] = { 'u32x2': [v0, v1], 'bytes': cdata.hex() }
            else:
                node['fields'][key] = { 'bytes': cdata.hex() }
        return node

if __name__ == '__main__':
    import glob, sys
    samples = sys.argv[1] if len(sys.argv) > 1 else 'C:/Users/LXN/Documents/Codex/2026-09-17/e-code-ffxiv-7-training/work/avfx-mid'
    for path in sorted(glob.glob(samples + '/*.avfx'))[:10]:
        raw = open(path, 'rb').read()
        parser = AvfxParser(raw)
        print(os.path.basename(path), 'particles:', len(parser.particles), 'emitters:', len(parser.emitters), 'textures:', len(parser.textures))
        for p in parser.particles[:3]:
            print('  ', p['name'], len(p['fields']), 'fields')

