#!/usr/bin/env bash
# Atomically publish the isolated Babylon preview without changing the main FF14 release.
set -Eeuo pipefail

release_id=${1:?release id required}
archive_sha=${2:?archive sha256 required}
site_origin=${3:?public site origin required}
case "$release_id" in (*[!A-Za-z0-9._-]*|'') exit 2;; esac
case "$archive_sha" in (''|*[!a-f0-9]*) exit 2;; esac
test "${#archive_sha}" -eq 64
case "$site_origin" in
  https://[A-Za-z0-9._:-]*|http://[A-Za-z0-9._:-]*) ;;
  *) echo "public site origin must be an http(s) host without a path" >&2; exit 2 ;;
esac
site_origin=${site_origin%/}

root=/opt/ff14-web-babylon-preview
main_root=/opt/ff14-web
gateway=/opt/photo-site/config/Caddyfile
archive=/tmp/ff14-babylon-preview-${release_id}.tar.gz
release="${root}/releases/${release_id}"
backup="${root}/backups/Caddyfile-${release_id}"
candidate="${release}/Caddyfile"

test -f "$archive"
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum -c -
test ! -e "$release"
test -f "$gateway"
test -L "$main_root/current"

if [ -L "$root/current" ]; then
  previous=$(readlink "$root/current")
elif [ -e "$root/current" ]; then
  echo "refusing a non-symlink preview current path" >&2
  exit 2
else
  previous=""
fi

main_current=$(readlink "$main_root/current")
main_index_sha=$(sha256sum "$main_root/current/site/index.html" | awk '{print $1}')
main_gateway_sha=$(sha256sum "$gateway" | awk '{print $1}')
main_mount=$(docker inspect ff14-web --format '{{json .Mounts}}' | python3 -c 'import json,sys; print(next((m["Source"] for m in json.load(sys.stdin) if m.get("Destination")=="/srv"), ""))')
main_command=$(docker inspect ff14-web --format '{{json .Config.Cmd}}')
test "$main_mount" = "$main_root"

main_route_sha() {
  python3 - "$1" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = "  # ff14-web managed start\n"
end = "  # ff14-web managed end\n"
if text.count(start) != 1 or text.count(end) != 1:
    raise SystemExit("main ff14-web managed block is not unique")
block = text.split(start, 1)[1].split(end, 1)[0]
print(sha256((start + block + end).encode()).hexdigest())
PY
}

main_route_sha_before=$(main_route_sha "$gateway")
test "$(grep -c '# ff14-web managed start' "$gateway")" -eq 1

