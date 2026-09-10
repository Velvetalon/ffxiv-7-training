#!/usr/bin/env bash
# Activate a small application archive with an already verified world resource tree.
set -Eeuo pipefail
release_id=${1:?release id required}
app_sha=${2:?application archive checksum required}
git_sha=${3:?git commit required}
world_run=${4:?world run id required}
expected_maps=${5:?expected map count required}
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]]
[[ "$world_run" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$ ]]
[[ "$app_sha" =~ ^[0-9a-f]{64}$ && "$git_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$expected_maps" =~ ^[1-9][0-9]*$ ]]
root=/opt/ff14-web
source="$root/staging/world-$world_run/site/extracted/$world_run"
release="$root/releases/$release_id"
archive="/tmp/ff14-app-$release_id.tar.gz"
printf '%s  %s\n' "$app_sha" "$archive" | sha256sum -c -
test -d "$source"
test ! -e "$release"
test -L "$root/current"
previous=$(readlink "$root/current")
mkdir -p "$release"
tar -xzf "$archive" --no-same-owner -C "$release"
test -s "$release/site/index.html"
test -s "$release/site/extracted/active.json"
mkdir -p "$release/site/extracted"
# Same-filesystem hard links preserve the verified staging tree for rollback
# without storing another entire world. The files are immutable after staging.
cp -al "$source" "$release/site/extracted/$world_run"
python3 - "$release/site" "$world_run" "$expected_maps" <<'PY'
import hashlib, json, sys
from pathlib import Path
site = Path(sys.argv[1]).resolve()
world, expected = sys.argv[2], int(sys.argv[3])
active = json.loads((site / 'extracted/active.json').read_text())
assert len(active['scenes']) == expected
assert active['runId'] == world
receipts = site / 'extracted' / world / '.prestage-manifests'
models, connections = 0, 0
for scene, record in active['scenes'].items():
    assert record['base'] == f'{world}/{scene}/'
    directory = site / 'extracted' / record['base']
    manifest_bytes = (directory / 'scene.json').read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == record['manifestSha256'], scene
    manifest = json.loads(manifest_bytes)
    assert manifest['scene'] == scene and not manifest['errors'], scene
    receipt = json.loads((receipts / f'{scene}.json').read_text())
    assert receipt['scene'] == scene and receipt['fileCount'] > 0
    assert sum(1 for p in directory.rglob('*') if p.is_file()) == receipt['fileCount'], scene
    for model in manifest['models']:
        resource = (directory / model['url']).resolve()
        assert resource.is_relative_to(directory.resolve()) and resource.is_file()
    for edge in manifest.get('connections', []):
        assert edge['targetScene'] in active['scenes'], (scene, edge['id'])
        connections += 1
    models += len(manifest['models'])
assert connections > 0
print(json.dumps({'maps': expected, 'models': models, 'connections': connections}))
PY
mv "$release/site/extracted/$world_run/.prestage-manifests" "$release/resource-receipts"
switched=0
rollback() {
  local code=$?
  trap - ERR
  if [ "$switched" = 1 ]; then
    ln -s "$previous" "$root/restore-$release_id"
    mv -Tf "$root/restore-$release_id" "$root/current"
  fi
  printf 'World activation failed; previous release retained: %s\n' "$previous"
  exit "$code"
}
trap rollback ERR
ln -s "releases/$release_id" "$root/next-$release_id"
mv -Tf "$root/next-$release_id" "$root/current"
switched=1
test "$(docker inspect ff14-web --format '{{.State.Running}}')" = true
curl -fsS https://yuluo.site/ff14-web/ -o "$release/served-index.html"
cmp "$release/site/index.html" "$release/served-index.html"
test "$(curl -sS -o /dev/null -w '%{http_code}' https://yuluo.site/ff14-web)" = 308
curl -fsS https://yuluo.site/api/healthz >/dev/null
curl -fsS https://yuluo.site/ >/dev/null
python3 - "$release" "$release_id" "$git_sha" "$app_sha" "$world_run" "$previous" <<'PY'
import json, sys
from pathlib import Path
directory, release, git, archive, world, previous = sys.argv[1:]
Path(directory, 'deployment.json').write_text(json.dumps({
    'releaseId': release, 'gitSha': git, 'applicationArchiveSha256': archive,
    'worldRunId': world, 'previous': previous, 'status': 'deployed',
    'url': 'https://yuluo.site/ff14-web/'
}, indent=2) + '\n')
PY
trap - ERR
printf 'DEPLOYED=%s\nGIT_SHA=%s\nWORLD=%s\n' "$release_id" "$git_sha" "$world_run"
