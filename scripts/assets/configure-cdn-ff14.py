#!/usr/bin/env python3
"""Additive FF14 browser-read CORS headers for the existing private COS/CDN path.

Reads credentials only from process environment. Default mode prints a plan; --apply
writes a non-secret backup before changing COS bucket CORS and CDN response headers.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


CDN_DOMAIN = "img.yuluo.site"
# Tencent CDN's directory matcher accepts this path without a trailing slash.
ASSET_DIRECTORY = "/ff14-assets"
FF14_CORS_ID = "ff14-assets-browser-read-v1"
ORIGIN = "https://yuluo.site"
FF14_CORS_RULE = {
    "ID": FF14_CORS_ID,
    "AllowedOrigin": [ORIGIN],
    "AllowedMethod": ["GET", "HEAD"],
    "AllowedHeader": ["Range", "Content-Type"],
    "ExposeHeader": ["Accept-Ranges", "Content-Length", "Content-Range", "ETag", "x-cos-request-id"],
    "MaxAgeSeconds": "600",
}
FF14_RESPONSE_HEADERS = {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Content-Type",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
    "Timing-Allow-Origin": ORIGIN,
}


class ConfigError(RuntimeError):
    pass


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"missing required environment variable: {name}")
    return value


def clients() -> tuple[Any, Any, str]:
    try:
        from qcloud_cos import CosConfig, CosS3Client
        from tencentcloud.cdn.v20180606 import cdn_client
        from tencentcloud.common import credential
    except ImportError as error:
        raise ConfigError("the approved Python environment must provide qcloud_cos and tencentcloud SDKs") from error
    secret_id = require_env("TENCENTCLOUD_SECRET_ID")
    secret_key = require_env("TENCENTCLOUD_SECRET_KEY")
    region = require_env("COS_REGION")
    bucket = require_env("COS_BUCKET")
    cos = CosS3Client(CosConfig(Region=region, SecretId=secret_id, SecretKey=secret_key, Scheme="https"))
    cdn = cdn_client.CdnClient(credential.Credential(secret_id, secret_key), "")
    return cos, cdn, bucket


def as_json(model: Any) -> dict[str, Any] | None:
    return json.loads(model.to_json_string()) if model is not None else None


def read_state(cos: Any, cdn: Any, bucket: str) -> dict[str, Any]:
    from tencentcloud.cdn.v20180606 import models
    request = models.DescribeDomainsConfigRequest()
    request.Offset = 0
    request.Limit = 10
    domain_filter = models.DomainFilter()
    domain_filter.Name = "domain"
    domain_filter.Value = [CDN_DOMAIN]
    domain_filter.Fuzzy = False
    request.Filters = [domain_filter]
    domains = cdn.DescribeDomainsConfig(request).Domains or []
    domain = next((item for item in domains if item.Domain == CDN_DOMAIN), None)
    if domain is None:
        raise ConfigError(f"CDN domain not found: {CDN_DOMAIN}")
    cors = cos.get_bucket_cors(Bucket=bucket)
    rules = cors.get("CORSRule") or []
    if isinstance(rules, dict):
        rules = [rules]
    return {
        "schemaVersion": 1,
        "cdnDomain": CDN_DOMAIN,
        "assetDirectory": ASSET_DIRECTORY,
        "bucketCorsRules": rules,
        "cdnResponseHeader": as_json(domain.ResponseHeader),
        "cdnCacheKey": as_json(domain.CacheKey),
        "cdnRangeOriginPull": as_json(domain.RangeOriginPull),
        "cdnCache": as_json(domain.Cache),
        "cdnAuthentication": {"enabled": bool(domain.Authentication and domain.Authentication.Switch == "on")},
    }


def response_header_after(before: dict[str, Any]) -> dict[str, Any]:
    config = dict(before or {})
    rules = list(config.get("HeaderRules") or [])
    retained = [rule for rule in rules if not (
        rule.get("RuleType") == "directory" and rule.get("RulePaths") == [ASSET_DIRECTORY]
        and rule.get("HeaderName") in FF14_RESPONSE_HEADERS
    )]
    retained.extend({
        "HeaderMode": "set",
        "HeaderName": name,
        "HeaderValue": value,
        "RuleType": "directory",
        "RulePaths": [ASSET_DIRECTORY],
    } for name, value in FF14_RESPONSE_HEADERS.items())
    return {"Switch": "on", "HeaderRules": retained}


def bucket_cors_after(before: list[dict[str, Any]]) -> list[dict[str, Any]]:
    retained = [rule for rule in before if rule.get("ID") != FF14_CORS_ID]
    return [*retained, FF14_CORS_RULE]


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def configure(args: argparse.Namespace) -> dict[str, Any]:
    cos, cdn, bucket = clients()
    before = read_state(cos, cdn, bucket)
    after = {
        "bucketCorsRules": bucket_cors_after(before["bucketCorsRules"]),
        "cdnResponseHeader": response_header_after(before["cdnResponseHeader"]),
    }
    plan = {
        "before": before,
        "patch": {
            "bucketCorsAdditiveRule": FF14_CORS_RULE,
            "cdnResponseHeaderDirectory": ASSET_DIRECTORY,
            "cdnResponseHeaders": FF14_RESPONSE_HEADERS,
            "cacheQueryPolicyPreserved": before["cdnCacheKey"],
            "rangeOriginPullPreserved": before["cdnRangeOriginPull"],
            "authenticationPreserved": before["cdnAuthentication"],
        },
        "after": after,
        "applied": False,
    }
    if not args.apply:
        return plan
    backup = Path(args.backup).resolve()
    if backup.exists() and not args.resume_with_backup:
        raise ConfigError(f"refusing to overwrite backup: {backup}")
    if not backup.exists():
        write_json(backup, before)
    try:
        cos.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRule": after["bucketCorsRules"]})
        from tencentcloud.cdn.v20180606 import models
        request = models.ModifyDomainConfigRequest()
        request.Domain = CDN_DOMAIN
        request.Route = "ResponseHeader"
        request.Value = json.dumps({"update": after["cdnResponseHeader"]}, separators=(",", ":"))
        cdn.ModifyDomainConfig(request)
    except Exception:
        # The on-disk backup is the rollback source. Do not guess at partial recovery here.
        raise
    verified = None
    for _ in range(6):
        candidate = read_state(cos, cdn, bucket)
        cors_ok = FF14_CORS_RULE in candidate["bucketCorsRules"]
        headers_ok = all(any(rule.get("HeaderName") == name and rule.get("HeaderValue") == value and rule.get("RulePaths") == [ASSET_DIRECTORY]
                             for rule in (candidate["cdnResponseHeader"] or {}).get("HeaderRules") or [])
                         for name, value in FF14_RESPONSE_HEADERS.items())
        if cors_ok and headers_ok:
            verified = candidate
            break
        time.sleep(2)
    if verified is None:
        raise ConfigError("post-apply verification did not converge; use the saved backup to roll back")
    plan["applied"] = True
    plan["verified"] = {
        "cacheQueryPolicy": verified["cdnCacheKey"],
        "rangeOriginPull": verified["cdnRangeOriginPull"],
        "authentication": verified["cdnAuthentication"],
    }
    return plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", help="new non-secret state backup path; required with --apply")
    parser.add_argument("--resume-with-backup", action="store_true", help="resume a previously interrupted apply using its existing backup")
    args = parser.parse_args()
    if args.apply and not args.backup:
        parser.error("--backup is required with --apply")
    try:
        print(json.dumps(configure(args), ensure_ascii=False, indent=2))
        return 0
    except ConfigError as error:
        print(f"configure-cdn-ff14: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
