# Babylon Golden Port Preview Deployment

This procedure publishes the isolated Babylon demo at
`/ff14-web-babylon-preview/`. It does not replace the main renderer or change
the main release pointer at `/opt/ff14-web/current`.

## Verified host shape

Read-only remote inspection on September 11, 2026 confirmed:

- The primary gateway is `config-caddy-1` with `/opt/photo-site/config/Caddyfile`.
- The main static sidecar is `ff14-web`, using `caddy:2.8.4-alpine`, network
  `config_default`, and a read-only `/opt/ff14-web -> /srv` mount. Its command
  serves `/srv/current/site`.
- The existing `/opt/ff14-web-preview` sidecar and its legacy route remain
  separate and are not reused by this release.
- The shared ticket sidecar mounts `/opt/ff14-web/current/ticket`; this
  procedure does not restart or rewrite it.
- `/opt/ff14-web-babylon-preview` was absent during that preflight.

The new route adds one independent `ff14-web-babylon-preview` Caddy sidecar on
`config_default`, mounted read-only from
`/opt/ff14-web-babylon-preview/current/site/current`. The outer Caddyfile gets
one managed block with a bare-path `308` redirect and a
`handle_path /ff14-web-babylon-preview/*` route. Existing main-route text,
main index hash, and main `current` pointer are checked before and after the
cutover.

## Dry run

Build the preview into `site-babylon-preview/` first. The helper validates the
deployment base path, rejects local endpoints and secret-like values, and
creates no files unless `--apply` is present.

```powershell
$id = 'v4-kugane-20260912'
python deploy/babylon-preview-release.py prepare `
  --source site-babylon-preview `
  --release-id $id

```

After the local archive has been created with `prepare --apply`, `deploy`
without `--apply` verifies that archive and prints the remote command plan
without opening SSH or changing the host.

## Authorized Deployment

The user has authorized this isolated deployment. No additional human GO is
required. The coordinator serializes builds and release execution so an old
artifact cannot replace a newer one.

```powershell
python deploy/babylon-preview-release.py prepare `
  --source site-babylon-preview `
  --release-id $id `
  --apply

python deploy/babylon-preview-release.py deploy `
  --prepared-dir work/deployment/babylon-preview-release-$id `
  --credentials G:/UGit/rawWeb/initPackage/02_bootstrap `
  --origin <public-http-origin> `
  --apply
```

The credentials file is read only in memory by the local helper and is never
copied into the archive or printed. The public origin is supplied at invocation
or through `FF14_PUBLIC_ORIGIN`; it is not embedded in source code.

## Remote cutover and rollback

The archive is uploaded to `/tmp`, checksum-verified, and extracted below
`/opt/ff14-web-babylon-preview/releases/<release-id>/site/current`. The remote
script then atomically switches the preview-only `current` symlink, recreates
the preview sidecar, validates a candidate Caddyfile, reloads Caddy, and runs
bounded route/main/API checks. It does not publish COS objects, reset caches,
touch the shared ticket service, or alter `/opt/ff14-web/current`.

Before changing the gateway, it saves
`/opt/ff14-web-babylon-preview/backups/Caddyfile-<release-id>`. If any step
fails after the preview switch, it restores that gateway snapshot, restores the
previous preview symlink, and starts the previous preview sidecar again. The
failed release remains on disk for investigation.

The remote script's HTTP checks are not the final browser acceptance. V4 still
requires QA to open and refresh the preview URL. The remote script already
performs the required one main-entry HTTP smoke; do not repeat it by default.

## Mount Diagnosis

Read-only SSH verification on September 12, 2026 returned:

```json
[{"Type":"bind","Source":"/opt/ff14-web","Destination":"/srv","RW":false}]
```

The complete Go template
`{{range .Mounts}}{{if eq .Destination "/srv"}}{{.Source}}{{end}}{{end}}`
successfully returns `/opt/ff14-web`, exit 0. The mount is not missing.
An earlier after-check omitted one `{{end}}` and produced `unexpected EOF`.
The subsequent Python variant introduced a separate error: `json .Mounts`
already returns the array, so `[0]["Mounts"]` was invalid. Both checks now
iterate `json.load(sys.stdin)` directly.

Content-level verification after cutover:

```powershell
node scripts/verify-babylon-deployment.mjs --origin=https://yuluo.site
```

This compares preview HTML/script/CSS/worker/build-metadata hashes to the local
release, distinguishes preview from the catch-all and unchanged main entry,
and checks `/api/healthz` JSON. `build-info.json` records the native engine
version, imported Three module count and runtime source SHA-256.
