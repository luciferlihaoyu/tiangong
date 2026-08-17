# Tiangong Zeabur deployment contract

`ZEABUR_DEPLOY.md` is the normative artifact-storage deployment contract. The service binds the Zeabur persistent volume named `tiangong-artifacts` at `/app/data/tiangong-artifacts` and sets `TIANGONG_ARTIFACT_ROOT=/app/data/tiangong-artifacts`.

## Identity and first initialization

Provision the volume and configure deployment-supplied values `TIANGONG_ARTIFACT_VOLUME_ID=<UUID>`, `TIANGONG_ARTIFACT_GENERATION_ID=1`, and `TIANGONG_PROVIDER_INSTANCE_ID=<persistent Tiangong instance UUID>`. Run exactly once:

```sh
npm run artifact-volume -- init --volume-id "$TIANGONG_ARTIFACT_VOLUME_ID" --generation "$TIANGONG_ARTIFACT_GENERATION_ID"
```

Only this operator command writes `.tiangong-artifact-root-marker.v1`. Normal startup never creates or rewrites it. Startup reads `/proc/self/mountinfo`, calls `statfs`, compares configured volume ID and generation with the marker, and refuses `missing_marker`, `ephemeral_root_filesystem`, or `mount_validation_failed`.

## Ownership and isolation

The image creates UID/GID `10001:10001` (`tiangong:tiangong`). The root and `by-sha`, `staged`, `gc`, and `probe` directories are owned by that identity with mode `0750`. Zeabur must mount the volume with this ownership. The frontend runs under a different UID and must receive an explicit ACL denial for read and execute access, for example `setfacl -m u:<frontend-uid>:--- /app/data/tiangong-artifacts` on the volume host.

Staged files are `0600`. Sealed `by-sha/<lowercase-sha256>` objects are `0444` and are never overwritten or exposed by path or URL.

## Startup and recovery

Every process start performs write/fsync/re-read, same-directory atomic rename, and `O_NOFOLLOW` probes after mount validation. A failed probe blocks process startup. Persistent-volume replacement or disaster recovery increments the marker generation through a deliberate operator-controlled rebuild; device numbers are informational and are not treated as stable identity across migrations.

Back up MySQL descriptor/manifests and the exact volume generation together as described by the Todo 40 rehearsal. Restore to a staged volume, verify every referenced `(generation, sha256, size)` object, initialize the replacement with the deployment UUID and incremented generation, switch while stopped, then run startup probes before admitting traffic. Never claim database and filesystem bytes commit atomically.

Unreferenced `by-sha` bytes left by a database rollback are inventory candidates. GC uses a lease, grace interval, and two phases (rename into `gc`, then delete after grace), and rechecks referenced generation identities before either phase.
