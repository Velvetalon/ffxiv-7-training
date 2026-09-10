#!/usr/bin/env python3
"""Build a non-destructive 128px WebP texture-preview tier for a packed release."""
from __future__ import annotations
import argparse, gzip, hashlib, json, os, shutil, threading
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from PIL import Image

MAGIC=b'AETHPAK1'; LIMIT=2*1024*1024
def h(b): return hashlib.sha256(b).hexdigest()
def jf(p): return json.loads(Path(p).read_text(encoding='utf-8'))
def wj(p,x):
 p=Path(p); p.parent.mkdir(parents=True,exist_ok=True); tmp=p.with_name(f'{p.name}.tmp-{os.getpid()}')
 tmp.write_text(json.dumps(x,separators=(',',':'),ensure_ascii=False)+'\n',encoding='utf-8'); os.replace(tmp,p)
def align(n): return (n+7)&~7
def link(src,dst):
 dst.parent.mkdir(parents=True,exist_ok=True)
 try: os.link(src,dst)
 except OSError: shutil.copy2(src,dst)
def render_preview(path,cached):
 with Image.open(path) as im:
  im.load(); dimensions=[im.width,im.height]
  if max(dimensions)<=128:
   data=Path(path).read_bytes(); mime=Image.MIME.get(im.format, 'application/octet-stream')
  else:
   im.thumbnail((128,128),Image.Resampling.LANCZOS); b=BytesIO(); im.save(b,format='WEBP',lossless=True,method=6); data=b.getvalue(); mime='image/webp'
 tmp=cached.with_name(f'{cached.name}.tmp-{os.getpid()}-{threading.get_ident()}'); tmp.write_bytes(data); os.replace(tmp,cached)
 return dimensions,h(data),len(data),mime
def makepack(out,entries):
 parts=[MAGIC]; pos=8; loc={}
 for rid,source in entries:
  data=source.read_bytes()
  parts.append(b'\0'*(align(pos)-pos)); pos=align(pos); loc[rid]=(pos,len(data)); parts.append(data); pos+=len(data)
 raw=b''.join(parts); digest=h(raw); rel=f'preview-packs/{digest}.aethpak'; p=out/rel; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(raw)
 return f'pack:sha256:{digest}',{'url':rel,'size':len(raw),'hash':digest,'group':'preview','resourceCount':len(entries),'oversize':len(raw)>LIMIT},loc
def texture_sources(analysis_path,wanted):
 """Read only wanted texture records; shard files are processed one at a time."""
 root=Path(analysis_path).resolve(); index=jf(root); found={}
 if index.get('format')=='asset-reference-shards-v1':
  for relative in index.get('resourceShards',[]):
   shard=jf(root.parent/relative)
   for rid,record in shard.items():
    if rid in wanted and record.get('type')=='texture': found[rid]=(record.get('sources') or [None])[0]
 else:
  for rid in wanted:
   record=(index.get('resources') or {}).get(rid)
   if record and record.get('type')=='texture': found[rid]=(record.get('sources') or [None])[0]
 return found
