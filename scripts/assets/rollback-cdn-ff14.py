#!/usr/bin/env python3
"""Restore COS bucket CORS and CDN response-header configuration from a safe backup."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

_configure_path = Path(__file__).with_name("configure-cdn-ff14.py")
_spec = importlib.util.spec_from_file_location("configure_cdn_ff14", _configure_path)
if _spec is None or _spec.loader is None:
    raise RuntimeError("cannot load configure-cdn-ff14.py")
_configure = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_configure)
CDN_DOMAIN = _configure.CDN_DOMAIN
ConfigError = _configure.ConfigError
clients = _configure.clients
read_state = _configure.read_state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", required=True)
    parser.add_argument("--apply", action="store_true", help="required to mutate cloud configuration")
    args = parser.parse_args()
    if not args.apply:
        print("rollback-cdn-ff14: dry-run; pass --apply to restore the supplied backup")
        return 0
    try:
        backup = json.loads(Path(args.backup).read_text(encoding="utf-8"))
        if backup.get("schemaVersion") != 1 or backup.get("cdnDomain") != CDN_DOMAIN:
            raise ConfigError("backup is not an FF14 CDN configuration backup")
        cos, cdn, bucket = clients()
        cos.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRule": backup["bucketCorsRules"]})
        from tencentcloud.cdn.v20180606 import models
        request = models.ModifyDomainConfigRequest()
        request.Domain = CDN_DOMAIN
        request.Route = "ResponseHeader"
        request.Value = json.dumps({"update": backup["cdnResponseHeader"]}, separators=(",", ":"))
        cdn.ModifyDomainConfig(request)
        current = read_state(cos, cdn, bucket)
        if current["bucketCorsRules"] != backup["bucketCorsRules"] or current["cdnResponseHeader"] != backup["cdnResponseHeader"]:
            raise ConfigError("rollback post-check did not exactly match backup")
        print(json.dumps({"rolledBack": True, "cdnDomain": CDN_DOMAIN}, ensure_ascii=False))
        return 0
    except (ConfigError, OSError, json.JSONDecodeError) as error:
        print(f"rollback-cdn-ff14: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
