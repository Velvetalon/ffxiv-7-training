#!/usr/bin/env python3
"""Prepare or deploy the isolated Babylon Golden Port preview release.

Every command is dry-run unless ``--apply`` is supplied.  The local package
contains only the built ``site-babylon-preview`` output.  The remote script
publishes it below ``/opt/ff14-web-babylon-preview`` and never changes the
main ``/opt/ff14-web/current`` release or the shared asset-ticket service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Iterable
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "site-babylon-preview"
DEFAULT_OUT_ROOT = ROOT / "work" / "deployment"
DEFAULT_CREDENTIALS = Path("G:/UGit/rawWeb/initPackage/02_bootstrap")
REMOTE_SCRIPT = ROOT / "deploy" / "deploy-babylon-preview.sh"
APP_BASE_PATH = "/ff14-web-babylon-preview/"
ASSET_CDN = "https://img.yuluo.site/ff14-assets/v1/"
TICKET_PATH = "/ff14-assets/ticket"
REMOTE_ROOT = "/opt/ff14-web-babylon-preview"


class ReleaseError(RuntimeError):
    """A user-actionable release-preparation or deployment failure."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"invalid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ReleaseError(f"JSON root must be an object: {path}")
    return value


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def validate_release_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,80}", value):
        raise ReleaseError("--release-id must contain only letters, digits, dot, underscore, or hyphen")
    return value


