# Extension trust: promote, install, run (WARP-2900, ADR-056 slice H)

How a workshop proposal becomes code the box runs, and what holds at each
step. The key and the signed statement are described in
[device-identity.md](device-identity.md) (custody) and in
`apps/orchestrator/src/services/extension-manifest.ts` (format); this page
covers what happens after the signature (slice H2).

## Promote (owner only, two phases)

`POST /api/extensions/:workspaceId/promote` is `requireRole("owner")`. No
service principal can reach it, the assistant included.

1. **Phase 1** reads the proposal from the workspace's BARE repository (the
   commit `proposal/<version>` points at, its tree, and
   `extension-manifest.json` exactly as committed), parses it under the
   strict schema, runs preflight, and answers `202` with a single-use
   confirmation token (5 minutes) bound to the owner, the workspace, the
   tag, the commit and the manifest digest. Nothing is signed.
2. **Phase 2** must echo that digest (`409 TOKEN_OPERATION_MISMATCH`
   otherwise). The token is taken in the same tick it is checked, so a
   double-click or a retried POST is `410` and never reaches the signer.
   The proposal is read again; if the bytes or the commit moved,
   `409 manifest_changed`. Preflight runs again against the box as it is
   now: another proposal confirmed in between may have taken a tool name or
   the memory (`409 preflight_changed`). Preflight, signing and storing run
   one promotion at a time, so two confirmations at the same moment cannot
   both pass. Only then does
   `extension-promotion.service.ts` (the one signer caller) ask the sidecar
   to sign. An unprovisioned or unreachable sidecar is
   `503 device_identity_svc_unreachable` and nothing is stored.

Enable runs the same preflight before it moves the row (`422
preflight_blocked`). The reconciler does not: it restarts what was already
running.

The readback the owner confirms is derived from `provides`, `resources` and
`egress` only. The manifest's `summary` and every `description` are the
author's words and never feed it.

**Open decision (WARP-2923, Romain):** whether promote also requires a
recent MFA challenge, as the device-identity reseal does. The hook is
`PROMOTE_REQUIRES_RECENT_MFA` in `routes/extensions.ts`, currently off.

## Store

`ExtensionVersion` keeps the statement bytes, the base64 signature, the
signer and the signing key's fingerprint exactly as signed, with the
manifest bytes. Nothing is re-derived: every start re-verifies these bytes
with the recorded signer and fingerprint as the expectation. A rebuilt boot
disk (a new box extension key) is `extension_key_changed`; the extension is
marked `failed` and the owner re-promotes.

The signature covers the statement, not the row. The `Extension` /
`ExtensionVersion` columns that repeat what the statement says (workspace,
version, commit, tree) are plain columns, so every start compares them with
the verified statement and refuses a row that disagrees, or that carries
another extension's statement (`statement_mismatch`, marked `failed`,
nothing started). What the sandbox is asked to export is taken from the
statement alone.

## Install and run (the sandbox)

- The sandbox exports exactly the signed commit, and refuses unless its tree
  is the tree the statement names. A `node20` extension with a
  `tsconfig.json` is compiled with the image's global `tsc` (no network).
  The installed directory is made read-only (0400 files, 0500 dirs), which
  is advisory against the extension itself (see Known limitations).
- The extension module is not an MCP server. The image's first-party host
  shim (`services/sandbox/ext_host/host.mjs` | `host.py`) is what runs: it
  serves the manifest's `provides.tools` (name, description, inputSchema;
  never annotations) over MCP JSON-RPC and calls the declared export.
- The shim listens on **127.0.0.1 inside the sandbox container only** and
  answers only requests carrying the per-start relay key. The orchestrator
  never dials an extension: it calls the sandbox's bearer-gated
  `/extensions/<slug>/rpc`, and the sandbox relays over loopback with a
  timeout and an output cap that is reported when hit.
- The child's environment is the sandbox's base environment plus an
  allowlist of keys (`DROPLET_EXT_ID`, `DROPLET_EXT_PORT`,
  `DROPLET_EXT_TOKEN`, `DROPLET_EXT_RELAY_KEY`, `DROPLET_ORCHESTRATOR_URL`).
  The sandbox's own bearer is not in it. The child runs as the server's uid,
  so the server marks itself non-dumpable at start (`prctl(PR_SET_DUMPABLE,
  0)`): its `/proc/<pid>/environ` and `/proc/<pid>/mem` are then closed to
  a same-uid reader, and the child cannot lift the bearer from there. If
  the kernel refuses the call, the server logs a warning and this
  protection is absent (see Known limitations).
- The relay passes only a 2xx answer through. Any other status the
  extension answers is a `502` "extension answered HTTP N", so extension
  code cannot pose as the sandbox's own `503` (bearer not configured) or
  bare `404` (supervision off).