def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--dir',required=True); ap.add_argument('--analysis',required=True); ap.add_argument('--out',required=True); ap.add_argument('--cache',default='work/asset-performance/preview-cache'); ap.add_argument('--resume',action='store_true'); ap.add_argument('--workers',type=int,default=2); a=ap.parse_args()
 if a.workers not in (1,2): raise SystemExit('--workers must be 1 or 2 to bound decoded RGBA residency')
 src=Path(a.dir).resolve(); out=Path(a.out).resolve()
 if out.exists() and not a.resume: raise SystemExit(f'output exists: {out}')
 out.mkdir(parents=True,exist_ok=True); cache=Path(a.cache).resolve(); cache.mkdir(parents=True,exist_ok=True); old=jf(src/'publish-manifest.json'); catalog=jf(src/old['entry'])
 for f in src.rglob('*'):
  if f.is_file() and f.name!='publish-manifest.json' and not (out/f.relative_to(src)).exists(): link(f,out/f.relative_to(src))
 uses=defaultdict(set); full={}; dims={}; pid={}; preview_file={}; preview_size={}; preview_mime={}; skipped=0
 for mid,item in catalog['maps'].items():
  doc=jf(src/item['manifest'])
  for rid,r in list(doc['resources'].items()):
   if r.get('type')=='texture': uses[rid].add(mid); full[rid]=r['hash']
 sources=texture_sources(a.analysis,set(uses)); cache_index=cache/'index.json'; cache_meta=jf(cache_index) if cache_index.exists() else {}
 todo=[]
 for position,rid in enumerate(uses,1):
  path=sources.get(rid)
  if not path: raise SystemExit(f'missing source {rid}')
  cached=cache/f'{full[rid]}.webp'; cached_meta=cache_meta.get(full[rid])
  if cached.exists() and cached_meta:
   dims[rid]=cached_meta['dimensions']
   if cached_meta.get('previewHash'):
     digest=cached_meta['previewHash']; pid[rid]=f'texture-preview:sha256:{digest}'; preview_file[pid[rid]]=cached; preview_size[pid[rid]]=cached.stat().st_size; preview_mime[pid[rid]]=cached_meta.get('previewMime','image/webp')
   else: skipped+=1
   if position%100==0: wj(cache_index,cache_meta)
   continue
  todo.append((position,rid,path,cached))
 completed=0
 with ThreadPoolExecutor(max_workers=a.workers) as executor:
  rendered=executor.map(lambda item:(item[0],item[1],item[3],*render_preview(item[2],item[3])),todo)
  for position,rid,cached,dimensions,digest,size,mime in rendered:
   dims[rid]=dimensions; cache_meta[full[rid]]={'dimensions':dimensions,'previewHash':digest,'previewMime':mime}
   if digest:
    q=f'texture-preview:sha256:{digest}'; pid[rid]=q; preview_file[q]=cached; preview_size[q]=size; preview_mime[q]=mime
   else: skipped+=1
   completed+=1
   if completed%100==0: wj(cache_index,cache_meta)
 wj(cache_index,cache_meta)
 pack_count=0
 active_urls=set()
 for mid,item in catalog['maps'].items():
  doc=jf(src/item['manifest'])
  preview_ids=sorted({pid[r] for r in uses if mid in uses[r] and r in pid}); entries=[(q,preview_file[q]) for q in preview_ids]; bundles={}; places={}; batch=[]; size=8
  def flush():
   nonlocal batch,size,pack_count
   if batch:
    bid,bundle,loc=makepack(out,batch); bundles[bid]=bundle; places.update({k:(bid,*v) for k,v in loc.items()}); pack_count+=1
   batch=[]; size=8
  for x in entries:
   if batch and align(size)+preview_size[x[0]]>LIMIT: flush()
   batch.append(x); size=align(size)+preview_size[x[0]]
  flush(); doc['bundles'].update(bundles)
  for rid,r in list(doc['resources'].items()):
   if rid in pid:
    q=pid[rid]; bid,off,length=places[q]; r.setdefault('metadata',{})['preview']=q
    doc['resources'][q]={'type':'texture','hash':q.rsplit(':',1)[1],'size':length,'dependencies':[],'virtual':False,'metadata':{'mime':preview_mime[q]},'bundle':bid,'offset':off,'length':length}
  gz=gzip.compress((json.dumps(doc,separators=(',',':'),ensure_ascii=False)+'\n').encode(),mtime=0); digest=h(gz); rel=f'maps/{mid}/manifest_{digest}.json.gz'; (out/rel).write_bytes(gz); catalog['maps'][mid]['manifest']=rel
  active_urls.update(bundle['url'] for bundle in doc['bundles'].values())
 craw=(json.dumps(catalog,separators=(',',':'),ensure_ascii=False)+'\n').encode(); entry=f'catalog_{h(craw)}.json'; (out/entry).write_bytes(craw)
 active={entry}
 for item in catalog['maps'].values():
  active.add(item['manifest'])
 active.update(active_urls)
 files=[]
 for rel in sorted(active):
  f=out/rel; data=f.read_bytes(); item={'path':rel,'size':len(data),'hash':h(data),'contentType':'application/octet-stream'}
  if rel.endswith('.json'): item['contentType']='application/json; charset=utf-8'
  if rel.endswith('.json.gz'): item.update(contentType='application/json; charset=utf-8',contentEncoding='gzip')
  if rel.endswith('.webp'): item['contentType']='image/webp'
  files.append(item)
 wj(out/'publish-manifest.json',{'schemaVersion':1,'releaseId':old['releaseId']+'-preview128','files':files,'entry':entry})
 wj(out/'preview-stats.json',{'schemaVersion':1,'textures':len(uses),'previews':len(pid),'skippedAtOrBelow128':skipped,'previewPackCount':pack_count,'previewBytes':sum(preview_size.values()),'dimensions':dims,'fullHashesUnchanged':full,'entry':entry})
 print(json.dumps({'out':str(out),'previews':len(pid),'previewBytes':sum(preview_size.values()),'packs':pack_count,'entry':entry}))
if __name__=='__main__': main()
