# Sandbox Release Preparation

This procedure adds character, animation, mount, and audio packs to the existing
ticket/CDN delivery path. It does not create a server, protocol, account system,
or a second CDN namespace.

## Reused immutable resources

- The established `ff14-assets/v1` COS prefix and its CDN authentication/CORS
  configuration remain unchanged.
- `work/asset-performance/packed-all-final` is the complete 65-map world source.
  Its 8,115 objects are not republished or re-HEADed by this Sandbox procedure.
- The current world catalog remains the ticket entry. The merged ticket allowlist
  adds only the Sandbox files and keeps earlier release manifests for existing
  pages while they renew tickets.
- `current.json` is not written. The only mutable cutover is the existing
  `/opt/ff14-web/current` symlink after the immutable objects are verified.

## Gates and commands

Do not run an apply command until the coordinator supplies the final Sandbox
output directory, a frozen commit, and the completed Fast Validation proof.
All commands are dry-run without `--apply`.

```powershell
$release = 'work/sandbox-release-final'
$id = '20260910T-sandbox-final'
python deploy/sandbox-release.py prepare --sandbox-release $release --release-id $id
```

The first command is a local dry-run plan. After the plan is approved and the
Fast Validation result is available, create the frozen preparation archive:

```powershell
python deploy/sandbox-release.py prepare --sandbox-release $release --release-id $id --freeze-ref HEAD --fast-validation-proof work/sandbox-fast-validation/result.json --apply
```

Then inspect the local COS plan and, after approval, publish only the new
packs. It performs remote HEAD reconciliation for those files, never for the
16 GB world release:

```powershell
python deploy/sandbox-release.py publish-assets --sandbox-release $release --execute
python deploy/sandbox-release.py publish-assets --sandbox-release $release --prepared-dir work/deployment/sandbox-release-$id --apply --execute
```

The successful apply records completed asset publication in the local release
record. This joins the immutable publisher and local archive builder without
putting credentials into either artifact.

```powershell
python deploy/sandbox-release.py deploy --prepared-dir work/deployment/sandbox-release-$id
python deploy/sandbox-release.py deploy --prepared-dir work/deployment/sandbox-release-$id --apply
```

The preparation archive contains `site/`, ticket code, the merged public
allowlist, and a non-secret release record. It contains no absolute workstation
paths, COS keys, CDN signatures, or server credentials. The record lists each
new bundle/manifest hash and MIME type.

The deploy helper checks the 65 scene catalog, CDN-ticket site shape and ticket
bootstrap, preserving the previous symlink and sidecar manifest chain. A
successful deploy is the terminal online verification for this release: do not
open the public page or run another online test afterward.
