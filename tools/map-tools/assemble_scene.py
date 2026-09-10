"""Read exported map layouts and prepare a deduplicated local Three.js scene."""
import collections
import csv
import concurrent.futures
import io
import json
import math
from pathlib import Path
import re
import shutil
import struct
import sys

from PIL import Image
from world_catalog import aetheryte_visual, exported_path, map_root, metadata, scene as catalog_scene

ROOT = Path(__file__).resolve().parent
EXPORTS = ROOT / "exports"
DEST = ROOT / "assembled"

def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]

def string(data, offset):
    if offset <= 0 or offset >= len(data):
        return ""
    return data[offset:data.find(b"\0", offset)].decode("utf-8", errors="replace")

def layer(data, offset):
    ident, name, objects, count = struct.unpack_from("<IIII", data, offset)
    festival, phase = struct.unpack_from("<HH", data, offset + 24)
    result = {"id": ident, "name": string(data, offset + name), "festival": festival, "phase": phase, "objects": []}
    for i in range(count):
        pos = offset + objects + u32(data, offset + objects + i * 4)
        kind, instance, name_offset = struct.unpack_from("<III", data, pos)
        transform = struct.unpack_from("<9f", data, pos + 12)
        item = {"kind": kind, "id": instance, "name": string(data, pos + name_offset), "position": transform[:3], "rotation": transform[3:6], "scale": transform[6:9]}
        if kind in [1, 6]:
            item["asset"] = string(data, pos + u32(data, pos + 48))
        if kind == 1:
            item["collision"] = string(data, pos + u32(data, pos + 52))
            item["visible"] = data[pos + 72]
        if kind == 43:
            item["placeBlock"] = u32(data, pos + 64)
            item["placeSpot"] = u32(data, pos + 68)
        result["objects"].append(item)
    return result

def read_layout(path):
    data = path.read_bytes()
    if data[:4] == b"LGB1":
        count = u32(data, 32)
        return [layer(data, 36 + u32(data, 36 + i * 4)) for i in range(count)]
    if data[:4] == b"SGB1":
        group_offset, group_count = struct.unpack_from("<II", data, 20)
        layers = []
        for i in range(group_count):
            start = 20 + group_offset + i * 4
            _, _, offset, count = struct.unpack_from("<IIII", data, start)
            for j in range(count):
                layers.append(layer(data, start + offset + u32(data, start + offset + j * 4)))
        return layers
    raise ValueError(f"Unrecognized layout: {path}")

def identity():
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

def multiply(a, b):
    return [sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4)) for col in range(4) for row in range(4)]

def matrix(item):
    x,y,z = item["rotation"]
    a,b,c,d,e,f = math.cos(x),math.sin(x),math.cos(y),math.sin(y),math.cos(z),math.sin(z)
    # FFXIV/Lumina Euler XYZ; Three.js Matrix4 column-major representation.
    r=[c*e, a*f+b*e*d, b*f-a*e*d,0, -c*f, a*e-b*f*d,b*e+a*f*d,0, d,-b*c,a*c,0, *item["position"],1]
    for col,s in enumerate(item["scale"]):
        for row in range(3):r[col*4+row]*=s
    return r

