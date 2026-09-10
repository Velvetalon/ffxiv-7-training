#!/usr/bin/env bash
set -Eeuo pipefail
release_id=${1:?release id required}
archive_sha=${2:?archive checksum required}
git_sha=${3:?git sha required}
expected_maps=${4:?expected map count required}
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]]
[[ "$archive_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$git_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$expected_maps" =~ ^[1-9][0-9]*$ ]]
root=/opt/ff14-web
release="$root/releases/$release_id"
archive="/tmp/ff14-site-$release_id.tar.gz"
gateway=/opt/photo-site/config/Caddyfile
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum -c -
test ! -e "$release"
test ! -e "$root/current" || test -L "$root/current"
mkdir -p "$release" "$root/backups"
tar -xzf "$archive" --no-same-owner -C "$release"
test -s "$release/site/index.html"
python3 - "$release/site/extracted" "$expected_maps" <<'PY'
import gzip, hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
active = json.loads((root / 'active.json').read_text())
assert len(active['scenes']) == int(sys.argv[2]), 'Incomplete world map count'
assert 'gridania' in active['scenes'] and 'limsa' in active['scenes'], 'Original cities missing'
manifests = {}
def child(parent, relative):
    result = (parent / relative).resolve()
    assert result.is_relative_to(root), f'Resource escaped deployment: {relative}'
    assert result.is_file(), f'Missing runtime resource: {relative}'
    return result
for scene, record in active['scenes'].items():
    folder = (root / record['base']).resolve()
    manifest_path = child(folder, 'scene.json')
    assert hashlib.sha256(manifest_path.read_bytes()).hexdigest() == record['manifestSha256'], scene
    manifest = json.loads(manifest_path.read_text())
    assert manifest['scene'] == scene and not manifest['errors'], scene
    child(folder, 'map.png')
    for model in manifest['models']:
        child(folder, model['url'])
    for material in manifest['materials'].values():
        for field in ('map', 'normalMap', 'specularMap', 'secondaryMap', 'secondaryNormalMap'):
            if material.get(field):
                child(folder, material[field])
    collision = child(folder, manifest.get('collisionFile', 'collision.bin')).read_bytes()
    if manifest.get('collisionEncoding') == 'gzip':
        collision = gzip.decompress(collision)
        assert len(collision) == manifest['collisionBytes'], scene
        assert hashlib.sha256(collision).hexdigest() == manifest['collisionSha256'], scene
    manifests[scene] = manifest
connections = 0
for scene, manifest in manifests.items():
    for edge in manifest.get('connections', []):
        assert edge['targetScene'] in manifests, (scene, edge['id'])
        if edge.get('targetConnection'):
            target = next((item for item in manifests[edge['targetScene']].get('connections', []) if item['id'] == edge['targetConnection']), None)
            assert target and target['targetScene'] == scene, (scene, edge['id'])
        else:
            assert len(edge['arrival']) == 3, (scene, edge['id'])
        connections += 1
assert connections > 0, 'No world connections in the release'
print(json.dumps({'verifiedMaps': len(manifests), 'verifiedConnections': connections}))
PY
previous=$(readlink "$root/current" || true)
backup="$root/backups/Caddyfile-$release_id"
cp -p "$gateway" "$backup"
created_container=0
changed_gateway=0
switched=0
rollback() {
  local code=$?
  trap - ERR
  if [ "$changed_gateway" = 1 ]; then
    cat "$backup" > "$gateway"
    docker exec config-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
  fi
  if [ "$switched" = 1 ]; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "$root/rollback-$release_id"
      mv -Tf "$root/rollback-$release_id" "$root/current"
    else
      rm -f "$root/current"
    fi
  fi
  if [ "$created_container" = 1 ]; then docker rm -f ff14-web || true; fi
  printf 'Deployment failed; restored prior route and release. Failed release retained: %s\n' "$release"
  exit "$code"
}
trap rollback ERR
ln -s "releases/$release_id" "$root/next-$release_id"
mv -Tf "$root/next-$release_id" "$root/current"
switched=1
if docker container inspect ff14-web >/dev/null 2>&1; then
  test "$(docker inspect ff14-web --format '{{.State.Running}}')" = true
  test "$(docker inspect ff14-web --format '{{range .Mounts}}{{if eq .Destination "/srv"}}{{.Source}}{{end}}{{end}}')" = "$root"
else
  docker run -d --name ff14-web --restart unless-stopped --network config_default \
    --mount type=bind,source="$root",target=/srv,readonly \
    caddy:2.8.4-alpine caddy file-server --listen :8080 --root /srv/current/site
  created_container=1
fi
candidate="$release/Caddyfile"
python3 - "$gateway" "$candidate" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
if '# ff14-web managed start' not in text:
    anchor = '  reverse_proxy app:8000\n'
    if text.count(anchor) != 2:
        raise RuntimeError('Unexpected gateway layout; refusing a blind replacement.')
    block = '''  # ff14-web managed start
  redir /ff14-web /ff14-web/ 308
  handle_path /ff14-web/* {
    reverse_proxy ff14-web:8080
  }
  # ff14-web managed end
'''
    text = text.replace(anchor, block + anchor, 1)
Path(sys.argv[2]).write_text(text)
PY
docker cp "$candidate" config-caddy-1:/tmp/ff14-candidate.Caddyfile
docker exec config-caddy-1 caddy validate --config /tmp/ff14-candidate.Caddyfile --adapter caddyfile
# Preserve the existing file inode: Caddy's current container binds this file.
changed_gateway=1
cat "$candidate" > "$gateway"
docker exec config-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
for attempt in 1 2 3 4 5; do
  if curl -fsS https://yuluo.site/ff14-web/ -o "$release/served-index.html" && grep -q Aetheryte "$release/served-index.html"; then break; fi
  sleep 1
done
grep -q Aetheryte "$release/served-index.html"
cmp "$release/site/index.html" "$release/served-index.html"
test "$(curl -sS -o /dev/null -w '%{http_code}' https://yuluo.site/ff14-web)" = 308
curl -fsS https://yuluo.site/api/healthz >/dev/null
curl -fsS https://yuluo.site/ >/dev/null
python3 - "$release" "$release_id" "$git_sha" "$archive_sha" "$previous" "$backup" <<'PY'
import json, sys
from pathlib import Path
root, release, git, checksum, previous, backup = sys.argv[1:]
Path(root, 'deployment.json').write_text(json.dumps({
    'releaseId': release, 'gitSha': git, 'archiveSha256': checksum,
    'previous': previous, 'gatewayBackup': backup,
    'url': 'https://yuluo.site/ff14-web/', 'status': 'deployed'
}, indent=2) + '\n')
PY
trap - ERR
printf 'DEPLOYED=%s\nGIT_SHA=%s\n' "$release_id" "$git_sha"
docker ps --format '{{.Names}} {{.Status}}'
