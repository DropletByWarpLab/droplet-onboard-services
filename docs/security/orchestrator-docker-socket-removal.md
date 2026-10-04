# Orchestrator: remove the Docker socket and the live TLS key directory (WARP-3578)

Status: design only, nothing implemented. Decision needed (see "Open decisions").

The orchestrator container runs as root with the host Docker socket and the
read-write gateway certificate directory mounted. This note describes how to
move each of those capabilities to a narrower host-side executor, one capability
at a time, so the orchestrator can later run non-root with neither mount. The
accepted risk for the current model is recorded under WARP-2924; this note is
the plan that retires it. Nothing here should ship without a box to rehearse
the OTA path, because a failure stops updates for that box.

## Current state

What the orchestrator container has (the `orchestrator` block of
`docker/docker-compose.yml`):

| Capability | Where | Why it is there |
|---|---|---|
| Docker socket | `orchestrator.volumes` in `docker/docker-compose.yml` (`/var/run/docker.sock:/var/run/docker.sock:ro`) | OTA apply creates a one-shot host-root container; box telemetry lists containers |
| Live TLS directory, read-write | `orchestrator.volumes` (`./certs:/app/docker/certs:rw`) | the certificate issuance cron installs `droplet.crt` and `droplet.key` |
| Root user | no `USER` in `apps/orchestrator/Dockerfile`; no `user:` in the compose block | never configured; needed today for the mounts above and for volume ownership |
| Internal CA bundle, read-only | `orchestrator.volumes` (`../data/secrets/service-tls/orchestrator`, mounted twice) | internal mTLS client and server cert for this service only; not the CA key |
| Other key material | `audit.key`, `audit-retired`, `doc-kek.key` (read-only file mounts in `orchestrator.volumes`) | audit signing and document key wrapping; not in scope here |

Who uses the socket (verified by grep over `apps/`, `services/`, `scripts/`, `docker/`):

1. `apps/orchestrator/src/services/update-agent/host-exec.ts`
   - `dockerSocketRequest()` (line 48) is a plain `node:http` client over the socket.
   - `resolveHostExecContext()` inspects the orchestrator's own container for its image ID and the
     host path of the updates volume.
   - `createHostExec()` creates a one-shot container from the orchestrator's own image, pinned
     by image ID, `NetworkMode: none`, bind `/:/host`, entrypoint `chroot`, user `0:0`, and runs
     `docker/ota/apply-update.sh <subcommand>` on the host. This is the OTA design from WARP-3007.
2. `apps/orchestrator/src/services/update-agent/host-compose-runner.ts` is the only caller of
   host-exec; it drives a fixed subcommand set of `docker/ota/apply-update.sh`
   (`snapshot`, `pull-images`, `stage-configs`, `migrate-deploy`, `recreate-services`,
   `reconcile-env`, `restore-configs`, `recreate-self-detached`, `self-swap-supervise`, and
   the helper-listing/cleanup subcommands; dispatch at the end of the script).
3. `apps/orchestrator/src/services/box-telemetry/index.ts:37,87` reuses `dockerSocketRequest`;
   `sources.ts` calls `/containers/json`, `/containers/<id>/json` and `/info` (read-only
   container inventory and host OS for fleet telemetry).
4. No other first-party container mounts the socket except `ops-console` (its own
   documented privilege boundary, a separate `ops-console` block).
   `scripts/test-security.sh` asserts the sandbox never mounts it (lines 405-440).

Who uses the TLS directory: `apps/orchestrator/src/services/tls-issuance.service.ts`
(atomic write of `droplet.key` 0600 and `droplet.crt` 0644 at lines 1263-1269, through the
filesystem seam at 279-285). The gateway mounts the same directory read-only. The nginx
reload is already delegated to the host through the device-bridge (the compose comment above the
`./certs` mount and `scripts/lib/tls-reload.sh:1-12`), so the socket is not needed for reloads.

Constraint worth stating plainly: the socket is host root. Today's controls are
cosign verification of the release manifest, a fixed helper subcommand surface and argv-only
invocation. Removing the socket removes the dependency on those controls being perfect; it does
not change them.

## Target state

- Orchestrator: non-root user, no Docker socket, no `/app/docker/certs` mount, `cap_drop: [ALL]`
  and a read-only root filesystem once the previous items are done (the container hardening
  baseline in WARP-3656 depends on this).
