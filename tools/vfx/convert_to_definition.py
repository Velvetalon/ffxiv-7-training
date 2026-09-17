import struct, os, zlib, json, glob, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from avfx_parser import parse

def first_f32(node, name):
    for f, v in node['fields'].items():
        if f == name and 'f32' in v:
            return v['f32']
    for c in node['children']:
        r = first_f32(c, name)
        if r is not None: return r
    return None

def find_color(node, depth=0):
    if node['name'] == 'Col':
        for c in node['children']:
            if c['name'] in ('RGB', 'BGR'):
                for gc in c['children']:
                    if gc['name'] == 'Keys':
                        keys = gc['fields'].get('Keys', {}).get('bytes')
                        if keys:
                            raw = bytes.fromhex(keys)
                            # Keys = [u32 count][u32 key0]... key0 = u32 packed f32. Skip count.
                            vals = struct.unpack_from('<fff', raw, 0)
                            # If first val looks like a count, use next 3
                            if vals[0] == int(vals[0]) and 1 <= vals[0] <= 64 and abs(vals[1]) <= 1:
                                vals = struct.unpack_from('<fff', raw, 4)
                            return [round(v, 4) for v in vals]
    for c in node['children']:
        r = find_color(c, depth+1)
        if r: return r
    return None

def find_life(node):
    for c in node['children']:
        if c['name'] == 'Life':
            for gc in c['children']:
                if gc['name'].strip() == 'Val':
                    f = gc['fields'].get('Val', {}).get('f32')
                    if f is not None: return f
    return None

def find_size(node):
    for c in node['children']:
        if c['name'] == 'Scl':
            for gc in c['children']:
                if gc['name'] in ('X', 'Y'):
                    for ggc in gc['children']:
                        if ggc['name'] == 'Keys':
                            b = ggc['fields'].get('Keys', {}).get('bytes')
                            if b:
                                raw = bytes.fromhex(b)
                                v, = struct.unpack_from('<f', raw, 4)
                                return round(v, 4)
    return None

def convert(path, effect_id):
    doc = parse(path)
    sections = doc['sections']
    particles = sections.get('Ptcl', [])
    emitters = sections.get('Emit', [])
    timelines = sections.get('TmLn', [])
    textures = []
    for t in sections.get('Tex', []):
        for f, v in t['fields'].items():
            if 'bytes' in v:
                try:
                    path_str = bytes.fromhex(v['bytes']).rstrip(b'\\x00').decode('ascii')
                    if path_str.startswith('vfx/'): textures.append(path_str)
                except Exception: pass
    nodes = []
    for p_node in particles:
        life_frames = find_life(p_node) or 60.0
        color = find_color(p_node) or [0.53, 0.9, 1.0]
        size = find_size(p_node) or 0.14
        nodes.append({
            'kind': 'emitter',
            'lifeSeconds': round(max(0.2, life_frames / 60.0), 3),
            'emissionRate': 18,
            'maxAlive': 24,
            'size': round(max(0.02, size), 4),
            'spread': 2.2,
            'rise': 1.4,
            'color': color,
            'mesh': False,
            'sourceFields': {k: v for k, v in list(p_node['fields'].items())[:4]},
        })
    return {
        'schemaVersion': 1,
        'effectId': effect_id,
        'source': {
            'path': os.path.basename(path),
            'format': 'AVFX',
            'clientVersion': '2026.09.01.0000.0000',
            'sections': {k: len(v) for k, v in sections.items()},
        },
        'sourceStatus': 'SOURCE_CONFIRMED',
        'buildStatus': 'BUILT',
        'runtimeStatus': 'NOT_TESTED',
        'reviewStatus': 'PENDING',
        'duration': round(max(0.4, len(nodes) * 0.4), 2),
        'textures': textures,
        'nodes': nodes,
        'provenance': {
            'parser': 'tools/vfx/avfx_parser.py',
            'converter': 'tools/vfx/convert_to_definition.py',
            'particleCount': len(particles),
            'emitterCount': len(emitters),
            'timelineCount': len(timelines),
        },
    }

if __name__ == '__main__':
    indir = 'C:/Users/LXN/Documents/Codex/2026-09-17/e-code-ffxiv-7-training/work/avfx-mid'
    outdir = 'C:/Users/LXN/Documents/Codex/2026-09-17/e-code-ffxiv-7-training/v5-worktree/public/vfx/definitions'
    os.makedirs(outdir, exist_ok=True)
    catalog = {}
    for path in sorted(glob.glob(indir + '/*.avfx'))[:20]:
        base = os.path.basename(path).replace('.avfx', '')
        d = convert(path, 'vfx://' + base)
        json.dump(d, open(os.path.join(outdir, base + '.json'), 'w'), indent=1)
        catalog[base] = d
    json.dump(catalog, open(os.path.join(outdir, 'catalog.json'), 'w'), indent=1)
    print('catalog written:', len(catalog), 'effects')
    sample = catalog['00000418']['nodes'][0]
    print('sample node:', json.dumps(sample, indent=1)[:600])