- Every start mints a new `dxt_` call-back bearer. Only its sha256 is
  stored (`Extension.serviceTokenHash`), and a stop clears it. What it
  resolves to is under "Attach and call-back" below.
- Everything is gated by `SANDBOX_PROCESS_SUPERVISION` (default `0`): off,
  every extension route in the sandbox is `404` and promote answers `503`.
- Every install write is status-claimed. An owner's disable or uninstall
  that lands during an install (up to four minutes of export, `tsc` and
  start) wins: the install stops or removes what the sandbox started and
  answers `409 wrong_state`. An install that fails stops what the sandbox
  may still start as well: a `TIMEOUT` or `UNREACHABLE` is the orchestrator
  giving up (about 245 s), not the sandbox (worst case about 315 s).
- The kill switch is retryable. Disable and uninstall claim the row first,
  then ask the sandbox. If that call fails, the row already says `disabled`
  / `uninstalled`, and a retry of the same transition acts again while the
  sandbox still runs (holds) the extension, instead of answering `409`.
- A stop takes the whole process tree. Every extension leads its own
  process group (`start_new_session`), and a stop signals the group:
  `SIGTERM`, a grace period, then `SIGKILL` to what is left. When the
  process exits on its own, the rest of its group is killed too. So a fork
  the extension made (which holds its `DROPLET_EXT_TOKEN`) does not survive
  a disable, an uninstall or a crash. The sandbox runs under `init: true`,
  so the killed orphans are reaped instead of piling up as zombies against
  `pids_limit` (pinned in `scripts/test-security.sh`). A fork that calls
  `setsid` itself leaves the group; see Known limitations.
- The supervisor never restarts an extension (`restart="never"`). A dead
  process comes back only through the orchestrator's install path, which
  re-exports the signed commit into a fresh directory after re-verifying
  the statement and rotating the bearer. The reconciler does that at most
  5 times in a row (`EXTENSION_MAX_RECONCILE_RESTARTS`), then marks the
  extension `failed` with the exit code; the owner re-enables it, which
  starts the count again.
- The reconciler goes both ways. It reinstalls an extension that should run
  and does not (a sandbox restart forgets every process, or the process
  died), and it stops a process the sandbox runs (`GET /extensions`) for a
  row that must not run: a kill switch whose sandbox call failed, an install
  that outlived its caller, a row left `signed` by an orchestrator restart,
  or no row at all. A row that still exists keeps its sandbox copy
  (stopped); an uninstalled row, or none, loses it. A slug whose install is
  in flight is left alone.
- `budget` is a reserved slug: the sandbox's `GET /extensions/budget` is
  declared before `GET /extensions/{slug}`.

## Attach and call-back (slice H3)

- **Attach.** Every attach re-verifies the stored statement against the
  box key and the row against the statement (the check install() makes),
  and pins what that verified, never the row's manifest bytes on their own
  word: the reconciler attaches with no install before it. A statement
  that does not verify fails the extension; a box key the sidecar cannot
  hand over yet leaves it `installed` for a later tick. The orchestrator
  then lists the extension's tools
  through the relay (`services/extension-mcp.port.ts`, plain JSON-RPC
  over the sandbox client, no MCP SDK transport) and compares the listing
  with the signed manifest: the same names, descriptions and input-schema
  hashes. A listing that differs fails the extension and stops its
  process. The port stays pinned to the manifest, so a listing that the
  extension's code rewrites at runtime stops being advertised
  (`REMOTE_CATALOG_UNAVAILABLE`) instead of being absorbed. Only then does
  `attachRemote('ext-<slug>')` run. The multiplexer admits an `ext-*` id
  only while the lifecycle lists it as installed; the env allowlist does
  not reach that namespace. `SANDBOX_URL` must name the `sandbox` host.
