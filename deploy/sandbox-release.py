#!/usr/bin/env python3
"""Prepare or deploy the additive FF14 character/world Sandbox release.

All commands default to dry-run.  Preparation builds a ticket-mode site locally
and creates an archive with no local paths, credentials, or CDN signatures.
Asset publication is deliberately a separate phase so immutable COS objects
are fully reconciled before the mutable web release is activated.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORLD = ROOT / "work" / "asset-performance" / "packed-all-final"
DEFAULT_OUT_ROOT = ROOT / "work" / "deployment"
DEFAULT_ACTIVE = ROOT / "work" / "duty-build" / "analysis-active" / "active.json"
PREFIX = "ff14-assets/v1"
TICKET_PATH = "/ff14-assets/ticket"
CDN_BASE = "https://img.yuluo.site/ff14-assets/v1/"


class ReleaseError(RuntimeError):
    pass


def npm_command() -> list[str]:
    if os.name != "nt":
        return ["npm"]
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise ReleaseError("npm.cmd is required on Windows")
    node = shutil.which("node.exe") or shutil.which("node")
    cli = Path(npm).resolve().parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if node and cli.is_file():
        return [node, str(cli)]
    return [npm]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"invalid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ReleaseError(f"JSON root must be an object: {path}")
    return value


def clean_relative(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ReleaseError(f"{label} must be a non-empty slash-separated relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ReleaseError(f"{label} is unsafe")
    return path.as_posix()


def validate_manifest(root: Path, label: str, *, verify_assets: bool = True) -> dict:
    manifest = read_json(root / "publish-manifest.json")
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("releaseId"), str):
        raise ReleaseError(f"{label} publish manifest has an invalid schema")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ReleaseError(f"{label} publish manifest has no files")
    paths: set[str] = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise ReleaseError(f"{label} files[{index}] is not an object")
        relative = clean_relative(item.get("path"), f"{label} files[{index}].path")
        if relative in paths:
            raise ReleaseError(f"{label} has a duplicate asset path: {relative}")
        paths.add(relative)
        declared_hash = item.get("hash")
        if not isinstance(declared_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", declared_hash):
            raise ReleaseError(f"{label} files[{index}] has no lowercase SHA-256")
        if declared_hash not in relative:
            raise ReleaseError(f"{label} files[{index}] path is not content addressed")
        local = (root / relative).resolve()
        try:
            local.relative_to(root.resolve())
        except ValueError as error:
            raise ReleaseError(f"{label} asset escaped its release directory") from error
        if not local.is_file():
            raise ReleaseError(f"{label} asset is missing: {relative}")
        # The established world release was reconciled before this phase. Do not
        # re-hash its 16 GB of immutable files while preparing an additive release.
        if verify_assets and (local.stat().st_size != item.get("size") or sha256_file(local) != declared_hash):
            raise ReleaseError(f"{label} asset failed local size/hash validation: {relative}")
    entry = clean_relative(manifest.get("entry"), f"{label}.entry")
    if entry not in paths:
        raise ReleaseError(f"{label} entry is not a declared file")
    return manifest


def canonical_file(item: dict) -> dict:
    # Ticket-server only needs these four public fields; avoid copying research metadata.
    return {key: item[key] for key in ("path", "size", "hash", "contentType") if key in item} | (
        {"contentEncoding": item["contentEncoding"]} if "contentEncoding" in item else {}
    )


def merged_ticket_manifest(world: dict, sandbox: dict) -> dict:
    world_files = [canonical_file(item) for item in world["files"]]
    sandbox_files = [canonical_file(item) for item in sandbox["files"]]
    paths = {item["path"] for item in world_files}
    collision = paths.intersection(item["path"] for item in sandbox_files)
    if collision:
        raise ReleaseError("Sandbox asset path collides with the immutable world release: " + ", ".join(sorted(collision)))
    entry = clean_relative(world["entry"], "world.entry")
    if entry not in paths:
        raise ReleaseError("world entry is not in its allowlist")
    files = [*world_files, *sandbox_files]
    if len(files) > 50_000:
        raise ReleaseError(f"merged ticket manifest has {len(files)} objects; ticket server limit is 50000")
    return {
        "schemaVersion": 1,
        "releaseId": f"sandbox-web-{sandbox['releaseId']}",
        "entry": entry,
        "files": files,
        "releaseComposition": {
            "worldReleaseId": world["releaseId"],
            "sandboxReleaseId": sandbox["releaseId"],
            "worldEntryRetained": entry,
        },
    }


def validate_sandbox_manifests(root: Path) -> dict:
    local = read_json(root / "manifest.json")
    cdn = read_json(root / "manifest.cdn.json")
    local_bundles = local.get("bundles")
    cdn_bundles = cdn.get("bundles")
    if not isinstance(local_bundles, dict) or not local_bundles:
        raise ReleaseError("sandbox manifest.json has no bundles")
    if not isinstance(cdn_bundles, dict) or set(cdn_bundles) != set(local_bundles):
        raise ReleaseError("sandbox manifest.cdn.json bundles differ from manifest.json")
    for bundle_id, local_bundle in local_bundles.items():
        cdn_bundle = cdn_bundles[bundle_id]
        if not isinstance(local_bundle, dict) or not isinstance(cdn_bundle, dict):
            raise ReleaseError(f"sandbox bundle {bundle_id} is not an object")
        local_metadata = {key: value for key, value in local_bundle.items() if key != "url"}
        cdn_metadata = {key: value for key, value in cdn_bundle.items() if key != "url"}
        if local_metadata != cdn_metadata:
            raise ReleaseError(f"sandbox bundle metadata differs for {bundle_id}")
        url = cdn_bundle.get("url")
        if not isinstance(url, str) or not url.startswith(CDN_BASE):
            raise ReleaseError(f"sandbox bundle URL is not pinned to the CDN: {bundle_id}")
    for key in ("schemaVersion", "resources", "aliases", "characters", "mounts", "sceneBgm", "skills", "rideBgm", "actionSfx", "defaultAppearance"):
        if local.get(key) != cdn.get(key):
            raise ReleaseError(f"sandbox manifest.cdn.json {key} differs from manifest.json")
    return cdn


def require_freeze(ref: str | None) -> str:
    if not ref:
        raise ReleaseError("--freeze-ref is required for a real prepare")
    actual = subprocess.check_output(["git", "-c", "core.fsmonitor=false", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    expected = subprocess.check_output(["git", "-c", "core.fsmonitor=false", "rev-parse", ref], cwd=ROOT, text=True).strip()
    if actual != expected:
        raise ReleaseError(f"code is not frozen at --freeze-ref ({actual} != {expected})")
    return actual


def require_fast_validation(proof: Path | None) -> str:
    if proof is None or not proof.is_file():
        raise ReleaseError("--fast-validation-proof must name the completed Fast Validation result")
    try:
        result = json.loads(proof.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseError("Fast Validation proof must be the JSON result.json file") from error
    if not isinstance(result, dict) or result.get("status") != "PASS":
        raise ReleaseError("Fast Validation proof status is not PASS")
    return sha256_file(proof)


def verify_site(site: Path, sandbox_manifest: dict, expected_scenes: int) -> None:
    active = read_json(site / "extracted" / "active.json")
    scenes = active.get("scenes")
    if not isinstance(scenes, dict) or len(scenes) != expected_scenes:
        raise ReleaseError(f"ticket-mode site does not retain all {expected_scenes} world scenes")
    if active.get("assetPipeline") != {"ticket": TICKET_PATH}:
        raise ReleaseError("ticket-mode site has an unexpected assetPipeline")
    if (site / "assets" / "world").exists() or (site / "extracted" / "world").exists():
        raise ReleaseError("ticket-mode site accidentally embeds world assets")
    shipped = read_json(site / "sandbox" / "manifest.json")
    if shipped.get("bundles") != sandbox_manifest.get("bundles"):
        raise ReleaseError("shipped sandbox CDN manifest differs from the prepared release")
    urls = [item.get("url") for item in shipped.get("bundles", {}).values()]
    if not urls or any(not isinstance(url, str) or not url.startswith(CDN_BASE) for url in urls):
        raise ReleaseError("shipped sandbox manifest is not pinned to the expected CDN prefix")
    if list(site.rglob("*.aethpak")):
        raise ReleaseError("ticket-mode site accidentally embeds Sandbox packs")


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_archive(prepared: Path, release_id: str) -> Path:
    archive = prepared / f"ff14-sandbox-{release_id}.tar.gz"
    with tarfile.open(archive, "w:gz") as output:
        for top in ("site", "ticket", "release-record.json"):
            source = prepared / top
            output.add(source, arcname=top, recursive=True)
    return archive


def prepare(args: argparse.Namespace) -> dict:
    release_id = args.release_id
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,80}", release_id):
        raise ReleaseError("--release-id must contain only letters, digits, dot, underscore, or hyphen")
    sandbox_root = Path(args.sandbox_release).resolve()
    world_root = Path(args.world_dir).resolve()
    prepared = Path(args.out or DEFAULT_OUT_ROOT / f"sandbox-release-{release_id}").resolve()
    sandbox = validate_manifest(sandbox_root, "sandbox")
    world = validate_manifest(world_root, "world", verify_assets=False)
    sandbox_manifest = validate_sandbox_manifests(sandbox_root)
    ticket = merged_ticket_manifest(world, sandbox)
    plan = {
        "dryRun": not args.apply,
        "releaseId": release_id,
        "preparedDir": str(prepared),
        "world": {"releaseId": world["releaseId"], "objects": len(world["files"]), "entry": world["entry"]},
        "sandbox": {"releaseId": sandbox["releaseId"], "objects": len(sandbox["files"]), "entry": sandbox["entry"]},
        "ticket": {"objects": len(ticket["files"]), "entry": ticket["entry"], "previousKeys": "retained remotely at activation"},
        "cos": {"prefix": PREFIX, "command": "publish-assets", "pointer": "not touched"},
    }
    if not args.apply:
        return plan
    if prepared.exists():
        raise ReleaseError(f"refusing to overwrite prepared output: {prepared}")
    commit = require_freeze(args.freeze_ref)
    proof_hash = require_fast_validation(Path(args.fast_validation_proof).resolve() if args.fast_validation_proof else None)
    prepared.mkdir(parents=True)
    env = os.environ | {
        "ASSET_PIPELINE_DIR": str(world_root),
        "ASSET_CDN_TICKET": TICKET_PATH,
        "BABYLON_ACTIVE": str(Path(args.active).resolve()),
        "BABYLON_EXPECTED_MAPS": str(args.expected_scenes),
        "BABYLON_OUT_DIR": str(prepared / "site"),
        "SANDBOX_RELEASE_DIR": str(sandbox_root),
        "SANDBOX_CDN": "1",
    }
    try:
        subprocess.run([*npm_command(), "run", "release"], cwd=ROOT, env=env, check=True)
        verify_site(prepared / "site", sandbox_manifest, args.expected_scenes)
        ticket_dir = prepared / "ticket"
        ticket_dir.mkdir()
        shutil.copy2(ROOT / "scripts" / "asset-ticket-server.mjs", ticket_dir / "asset-ticket-server.mjs")
        write_json(ticket_dir / "publish-manifest.json", ticket)
        record = {
            **{key: value for key, value in plan.items() if key != "preparedDir"},
            "dryRun": False,
            "codeFreezeCommit": commit,
            "fastValidationProofSha256": proof_hash,
            "assetPublication": {"required": True, "complete": False, "pointerTouched": False},
            "site": {"sha256": sha256_file(prepared / "site" / "index.html"), "worldSceneCount": args.expected_scenes},
            "sandboxFiles": [{"path": item["path"], "sha256": item["hash"], "mime": item["contentType"]} for item in sandbox["files"]],
        }
        # The archive intentionally contains a release record without its own
        # digest. The external record receives that digest after creation; trying
        # to embed an archive's hash inside the archive is self-referential.
        write_json(prepared / "release-record.json", record)
        archive = make_archive(prepared, release_id)
        record["archive"] = {"name": archive.name, "sha256": sha256_file(archive), "bytes": archive.stat().st_size}
        write_json(prepared / "release-record.json", record)
        plan |= {"dryRun": False, "archive": str(archive), "archiveSha256": sha256_file(archive)}
        return plan
    except Exception:
        shutil.rmtree(prepared, ignore_errors=True)
        raise


def publish_assets(args: argparse.Namespace) -> dict:
    world_root = Path(args.world_dir).resolve()
    world_manifest = validate_manifest(world_root, "world", verify_assets=False)
    sandbox_root = Path(args.sandbox_release).resolve()
    sandbox_manifest = validate_manifest(sandbox_root, "sandbox")
    validate_sandbox_manifests(sandbox_root)
    prepared = None
    if args.apply and args.execute and args.prepared_dir:
        prepared = Path(args.prepared_dir).resolve()
        record_path = prepared / "release-record.json"
        record = read_json(record_path)
        if record.get("sandbox", {}).get("releaseId") != sandbox_manifest["releaseId"]:
            raise ReleaseError("prepared record was made from a different Sandbox release")
        if record.get("world", {}).get("releaseId") != world_manifest["releaseId"]:
            raise ReleaseError("prepared record was made from a different world release")
    # `--only-prefix` cannot include the root-level hashed entry alongside
    # `packs/`. The Sandbox manifest contains only newly assembled files, so
    # `--files-only` is the exact selection and excludes the derived control
    # manifest and current.json.
    commands = []
    for root in (world_root, sandbox_root):
        command = [sys.executable, str(ROOT / "scripts" / "assets" / "publish-cos.py"), "--dir", str(root),
                   "--prefix", PREFIX, "--files-only"]
        if args.apply:
            command.append("--apply")
        elif args.check:
            command.append("--check-only")
        command += ["--summary-only", "--progress-every", "1000"]
        commands.append(command)
    if args.execute:
        for command in commands:
            subprocess.run(command, cwd=ROOT, check=True)
    if args.apply and args.execute and prepared:
        record_path = prepared / "release-record.json"
        record = read_json(record_path)
        record["assetPublication"] = {
            "required": True,
            "complete": True,
            "pointerTouched": False,
            "publisher": "publish-cos.py --files-only",
            "worldObjects": len(world_manifest["files"]),
            "sandboxObjects": len(sandbox_manifest["files"]),
        }
        write_json(record_path, record)
    return {
        "dryRun": not args.apply,
        "checkOnly": bool(args.check),
        "commands": commands,
        "world": {"releaseId": world_manifest["releaseId"], "objects": len(world_manifest["files"])},
        "sandbox": {"releaseId": sandbox_manifest["releaseId"], "objects": len(sandbox_manifest["files"])},
        "note": "No current.json activation; publishes all and only world plus Sandbox manifest files.",
    }


def deploy(args: argparse.Namespace) -> dict:
    prepared = Path(args.prepared_dir).resolve()
    record = read_json(prepared / "release-record.json")
    archive_info = record.get("archive") or {}
    archive = prepared / str(archive_info.get("name", ""))
    if not archive.is_file() or sha256_file(archive) != archive_info.get("sha256"):
        raise ReleaseError("prepared archive is missing or no longer matches its release record")
    release_id = record.get("releaseId")
    if not isinstance(release_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,80}", release_id):
        raise ReleaseError("prepared release record has an unsafe releaseId")
    remote_script = ROOT / "deploy" / "deploy-sandbox-ticket.sh"
    plan = {"dryRun": not args.apply, "releaseId": release_id, "archive": str(archive), "remoteScript": str(remote_script),
            "onlineFollowup": "None after this command reports success; its bounded server health checks are the final deployment verification."}
    if not args.apply:
        return plan
    if record.get("assetPublication", {}).get("complete") is not True:
        raise ReleaseError("refusing deployment until release-record.json records completed incremental COS publication")
    credentials = Path(args.credentials).resolve()
    if not credentials.is_file():
        raise ReleaseError("credentials file is required only for --apply")
    values = {}
    for line in credentials.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    required = ("SERVER_HOST", "SERVER_USER", "SERVER_PASSWD")
    if any(not values.get(key) for key in required):
        raise ReleaseError("credentials file lacks the server connection fields")
    try:
        import paramiko
    except ImportError as error:
        raise ReleaseError("Paramiko is required for --apply deployment") from error
    remote_archive = f"/tmp/ff14-sandbox-{release_id}.tar.gz"
    remote_deploy = f"/tmp/ff14-sandbox-deploy-{release_id}.sh"
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(values["SERVER_HOST"], port=int(values.get("SERVER_PORT", "22")), username=values["SERVER_USER"], password=values["SERVER_PASSWD"], look_for_keys=False, allow_agent=False, timeout=20, auth_timeout=20)
        with client.open_sftp() as sftp:
            sftp.put(str(archive), remote_archive)
            sftp.put(str(remote_script), remote_deploy)
            sftp.chmod(remote_deploy, 0o700)
        command = f"sha256sum {remote_archive} && sudo -n bash {remote_deploy} {release_id} {archive_info['sha256']}"
        _, stdout, stderr = client.exec_command(command, timeout=300)
        sys.stdout.write(stdout.read().decode(errors="replace"))
        sys.stderr.write(stderr.read().decode(errors="replace"))
        if stdout.channel.recv_exit_status() != 0:
            raise ReleaseError("remote deployment failed; remote script restores the previous release after a failed cutover")
    finally:
        client.close()
    return plan | {"dryRun": False, "deployed": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare_parser = sub.add_parser("prepare")
    prepare_parser.add_argument("--sandbox-release", required=True)
    prepare_parser.add_argument("--release-id", required=True)
    prepare_parser.add_argument("--world-dir", default=DEFAULT_WORLD)
    prepare_parser.add_argument("--active", default=str(DEFAULT_ACTIVE))
    prepare_parser.add_argument("--expected-scenes", type=int, default=596)
    prepare_parser.add_argument("--out")
    prepare_parser.add_argument("--freeze-ref")
    prepare_parser.add_argument("--fast-validation-proof")
    prepare_parser.add_argument("--apply", action="store_true", help="perform local build/archive creation")
    publish_parser = sub.add_parser("publish-assets")
    publish_parser.add_argument("--sandbox-release", required=True)
    publish_parser.add_argument("--world-dir", default=DEFAULT_WORLD)
    publish_parser.add_argument("--prepared-dir", help="mark this local release record complete after a successful --apply --execute")
    publish_parser.add_argument("--apply", action="store_true", help="perform immutable COS uploads")
    publish_parser.add_argument("--check", action="store_true", help="HEAD every object against COS without uploading")
    publish_parser.add_argument("--execute", action="store_true", help="run the printed publisher command")
    deploy_parser = sub.add_parser("deploy")
    deploy_parser.add_argument("--prepared-dir", required=True)
    deploy_parser.add_argument("--credentials", default=DEFAULT_OUT_ROOT / "sandbox-credentials.env")
    deploy_parser.add_argument("--apply", action="store_true", help="upload archive and atomically switch server current")
    args = parser.parse_args()
    try:
        result = {"prepare": prepare, "publish-assets": publish_assets, "deploy": deploy}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except (ReleaseError, subprocess.CalledProcessError, OSError) as error:
        print(f"sandbox-release: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
