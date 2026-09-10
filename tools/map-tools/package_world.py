"""Build a lossless, runtime-only world bundle without changing source releases."""
import argparse
import concurrent.futures
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import time
import uuid

from PIL import Image, features
from world_catalog import scene as catalog_scene

TOOLS = Path(__file__).resolve().parent
POLICY = {"version": 3, "textures": {"format": "WEBP", "lossless": True, "quality": 0, "method": 0, "exact": True, "selection": "bestAvailableLosslessCache+fastEncode", "onlyIfSmaller": True}, "collision": {"format": "gzip", "mtime": 0}}


def sha_bytes(value): return hashlib.sha256(value).hexdigest()
def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): digest.update(block)
    return digest.hexdigest()
def write_json(path, value):
    path = Path(path); temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"); os.replace(temporary, path)
def utc_now(): return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
def safe_child(root, relative):
    value = (Path(root) / relative).resolve()
    if not value.is_relative_to(Path(root).resolve()): raise ValueError(f"Path escaped bundle root: {relative}")
    return value
def copy_file(source, destination):
    destination = Path(destination); destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp-" + uuid.uuid4().hex)
    shutil.copyfile(source, temporary); os.replace(temporary, destination)


def discover(source):
    source = Path(source).resolve(); active_path = source / "active.json"
    if active_path.is_file():
        active = json.loads(active_path.read_text(encoding="utf-8")); result = {}
        for scene, record in active["scenes"].items(): result[scene] = (safe_child(source, record["base"]), record)
        return result
    return {item.name: (item, {}) for item in source.iterdir() if item.is_dir() and (item / "scene.json").is_file()}


def rgba_bytes(path):
    with Image.open(path) as image:
        rgba = image.convert("RGBA")
        return rgba.size, rgba.tobytes()


def encode_texture(source, cache, policy_sha):
    source = Path(source); source_sha = sha_file(source); meta_path = cache / f"{source_sha}.json"; webp_path = cache / f"{source_sha}.webp"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("sourceSha256") == source_sha:
            # A prior lossless result remains valid under a faster selection
            # policy when it is smaller and still exactly reconstructs RGBA.
            if meta.get("kind") == "webp" and webp_path.is_file() and meta.get("webpBytes", webp_path.stat().st_size) < source.stat().st_size:
                size, original = rgba_bytes(source); decoded_size, decoded = rgba_bytes(webp_path)
                if size == decoded_size and original == decoded:
                    return {**meta, "cacheHit": True, "path": webp_path, "selectedBy": "bestAvailableLosslessCache", "encoderPolicySha256": meta.get("encoderPolicySha256", meta.get("policySha256"))}
            if meta.get("kind") == "png" and meta.get("policySha256") == policy_sha:
                return {**meta, "cacheHit": True, "path": source, "selectedBy": "fastEncodePngFallback", "encoderPolicySha256": meta.get("encoderPolicySha256", policy_sha)}
    started = time.perf_counter(); size, original = rgba_bytes(source); encoded = io.BytesIO()
    with Image.open(source) as image: image.convert("RGBA").save(encoded, "WEBP", lossless=True, quality=POLICY["textures"]["quality"], method=POLICY["textures"]["method"], exact=True)
    webp = encoded.getvalue(); decoded_size, decoded = rgba_bytes(io.BytesIO(webp))
    exact = size == decoded_size and original == decoded
    if not exact: raise RuntimeError(f"{source}: lossless WebP RGBA roundtrip mismatch")
    meta = {"sourceSha256": source_sha, "policySha256": policy_sha, "encoderPolicySha256": policy_sha, "encoder": POLICY["textures"], "pngBytes": source.stat().st_size, "webpBytes": len(webp), "rgbaByteExact": True, "encodeMs": round((time.perf_counter() - started) * 1000, 2), "selectedBy": "fastEncode"}
    if len(webp) < source.stat().st_size:
        temporary = webp_path.with_name(webp_path.name + ".tmp-" + uuid.uuid4().hex); temporary.write_bytes(webp); os.replace(temporary, webp_path)
        meta["kind"] = "webp"; meta["path"] = webp_path
    else: meta["kind"] = "png"; meta["path"] = source
    write_json(meta_path, {key: value for key, value in meta.items() if key not in ("path", "cacheHit")}); meta["cacheHit"] = False
    return meta


def encode_task(task):
    source, cache, policy_sha = task
    return encode_texture(Path(source), Path(cache), policy_sha)


def replace_urls(value, mapping):
    if isinstance(value, str): return mapping.get(value, value)
    if isinstance(value, list): return [replace_urls(item, mapping) for item in value]
    if isinstance(value, dict): return {key: replace_urls(item, mapping) for key, item in value.items()}
    return value


