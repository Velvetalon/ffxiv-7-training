"""Decode original PCB collision triangles and bake source instance transforms."""
import array
import collections
import json
import math
from pathlib import Path
import statistics
import struct
import sys

from assemble_scene import read_layout, matrix, multiply, identity
from world_catalog import map_root

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

def grounded_seed(triangles):
    """Choose an actual broad, upward-facing collision triangle, never origin."""
    cells={}
    for offset in range(0,len(triangles),9):
        ax,ay,az,bx,by,bz,cx,cy,cz=triangles[offset:offset+9]
        ux,uy,uz=bx-ax,by-ay,bz-az;vx,vy,vz=cx-ax,cy-ay,cz-az
        nx,ny,nz=uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx
        length=math.sqrt(nx*nx+ny*ny+nz*nz)
        if length==0 or abs(ny)/length < .82:continue
        area=length*.5
        if area < .25:continue
        point=((ax+bx+cx)/3,(ay+by+cy)/3,(az+bz+cz)/3)
        key=(round(point[0]/12),round(point[2]/12))
        score=area*(abs(ny)/length)**2
        total,best,best_point=cells.get(key,(0,0,None))
        cells[key]=(total+score,max(best,score),point if score>best else best_point)
    if not cells:raise RuntimeError("No broad upward-facing collision surface for spawn")
    _,(_,_,point)=max(cells.items(),key=lambda item:(item[1][0],item[1][1]))
    return [round(value,4) for value in point]

def build(scene, destination=DEST, exports=ROOT/"exports"):
    root=Path(exports)/scene
    catalog_root=map_root(exports,scene)
    triangles=array.array("f");failures=[];terrain_count=0
    def append(mesh,m):
        for face in mesh:
            for vertex in face:triangles.extend(transform(vertex,m))
    for path in (catalog_root/"collision").glob("tr*.pcb"):
        try: append(pcb_triangles(path),identity());terrain_count+=1
        except Exception as e:failures.append({"file":str(path),"error":str(e)})
    groups=collections.defaultdict(list);cache={};seen=set()
    fallback_points=[]
    def expand(item,parent,chain=()):
        m=multiply(parent,matrix(item));asset=item.get("asset","")
        translation=item.get("translation")
        if isinstance(translation,dict):
            fallback_points.append((translation.get("X",0),translation.get("Y",0),translation.get("Z",0)))
        if item["kind"]==1 and item.get("collision"):
            key=(item["collision"],tuple(round(x,4) for x in m))
            if key not in seen:groups[item["collision"]].append(m);seen.add(key)
        elif item["kind"]==6 and asset not in chain and asset.endswith(".sgb"):
            try:
                if asset not in cache:cache[asset]=read_layout(root/asset)
                for layer in cache[asset]:
                    for child in layer["objects"]:expand(child,m,(*chain,asset))
            except Exception as e:failures.append({"file":asset,"error":str(e)})
    bg=catalog_root/"level/bg.lgb"
    if not bg.is_file():raise FileNotFoundError(f"{scene}: catalog bg layout was not exported: {bg}")
    for layer in read_layout(bg):
        if layer["festival"]:continue
        for item in layer["objects"]:expand(item,identity())
    for asset,instances in groups.items():
        try:
            mesh=pcb_triangles(root/asset)
            for m in instances:append(mesh,m)
        except Exception as e:failures.append({"file":asset,"error":str(e)})
    source_triangle_count=len(triangles)//9
    collision_fallback=None
    if source_triangle_count==0:
        # Some event/interior territories intentionally have no PCB collision.
        # Keep them renderable with a clearly marked navigation plane; this is
        # not presented as source collision data.
        center=[statistics.median(point[axis] for point in fallback_points) if fallback_points else 0 for axis in range(3)]
        radius=max(200.0, *(max(abs(point[axis]) for point in fallback_points)+100 for axis in (0,2) if fallback_points))
        x,y,z=center; a=(-radius+x,y,-radius+z);b=(radius+x,y,-radius+z);c=(radius+x,y,radius+z);d=(-radius+x,y,radius+z)
        triangles.extend((*a,*b,*c,*a,*c,*d))
        collision_fallback={"kind":"ground-plane","source":"layout translation median","center":[round(value,4) for value in center],"radius":radius,"sourceTriangles":0}
    destination=Path(destination)/scene/"collision.bin"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as f:triangles.tofile(f)
    scene_path=destination.with_name("scene.json")
    scene_data=json.loads(scene_path.read_text(encoding="utf-8"))
    if scene_data.get("aetheryte"):
        scene_data["spawn"]=scene_data["aetheryte"]
        scene_data["spawnSource"]={"kind":"aetheryte-layout"}
    else:
        scene_data["spawn"]=grounded_seed(triangles)
        scene_data["spawnSource"]={"kind":"collision-flat-surface" if not collision_fallback else "fallback-ground-plane","triangleCount":len(triangles)//9}
    if collision_fallback:scene_data["collisionFallback"]=collision_fallback
    scene_path.write_text(json.dumps(scene_data,separators=(",",":")),encoding="utf-8")
    report={"scene":scene,"terrainChunks":terrain_count,"instancedCollisionModels":len(groups),"sourceTriangles":source_triangle_count,"collisionFallback":collision_fallback,"triangles":len(triangles)//9,"bytes":len(triangles)*4,"spawn":scene_data["spawn"],"errors":failures}
    destination.with_name("collision-report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps(report),flush=True)
    if failures: raise RuntimeError(f"{scene}: collision conversion failed; see collision-report.json")

if __name__=="__main__":
    requested=[arg for arg in sys.argv[1:] if not arg.startswith("--")]
    output=Path(next((arg.split("=",1)[1] for arg in sys.argv[1:] if arg.startswith("--destination=")), DEST))
    exports=Path(next((arg.split("=",1)[1] for arg in sys.argv[1:] if arg.startswith("--exports=")), ROOT/"exports"))
    for scene in requested:build(scene,output,exports)
