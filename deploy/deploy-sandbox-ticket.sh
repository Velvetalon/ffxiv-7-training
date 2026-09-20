#!/usr/bin/env bash
# Atomic Sandbox ticket-mode deployment. It performs only bounded server health
# checks; a successful exit is the terminal online verification for this release.
set -Eeuo pipefail

release_id=${1:?release id}
archive_sha=${2:?archive sha256}
case "$release_id" in (*[!A-Za-z0-9._-]*|'') exit 2;; esac
root=/opt/ff14-web
archive=/tmp/ff14-sandbox-${release_id}.tar.gz
release="${root}/releases/${release_id}"
test -f "$archive" && test ! -e "$release"
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum -c -

mkdir -p "$release"
tar -xzf "$archive" --no-same-owner -C "$release"
test -s "$release/site/index.html"
test -s "$release/site/sandbox/manifest.json"
test -s "$release/ticket/asset-ticket-server.mjs"
test -s "$release/ticket/publish-manifest.json"
test ! -e "$release/site/assets/world" && test ! -e "$release/site/extracted/world"
python3 - "$release/site/extracted/active.json" "$release/ticket/publish-manifest.json" <<'PY'
import json, sys
active=json.load(open(sys.argv[1], encoding='utf-8'))
ticket=json.load(open(sys.argv[2], encoding='utf-8'))
assert len(active['scenes']) == 65
assert active['assetPipeline'] == {'ticket':'/ff14-assets/ticket'}
assert ticket['entry'].startswith('catalog_')
assert len(ticket['files']) > 8115
assert any(item['path'].startswith('sandbox_') for item in ticket['files'])
PY

previous=$(readlink "$root/current")
previous_manifests=()
for name in publish-manifest.json previous-publish-manifest.json previous-2-publish-manifest.json; do
  source="${root}/current/ticket/${name}"
  test -f "$source" || continue
  case "$name" in
    publish-manifest.json) target=previous-publish-manifest.json ;;
    previous-publish-manifest.json) target=previous-2-publish-manifest.json ;;
    previous-2-publish-manifest.json) target=previous-3-publish-manifest.json ;;
  esac
  cp -p "$source" "$release/ticket/$target"
  previous_manifests+=("/app/${target}")
done
previous_manifest=$(IFS=';'; echo "${previous_manifests[*]}")
env_file="${root}/ticket-${release_id}.env"
umask 077
secret=$(grep '^CDN_AUTH_SECRET=' /opt/photo-site/config/.env.production | cut -d= -f2-)
test -n "$secret"
cat > "$env_file" <<EOF
CDN_ORIGIN=https://img.yuluo.site
CDN_AUTH_SECRET=$secret
ASSET_PREFIX=ff14-assets/v1
TICKET_MANIFEST_PATH=/app/publish-manifest.json
TICKET_PREVIOUS_MANIFEST_PATHS=$previous_manifest
HOST=0.0.0.0
PORT=8790
EOF
unset secret

run_ticket() {
  docker rm -f ff14-asset-ticket >/dev/null 2>&1 || true
  docker run -d --name ff14-asset-ticket --restart unless-stopped --network config_default \
    --env-file "$1" --mount type=bind,source="$2/ticket",target=/app,readonly \
    node:22-alpine node /app/asset-ticket-server.mjs >/dev/null
}

switched=0
rollback() {
  code=$?; trap - ERR
  if [ "$switched" = 1 ]; then
    ln -s "$previous" "$root/restore-${release_id}"
    mv -Tf "$root/restore-${release_id}" "$root/current"
    # Docker bind mounts resolve their source when the container starts, so restart
    # the sidecar against the restored release rather than trusting the symlink.
    previous_env="${root}/ticket-$(basename "$previous").env"
    test -f "$previous_env" && run_ticket "$previous_env" "${root}/current" || true
  fi
  exit "$code"
}
trap rollback ERR

ln -s "releases/${release_id}" "$root/next-${release_id}"
mv -Tf "$root/next-${release_id}" "$root/current"
switched=1
run_ticket "$env_file" "${root}/current"
for _ in 1 2 3 4 5; do curl -fsS https://yuluo.site/ff14-web/ -o "$release/served-index.html" && break || sleep 1; done
cmp "$release/site/index.html" "$release/served-index.html"
test "$(curl -sS -o /dev/null -w '%{http_code}' https://yuluo.site/ff14-web)" = 308
curl -fsS https://yuluo.site/api/healthz >/dev/null
# The ticket sidecar is recreated just above; wait for it to bind before
# treating a connection refusal as a deployment failure.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS https://yuluo.site/ff14-assets/healthz >/dev/null; then break; fi
  sleep 2
done
curl -fsS https://yuluo.site/ff14-assets/healthz >/dev/null
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS 'https://yuluo.site/ff14-assets/ticket?mode=batch' -o "$release/ticket-bootstrap.json"; then break; fi
  sleep 2
done
curl -fsS 'https://yuluo.site/ff14-assets/ticket?mode=batch' -o "$release/ticket-bootstrap.json"
python3 - "$release/ticket-bootstrap.json" "$release/ticket/publish-manifest.json" <<'PY'
import json, sys
doc=json.load(open(sys.argv[1])); manifest=json.load(open(sys.argv[2]))
assert doc['entryKey'] == 'ff14-assets/v1/' + manifest['entry']
assert doc['supportsBatch'] is True
assert doc['entryKey'] in doc['urls']
PY
printf 'DEPLOYED=%s\nPREVIOUS=%s\nCURRENT=%s\nONLINE_FOLLOWUP=prohibited-after-success\n' "$release_id" "$previous" "$(readlink "$root/current")"
