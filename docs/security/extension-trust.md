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
   otherwise). The proposal is read again; if the bytes or the commit moved,
   `409 manifest_changed`. Only then does `extension-promotion.service.ts`
   (the one signer caller) ask the sidecar to sign. An unprovisioned or
   unreachable sidecar is `503 device_identity_svc_unreachable` and nothing
   is stored.

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

## Install and run (the sandbox)

- The sandbox exports exactly the signed commit, and refuses unless its tree
  is the tree the statement names. A `node20` extension with a
  `tsconfig.json` is compiled with the image's global `tsc` (no network).
  The installed directory is read-only.
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
  The sandbox's own bearer never reaches it.
- Every start mints a new `dxt_` call-back bearer. Only its sha256 is
  stored (`Extension.serviceTokenHash`), and a stop clears it. Resolving it
  to a principal is slice H3.
- Everything is gated by `SANDBOX_PROCESS_SUPERVISION` (default `0`): off,
  every extension route in the sandbox is `404` and promote answers `503`.

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
- Memory: node's heap is capped at the manifest's `memoryMb`; every install
  is accounted against the container's cgroup limit (minus the transform
  child's ceiling and every other installed extension) before it starts;
  `mem_limit` is the hard ceiling. A per-extension RSS cap needs cgroup
  delegation, which this `cap_drop: ALL` container does not have.

### Known limitations (for the WARP-2923 review)

- Every process in the sandbox runs as the same uid. A workspace `run`
  child (an allow-listed `npm test` executing run-written code) can read
  another process's environment under `/proc` and so learn an installed
  extension's relay key and call-back bearer. The relay key stops a naive
  connect, not a same-uid reader. Per-extension uids need privileges this
  container drops; a separate container per extension is WARP-2898's path.
- Extension tools stay denied at dispatch until an owner reviews one as a
  read, or WARP-2321's runtime confirmation lands (H3).