- A host-side executor (systemd unit on the host, not a container) owns:
  - the OTA helper invocations (today's one-shot `chroot /host` container),
  - certificate and key installation plus gateway reload,
  - the container inventory telemetry needs.
- The orchestrator talks to the executor through a narrow request interface that carries only
  the same already-verified inputs it passes today (subcommand name, update id, file paths under the
  updates volume). Candidate interfaces:
  - A. Spool directory on a shared volume plus a host `systemd.path` unit. This is the same shape as
    `droplet-openwrt-attach.path` and `droplet-ssh-access.path` in
    `scripts/host/etc-systemd-system/`. No listening socket, requests are files, results are files.
  - B. A unix socket owned by the host executor, mounted into the orchestrator. Lower latency, but
    the orchestrator then holds a new privileged handle, so it needs per-request authorization
    inside the executor.
  - C. A filtering Docker API proxy that allows only the calls host-exec makes. Smallest code, but the
    one-shot container create call is itself the privileged operation, so the filter must pin image,
    binds and entrypoint; a mistake there is equivalent to keeping the socket.
  Recommendation: A for OTA and certificates (both are low-frequency, already asynchronous and already
  file-staged under `ota-updates`), and A with a read-only "inventory" file written by a host timer for telemetry.

## Migration (one capability at a time)

Order is chosen so the least risky step goes first and OTA, which can strand a box, goes last.
Each step ends with the orchestrator still able to do everything it does today.

### Step 1. Telemetry inventory without the socket

- Add a host timer (or a one-shot invoked by the existing host watchdog cadence) that writes
  `docker ps` / `docker info` JSON of the compose service labels to a file on a read-only mount.
  Change `box-telemetry` to read the file when the socket path is absent (`index.ts:87` already
  tolerates `docker: null`).
- Test on box: with the socket temporarily removed from the orchestrator (override file, not the
  tracked compose), `GET /api/telemetry/last` still reports the container list and OS string.
- Breaks: telemetry shows an empty container list and host OS; no user-facing feature.
  Roll back: re-add the socket mount in the override and restart the orchestrator.

### Step 2. Certificate install via an inbox

- Orchestrator writes the new key and chain into a dedicated inbox volume (not the live
  directory). A host path unit validates (key matches certificate, chain parses, not-after in the
  future), installs into `docker/certs/` with the correct owner and modes, then runs the existing
  `scripts/lib/tls-reload.sh` gateway reload. Result file is read back by the orchestrator to record
  issuance state.
- Then remove `./certs:/app/docker/certs:rw` (`:551`) from the orchestrator. The gateway mount
  (read-only) is untouched.
- Test on box: force an issuance (`POST` the existing admin issuance route or wait for the cron), then
  `openssl s_client -connect <box>:443 -servername <fqdn>` shows the new serial; gateway
  `nginx -t` clean; `ls -l docker/certs` shows `droplet.key` 0600; a deliberately mismatched key in the
  inbox is rejected and the old certificate keeps serving.
- Breaks: renewal silently stops and the certificate expires; issuance state shows failed. Detect with
  the existing expiry alert and the result file. Roll back: restore the mount, restart the orchestrator.

### Step 3. Run the orchestrator as non-root (still with the socket)

- Add a numeric `user:` (and `group_add` for the socket group on Linux), fix ownership on the named
  volumes it writes (`ota-updates`, `migration-snapshots`, `brain-memory-data`, `audit` mounts).
  Do this before touching OTA so a permission bug is isolated from an OTA bug.
- Test on box: `docker compose up -d --force-recreate orchestrator`; healthcheck green;
  upload a file, run a chat turn, take a migration snapshot (`/data/migration-snapshots` writable),
  read the audit log; check `docker exec orchestrator id`.
- Breaks: migration entrypoint (`apps/orchestrator/scripts/migrate-and-start.sh`) cannot write
  snapshots and refuses to start the app, so the orchestrator crash-loops. Roll back: remove `user:`.

### Step 4. OTA through the host executor

- Replace `createHostExec` with a client for the chosen interface: write
  `<updatesDir>/<id>/request.json` (subcommand, flags, env allowlist), host unit runs
  `docker/ota/apply-update.sh` directly (it already runs on the host once inside the chroot) and writes
  `result.json` plus the log. `resolveHostExecContext` (needs the socket to inspect itself) is replaced by
  values the host knows: image ID and updates path.
- The self-swap path (`recreate-self-detached`, `self-swap-supervise`) already runs detached from the
  orchestrator; confirm it needs nothing from the orchestrator's process after the request is accepted.
- Keep the old socket path behind a feature flag for one release so a bad host unit can be bypassed
  by an override file.
- Test on box (use a stage release to a stage box, never first on a stable box): full apply with a
  no-op release; a release that fails its health gate and triggers rollback (`restore-configs`);
  an apply that recreates the orchestrator itself. Verify a hostile request file (unknown subcommand,
  `--services` with shell metacharacters) is refused by the helper's existing validation and by the
  new request parser.
- Breaks: boxes cannot update; the OTA window reports failed. This is the highest-impact failure of the
  four steps. Roll back: re-enable the flagged socket path via the override and recreate the orchestrator
  (the helper on the host is unchanged).

### Step 5. Remove the socket mount

- Delete the `docker.sock` entry from `orchestrator.volumes`; add `cap_drop: [ALL]` and `security_opt: no-new-privileges:true`
  (WARP-3656). Keep a test in `scripts/test-security.sh` that fails if the orchestrator block mounts
  the socket or `/app/docker/certs`, mirroring the existing sandbox assertion.
- Test on box: `docker inspect` shows no socket bind; a full OTA cycle and a certificate renewal still pass.
- Roll back: revert the compose change in a patch release; the previous step's flag path is gone after
  this step, so keep step 4's flag for one release before this removal.

## Open decisions for Romain

1. Interface for the host executor: spool and path unit (recommended), a unix socket, or a filtering proxy.
2. Is it acceptable to keep the socket for OTA only until step 4 has soaked on stage for one release?
3. Key custody: should the host generate the TLS private key (orchestrator never sees it) rather than receive
   it through the inbox? This changes the HQ issuance flow and is a larger change than step 2.
4. `ops-console` also mounts the socket; confirm it stays out of this ticket.

## Related

WARP-3578 (this), WARP-2924 (security review of the host-execution model, accepted risk today),
WARP-3656 (container hardening baseline), WARP-3588 (per-service environment), WARP-1375 (network exposure
context), WARP-3623 (network segmentation; the executor's request channel must not need a new network),
WARP-2565 and WARP-3454 (internal TLS default, guest access to container addresses).