- **The row is `live` only once attached.** An extension that does not
  answer yet stays `installed`, and the reconciler attaches it later. The
  same tick re-attaches every running extension after an orchestrator
  restart (the attachment is in-process memory), but only the process
  install() started (`restarts` 0). One the sandbox restarted in place, or
  one with no process record, is detached and reinstalled through
  install() first (review #2325).
- **Classification.** Every tool is recorded as a confirming write
  (`requiresWrite`, `requiresConfirmation`), whatever the author proposed
  or the wire claims (`readOnlyHint` is never read). For `ext-*` the
  record is the whole call policy: an unreviewed tool is
  `REMOTE_WRITE_NOT_PERMITTED`, so **no extension tool runs from chat until
  an owner reviews it as a read** (or WARP-2321 lands). A new version keeps
  a reviewed read only while the tool's input-schema hash is unchanged; a
  changed schema resets the tool to the default and clears the review. An
  operator's block is never lifted by that reset.
- **Call-back principal.** A `dxt_` header bearer is looked up by its
  sha256 and resolves to `_service:ext:<slug>` only while the extension is
  `installed` or `live`. An unknown one is a 401 at once; it never reaches
  the Nextcloud fallback, a `dxt_` cookie is refused, and it never opens a
  WebSocket. A global guard mounted right after `authMiddleware` confines
  that principal to `GET /api/extensions/self` and
  `POST /api/extensions/self/call` (exact method and path), so the routes
  that carry no `requireRole` of their own are closed to it too.
- **Acting for the owner.** Both routes resolve the owner who installed
  the extension at call time (the User row, active, still an owner) and
  answer `403 owner_unresolved` otherwise. `/self/call` runs a static
  catalog tool with `requiresWrite` and `requiresConfirmation` both false,
  as that owner, after the owner's own reach check; the `tool_call` row
  carries `refs.extensionId`. Writes are refused in v1. **`/self/call`
  ships off** (`EXTENSION_SELF_CALL_ENABLED=0`, a 503), for the reason in
  the first known limitation below.

### Why a sandbox relay and not the mcp-bridge

The ticket's "attach through the multiplexer" could read as "add an
mcp-bridge profile". This build does not, for three reasons: joining
mcp-bridge to `droplet-internal` would trip `scripts/test-security.sh` Test
14b and widen the WARP-2922-reviewed network; the bridge's session profiles
are Atlassian credential-shaped; and the ticket keeps
`session-profiles.ts` a closed registry. The sandbox (our code, behind its
bearer) is the component between the orchestrator and customer code that
ADR-043 §5 asks for. **Needs Stefan/Romain confirmation.**

### Limits

- No `RLIMIT_AS`: V8 cannot start under one, and a python server under the
  manifest's budget cannot start a request thread (measured). No
  `RLIMIT_NPROC` by default: it is per-UID across containers and the host.
  Process fan-out is bounded by the container's `pids_limit`.
- Memory: node's `--max-old-space-size` caps only the V8 old space, not the
  whole process. A `python312` extension has no per-process cap at all.
  Every install is accounted against the container's cgroup limit (minus
  the transform child's ceiling and every other RUNNING extension; a
  stopped or dead one holds nothing) before it starts. The account does not
  subtract the sandbox server's own RSS. `mem_limit` is the hard ceiling. A
  per-extension RSS cap needs cgroup delegation, which this `cap_drop: ALL`
  container does not have.

### Known limitations (for the WARP-2923 review; WARP-2898 is the fix)

Every process in the sandbox (the server, every installed extension, every
workspace `run` child) runs as the one uid `sandbox`. Per-extension uids
need privileges this container drops. A separate container per extension is
WARP-2898's path. Until then, extension code (which runs at import time,
inside the host shim) can do the following:

- **Read other children's secrets.** Children are dumpable (`execve` resets
  the flag), so any child can read another's environment under `/proc`,
  including an installed extension's relay key and `dxt_` call-back
  bearer. The relay key stops a naive connect, not a same-uid reader.
  Since H3 that bearer has authority: with `EXTENSION_SELF_CALL_ENABLED=1`
  it runs read tools as the extension's installing OWNER. A workspace
  `run` child belongs to whoever started the workshop run, which need not
  be an owner, so turning that flag on lets such a child read what the
  owner can read. The flag stays off until WARP-2898 (or per-process
  uids) closes this.
- **Not the server's bearer, conditionally.** `SANDBOX_SERVICE_TOKEN` is in
  the SERVER's environment only, and the server is non-dumpable (above).
  If `prctl` fails (the log line says so), a child can read
  `/proc/<server pid>/environ`, and with that bearer it can call the whole
  sandbox API: any extension's `/rpc`, `/processes`, and other users'
  `/workspaces/*`.
- **Write the git store and other extensions' code.** The bare repositories
  (`/var/lib/workspace-git`), the checkouts and every extension's install
  dir belong to that uid. The install dir's `0400`/`0500` modes stop an
  accidental write, not the extension: it owns the files and can `chmod`
  them back, then rewrite its own code or a sibling's. There is no
  supervisor restart to pick a rewrite up: a dead extension comes back only
  through install, which removes the directory and re-exports the signed
  commit. Code already loaded keeps running as loaded, and a module the
  process imports later is read from the (rewritable) directory. **Treat
  "read-only" as advisory against the extension itself.**
- **Escape the process group.** A fork that calls `setsid` leaves the
  extension's group, so a stop does not reach it. It keeps running,
  bounded by `pids_limit` and `mem_limit`, holding whatever it read.
- Extension tools stay denied at dispatch until an owner reviews one as a
  read, or WARP-2321's runtime confirmation lands (H3, above).