def verify_scene(folder, expected_source_sha, policy_sha):
    folder = Path(folder); state_path = folder / "package-state.json"
    if not state_path.is_file(): return False
    state = json.loads(state_path.read_text(encoding="utf-8")); manifest_path = folder / "scene.json"
    if state.get("sourceManifestSha256") != expected_source_sha or state.get("policySha256") != policy_sha or not manifest_path.is_file(): return False
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")); map_path = folder / "map.png"
    if not map_path.is_file() or sha_file(manifest_path) != state.get("manifestSha256") or sha_file(map_path) != state.get("mapSha256"): return False
    if manifest.get("collisionFile") != "collision.bin.gz" or manifest.get("collisionEncoding") != "gzip": return False
    collision = folder / manifest["collisionFile"]
    if not collision.is_file(): return False
    raw = gzip.decompress(collision.read_bytes())
    if len(raw) != manifest.get("collisionBytes") or sha_bytes(raw) != manifest.get("collisionSha256"): return False
    for model in manifest.get("models", []):
        if not safe_child(folder, model["url"]).is_file() or sha_file(safe_child(folder, model["url"])) != state.get("modelSha256", {}).get(model["url"]): return False
    texture_hashes = state.get("textureSha256")
    if not isinstance(texture_hashes, dict) or state.get("textureVerifiedCount") != len(texture_hashes): return False
    for relative, record in texture_hashes.items():
        target = safe_child(folder, relative)
        if not target.is_file() or sha_file(target) != record.get("outputSha256"): return False
    for path in manifest.get("materials", {}).values():
        for key in ("map", "normalMap", "specularMap", "secondaryMap", "secondaryNormalMap"):
            if path.get(key) and not safe_child(folder, path[key]).is_file(): return False
        for sample in path.get("samplers", []):
            if sample.get("map") and not safe_child(folder, sample["map"]).is_file(): return False
    return (folder / "map.png").is_file() and (folder / "collision-report.json").is_file()


def package_scene(scene, source, destination, cache, policy_sha, workers):
    source_manifest = source / "scene.json"; source_sha = sha_file(source_manifest); target = destination / scene
    if verify_scene(target, source_sha, policy_sha): return {"scene": scene, "resumed": True, "sourceManifestSha256": source_sha}
    manifest = json.loads(source_manifest.read_text(encoding="utf-8")); target.mkdir(parents=True, exist_ok=True)
    textures = sorted((source / "textures").rglob("*.png"))
    by_hash = {}
    for texture in textures: by_hash.setdefault(sha_file(texture), []).append(texture)
    tasks = [(str(paths[0]), str(cache), policy_sha) for paths in by_hash.values()]
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
        decisions = list(pool.map(encode_task, tasks))
    mapping = {}; texture_hashes = {}; texture_stats = {"pngFiles": len(textures), "uniqueSourceFiles": len(by_hash), "rgbaByteExactFiles": len(textures), "webpFiles": 0, "pngBytes": 0, "bundleTextureBytes": 0, "cacheHits": 0, "rgbaByteExact": True, "encodeMs": 0}
    for paths, decision in zip(by_hash.values(), decisions):
        for texture in paths:
            relative = texture.relative_to(source).as_posix(); output = relative[:-4] + ".webp" if decision["kind"] == "webp" else relative
            mapping[relative] = output; copy_file(decision["path"], safe_child(target, output))
            source_hash, output_hash = sha_file(texture), sha_file(safe_child(target, output))
            if decision["kind"] == "png" and source_hash != output_hash: raise RuntimeError(f"{scene}: PNG copy hash mismatch: {relative}")
            if decision["kind"] == "webp" and output_hash != sha_file(decision["path"]): raise RuntimeError(f"{scene}: WebP copy hash mismatch: {relative}")
            texture_hashes[output] = {"sourcePngSha256": source_hash, "outputSha256": output_hash, "encoding": decision["kind"], "rgbaByteExact": True, "encoderPolicySha256": decision.get("encoderPolicySha256", decision.get("policySha256")), "selectedBy": decision.get("selectedBy", "fastEncode")}
            texture_stats["pngBytes"] += texture.stat().st_size; texture_stats["bundleTextureBytes"] += safe_child(target, output).stat().st_size
        texture_stats["webpFiles"] += len(paths) if decision["kind"] == "webp" else 0; texture_stats["cacheHits"] += int(decision["cacheHit"]); texture_stats["encodeMs"] += decision.get("encodeMs", 0)
    model_sha = {}
    for model in manifest.get("models", []):
        source_model, target_model = safe_child(source, model["url"]), safe_child(target, model["url"]); copy_file(source_model, target_model)
        model_sha[model["url"]] = sha_file(source_model)
        if sha_file(target_model) != model_sha[model["url"]]: raise RuntimeError(f"{scene}: GLB copy hash mismatch: {model['url']}")
    copy_file(source / "map.png", target / "map.png"); copy_file(source / "collision-report.json", target / "collision-report.json")
    if sha_file(source / "map.png") != sha_file(target / "map.png"): raise RuntimeError(f"{scene}: map PNG copy hash mismatch")
    raw_collision = (source / "collision.bin").read_bytes(); collision_sha = sha_bytes(raw_collision)
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as stream: stream.write(raw_collision)
    collision_path = target / "collision.bin.gz"; temporary = collision_path.with_name(collision_path.name + ".tmp-" + uuid.uuid4().hex); temporary.write_bytes(compressed.getvalue()); os.replace(temporary, collision_path)
    manifest = replace_urls(manifest, mapping); manifest.update({"collisionFile": "collision.bin.gz", "collisionEncoding": "gzip", "collisionSha256": collision_sha, "collisionBytes": len(raw_collision)})
    write_json(target / "scene.json", manifest); manifest_sha = sha_file(target / "scene.json")
    verification = {"sourceManifestSha256": source_sha, "manifestSha256": manifest_sha, "modelSha256": model_sha, "mapSha256": sha_file(target / "map.png"), "textureSha256": texture_hashes, "textureVerifiedCount": len(texture_hashes), "collisionRoundtripSha256": sha_bytes(gzip.decompress(collision_path.read_bytes())), "collisionCompressedBytes": collision_path.stat().st_size, "collisionSourceBytes": len(raw_collision), "textureStats": texture_stats}
    write_json(target / "package-report.json", verification); write_json(target / "package-state.json", {"status": "complete", "policy": POLICY, "policySha256": policy_sha, **verification})
    if not verify_scene(target, source_sha, policy_sha): raise RuntimeError(f"{scene}: packaged scene verification failed")
    return {"scene": scene, "resumed": False, **verification}


