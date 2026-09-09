"""Decode original PCB collision triangles and bake source instance transforms."""
import array
import collections
import json
import math
from pathlib import Path
import struct
import sys

from assemble_scene import read_layout, matrix, multiply, identity

ROOT = Path(__file__).resolve().parent
DEST = ROOT / "assembled"

def pcb_triangles(path):
    data=path.read_bytes()
    if struct.unpack_from("<I",data)[0]!=0:raise ValueError("Not a mesh PCB")
    result=[]
    visited=set()
    def node(offset):
        if offset in visited:return
        visited.add(offset)
        _,_,child1,child2,*bounds=struct.unpack_from("<IIii6f",data,offset)
        compressed,polys,full=struct.unpack_from("<HHH",data,offset+40)
        cursor=offset+48
        vertices=[struct.unpack_from("<3f",data,cursor+i*12) for i in range(full)];cursor+=full*12
        for i in range(compressed):
            v=struct.unpack_from("<3H",data,cursor+i*6)
            vertices.append(tuple(bounds[c]+v[c]/65535*(bounds[c+3]-bounds[c]) for c in range(3)))
        cursor+=compressed*6
        for i in range(polys):
            a,b,c=struct.unpack_from("<3B",data,cursor+i*12)
            result.append((vertices[a],vertices[b],vertices[c]))
        if child1:node(offset+child1)
        if child2:node(offset+child2)
    node(16)
    return result

def transform(v,m):
    x,y,z=v
    return (m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14])

def build(scene, destination=DEST, exports=ROOT/"exports"):
    root=Path(exports)/scene
    triangles=array.array("f");failures=[];terrain_count=0
    def append(mesh,m):
        for face in mesh:
            for vertex in face:triangles.extend(transform(vertex,m))
    for path in root.glob("bg/ffxiv/*/twn/*/collision/tr*.pcb"):
        try: append(pcb_triangles(path),identity());terrain_count+=1
        except Exception as e:failures.append({"file":str(path),"error":str(e)})
    groups=collections.defaultdict(list);cache={};seen=set()
    def expand(item,parent,chain=()):
        m=multiply(parent,matrix(item));asset=item.get("asset","")
        if item["kind"]==1 and item.get("collision"):
            key=(item["collision"],tuple(round(x,4) for x in m))
            if key not in seen:groups[item["collision"]].append(m);seen.add(key)
        elif item["kind"]==6 and asset not in chain and asset.endswith(".sgb"):
            try:
                if asset not in cache:cache[asset]=read_layout(root/asset)
                for layer in cache[asset]:
                    for child in layer["objects"]:expand(child,m,(*chain,asset))
            except Exception as e:failures.append({"file":asset,"error":str(e)})
    for layer in read_layout(next(root.glob("bg/ffxiv/*/twn/*/level/bg.lgb"))):
        if layer["festival"]:continue
        for item in layer["objects"]:expand(item,identity())
    for asset,instances in groups.items():
        try:
            mesh=pcb_triangles(root/asset)
            for m in instances:append(mesh,m)
        except Exception as e:failures.append({"file":asset,"error":str(e)})
    destination=Path(destination)/scene/"collision.bin"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as f:triangles.tofile(f)
    report={"scene":scene,"terrainChunks":terrain_count,"instancedCollisionModels":len(groups),"triangles":len(triangles)//9,"bytes":len(triangles)*4,"errors":failures}
    destination.with_name("collision-report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps(report),flush=True)
    if failures: raise RuntimeError(f"{scene}: collision conversion failed; see collision-report.json")

if __name__=="__main__":
    requested=[arg for arg in sys.argv[1:] if not arg.startswith("--")]
    output=Path(next((arg.split("=",1)[1] for arg in sys.argv[1:] if arg.startswith("--destination=")), DEST))
    exports=Path(next((arg.split("=",1)[1] for arg in sys.argv[1:] if arg.startswith("--exports=")), ROOT/"exports"))
    for scene in requested or ["gridania","limsa"]:build(scene,output,exports)
