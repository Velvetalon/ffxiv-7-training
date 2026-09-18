"""Parallel, resumable reconstruction of hidden-catalog scene roots."""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent
STATE_LOCK = threading.Lock()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    payload = json.dumps(value, ensure_ascii=False, indent=2)
    temporary.write_text(payload + "\n", encoding="utf-8")
    temporary.replace(path)


def run(command, log, env):
    with Path(log).open("w", encoding="utf-8", errors="replace") as stream:
        process = subprocess.run(
            [str(item) for item in command], cwd=PROJECT, env=env,
            stdout=stream, stderr=subprocess.STDOUT,
        )
    return process.returncode


def package_complete(destination, scene):
    state = Path(destination) / scene / "package-state.json"
    if not state.is_file():
        return False
    try:
        document = json.loads(state.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return document.get("status") == "complete"


def staged_scenes(stage):
    if not stage.is_dir():
        return []
    return sorted(
        item.name for item in stage.iterdir()
        if item.is_dir() and (item / "scene.json").is_file() and (item / "collision.bin").is_file()
    )


def build_tool():
    dotnet = shutil.which("dotnet") or str(ROOT / "dotnet/dotnet.exe")
    command = [
        dotnet, "build", ROOT / "MapExtract/MapExtract.csproj",
        "-c", "Release", "-o", ROOT / "bin", "-p:RestoreLockedMode=true",
    ]
    process = subprocess.run([str(item) for item in command], cwd=PROJECT, capture_output=True)
    if process.returncode:
        output = (process.stdout or b"") + (process.stderr or b"")
        raise RuntimeError(f"MapExtract build failed:\n{output.decode('utf-8', errors='replace')}")


def process_chunk(chunk, args, state, catalog_sha):
    scenes = chunk["scenes"]
    chunk_id = chunk["id"]
    attempt = int(chunk.get("attempts", 0)) + 1
    run_id = f"{chunk_id}-a{attempt:02d}-{uuid.uuid4().hex[:6]}"
    stage_root = args.work / "stage" / chunk_id
    stage = stage_root / run_id
    stage_root.mkdir(parents=True, exist_ok=True)
    stage.mkdir(parents=True, exist_ok=True)
    (ROOT / "logs" / run_id).mkdir(parents=True, exist_ok=True)
    logs = args.work / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["MAP_TOOLS_CATALOG"] = str(args.catalog.resolve())
    env.update({
        "DOTNET_CLI_HOME": str(ROOT / ".dotnet-home"),
        "NUGET_PACKAGES": str(ROOT / "nuget"),
        "DOTNET_CLI_TELEMETRY_OPTOUT": "1",
        "DOTNET_GENERATE_ASPNET_CERTIFICATE": "false",
    })

    batch_command = [
        args.python, ROOT / "batch_rebuild.py",
        "--catalog", args.catalog,
        "--client", args.client,
        "--output", args.work / "raw",
        "--stage-root", stage_root,
        "--resume-run", run_id,
        "--no-publish", "--cleanup-raw", "--skip-build-tool",
        "--lock", args.work / "locks" / f"{chunk_id}.lock",
        "--scenes", *scenes,
    ]
    if attempt > 1:
        batch_command.append("--skip-extract")
    batch_code = run(batch_command, logs / f"{run_id}-rebuild.log", env)
    converted = [scene for scene in staged_scenes(stage) if scene in scenes]

    package_code = 1
    if converted:
        package_command = [
            args.python, ROOT / "package_world.py",
            "--source", stage,
            "--destination", args.work / "packed",
            "--public-root", args.work / "packed",
            "--cache", args.cache,
            "--workers", str(args.package_workers),
            "--progress", logs / f"{run_id}-package-progress.json",
            "--report", logs / f"{run_id}-package-report.json",
            "--scenes", *converted,
        ]
        package_code = run(package_command, logs / f"{run_id}-package.log", env)
    complete = [scene for scene in scenes if package_complete(args.work / "packed", scene)]
    failed = [scene for scene in scenes if scene not in complete]
    result = {
        "chunkId": chunk_id,
        "runId": run_id,
        "catalogSha256": catalog_sha,
        "requested": scenes,
        "complete": complete,
        "failed": failed,
        "batchExitCode": batch_code,
        "packageExitCode": package_code,
        "updatedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if not failed:
        shutil.rmtree(stage_root, ignore_errors=True)
    else:
        for scene in complete:
            shutil.rmtree(stage / scene, ignore_errors=True)

    with STATE_LOCK:
        for scene in complete:
            state["scenes"][scene] = {
                "status": "complete", "chunkId": chunk_id, "runId": run_id,
                "packageState": str((args.work / "packed" / scene / "package-state.json").resolve()),
            }
        for scene in failed:
            previous = state["scenes"].get(scene, {})
            state["scenes"][scene] = {
                "status": "failed", "chunkId": chunk_id, "runId": run_id,
                "attempts": max(attempt, int(previous.get("attempts", 0))),
                "reason": "rebuild or package failed; see chunk logs",
                "log": str((logs / f"{run_id}-rebuild.log").resolve()),
                **({"packageLog": str((logs / f"{run_id}-package.log").resolve())} if converted else {}),
            }
        state["chunks"][chunk_id] = result
        state["updatedAtUtc"] = result["updatedAtUtc"]
        write_json(args.state, state)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=PROJECT / "config/duties/hidden-catalog.json")
    parser.add_argument("--client", type=Path)
    parser.add_argument("--work", type=Path, default=PROJECT / "work/duty-build/full")
    parser.add_argument("--cache", type=Path, default=PROJECT / "work/world-package-cache")
    parser.add_argument("--state", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--package-workers", type=int, default=2)
    parser.add_argument("--chunk-size", type=int, default=12)
    parser.add_argument("--limit", type=int, help="limit scene count for a controlled trial")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--python", default="py")
    args = parser.parse_args()

    client = args.client or Path(os.environ.get("FFXIV_CLIENT", ""))
    if not client.is_dir() and not args.dry_run:
        raise ValueError("A valid --client or FFXIV_CLIENT is required")
    args.work = args.work.resolve()
    args.state = (args.state or args.work / "rebuild-state.json").resolve()
    args.cache = args.cache.resolve()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    all_scenes = [item["id"] for item in catalog["scenes"]]
    state = {"schemaVersion": 1, "scenes": {}, "chunks": {}} if not args.state.is_file() else json.loads(args.state.read_text(encoding="utf-8"))
    for scene in all_scenes:
        if package_complete(args.work / "packed", scene):
            state["scenes"].setdefault(scene, {"status": "complete"})
        elif state["scenes"].get(scene, {}).get("status") != "failed":
            state["scenes"][scene] = {"status": "queued"}
    pending = [scene for scene in all_scenes if state["scenes"].get(scene, {}).get("status") != "complete"]
    if args.limit is not None:
        pending = pending[:args.limit]
    chunks = []
    for index in range(0, len(pending), args.chunk_size):
        number = index // args.chunk_size + 1
        chunks.append({"id": f"chunk-{number:03d}", "scenes": pending[index:index + args.chunk_size]})
    summary = {
        "catalog": str(args.catalog.resolve()),
        "catalogScenes": len(all_scenes),
        "alreadyComplete": sum(state["scenes"].get(scene, {}).get("status") == "complete" for scene in all_scenes),
        "pending": len(pending),
        "chunks": [item["id"] for item in chunks],
        "workers": args.workers,
    }
    if args.dry_run:
        print(json.dumps(summary, ensure_ascii=False))
        return
    write_json(args.state, state)
    build_tool()
    catalog_sha = hashlib.sha256(args.catalog.read_bytes()).hexdigest()
    failures = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_chunk, chunk, args, state, catalog_sha): chunk for chunk in chunks}
        for future in as_completed(futures):
            chunk = futures[future]
            try:
                result = future.result()
                print(json.dumps({
                    "chunk": chunk["id"], "complete": len(result["complete"]),
                    "failed": len(result["failed"]), "batchExitCode": result["batchExitCode"],
                }), flush=True)
                failures.extend(result["failed"])
            except Exception as error:
                failures.extend(chunk["scenes"])
                print(json.dumps({"chunk": chunk["id"], "error": str(error)}), flush=True)
    state["summary"] = {
        **summary,
        "finishedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "failed": sorted(set(failures)),
    }
    write_json(args.state, state)
    print(json.dumps({**state["summary"], "stateFile": str(args.state)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
