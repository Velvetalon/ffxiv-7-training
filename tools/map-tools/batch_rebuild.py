"""Transactional local map rebuild. Never modifies client files or deletes prior releases."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid
from world_catalog import scene as catalog_scene, scene_ids

TOOLS = Path(__file__).resolve().parent
SCENES = scene_ids()
MIN_NODE_MAJOR = 20
MIN_DOTNET_MAJOR = 10

def command_version(command, argument):
    try:
        result = subprocess.run([str(command), argument], capture_output=True, text=True, timeout=15)
    except OSError:
        return ""
    return (result.stdout or result.stderr).strip()

def resolve_node(explicit):
    candidates = [explicit] if explicit else [
        Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe",
        shutil.which("node"),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        candidate = Path(candidate).resolve()
        if not candidate.is_file():
            continue
        match = re.search(r"v?(\d+)", command_version(candidate, "--version"))
        if match and int(match.group(1)) >= MIN_NODE_MAJOR:
            return candidate
    origin = "--node" if explicit else "the Codex runtime or PATH"
    raise RuntimeError(f"Node {MIN_NODE_MAJOR}+ is required; no suitable executable found via {origin}.")

def resolve_dotnet():
    candidates = [TOOLS / "dotnet/dotnet.exe", shutil.which("dotnet")]
    for candidate in candidates:
        if not candidate:
            continue
        candidate = Path(candidate).resolve()
        if not candidate.is_file():
            continue
        versions = command_version(candidate, "--list-sdks")
        if any(int(match.group(1)) >= MIN_DOTNET_MAJOR for match in re.finditer(r"(?m)^\s*(\d+)\.\d+\.\d+\s+\[", versions)):
            return candidate
    raise RuntimeError(f".NET SDK {MIN_DOTNET_MAJOR}+ is required; add dotnet/dotnet.exe or install it on PATH.")

def write_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)

def tree_bytes(path):
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file()) if path.is_dir() else 0

def estimate_disk(args):
    output=args.output.resolve();project=args.project.resolve();release_root=project/"public/extracted/releases"
    raw={scene:tree_bytes(output/scene) for scene in SCENES if (output/scene).is_dir()}
    released={}
    if release_root.is_dir():
        for release in release_root.iterdir():
            for scene in SCENES:
                value=tree_bytes(release/scene)
                if value:released[scene]=max(released.get(scene,0),value)
    observed=max([*raw.values(),*released.values()],default=0)
    if not observed:raise RuntimeError("Disk estimate requires at least one converted catalog map.")
    # Existing maps show exact local conversion size; 25% headroom covers zones
    # larger than the observed first pair and the concurrent raw + release copy.
    per_scene=int(observed*1.25)
    required=per_scene*len(SCENES)*2
    drive=project.anchor or output.anchor
    free=shutil.disk_usage(drive).free
    report={"scenes":len(SCENES),"observedScenes":sorted(set(raw)|set(released)),"largestObservedBytes":observed,
            "perSceneWithHeadroomBytes":per_scene,"estimatedAdditionalBytes":required,"freeBytes":free,"sufficient":free>=required}
    print(json.dumps(report),flush=True)
    if free<required:raise RuntimeError("Insufficient free disk for conservative full-catalog estimate.")

@contextmanager
def pipeline_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.tell() == 0: stream.write(b"0"); stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            try: msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError: raise RuntimeError("Another map rebuild is already running.")
        try: yield
        finally:
            if os.name == "nt":
                stream.seek(0); msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)

def run_batch(args):
    project = args.project.resolve()
    client_arg = args.client or (Path(os.environ["FFXIV_CLIENT"]) if os.environ.get("FFXIV_CLIENT") else None)
    if not client_arg:
        raise RuntimeError("A client path is required. Pass --client or set FFXIV_CLIENT.")
    client = client_arg.resolve()
    if client.name.lower() == "game": client = client.parent
    version_path = client / "game/ffxivgame.ver"
    if not (client / "game/sqpack").is_dir(): raise RuntimeError("Client game/sqpack does not exist.")
    version = version_path.read_text().strip()
    output = args.output.resolve()
    public = project / "public/extracted"
    public.mkdir(parents=True, exist_ok=True)
    run_id = args.resume_run or (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6])
    # The unique release directory is not live until active.json points to it.
    # Never rename a populated watched directory on Windows; Vite can hold it open.
    stage = public / "releases" / run_id
    if args.resume_run and not stage.is_dir():raise RuntimeError(f"No resumable release stage: {stage}")
    stage.mkdir(parents=True,exist_ok=True)
    logs = TOOLS / "logs" / run_id
    if args.resume_run and not logs.is_dir():raise RuntimeError(f"No resumable log directory: {logs}")
    logs.mkdir(parents=True,exist_ok=True)
    env = os.environ.copy()
    env.update({"DOTNET_CLI_HOME": str(TOOLS / ".dotnet-home"), "NUGET_PACKAGES": str(TOOLS / "nuget"),
                "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false"})
    dotnet = resolve_dotnet()
    node = resolve_node(args.node)
    report_path = logs / "report.json"
    report=json.loads(report_path.read_text(encoding="utf-8")) if args.resume_run and report_path.exists() else {"runId": run_id,"clientVersion": version,"client": str(client),"project": str(project),"scenes": args.scenes,"state":"running","steps":[],"stage":str(stage),"toolchain":{"dotnet":str(dotnet),"node":str(node)}}
    if report["scenes"] != args.scenes or report["clientVersion"] != version:raise RuntimeError("Resume run does not match selected scenes or installed client version.")
    report.update({"state":"running","error":None,"published":False,"running":[]})
    progress_path=TOOLS/"work/overworld-conversion-progress.json";progress_path.parent.mkdir(parents=True,exist_ok=True)
    def save():
        write_json(report_path,report)
        write_json(progress_path,{"runId":run_id,"state":report["state"],"stage":str(stage),"report":str(report_path),"scenes":args.scenes,"completedScenes":sorted(report.get("results",{})),"running":report.get("running",[]),"updatedAt":datetime.now(timezone.utc).isoformat()})
    def complete(scene):
        scene_path=stage/scene/"scene.json";collision=stage/scene/"collision.bin";collision_report=stage/scene/"collision-report.json"
        if not (scene_path.is_file() and collision.is_file() and collision_report.is_file()):return False
        data=json.loads(scene_path.read_text(encoding="utf-8"));report_data=json.loads(collision_report.read_text(encoding="utf-8"))
        return data.get("scene")==scene and not data.get("errors") and not report_data.get("errors")
    def run(label, command, cwd=TOOLS):
        started = time.monotonic()
        print(f"[{label}]", flush=True)
        with (logs / f"{len(report['steps']):02d}-{label}.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([str(x) for x in command], cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
            running={"label":label,"pid":process.pid,"log":str(log.name)}
            report.setdefault("running",[]).append(running);save()
            exit_code=process.wait()
        report["running"].remove(running)
        report["steps"].append({"label": label, "pid":process.pid,"log":str(log.name),"exitCode": exit_code, "seconds": round(time.monotonic()-started, 2)})
        save()
        if exit_code: raise RuntimeError(f"{label} failed ({exit_code}); see {logs}")
    def cli(*params):
        return [dotnet, TOOLS / "bin/MapExtract.dll", *params]
    with pipeline_lock(TOOLS / "rebuild.lock"):
        try:
            run("build-tool", [dotnet, "build", TOOLS / "MapExtract/MapExtract.csproj", "-c", "Release", "-o", TOOLS / "bin", "-p:RestoreLockedMode=true"])
            for scene in args.scenes:
                if complete(scene):
                    report.setdefault("results",{}).setdefault(scene,{"resumed":True})
                    save();continue
                raw = output / scene
                if args.skip_extract:
                    manifest = json.loads((raw / "manifest.json").read_text(encoding="utf-8"))
                    if manifest["gameVersion"] != version:
                        raise RuntimeError(f"{scene}: cached export version differs from installed client; run without --skip-extract.")
                else:
                    run(f"{scene}-extract", cli("extract-map", client, scene, raw))
                    run(f"{scene}-collision", cli("collision-map", client, scene, raw))
                    map_path = catalog_scene(scene)["mapTexture"]
                    run(f"{scene}-map", cli("raw", client, map_path, raw / map_path))
                # Conversion always runs; SkipExtract must not retain an obsolete GLB schema.
                run(f"{scene}-models", cli("model-folder", raw))
                run(f"{scene}-assemble", [sys.executable, TOOLS / "assemble_scene.py", scene, f"--exports={output}", f"--destination={stage}"])
                run(f"{scene}-bake-collision", [sys.executable, TOOLS / "collision_mesh.py", scene, f"--exports={output}", f"--destination={stage}"])
                scene_manifest=json.loads((stage/scene/"scene.json").read_text(encoding="utf-8"))
                report.setdefault("results",{})[scene]={"models":len(scene_manifest["models"]),"instances":sum(len(model["matrices"]) for model in scene_manifest["models"]),"materials":len(scene_manifest["materials"]),"errors":len(scene_manifest["errors"])}
                save()
            run("verify-staged", [node, project / "scripts/verify-extracted.mjs", f"--root={stage}", f"--scenes={','.join(args.scenes)}"], project)
            if version_path.read_text().strip() != version:
                raise RuntimeError("Client version changed during extraction. Staged files were not published.")
            previous = json.loads((public / "active.json").read_text(encoding="utf-8")) if (public / "active.json").exists() else {"scenes": {}}
            pointer = {"runId": run_id, "publishedAt": datetime.now(timezone.utc).isoformat(), "scenes": dict(previous["scenes"])}
            for scene in args.scenes:
                scene_manifest = json.loads((stage / scene / "scene.json").read_text(encoding="utf-8"))
                pointer["scenes"][scene] = {"base": f"releases/{run_id}/{scene}/", "clientVersion": version,**{key:catalog_scene(scene)[key] for key in ("name","en","region","territoryId")},
                                          "manifestSha256": hashlib.sha256((stage / scene / "scene.json").read_bytes()).hexdigest()}
                report.setdefault("results", {})[scene] = {"models": len(scene_manifest["models"]),
                    "instances": sum(len(model["matrices"]) for model in scene_manifest["models"]),
                    "materials": len(scene_manifest["materials"]), "errors": len(scene_manifest["errors"])}
            if args.no_publish:
                report["state"] = "validated"; report["published"] = False
            else:
                release = stage
                if not release.resolve().is_relative_to(public.resolve()):
                    raise RuntimeError("Publication path escaped extracted workspace.")
                write_json(public / "active.json", pointer)
                report["state"] = "complete"; report["published"] = True; report["release"] = str(release)
            save()
            print(json.dumps({"state": report["state"], "report": str(report_path), "results": report["results"]}), flush=True)
        except Exception as error:
            report["state"] = "failed"; report["error"] = str(error); report["published"] = False
            save()
            raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", type=Path, help="FFXIV install root, or set FFXIV_CLIENT")
    parser.add_argument("--project", type=Path, default=TOOLS.parent.parent,
                        help="trainer root; defaults to tools/map-tools/../../")
    parser.add_argument("--output", type=Path, default=TOOLS / "exports")
    parser.add_argument("--scenes", nargs="+", choices=SCENES, default=list(SCENES))
    parser.add_argument("--estimate-only", action="store_true", help="estimate catalog raw+release disk needs from converted maps")
    parser.add_argument("--resume-run", help="continue a failed run id, skipping complete staged scenes")
    parser.add_argument("--skip-extract", action="store_true")
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--node", type=Path)
    args=parser.parse_args()
    try: estimate_disk(args) if args.estimate_only else run_batch(args)
    except Exception as error: print(str(error), file=sys.stderr); sys.exit(1)