def texture_png(path, destination):
    data = path.read_bytes()
    fmt = u32(data, 4)
    width,height,depth = struct.unpack_from("<HHH", data, 8)
    offset = u32(data, 28)
    if offset <= 0 or offset >= len(data):raise ValueError(f"Invalid TEX surface offset {offset}")
    pixels=data[offset:]
    raw_bytes={0x1130:1,0x1131:1,0x1132:1,0x1133:1,0x1240:2,0x1440:2,0x1441:2,0x1450:4,0x1451:4}
    if fmt in raw_bytes:
        required=width*height*raw_bytes[fmt]
        if len(pixels)<required:raise ValueError(f"Truncated TEX format {fmt:x}: {len(pixels)} < {required}")
        pixels=pixels[:required]
        if fmt==0x1130: # L8_UNORM
            image=Image.frombytes("L",(width,height),pixels).convert("RGBA")
        elif fmt==0x1131: # A8_UNORM
            alpha=Image.frombytes("L",(width,height),pixels)
            image=Image.merge("RGBA",(Image.new("L",alpha.size,255),)*3+(alpha,))
        elif fmt in (0x1132,0x1133): # R8_UNORM / R8_UINT
            red=Image.frombytes("L",(width,height),pixels)
            image=Image.merge("RGBA",(red,Image.new("L",red.size),Image.new("L",red.size),Image.new("L",red.size,255)))
        elif fmt==0x1240: # R8G8_UNORM
            image=Image.frombytes("LA",(width,height),pixels)
            red,green=image.split();image=Image.merge("RGBA",(red,green,Image.new("L",red.size),Image.new("L",red.size,255)))
        elif fmt==0x1450: # B8G8R8A8_UNORM
            image=Image.frombytes("RGBA",(width,height),pixels,"raw","BGRA")
        elif fmt==0x1451: # B8G8R8X8_UNORM
            image=Image.frombytes("RGBA",(width,height),pixels,"raw","BGRX")
        else:
            values=struct.unpack("<"+"H"*(width*height),pixels)
            if fmt==0x1440: # B4G4R4A4_UNORM
                rgba=bytes(channel for value in values for channel in (((value>>8)&15)*17,((value>>4)&15)*17,(value&15)*17,((value>>12)&15)*17))
            else: # B5G5R5A1_UNORM
                rgba=bytes(channel for value in values for channel in (((value>>10)&31)*255//31,((value>>5)&31)*255//31,(value&31)*255//31,255 if value&0x8000 else 0))
            image=Image.frombytes("RGBA",(width,height),rgba)
    else:
        code = {0x3420:b"DXT1",0x3430:b"DXT3",0x3431:b"DXT5",0x6432:b"DX10"}.get(fmt)
        if not code:raise ValueError(f"Unknown TEX format {fmt:x}")
        block_bytes=8 if code==b"DXT1" else 16
        required=max(1,(width+3)//4)*max(1,(height+3)//4)*block_bytes
        if len(pixels)<required:raise ValueError(f"Truncated TEX format {fmt:x}: {len(pixels)} < {required}")
        # Pillow's native DDS decoder supports BC1/2/3/7.
        header = [124,0x00081007,height,width,required,0,1] + [0]*11
        header += [32,4,int.from_bytes(code,"little"),0,0,0,0,0,0x1000,0,0,0,0]
        dds = b"DDS "+struct.pack("<31I",*header)
        if code==b"DX10":dds+=struct.pack("<5I",98,3,0,1,0)
        image=Image.open(io.BytesIO(dds+pixels[:required])).convert("RGBA")
    image.thumbnail((1024,1024))
    destination.parent.mkdir(parents=True,exist_ok=True)
    image.save(destination)
    return width,height

def material_record(path):
    data=path.read_bytes()
    _,_,dataset,string_size,shader_offset,nt,nu,nc,additional=struct.unpack_from("<I4H4B",data)
    cursor=16+(nt+nu+nc)*4
    strings=data[cursor:cursor+string_size]
    textures=[string(strings,struct.unpack_from("<H",data,16+i*4)[0]) if struct.unpack_from("<H",data,16+i*4)[0] else strings.split(b"\0")[0].decode() for i in range(nt)]
    shader=string(strings,shader_offset)
    sh=cursor+string_size+additional+dataset
    _,keys,constants,samplers,flags=struct.unpack_from("<HHHHI",data,sh)
    keys_offset=sh+12
    constants_offset=keys_offset+keys*8
    sample_offset=constants_offset+constants*8
    samples=[{"id":u32(data,sample_offset+i*12),"index":data[sample_offset+i*12+8]} for i in range(samplers)]
    by_usage={}
    for sample in samples:
        texture = textures[sample["index"]] if sample["index"] < len(textures) else None
        if sample["id"] in (0x1E6FEF9C, 0x6968DF0A):
            by_usage.setdefault("diffuse", []).append(texture)
        elif sample["id"] in (0xAAB4D9E9, 0xDDB3E97F):
            by_usage.setdefault("normal", []).append(texture)
        elif sample["id"] in (0x1BBC2F12, 0x6CBB1F84, 0x2B99E025):
            by_usage.setdefault("specular", []).append(texture)
        elif sample["id"] in (0xE6321AFC, 0xE5338C17, 0xF8D7957A, 0x95E1F64D):
            by_usage.setdefault("effect", []).append(texture)
    diffuse=next(iter(by_usage.get("diffuse", [])),None)
    if not diffuse:
        diffuse=next((t for t in textures if re.search(r"_(?:d|base|diffuse)\.tex$",t)),None)
    values={}
    key_values={str(u32(data,keys_offset+i*8)):u32(data,keys_offset+i*8+4) for i in range(keys)}
    constants_start=constants_offset
    values_offset=sample_offset+samplers*12
    for i in range(constants):
        ident,off,num=struct.unpack_from("<IHH",data,constants_start+i*8)
        values[ident]=list(struct.unpack_from("<"+str(num//4)+"f",data,values_offset+off))
    return {
        "shader":shader,"textures":textures,"diffuse":diffuse,
        "normal":next(iter(by_usage.get("normal", [])),None),
        "specular":next(iter(by_usage.get("specular", [])),None),
        "effectTextures":by_usage.get("effect",[]),
        "flags":flags,"samplers":samples,
        "keys":key_values,
        "colorMap1":next((textures[s["index"]] for s in samples if s["id"]==0x6968DF0A and s["index"]<len(textures)),None),
        "normalMap1Path":next((textures[s["index"]] for s in samples if s["id"]==0xDDB3E97F and s["index"]<len(textures)),None),
        "multiDiffuseColor":values.get(0x3F8AC211,[1,1,1]),
        "alphaMultiParam":values.get(0x07EDA444,[0,0,0,0]),
        "diffuseColor":values.get(0x2C2A34DD,[1,1,1]),
        "emissiveColor":values.get(0x38A64362,[0,0,0]),
        "colorUVScale":values.get(0xA5D02C52,[1,1,1,1]),
        "normalUVScale":values.get(0xBB99CF76,[1,1,1,1]),
        "specularUVScale":values.get(0x8D03A782,[1,1,1,1]),
        "normalScale":values.get(0xB5545FBB,[1])[0],
        "alphaThreshold":values.get(0x29AC0223,[0])[0],
    }

def assemble(scene, destination=DEST, exports=EXPORTS):
    source=Path(exports)/scene
    target=Path(destination)/scene
    target.mkdir(parents=True,exist_ok=True)
    catalog=catalog_scene(scene)
    manifest=json.loads((source/"manifest.json").read_text())
    root=map_root(exports,scene)
    bg=root/"level/bg.lgb"
    if not bg.is_file():raise FileNotFoundError(f"{scene}: catalog bg layout was not exported: {bg}")
    layers=read_layout(bg)
    (ROOT/f"{scene}-layers.json").write_text(json.dumps([{k:v for k,v in l.items() if k!="objects"}|{"count":len(l["objects"])} for l in layers],ensure_ascii=False,indent=2),encoding="utf-8")
    groups=collections.defaultdict(list)
    errors=[];limitations=[];shared_cache={}; layer_stats=[]
    def expand(item,parent,chain=()):
        asset=item.get("asset","")
        transform=multiply(parent,matrix(item))
        if item["kind"]==1 and asset.endswith(".mdl"):
            groups[asset].append(transform)
        elif item["kind"]==6 and asset.endswith(".sgb") and asset not in chain:
            try:
                if asset not in shared_cache:shared_cache[asset]=read_layout(source/asset)
                for child_layer in shared_cache[asset]:
                    for child in child_layer["objects"]:expand(child,transform,(*chain,asset))
            except Exception as error:
                errors.append({"path":asset,"error":str(error)})
    for entry in layers:
        # Conditional festival/temporary assets are not all simultaneously active.
        include=entry["festival"]==0 and not re.search(r"(?:festival|season|event|halloween|christmas)",entry["name"],re.I)
        layer_stats.append({"name":entry["name"],"count":len(entry["objects"]),"festival":entry["festival"],"included":include})
        if include:
            for item in entry["objects"]:expand(item,identity())
    for item in manifest["layouts"]:
        if item["type"]=="TerrainPlate":
            t=identity();p=item["translation"];t[12:15]=[p["X"],p["Y"],p["Z"]];groups[item["model"]].append(t)
    # Aetherytes are absent in many overworld maps. When present, include the
    # shared visual; safe placement is finalized from collision after baking.
    main_aetheryte=next((item for item in manifest["layouts"] if item["type"]=="Aetheryte"),None)
    visual=aetheryte_visual(source)
    if main_aetheryte and visual:
        expand({"kind":6,"asset":visual,
                "position":[main_aetheryte["translation"][k] for k in ["X","Y","Z"]],
                "rotation":[0,0,0],"scale":[1,1,1]},identity())
    elif main_aetheryte:
        limitations.append("Aetheryte layout has no uniquely exported visual shared group; no generic crystal was injected.")
    # Avoid duplicate placements that appear in multiple layout layers.
    for key,values in groups.items():
        seen=set();unique=[]
        for m in values:
            token=tuple(round(v,4) for v in m)
            if token not in seen:seen.add(token);unique.append(m)
        groups[key]=unique
    models=[];materials={};tex_needed=set()
    for i,(asset,transforms) in enumerate(sorted(groups.items())):
        path=source/(asset+".glb")
        if not path.exists():errors.append({"path":asset,"error":"Missing model GLB"});continue
        name=f"models/{i:04d}.glb";(target/"models").mkdir(exist_ok=True);shutil.copyfile(path,target/name)
        b=path.read_bytes();j=json.loads(b[20:20+u32(b,12)])
        for node in j["nodes"]:
            mat=node.get("extras",{}).get("materialPath")
            if mat and mat not in materials:
                try:
                    record=material_record(source/mat)
                    materials[mat]=record
                    for texture in record["textures"]:
                        if texture:tex_needed.add(texture)
                except Exception as error:errors.append({"path":mat,"error":str(error)})
        models.append({"asset":asset,"url":name,"matrices":transforms})
    texture_map={}
    def convert(pair):
        i,asset=pair;name=f"textures/{i:04d}.png"
        try: texture_png(source/asset,target/name);return asset,name,None
        except Exception as error:return asset,None,str(error)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for asset,name,error in pool.map(convert,enumerate(sorted(tex_needed))):
            if error:errors.append({"path":asset,"error":error})
            else:texture_map[asset]=name
    for record in materials.values():
        record["map"]=texture_map.get(record["diffuse"])
        record["normalMap"]=texture_map.get(record["normal"])
        record["specularMap"]=texture_map.get(record["specular"])
        record["secondaryMap"]=texture_map.get(record["colorMap1"])
        record["secondaryNormalMap"]=texture_map.get(record["normalMap1Path"])
        for sample in record["samplers"]:
            sample["path"]=record["textures"][sample["index"]] if sample["index"] < len(record["textures"]) else None
            sample["map"]=texture_map.get(sample["path"])
    map_texture=exported_path(exports,scene,catalog["mapTexture"])
    if not map_texture.is_file():raise FileNotFoundError(f"{scene}: catalog map texture was not exported: {catalog['mapTexture']}")
    texture_png(map_texture,target/"map.png")
    aetheryte=([main_aetheryte["translation"][k] for k in ["X","Y","Z"]] if main_aetheryte else None)
    place_file=ROOT/"data/PlaceName-7.0.csv"
    if not place_file.exists():place_file=ROOT/"research/PlaceName-7.0.csv"
    names={}
    if place_file.exists():
        with place_file.open(encoding="utf-8-sig") as stream:
            rows=list(csv.reader(stream))
        names={int(row[0]):row[1] for row in rows[3:] if row[0].isdigit()}
    landmarks=[];seen_places=set()
    plan=root/"level/planmap.lgb"
    if plan.is_file():
        for entry in read_layout(plan):
            for item in entry["objects"]:
                if item["kind"]!=43:continue
                place=item["placeSpot"] or item["placeBlock"]
                if not place or place in seen_places:continue
                seen_places.add(place)
                x,y,z=item["position"]
                landmarks.append({"id":str(place),"name":names.get(place,str(place)),"x":x,"y":y,"z":z,"type":"landmark"})
    report={"sourceVersion":manifest["gameVersion"],"scene":scene,**metadata(scene),"mapTexture":catalog["mapTexture"],"aetheryte":aetheryte,"spawn":aetheryte,"connections":[],"models":models,"materials":materials,"layers":layer_stats,"errors":errors,"limitations":[*manifest.get("limitations",[]),*limitations],"source":"Local installed client, read-only SqPack export","sharedGroups":len(shared_cache),"landmarks":landmarks}
    (target/"scene.json").write_text(json.dumps(report,separators=(",",":")),encoding="utf-8")
    print(json.dumps({"scene":scene,"models":len(models),"instances":sum(len(m["matrices"]) for m in models),"textures":len(texture_map),"materials":len(materials),"sharedGroups":len(shared_cache),"errors":len(errors),"examples":errors[:5]}),flush=True)
    if errors: raise RuntimeError(f"{scene}: {len(errors)} assembly errors; see scene.json")

if __name__=="__main__":
    requested=[arg for arg in sys.argv[1:] if not arg.startswith("--")]
    destination=Path(next((arg.split("=",1)[1] for arg in sys.argv[1:] if arg.startswith("--destination=")), DEST))
    exports=Path(next((arg.split("=",1)[1] for arg in sys.argv[1:] if arg.startswith("--exports=")), EXPORTS))
    for scene in requested:assemble(scene,destination,exports)