mkdir -p "$release" "${root}/backups"
while IFS= read -r member; do
  case "$member" in
    /*|../*|*/../*|*'/..'|*'..')
      echo "unsafe archive member: $member" >&2
      exit 2
      ;;
  esac
done < <(tar -tzf "$archive")
tar -xzf "$archive" --no-same-owner -C "$release"
test -s "$release/site/current/index.html"
test ! -e "$release/site/current/ticket"
if find "$release/site/current" -type l -print -quit | grep -q .; then
  echo "preview archive must not contain symlinks" >&2
  exit 2
fi
grep -R -I -F -m1 '/ff14-web-babylon-preview/' "$release/site/current" >/dev/null
if grep -R -I -n -E 'localhost(:|/)|127\.0\.0\.1|CDN_AUTH_SECRET|SERVER_PASSWD' "$release/site/current" >/dev/null; then
  echo "preview site contains a local endpoint or secret-like value" >&2
  exit 2
fi

cp -p "$gateway" "$backup"

python3 - "$gateway" "$candidate" <<'PY'
from pathlib import Path
import sys

gateway, candidate = map(Path, sys.argv[1:])
text = gateway.read_text(encoding="utf-8")
start = "  # ff14-babylon-preview managed start\n"
end = "  # ff14-babylon-preview managed end\n"
if start in text or end in text:
    if text.count(start) != 1 or text.count(end) != 1:
        raise RuntimeError("Babylon preview managed block is not unique")
    before, rest = text.split(start, 1)
    _, after = rest.split(end, 1)
    text = before + after
anchor = "  reverse_proxy app:8000\n"
if text.count(anchor) != 2:
    raise RuntimeError("Unexpected gateway layout; refusing a blind replacement")
block = """  # ff14-babylon-preview managed start
  redir /ff14-web-babylon-preview /ff14-web-babylon-preview/ 308
  handle_path /ff14-web-babylon-preview/* {
    header {
      X-Content-Type-Options nosniff
      Referrer-Policy strict-origin-when-cross-origin
    }
    reverse_proxy ff14-web-babylon-preview:8080
  }
  # ff14-babylon-preview managed end
"""
candidate.write_text(text.replace(anchor, block + anchor, 1), encoding="utf-8")
PY

switched=0
gateway_changed=0
rollback() {
  code=$?
  trap - ERR
  if [ "$gateway_changed" -eq 1 ]; then
    cat "$backup" > "$gateway" || true
    docker exec config-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  fi
  if [ "$switched" -eq 1 ]; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "${root}/rollback-${release_id}"
      mv -Tf "${root}/rollback-${release_id}" "$root/current"
    else
      rm -f "$root/current"
    fi
  fi
  docker rm -f ff14-web-babylon-preview >/dev/null 2>&1 || true
  if [ -n "$previous" ]; then
    docker run -d --name ff14-web-babylon-preview --restart unless-stopped --network config_default \
      --mount type=bind,source="${root}/current/site/current",target=/srv,readonly \
      caddy:2.8.4-alpine caddy file-server --listen :8080 --root /srv >/dev/null 2>&1 || true
  fi
  printf 'Deployment failed; restored preview pointer/config. Failed release retained: %s\n' "$release" >&2
  exit "$code"
}
trap rollback ERR

ln -s "releases/${release_id}" "${root}/next-${release_id}"
mv -Tf "${root}/next-${release_id}" "$root/current"
switched=1
docker rm -f ff14-web-babylon-preview >/dev/null 2>&1 || true
docker run -d --name ff14-web-babylon-preview --restart unless-stopped --network config_default \
  --mount type=bind,source="${root}/current/site/current",target=/srv,readonly \
  caddy:2.8.4-alpine caddy file-server --listen :8080 --root /srv >/dev/null

docker cp "$candidate" config-caddy-1:/tmp/ff14-babylon-preview-${release_id}.Caddyfile
docker exec config-caddy-1 caddy validate --config /tmp/ff14-babylon-preview-${release_id}.Caddyfile --adapter caddyfile
test "$(sha256sum "$gateway" | awk '{print $1}')" = "$main_gateway_sha"
gateway_changed=1
cat "$candidate" > "$gateway"
docker exec config-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

for _ in 1 2 3 4 5; do
  if curl -fsS "$site_origin/ff14-web-babylon-preview/" -o "$release/served-index.html"; then break; fi
  sleep 1
done
cmp "$release/site/current/index.html" "$release/served-index.html"
preview_bare_status=$(curl -sS -o /dev/null -w '%{http_code}' "$site_origin/ff14-web-babylon-preview")
test "$preview_bare_status" = 308
curl -fsS "$site_origin/ff14-web-babylon-preview/" >/dev/null
curl -fsS "$site_origin/ff14-web/" >/dev/null
curl -fsS "$site_origin/api/healthz" >/dev/null

main_current_after=$(readlink "$main_root/current")
main_index_sha_after=$(sha256sum "$main_root/current/site/index.html" | awk '{print $1}')
main_mount_after=$(docker inspect ff14-web --format '{{json .Mounts}}' | python3 -c 'import json,sys; print(next((m["Source"] for m in json.load(sys.stdin) if m.get("Destination")=="/srv"), ""))')
main_command_after=$(docker inspect ff14-web --format '{{json .Config.Cmd}}')
main_route_sha_after=$(main_route_sha "$gateway")
test "$main_current_after" = "$main_current"
test "$main_index_sha_after" = "$main_index_sha"
test "$main_mount_after" = "$main_mount"
test "$main_command_after" = "$main_command"
test "$main_route_sha_after" = "$main_route_sha_before"
test "$(grep -c '# ff14-web managed start' "$gateway")" -eq 1

python3 - "$release/deployment.json" "$release_id" "$archive_sha" "$previous" "$backup" "$site_origin" "$main_gateway_sha" <<'PY'
import json
import sys
from pathlib import Path

path, release_id, archive_sha, previous, backup, site_origin, main_gateway_sha = sys.argv[1:]
Path(path).write_text(json.dumps({
    "releaseId": release_id,
    "archiveSha256": archive_sha,
    "mainGatewaySha256Before": main_gateway_sha,
    "previous": previous,
    "gatewayBackup": backup,
    "url": site_origin + "/ff14-web-babylon-preview/",
    "status": "deployed",
}, indent=2) + "\n", encoding="utf-8")
PY

trap - ERR
printf 'DEPLOYED=%s\nREADY_URL=%s/ff14-web-babylon-preview/\nPREVIOUS=%s\nROLLBACK_CADDY=%s\nMAIN_CURRENT_PRESERVED=%s\nMAIN_GATEWAY_BEFORE_SHA=%s\nONLINE_CHECK=bounded-server\n' \
  "$release_id" "$site_origin" "$previous" "$backup" "$(readlink "$main_root/current")" "$main_gateway_sha"