def main(args):
    if not features.check("webp"): raise RuntimeError("Pillow was built without WebP support")
    source = Path(args.source).resolve(); destination = Path(args.destination).resolve(); destination.mkdir(parents=True, exist_ok=True)
    policy_sha = sha_bytes(json.dumps(POLICY, sort_keys=True).encode()); cache = (Path(args.cache).resolve() if args.cache else TOOLS / "work/world-package-cache"); cache.mkdir(parents=True, exist_ok=True)
    available = discover(source); selected = args.scenes or list(available)
    missing = [scene for scene in selected if scene not in available]
    if missing: raise ValueError(f"Unknown source scenes: {', '.join(missing)}")
    report_path = destination / "package-report.json"; progress_path = (Path(args.progress).resolve() if args.progress else TOOLS / "work/world-package-progress.json")
    report = {"state": "running", "pid": os.getpid(), "source": str(source), "destination": str(destination), "cache": str(cache), "policy": POLICY, "policySha256": policy_sha, "scenes": {}}
    def save_progress(current=None, error=None):
        write_json(report_path, report)
        write_json(progress_path, {"runId": destination.name, "state": report["state"], "pid": os.getpid(), "source": str(source), "destination": str(destination), "report": str(report_path), "cache": str(cache), "workers": args.workers, "currentScene": current, "completedScenes": sorted(report["scenes"]), "totalScenes": len(selected), "error": error, "updatedAt": utc_now()})
    try:
        for scene in selected:
            save_progress(scene)
            report["scenes"][scene] = package_scene(scene, available[scene][0], destination, cache, policy_sha, args.workers); save_progress()
    except Exception as error:
        report["state"] = "failed"; save_progress(error=str(error)); raise
    public_root = Path(args.public_root).resolve() if args.public_root else destination.parent
    relative_base = destination.relative_to(public_root).as_posix()
    active = {"runId": destination.name, "packagedAt": utc_now(), "scenes": {}}; candidate = {**active, "scenes": {}}
    for scene in selected:
        manifest = json.loads((destination / scene / "scene.json").read_text(encoding="utf-8")); source_record = available[scene][1]
        try: catalog = catalog_scene(scene)
        except ValueError: catalog = {"name": manifest.get("name", scene), "en": manifest.get("en", scene), "region": manifest.get("region"), "territoryId": manifest.get("territoryId"), "kind": manifest.get("kind"), "expansion": manifest.get("expansion")}
        field = lambda key, fallback: source_record.get(key, manifest.get(key, fallback))
        record = {"clientVersion": manifest["sourceVersion"], "name": field("name", catalog["name"]), "fullSceneName": field("fullSceneName", catalog["name"]), "en": field("en", catalog["en"]), "region": field("region", catalog["region"]), "territoryId": field("territoryId", catalog["territoryId"]), "kind": field("kind", catalog["kind"]), "expansion": field("expansion", catalog["expansion"]), "manifestSha256": sha_file(destination / scene / "scene.json")}
        active["scenes"][scene] = {"base": f"{scene}/", **record}; candidate["scenes"][scene] = {"base": f"{relative_base}/{scene}/", **record}
    write_json(destination / "active.json", active); write_json(destination / "candidate-active.json", candidate); report["state"] = "complete"; report["candidateActive"] = str(destination / "candidate-active.json"); report["localActive"] = str(destination / "active.json"); save_progress()
    print(json.dumps({"state": report["state"], "scenes": len(selected), "report": str(report_path), "candidateActive": report["candidateActive"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--source", type=Path, required=True); parser.add_argument("--destination", type=Path, required=True); parser.add_argument("--public-root", type=Path); parser.add_argument("--cache", type=Path); parser.add_argument("--progress", type=Path); parser.add_argument("--scenes", nargs="+"); parser.add_argument("--workers", type=int, default=4)
    main(parser.parse_args())