def relative_files(root: Path) -> list[tuple[Path, str]]:
    files: list[tuple[Path, str]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ReleaseError(f"preview output must not contain symlinks: {path}")
        if not path.is_file():
            continue
        relative = PurePosixPath(path.relative_to(root).as_posix())
        if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
            raise ReleaseError(f"preview output contains an unsafe relative path: {relative}")
        files.append((path, relative.as_posix()))
    return files


def text_files(files: Iterable[tuple[Path, str]]) -> Iterable[tuple[Path, str]]:
    for path, relative in files:
        if path.stat().st_size > 8 * 1024 * 1024:
            continue
        try:
            yield path, path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue


def validate_source(source: Path) -> dict:
    source = source.resolve()
    if not source.is_dir():
        raise ReleaseError(f"Babylon preview output directory is missing: {source}")
    index = source / "index.html"
    if not index.is_file() or index.stat().st_size == 0:
        raise ReleaseError(f"Babylon preview output has no index.html: {source}")
    files = relative_files(source)
    if not files:
        raise ReleaseError("Babylon preview output is empty")

    joined_text = "\n".join(text for _, text in text_files(files))
    if APP_BASE_PATH not in joined_text:
        raise ReleaseError(f"built preview output does not contain its deployment base path: {APP_BASE_PATH}")
    if re.search(r"localhost(?::|/)|127\.0\.0\.1|CDN_AUTH_SECRET|SERVER_PASSWD", joined_text):
        raise ReleaseError("built preview output contains a local endpoint or secret-like value")

    total_bytes = sum(path.stat().st_size for path, _ in files)
    return {
        "files": len(files),
        "bytes": total_bytes,
        "indexSha256": sha256_file(index),
        "relativeFiles": files,
    }


def make_archive(source: Path, archive: Path, files: list[tuple[Path, str]]) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w:gz") as output:
        for path, relative in files:
            output.add(path, arcname=PurePosixPath("site/current", relative), recursive=False)


def prepare(args: argparse.Namespace) -> dict:
    release_id = validate_release_id(args.release_id)
    source = Path(args.source).resolve()
    stats = validate_source(source)
    prepared = Path(args.out or DEFAULT_OUT_ROOT / f"babylon-preview-release-{release_id}").resolve()
    plan = {
        "dryRun": not args.apply,
        "releaseId": release_id,
        "source": "site-babylon-preview",
        "preparedDir": str(prepared),
        "output": {
            "files": stats["files"],
            "bytes": stats["bytes"],
            "indexSha256": stats["indexSha256"],
        },
        "application": {
            "basePath": APP_BASE_PATH,
            "assetCdn": ASSET_CDN,
            "ticketPath": TICKET_PATH,
        },
        "remote": {
            "root": REMOTE_ROOT,
            "archiveLayout": "site/current",
            "mainRootUntouched": "/opt/ff14-web/current",
            "sharedTicketUntouched": True,
        },
        "assetPublication": {"required": False, "reason": "Babylon preview reuses the shared CDN; no new assets are expected."},
    }
    if not args.apply:
        return plan
    if prepared.exists():
        raise ReleaseError(f"refusing to overwrite prepared output: {prepared}")
    prepared.mkdir(parents=True)
    archive = prepared / f"ff14-babylon-preview-{release_id}.tar.gz"
    make_archive(source, archive, stats["relativeFiles"])
    record = {
        **{key: value for key, value in plan.items() if key != "preparedDir"},
        "dryRun": False,
        "archive": {
            "name": archive.name,
            "sha256": sha256_file(archive),
            "bytes": archive.stat().st_size,
        },
        "remoteScript": "deploy/deploy-babylon-preview.sh",
    }
    write_json(prepared / "release-record.json", record)
    return plan | {
        "dryRun": False,
        "archive": str(archive),
        "archiveSha256": record["archive"]["sha256"],
    }


def load_credentials(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise ReleaseError(f"credentials file is required only for --apply: {path}")
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    required = ("SERVER_HOST", "SERVER_USER", "SERVER_PASSWD")
    if any(not values.get(key) for key in required):
        raise ReleaseError("credentials file lacks SERVER_HOST, SERVER_USER, or SERVER_PASSWD")
    return values


def normalize_origin(value: str | None, *, required: bool) -> str | None:
    if not value:
        if required:
            raise ReleaseError("--origin or FF14_PUBLIC_ORIGIN is required for --apply")
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ReleaseError("--origin must be an http(s) origin without credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ReleaseError("--origin must contain only scheme and host")
    return value.rstrip("/")


def deploy(args: argparse.Namespace) -> dict:
    prepared = Path(args.prepared_dir).resolve()
    record = read_json(prepared / "release-record.json")
    release_id = validate_release_id(str(record.get("releaseId", "")))
    archive_info = record.get("archive") or {}
    archive_name = archive_info.get("name")
    archive_sha = archive_info.get("sha256")
    if not isinstance(archive_name, str) or not re.fullmatch(r"[A-Za-z0-9._-]+\.tar\.gz", archive_name):
        raise ReleaseError("prepared record has an unsafe archive name")
    if not isinstance(archive_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", archive_sha):
        raise ReleaseError("prepared record has an invalid archive SHA-256")
    archive = prepared / archive_name
    if not archive.is_file() or sha256_file(archive) != archive_sha:
        raise ReleaseError("prepared archive is missing or no longer matches its release record")
    script = Path(args.remote_script).resolve() if args.remote_script else REMOTE_SCRIPT
    if not script.is_file():
        raise ReleaseError(f"remote deployment script is missing: {script}")
    origin = normalize_origin(args.origin, required=args.apply)

    plan = {
        "dryRun": not args.apply,
        "releaseId": release_id,
        "archive": str(archive),
        "archiveSha256": archive_sha,
        "remoteScript": "deploy/deploy-babylon-preview.sh",
        "remoteArchive": f"/tmp/ff14-babylon-preview-{release_id}.tar.gz",
        "remoteRoot": REMOTE_ROOT,
        "originConfigured": origin is not None,
        "onlineChecks": "bounded route/main health checks in the remote cutover script; browser open/refresh remains a separate QA step",
    }
    if not args.apply:
        return plan

    values = load_credentials(Path(args.credentials).resolve())
    try:
        import paramiko
    except ImportError as error:
        raise ReleaseError("Paramiko is required for --apply deployment") from error

    remote_archive = f"/tmp/ff14-babylon-preview-{release_id}.tar.gz"
    remote_script = f"/tmp/ff14-babylon-preview-deploy-{release_id}.sh"
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    known_hosts = Path.home() / ".ssh" / "known_hosts"
    if known_hosts.is_file():
        client.load_host_keys(str(known_hosts))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(
            values["SERVER_HOST"],
            port=int(values.get("SERVER_PORT", "22")),
            username=values["SERVER_USER"],
            password=values["SERVER_PASSWD"],
            look_for_keys=False,
            allow_agent=False,
            timeout=20,
            auth_timeout=20,
        )
        with client.open_sftp() as sftp:
            sftp.put(str(archive), remote_archive)
            sftp.put(str(script), remote_script)
            sftp.chmod(remote_script, 0o700)
        command = (
            f"sha256sum {shlex.quote(remote_archive)} && sudo -n bash {shlex.quote(remote_script)} "
            f"{shlex.quote(release_id)} {shlex.quote(archive_sha)} {shlex.quote(origin or '')}"
        )
        _, stdout, stderr = client.exec_command(command, timeout=300)
        output = stdout.read().decode("utf-8", errors="replace")
        errors = stderr.read().decode("utf-8", errors="replace")
        sys.stdout.write(output)
        sys.stderr.write(errors)
        if stdout.channel.recv_exit_status() != 0:
            raise ReleaseError("remote Babylon preview deployment failed; the remote script restores its prior preview state")
    finally:
        client.close()
    return plan | {"dryRun": False, "deployed": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    prepare_parser = sub.add_parser("prepare", help="inspect or package site-babylon-preview")
    prepare_parser.add_argument("--source", default=DEFAULT_SOURCE)
    prepare_parser.add_argument("--release-id", required=True)
    prepare_parser.add_argument("--out")
    prepare_parser.add_argument("--apply", action="store_true", help="create the local archive")

    deploy_parser = sub.add_parser("deploy", help="inspect or upload a prepared preview archive")
    deploy_parser.add_argument("--prepared-dir", required=True)
    deploy_parser.add_argument("--credentials", default=DEFAULT_CREDENTIALS)
    deploy_parser.add_argument("--remote-script")
    deploy_parser.add_argument("--origin", default=os.environ.get("FF14_PUBLIC_ORIGIN"), help="public http(s) origin used by bounded remote checks")
    deploy_parser.add_argument("--apply", action="store_true", help="upload and run the remote cutover")

    args = parser.parse_args()
    try:
        result = {"prepare": prepare, "deploy": deploy}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0
    except (ReleaseError, OSError, ValueError) as error:
        print(f"babylon-preview-release: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
