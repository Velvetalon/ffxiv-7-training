#!/usr/bin/env python3
"""Publish an immutable FF14 asset release to Tencent COS.

The default mode is local-only dry-run. A real upload requires --apply and
process environment credentials; this program never reads credential files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from typing import Any


class PublishError(RuntimeError):
    pass


@dataclass(frozen=True)
class Asset:
    path: str
    local_path: Path
    size: int
    sha256: str
    content_type: str
    cache_control: str
    content_encoding: str | None = None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalise_prefix(value: str) -> str:
    value = value.strip().strip("/")
    if not value:
        raise PublishError("--prefix must not be empty")
    parts = value.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise PublishError("--prefix contains an invalid path segment")
    return "/".join(parts)


def normalise_relative_path(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise PublishError(f"{field} must be a non-empty string")
    if "\\" in value:
        raise PublishError(f"{field} must use forward slashes")
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise PublishError(f"{field} is not a safe relative path")
    return candidate.as_posix()


def under_root(root: Path, relative_path: str) -> Path:
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise PublishError(f"path escapes --dir: {relative_path}") from error
    return candidate


def cache_control_for(content_type: str) -> str:
    if content_type == "application/json":
        return "public, max-age=31536000, immutable"
    return "public, max-age=31536000, immutable"


def read_manifest(root: Path, *, files_only: bool = False) -> tuple[dict[str, Any], list[Asset], Asset, str | None]:
    manifest_path = root / "publish-manifest.json"
    if not manifest_path.is_file():
        raise PublishError(f"missing planner manifest: {manifest_path}")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise PublishError(f"invalid publish-manifest.json: {error.msg}") from error
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        raise PublishError("publish-manifest.json must have schemaVersion: 1")
    release_id = payload.get("releaseId")
    if not isinstance(release_id, str) or not release_id.strip():
        raise PublishError("publish-manifest.json must have a releaseId")
    files = payload.get("files")
    if not isinstance(files, list) or not files:
        raise PublishError("publish-manifest.json must have a non-empty files array")
    entry_value = payload.get("entry")
    entry = normalise_relative_path(entry_value, field="entry") if entry_value is not None else None
    if entry is None and not files_only:
        raise PublishError("publish-manifest.json must have an entry unless --files-only is used")

    assets: list[Asset] = []
    seen_paths: set[str] = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            raise PublishError(f"files[{index}] must be an object")
        relative_path = normalise_relative_path(item.get("path"), field=f"files[{index}].path")
        if relative_path in seen_paths:
            raise PublishError(f"duplicate asset path: {relative_path}")
        seen_paths.add(relative_path)
        declared_hash = str(item.get("hash", "")).lower()
        if len(declared_hash) != 64 or any(char not in "0123456789abcdef" for char in declared_hash):
            raise PublishError(f"files[{index}].hash must be a lowercase SHA-256")
        if declared_hash not in relative_path:
            raise PublishError(f"files[{index}].path must include its content hash for cross-release deduplication")
        if release_id in PurePosixPath(relative_path).parts:
            raise PublishError(f"files[{index}].path must not include the releaseId")
        declared_size = item.get("size")
        if not isinstance(declared_size, int) or declared_size < 0:
            raise PublishError(f"files[{index}].size must be a non-negative integer")
        content_type = item.get("contentType")
        if not isinstance(content_type, str) or not content_type.strip():
            raise PublishError(f"files[{index}].contentType must be a non-empty string")
        local_path = under_root(root, relative_path)
        if not local_path.is_file():
            raise PublishError(f"asset is missing: {relative_path}")
        actual_size = local_path.stat().st_size
        if actual_size != declared_size:
            raise PublishError(f"size mismatch for {relative_path}: manifest={declared_size} actual={actual_size}")
        actual_hash = sha256_file(local_path)
        if actual_hash != declared_hash:
            raise PublishError(f"SHA-256 mismatch for {relative_path}")
        content_encoding = item.get("contentEncoding")
        if content_encoding is not None and content_encoding != "gzip":
            raise PublishError(f"files[{index}].contentEncoding must be gzip when present")
        assets.append(Asset(relative_path, local_path, actual_size, declared_hash, content_type.strip(), cache_control_for(content_type), content_encoding))

    if entry is not None and entry not in seen_paths:
        raise PublishError("entry must name a path in files")
    manifest_hash = sha256_file(manifest_path)
    manifest_remote_path = f"manifests/publish-manifest.{manifest_hash}.json"
    manifest_asset = Asset(
        manifest_remote_path,
        manifest_path,
        manifest_path.stat().st_size,
        manifest_hash,
        "application/json",
        "public, max-age=31536000, immutable",
    )
    return payload, assets, manifest_asset, entry


def object_key(prefix: str, path: str) -> str:
    return f"{prefix}/{path}"


def metadata_value(response: dict[str, Any], name: str) -> str | None:
    target = name.lower()
    for key, value in response.items():
        if str(key).lower() == target:
            return str(value)
    headers = response.get("ResponseMetadata", {}).get("HTTPHeaders", {}) if isinstance(response, dict) else {}
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).lower() == target:
                return str(value)
    return None


def error_status(error: Exception) -> int | None:
    for name in ("get_status_code", "status_code"):
        value = getattr(error, name, None)
        try:
            value = value() if callable(value) else value
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass
    return None


class FixtureHeadClient:
    """Local-only HEAD fixture used for focused verification; it never uploads."""

    def __init__(self, fixture_path: Path):
        payload = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.objects = payload.get("objects", {})
        self.default_status = int(payload.get("defaultStatus", 404))

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        item = self.objects.get(Key, {"status": self.default_status})
        status = int(item.get("status", 404))
        if status == 404:
            raise FixtureHttpError(404)
        if status >= 400:
            raise FixtureHttpError(status)
        return {
            "Content-Length": str(item["size"]),
            "x-cos-meta-sha256": item.get("sha256", ""),
        }


class FixtureHttpError(Exception):
    def __init__(self, status: int):
        self.status_code = status
        super().__init__(f"fixture HTTP {status}")


def build_cos_client() -> tuple[Any, str]:
    required = ("TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "COS_REGION", "COS_BUCKET")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise PublishError("missing required environment variables: " + ", ".join(missing))
    try:
        from qcloud_cos import CosConfig, CosS3Client
    except ImportError as error:
        raise PublishError("qcloud_cos is required for --apply; use the approved external Python environment") from error
    config = CosConfig(
        Region=os.environ["COS_REGION"],
        SecretId=os.environ["TENCENTCLOUD_SECRET_ID"],
        SecretKey=os.environ["TENCENTCLOUD_SECRET_KEY"],
        Scheme="https",
    )
    return CosS3Client(config), os.environ["COS_BUCKET"]


def remote_disposition(client: Any, bucket: str, key: str, asset: Asset) -> str:
    try:
        remote = client.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        status = error_status(error)
        if status == 404:
            return "missing"
        raise PublishError(f"HEAD failed for {key} (HTTP {status or 'unknown'})") from error
    remote_size = metadata_value(remote, "content-length")
    remote_hash = metadata_value(remote, "x-cos-meta-sha256")
    remote_encoding = metadata_value(remote, "content-encoding")
    if remote_size == str(asset.size) and remote_hash == asset.sha256 and (remote_encoding or None) == asset.content_encoding:
        return "skip"
    raise PublishError(f"immutable key collision for {key}: existing object does not match size and sha256 metadata")


def upload_asset(client: Any, bucket: str, key: str, asset: Asset) -> None:
    # qcloud_cos upload_file uses multipart uploads as needed; TLS is the SDK default.
    client.upload_file(
        Bucket=bucket,
        LocalFilePath=str(asset.local_path),
        Key=key,
        PartSize=10,
        MAXThread=4,
        EnableMD5=False,
        ContentType=asset.content_type,
        CacheControl=asset.cache_control,
        Metadata={"x-cos-meta-sha256": asset.sha256},
        **({"ContentEncoding": asset.content_encoding} if asset.content_encoding else {}),
    )
    disposition = remote_disposition(client, bucket, key, asset)
    if disposition != "skip":
        raise PublishError(f"post-upload HEAD did not verify {key}")


def make_pointer(payload: dict[str, Any], prefix: str, entry: str, manifest_asset: Asset) -> bytes:
    return (json.dumps({
        "schemaVersion": 1,
        "releaseId": payload["releaseId"],
        "manifest": object_key(prefix, manifest_asset.path),
        "entry": object_key(prefix, entry),
        "activatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def run_publish(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.dir).resolve()
    if not root.is_dir():
        raise PublishError(f"--dir is not a directory: {root}")
    prefix = normalise_prefix(args.prefix)
    files_only = bool(getattr(args, "files_only", False))
    payload, assets, manifest_asset, entry = read_manifest(root, files_only=files_only)
    selected_prefixes = tuple(normalise_relative_path(value, field="--only-prefix").rstrip("/") + "/" for value in getattr(args, "only_prefix", []))
    skip_control_manifest = bool(getattr(args, "skip_control_manifest", False))
    planned = [asset for asset in assets if not selected_prefixes or any(asset.path.startswith(prefix) for prefix in selected_prefixes)]
    if not skip_control_manifest and not files_only:
        planned.append(manifest_asset)
    if not planned:
        raise PublishError("selection contains no assets")
    if args.activate and (files_only or selected_prefixes or skip_control_manifest):
        raise PublishError("--activate requires the complete unfiltered release")
    client = bucket = None
    check_only = bool(getattr(args, "check_only", False))
    if args.head_fixture:
        client = FixtureHeadClient(Path(args.head_fixture).resolve())
        bucket = "fixture"
    elif args.apply or check_only:
        client, bucket = build_cos_client()

    results: list[dict[str, str]] = []
    progress_every = int(getattr(args, "progress_every", 0) or 0)
    if progress_every < 0:
        raise PublishError("--progress-every must not be negative")
    action_counts: dict[str, int] = {}
    action_bytes: dict[str, int] = {}
    for completed, asset in enumerate(planned, 1):
        key = object_key(prefix, asset.path)
        if client is None:
            action = "would-upload"
        else:
            state = remote_disposition(client, bucket, key, asset)
            if state == "skip":
                action = "skipped"
            elif args.apply and not args.head_fixture:
                upload_asset(client, bucket, key, asset)
                action = "uploaded"
            else:
                action = "would-upload"
        results.append({"path": asset.path, "key": key, "action": action, "sha256": asset.sha256})
        action_counts[action] = action_counts.get(action, 0) + 1
        action_bytes[action] = action_bytes.get(action, 0) + asset.size
        if progress_every and (completed % progress_every == 0 or completed == len(planned)):
            print(json.dumps({"event": "progress", "completed": completed, "total": len(planned), "actions": action_counts}, separators=(",", ":")), flush=True)

    pointer_key = object_key(prefix, "current.json")
    pointer_action = "not-requested"
    if args.activate:
        assert entry is not None
        pointer_bytes = make_pointer(payload, prefix, entry, manifest_asset)
        if args.apply and not args.head_fixture:
            client.put_object(
                Bucket=bucket,
                Body=pointer_bytes,
                Key=pointer_key,
                ContentType="application/json",
                CacheControl="no-store, max-age=0",
            )
            pointer_action = "activated"
        else:
            pointer_action = "would-activate"
    return {
        "dryRun": not args.apply or bool(args.head_fixture),
        "fixture": bool(args.head_fixture),
        "releaseId": payload["releaseId"],
        "prefix": prefix,
        "entry": object_key(prefix, entry) if entry is not None else None,
        "manifest": object_key(prefix, manifest_asset.path),
        "objects": results,
        "totalBytes": sum(asset.size for asset in planned),
        "actionBytes": action_bytes,
        "pointer": {"key": pointer_key, "action": pointer_action},
    }


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        asset_bytes = b"asset-fixture"
        asset_hash = hashlib.sha256(asset_bytes).hexdigest()
        asset_relative_path = f"objects/bundle.{asset_hash}.pack"
        asset_path = root / asset_relative_path
        asset_path.parent.mkdir(parents=True)
        asset_path.write_bytes(asset_bytes)
        (root / "publish-manifest.json").write_text(json.dumps({
            "schemaVersion": 1,
            "releaseId": "local-test-release",
            "files": [{
                "path": asset_relative_path,
                "size": len(asset_bytes),
                "hash": asset_hash,
                "contentType": "application/octet-stream",
            }],
            "entry": asset_relative_path,
        }), encoding="utf-8")
        dry_result = run_publish(SimpleNamespace(
            dir=str(root), prefix="ff14-assets/v1", apply=False, activate=True, head_fixture=None,
        ))
        assert [item["action"] for item in dry_result["objects"]] == ["would-upload", "would-upload"]
        assert dry_result["pointer"]["action"] == "would-activate"

        sample = Asset(asset_relative_path, asset_path, len(asset_bytes), asset_hash, "application/octet-stream", "public, max-age=31536000, immutable")
        fixture_path = root / "head.json"
        key = "ff14-assets/v1/" + sample.path
        fixture_path.write_text(json.dumps({"objects": {key: {"status": 200, "size": len(asset_bytes), "sha256": asset_hash}}}), encoding="utf-8")
        assert remote_disposition(FixtureHeadClient(fixture_path), "fixture", key, sample) == "skip"
        fixture_path.write_text(json.dumps({"objects": {key: {"status": 200, "size": len(asset_bytes) + 1, "sha256": "b" * 64}}}), encoding="utf-8")
        try:
            remote_disposition(FixtureHeadClient(fixture_path), "fixture", key, sample)
        except PublishError as error:
            assert "collision" in str(error)
        else:
            raise AssertionError("collision fixture did not fail")
        fixture_path.write_text(json.dumps({"objects": {key: {"status": 503}}}), encoding="utf-8")
        try:
            remote_disposition(FixtureHeadClient(fixture_path), "fixture", key, sample)
        except PublishError as error:
            assert "HTTP 503" in str(error)
        else:
            raise AssertionError("HTTP-error fixture did not fail")
    print("self-test: planner dry-run, HEAD skip, immutable collision, and HEAD HTTP error passed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", help="planner output directory containing publish-manifest.json")
    parser.add_argument("--prefix", default="ff14-assets/v1", help="immutable COS key namespace")
    parser.add_argument("--apply", action="store_true", help="perform COS writes; omitted means dry-run")
    parser.add_argument("--check-only", action="store_true", help="HEAD every selected object without uploading")
    parser.add_argument("--activate", action="store_true", help="write current.json last after all immutable objects verify")
    parser.add_argument("--head-fixture", help="local JSON fixture for HEAD-only verification; never writes COS")
    parser.add_argument("--only-prefix", action="append", default=[], help="publish only a manifest-relative directory prefix; repeatable")
    parser.add_argument("--skip-control-manifest", action="store_true", help="do not upload the derived immutable publish manifest")
    parser.add_argument("--files-only", action="store_true", help="allow a temporary files-only manifest; never uploads a control manifest or activates current.json")
    parser.add_argument("--progress-every", type=int, default=0, help="emit a non-secret progress record after this many objects")
    parser.add_argument("--summary-only", action="store_true", help="print aggregate actions instead of every object result")
    parser.add_argument("--self-test", action="store_true", help="run local HEAD reconciliation tests")
    args = parser.parse_args()
    if args.self_test:
        return args
    if not args.dir:
        parser.error("--dir is required unless --self-test is used")
    return args


def main() -> int:
    args = parse_args()
    try:
        if args.self_test:
            self_test()
            return 0
        if args.check_only and args.activate:
            raise PublishError("--check-only cannot be combined with --activate")
        result = run_publish(args)
        if args.summary_only:
            counts: dict[str, int] = {}
            for item in result["objects"]:
                counts[item["action"]] = counts.get(item["action"], 0) + 1
            print(json.dumps({key: result[key] for key in ("dryRun", "fixture", "releaseId", "prefix", "entry", "manifest", "pointer")}
                             | {"objectCount": len(result["objects"]), "totalBytes": result["totalBytes"],
                                "actions": counts, "actionBytes": result["actionBytes"]}, ensure_ascii=False))
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except PublishError as error:
        print(f"publish-cos: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
