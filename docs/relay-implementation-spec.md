# Blind-relay implementation spec — building ADR-040

- **Status:** Implementation spec, 2026-08-16. Not a decision doc — the decision is
  [ADR-040](ADR-040-blind-relay-fallback-for-punch-failures.md) (accepted 2026-08-15).
  This spec is ADR-040 follow-ups 1, 2 and 4 turned into buildable work.
- **Epic:** WARP-1382. Builds on ADR-031 (direct-first overlay, live since WARP-1767),
  WARP-1384 (HQ signaling), WARP-1385 (box connect agent), WARP-1389 (punch telemetry).
- **Repos touched:** `droplet-fleet-hq` (relay daemon + allocation API),
  `droplet-onboard-services` (box emission), docs only in clients.
- **Written against post-merge state of:** onboard #1609/#1610/#1611, fleet-hq #15/#17,
  windows #32, onboard #1615 (HQ URL flip, gated). If any of those did NOT merge,
  re-verify the citations before building.

## 0. What exists today — the verified map

Every claim below was read from the code, not remembered.

- **The ladder already reserves the relay rung and never fills it.**
  `apps/orchestrator/src/services/overlay-placement.service.ts:265-271` defines
  `PRIORITY = { lan: 120, direct: 100, mapped: 80, srflx: 60, relay: 20 }`;
  `EndpointCandidate.kind` includes `"relay"` (`:249-254`). `buildCandidates()`
  (`:298-345`) has no push for it. `needsRelay()` (`:374-376`) returns true when
  every candidate is `lan | relay` — i.e. "only a relay would help" — and
  `observePlacement()` surfaces that as `PlacementSnapshot.relayRequired` (`:395-400`).
- **The profile route already computes `relayRequired` and can only log about it.**
  `apps/orchestrator/src/routes/vpn.ts:189-210` (`resolveOverlayEndpointCandidates`)
  calls `observePlacement` with device-bridge probes and warns
  "this box needs a relay to be reachable off-LAN" at `:204-209`. The wire type
  `OverlayEndpointCandidate` carries `"relay"` in its kind union with the comment
  "not yet implemented" (`services/overlay-profile.service.ts:46-57`).
- **The box connect agent is the only place the box talks to HQ about sessions.**
  `services/overlay-connect.service.ts:556-586` (`runOverlayConnectTick`):
  poll → `probeBoxEndpoint` (device-bridge STUN, `:346-376`) →
  `answerOverlaySession` (`:382-420`, signs
  `droplet-overlay-answer:v1:<session_id>:<box_endpoint>:<ts>`, `:44-50`) →
  `installOrRefreshOverlayPeer` (`:428-509`), which installs the phone peer with
  `endpoint: offer.clientEndpoint` and the 25 s keepalive (`:499-506`).
- **HQ hands the client whatever the box answered, verbatim.**
  `droplet-fleet-hq/worker/src/overlay.ts:233-257` (`answer`) stores `box_endpoint`
  via `ackOverlaySession` (`worker/src/db.ts:396-402`); `sessionStatus`
  (`overlay.ts:262-293`) returns it to the client at `:286-288`. Post fleet-hq #15,
  `box_endpoint` is validated as an IP literal (bracketed v6 allowed) — this
  constrains what a relay-backed answer may contain (§2.3).
- **Routes are flat string matches** in `worker/src/index.ts:119-155`
  (`/api/overlay/devices/enroll|devices/revoke|connect|poll|answer|session/:id|complete`),
  overlay GC runs in the daily 03:00 UTC cron (`index.ts:227`,
  `worker/wrangler.toml:77-78`). Custom domain `fleet-hq.droplet-us.com` is declared
  at `wrangler.toml:34-36` (fleet-hq #17).
- **Windows dials the ladder only — it has NO HQ signaling client.** Grep of
  `droplet-windows/droplet-vpnd/src` finds no HQ/punch/session-broker code (the
  `session.rs` hits are Noise sessions). `protocol.rs:47-73` parses candidate kinds
  including `Relay` and, post windows #32 (WARP-2063), `#[serde(other)] Unknown`;
  `tunnel.rs:192-243` salvages per-candidate (one bad candidate no longer kills the
  profile) and `validate_candidate` rejects port 0 (`tunnel.rs:323-327`). Android is
  the client that runs the HQ connect/session-status dance. This asymmetry drives the
  two-track design in §3.
- **Config idioms to copy.** `apps/orchestrator/src/config.ts:509-513`
  (`HQ_ISSUANCE_URL`, empty ⇒ feature off) and `:533-550`
  (`OVERLAY_CONNECT_ENABLED` default-true flip story, `OVERLAY_CONNECT_POLL_SECONDS`,
  `OVERLAY_PEER_IDLE_EXPIRY_HOURS`). D1 schema rule: explicit `CHECK` state enums,
  never IS-NULL inference (`worker/schema.sql:2-3`).
- **Telemetry base:** `docs/overlay-connect-punch-telemetry.md` — box counters
  `overlay.punch.attempted|succeeded|failed` on the `Analytics.metric` surface, and
  the HQ D1 success-rate recipe. The sweep settles outcomes from real wg handshakes
  (`overlay-connect.service.ts:602-664`); that mechanism works unchanged through a
  relay, because a relayed tunnel still handshakes.

## 1. The relay daemon (`droplet-relayd`) — wire behavior

A blind UDP forwarder. It moves encrypted WireGuard datagrams and holds no key
material (ADR-040 §Decision). Lives in `droplet-fleet-hq/relayd/` — it is HQ-side
infrastructure, versioned next to the control plane that mints its allocations.
Language: Rust (tokio; the team already ships Rust in `droplet-windows/droplet-vpnd`),
static musl binary, **permissive-licence dependencies only** (appliance/infra rule).

### 1.1 Allocation model

- An **allocation** = two UDP ports on the relay's public IP, drawn randomly and
  distinctly from `RELAYD_UDP_PORT_RANGE`: a **box-facing port** and a
  **client-facing port**. One allocation serves exactly one (box, client) pairing —
  learn-from-first-datagram cannot disambiguate two clients on one port.
- **Learn-from-first-datagram, then lock.** The first plausible datagram arriving on
  a port fixes that side's peer address for the allocation's lifetime. "Plausible"
  = WireGuard framing sanity only: first byte 1–4, three reserved zero bytes,
  length ≥ 32. This is header-shape inspection, not crypto — the relay stays blind —
  and it stops random internet scanners from squatting the lock. After lock,
  datagrams from any other source are dropped and counted
  (`relay.datagrams.rejected` metric).
- **Spoofing is a DoS risk only, and is accepted for v1.** An attacker who wins the
  lock race carries ciphertext that fails WG auth at both real endpoints; the session
  re-brokers through HQ with a fresh allocation. Optional hardening (config, off by
  default): HQ passes an `expected_box_ip` hint at allocation time and the box-facing
  lock only accepts that source IP.
- **Cross-forward, unmodified.** Datagram on box port from the locked box address →
  emitted from client port to the locked client address, and vice versa. Payload
  bytes untouched — the no-MTU-penalty property ADR-040 claims (`ADR-040:98`)
  is exactly this. Datagrams over `RELAYD_MAX_DATAGRAM` (default 1500) are dropped.
  Until BOTH sides are locked, nothing is forwarded and nothing is buffered.
- **Address changes do not re-learn.** A phone that switches networks mid-session
  sends from a new address, which the lock drops. Recovery is a fresh HQ connect →
  fresh allocation. Deliberate: re-learn-on-any-source reopens the hijack surface
  the lock closed.

### 1.2 State and expiry

- **In-memory only.** No disk, no keys, no content logs (ADR-040:47-49). A relay
  restart loses all allocations; sessions re-broker through HQ. The systemd unit
  (§4) enforces this — `ProtectSystem=strict` with no writable path granted.
- **Expiry = idle timeout + absolute cap.** An allocation with no datagrams on either
  port for `RELAYD_IDLE_TIMEOUT_SECONDS` (default 90) is freed; every allocation
  dies at `RELAYD_MAX_ALLOCATION_HOURS` (default 12) regardless. **The box's 25 s
  persistent keepalive (`overlay-connect.service.ts:504`) IS the refresh** — an
  allocation whose box peer is installed never idles out, and no separate refresh
  protocol is needed. Freed ports return to the pool; late datagrams are dropped.
- **Per-allocation byte counters, both directions**, kept for the allocation's life
  and returned on release/query. This is the metering prerequisite ADR-040 names
  for camera traffic (`ADR-040:106-109`); see §5.

### 1.3 Control API (HQ Worker → relayd only)

Bearer-token HTTPS on `RELAYD_CONTROL_LISTEN` (bind loopback; front with a TLS
terminator — the relay host serves NO other inbound TCP). The token
(`RELAYD_CONTROL_TOKEN`) is shared with the Worker secret `RELAY_CONTROL_TOKEN`.
The control API is the ONLY way an allocation comes to exist — the relay is never
an open forwarder (ADR-040:110-111).

```
POST   /v1/allocations        {id, mode: "session"|"standing", expected_box_ip?}
                              → 201 {box_port, client_port, expires_at}
                              Idempotent on id while active (returns existing ports).
GET    /v1/allocations/:id    → {locked_box, locked_client, bytes_to_client,
                                 bytes_to_box, last_activity, expires_at}
DELETE /v1/allocations/:id    → 200 {bytes_to_client, bytes_to_box}   (final counters)
GET    /healthz               → 200 {active_allocations, port_pool_free}
```

`mode: "standing"` gets a longer absolute cap (`RELAYD_MAX_STANDING_HOURS`,
default 720) — same idle rule; the box keepalive keeps it warm (§3.2).

## 2. The HQ allocation API — who mints, endpoint shape, D1 schema

### 2.1 Who mints: the BOX, at answer time. Committed, with reasons.

The alternatives were client-side minting at connect time vs box-side minting at
answer time. **Box-side wins on four grounds:**

1. **Zero client changes — the ADR's own deciding argument** (`ADR-040:51-55`).
   The client learns where to dial from `GET /api/overlay/session/:id`, which
   returns whatever `box_endpoint` the box answered (`worker/src/overlay.ts:286-288`).
   If the box answers with the relay's client-facing address, the client dials a
   relay without knowing relays exist. Client-side minting requires new
   client-authed HQ endpoints plus allocation logic in Android, iOS, and Windows —
   re-importing the three-codebase cost that sank Cloudflare TURN.
2. **Only the box knows whether a relay is needed.** The placement verdict
   (`cgnat`, `address_dependent`, `relayRequired`) is computed box-side from the
   box's own WAN + STUN observations (`overlay-placement.service.ts:146-229,374-376`).
   A client cannot see the box's placement; it would have to mint always (waste,
   abuse surface) or never (the gap stays).
3. **Abuse control lands on the strongest principal.** Box mints ride the existing
   TPM-key PoP (`worker/src/overlay.ts:52-65`) against the pre-seeded `devices`
   registry, where HQ already rate-limits and caps (the `countRecentConnects`
   pattern, `worker/src/db.ts:346-356`; the cap-live-peers pattern from #1610).
   Client identity is per-box enrollment — real, but weaker, and rate limits keyed
   on it protect the wrong asset.
4. **Minimal TTL exposure.** Answer happens between the box's poll and the client's
   session-status read — the allocation is born seconds before its first datagram.
   Connect-time minting would open the window across the whole punch attempt that
   precedes the fallback.

There is a second, box-minted moment — **profile-fetch time**, for the standing
"client-of-record" allocation that serves ladder-only clients (Windows has no HQ
signaling — §0). Same principal, same endpoint, different `scope`. Client-side
minting is rejected outright.

### 2.2 New box-authed endpoints (existing PoP plane)

Mounted as flat matches in `worker/src/index.ts` next to `/api/overlay/answer`
(`index.ts:135-137`). Both audit success AND failure
(`overlay.ts:19`, the WARP-1349 lesson).

**`POST /api/overlay/relay/allocate`** — BOX-authed, timestamp-bound.

```jsonc
{
  "device_id": "...", "key_fingerprint": "...", "sig": "...", "sig_alg": "ecdsa-sha256",
  "ts": "<iso>",
  "scope": "session" | "standing",
  "session_id": "ovs_...",          // required when scope=session
  "client_wg_public_key": "..."     // required when scope=standing
}
```

Signed message (new domain prefix, mirroring `OVERLAY_ANSWER_PREFIX` at
`overlay-connect.service.ts:34-36`):
`droplet-overlay-relay-allocate:v1:<device_id>:<scope>:<session_id|client_wg_public_key>:<ts>`.

Checks, in order: `assertFreshTs` (`overlay.ts:74-78`) → `verifyBoxSignature`
(`overlay.ts:52-65`) → scope=session: session exists, `device_id` matches, state
non-terminal (`getOverlaySession`, `db.ts:388-393`); scope=standing: client enrolled
under this box AND `state='active'` (`getClientDevice`, `db.ts:300-305` — the #1610
enroll-state gate applies) → rate limits: max mints per device per window AND max
concurrent `active` allocations per device (`RELAY_MAX_ACTIVE_PER_DEVICE`, default 8;
count live rows, the #1610 pattern). Then: idempotent re-mint (an `active` row for
the same (device, scope, session|client) returns the existing allocation — this IS
the standing-refresh path), else call relayd `POST /v1/allocations`, insert the D1
row, return:

```jsonc
{ "allocation_id": "rly_...", "relay_ip": "<ip-literal>",
  "box_port": 40123, "client_port": 40124, "expires_at": "<iso>" }
```

**`relay_ip` is an IP literal, never a hostname** — post fleet-hq #15 the answer
endpoint validates `box_endpoint` as an IP literal (bracketed v6), and the box will
answer with `<relay_ip>:<client_port>`. A hostname would bounce off HQ's own
validation and cost every client a resolve besides. The relay's DNS name exists for
ops only, and its A record must be **unproxied** (grey-cloud) — Cloudflare's proxy
does not carry arbitrary UDP.

**`POST /api/overlay/relay/release`** — BOX-authed, `{allocation_id}`, message
`droplet-overlay-relay-release:v1:<device_id>:<allocation_id>:<ts>`. Marks the row
`released`, fetches final byte counters from relayd (best-effort, `ctx.waitUntil`).
Idempotent on terminal rows.

Automatic release, no box call needed: the daily cron expires allocations past
`expires_at` alongside `expireOverlaySessions` (`worker/src/index.ts:227`,
`db.ts:416-422`); `deleteDevice` (`db.ts:171-178`) and `releaseDevice`
(`db.ts:189-197`) grow a `relay_allocations` statement in their atomic batches; the
#1610 HQ-revoke-on-owner-delete path releases that client's standing allocation.

### 2.3 D1 schema addition (`worker/schema.sql`)

Explicit state enum, per the rule at `schema.sql:2-3`:

```sql
-- Blind-relay allocations (ADR-040). The relay itself is memory-only; this row is
-- the audit + metering record, not the runtime state.
CREATE TABLE IF NOT EXISTS relay_allocations (
  id                TEXT PRIMARY KEY,              -- "rly_" + randomToken()
  device_id         TEXT NOT NULL,                 -- the BOX (→ devices.device_id)
  client_device_id  TEXT,                          -- → client_devices.id
  session_id        TEXT,                          -- → overlay_sessions.id (scope=session)
  scope             TEXT NOT NULL CHECK (scope IN ('session','standing')),
  relay_ip          TEXT NOT NULL,
  box_port          INTEGER NOT NULL,
  client_port       INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('active','released','expired')),
  bytes_to_client   INTEGER NOT NULL DEFAULT 0,
  bytes_to_box      INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_relay_allocations_device_state
    ON relay_allocations (device_id, state);
CREATE INDEX IF NOT EXISTS idx_relay_allocations_expires
    ON relay_allocations (expires_at);
```

Terminal rows are kept `RELAY_ALLOCATION_RETENTION_DAYS` (default 90) for metering,
then GC'd by the cron — bounded table, but not before the egress numbers are
harvestable (§5).

### 2.4 Worker config

`wrangler.toml [vars]`: `RELAY_PUBLIC_IP`, `RELAY_CONTROL_URL`,
`RELAY_MAX_ACTIVE_PER_DEVICE="8"`, `RELAY_MINT_LIMIT="6"`,
`RELAY_MINT_WINDOW_SEC="60"`. Secret: `RELAY_CONTROL_TOKEN`
(`npx wrangler secret put`). **Unset/empty `RELAY_CONTROL_URL` ⇒ the allocate
endpoint answers 503 `relay_not_configured`** — the same empty-string-disables
posture as `HQ_ISSUANCE_URL` (`config.ts:509-513`). That makes the API deployable
before any relay host exists.

## 3. Box-side emission

Gate everything behind one new orchestrator env var, following the
`OVERLAY_CONNECT_ENABLED` idiom (`config.ts:533-545`):

```
OVERLAY_RELAY_ENABLED   default FALSE at introduction
```

Default flips to true only after §6 Stage 5 — the same expired-reason playbook
WARP-1767 used for the connect agent. Plus one diagnostic:
`OVERLAY_RELAY_FORCE` (default false) — treats the relay decision as
unconditionally yes; exists solely for bench verification (§6), documented as such
in `.env.example`.

### 3.1 Session path (Android / any HQ-dance client) — v1, ships first

In `runOverlayConnectTick` (`overlay-connect.service.ts:556-586`), after
`probeBoxEndpoint`:

1. Decide: `useRelay = OVERLAY_RELAY_ENABLED && (snapshot.relayRequired
   || placement === "cgnat" || natClass === "address_dependent" || OVERLAY_RELAY_FORCE)`.
   The placement snapshot comes from the same `observePlacement` wiring
   `resolveOverlayEndpointCandidates` uses (`routes/vpn.ts:192-203`) — extract that
   probe wiring into a shared lib so the tick and the profile route classify from
   one source instead of two drifting copies.
2. If `useRelay`: `POST /api/overlay/relay/allocate` (scope=session) →
   **answer the session with `box_endpoint = <relay_ip>:<client_port>`** — the
   existing `answerOverlaySession` and its signed message, unchanged
   (`:382-420`) → install the phone peer with
   **`endpoint: <relay_ip>:<box_port>`** instead of `offer.clientEndpoint`
   (`:499-506`). The 25 s keepalive already configured there is what teaches the
   relay the box's address and keeps the allocation from idling out (§1.2).
3. If allocation fails (503/429/timeout): fall back to the direct answer — a failed
   relay mint must degrade to today's behavior, never fail the tick.

No HQ session-state change, no client change, no schema change to
`overlay_sessions` required for correctness. Add a nullable
`relay_allocation_id` column to `overlay_sessions` if telemetry wants the join
cheap (optional; `relay_allocations.session_id` already carries the link).

### 3.2 Profile ladder + client-of-record (Windows / ladder-only clients) — v1.1

Windows dials the profile's candidate list directly and never talks to HQ (§0), so
the only relay it can ever use is one whose address sits in the profile. That
requires an allocation that outlives a session: the **standing allocation**, one per
(box, client-of-record), minted by the box with scope=standing.

- `buildCandidates` (`overlay-placement.service.ts:298-345`): `CandidateInput` gains
  `relay?: { host: string; port: number } | null`; when present, push
  `{ kind: "relay", host, port, priority: PRIORITY.relay }`. The existing sort +
  `dedupeByTransport` handle ordering. Never emit a placeholder — Windows
  `validate_candidate` rejects port 0 (`droplet-windows/droplet-vpnd/src/tunnel.rs:323-327`).
- `resolveOverlayEndpointCandidates` (`routes/vpn.ts:189-210`): when
  `OVERLAY_RELAY_ENABLED && snapshot.relayRequired`, mint/refresh the standing
  allocation for the fetching client (allocate is idempotent while active — §2.2)
  and pass `<relay_ip>:<client_port>` as the relay input. Profile fetch is already
  per-peer, so the client binding is natural.
- On a relay-required box, install the client's wg0 peer with
  `endpoint = <relay_ip>:<box_port>` at provision time. `provisionOverlayPeer`
  deliberately installs NO endpoint today so the client can initiate directly
  (`services/overlay-profile.service.ts:23-28, 259-267`) — a relay-required box is
  the documented exception: the direct paths cannot work there by definition, and
  the box must initiate toward the relay for the keepalive/learning loop, exactly
  as the file header says endpoints exist for ("the hole-punch path").
- **Honesty limit, stated:** a cached profile's relay rung dies if the relay
  restarts or the allocation rotates, and a remote-only client cannot refetch the
  profile without the tunnel it is trying to build. The standing allocation's long
  absolute cap (§1.3) narrows this; it does not close it. The robust path is the HQ
  session flow — adding it to Windows vpnd is a named follow-on, not smuggled scope.
- **Owner honesty:** `needsRelay()` semantics stay correct ("punch cannot work"),
  but once a live relay rung exists the owner-facing "remote connect unavailable on
  this network" surface must say "reachable via relay" instead. Do not touch
  `computeOffLanReachable` (`lib/remote-access.ts:86`) blindly — its "relay" is the
  ADR-025 cloudflared HQ relay, a different animal; the change belongs where the
  `relayRequired` warn currently fires (`routes/vpn.ts:204-209`) and in the
  dashboard copy that consumes it.

## 4. Relay host deployment — one region first

One host, one region (ADR-040:115-117 — telemetry drives the second). US first;
DNS `relay1.droplet-us.com` (A record, **unproxied**) in the same Cloudflare zone as
`fleet-hq.droplet-us.com` (`worker/wrangler.toml:34-36`) — for ops reference only,
the data plane and the advertised addresses use the IP literal (§2.2).

This is the ADR-025A "no servers" narrowing made real (ADR-040:79-90): the host
holds no customer data, no keys, nothing worth backing up. Treat it as cattle — the
runbook for a dead relay is "provision a new one, update `RELAY_PUBLIC_IP` +
`RELAY_CONTROL_URL`, redeploy the Worker".

### 4.1 systemd unit sketch

```ini
# /etc/systemd/system/droplet-relayd.service
[Unit]
Description=Droplet blind relay (ADR-040) — forwards sealed WireGuard datagrams
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/droplet-relayd
EnvironmentFile=/etc/droplet-relayd/relayd.env
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
# Deliberately NO StateDirectory and no writable path: allocations are memory-only
# (ADR-040). If the daemon ever needs a write path, that is a spec violation, not a
# unit bug. (Ports are >1024, so no capabilities either.)
MemoryMax=512M
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

### 4.2 Config surface (`/etc/droplet-relayd/relayd.env`)

```
RELAYD_PUBLIC_IP=            # the address allocations advertise
RELAYD_UDP_PORT_RANGE=40000-49999
RELAYD_CONTROL_LISTEN=127.0.0.1:7300   # front with a TLS terminator; token-authed
RELAYD_CONTROL_TOKEN=        # = Worker secret RELAY_CONTROL_TOKEN
RELAYD_IDLE_TIMEOUT_SECONDS=90
RELAYD_MAX_ALLOCATION_HOURS=12
RELAYD_MAX_STANDING_HOURS=720
RELAYD_MAX_ALLOCATIONS=2048
RELAYD_MAX_DATAGRAM=1500
RELAYD_MAX_PPS_PER_ALLOCATION=5000
RELAYD_METRICS_LISTEN=127.0.0.1:7301   # prometheus text; scrape locally
```

### 4.3 Abuse controls (all required, none optional)

1. Allocations exist ONLY via the token-authed control API, which only the HQ
   Worker holds — HQ-minted, short-lived, bound to a session or an enrolled client
   (ADR-040:110-111). There is no unauthenticated path to a forwarding state.
2. First-datagram lock + WG-framing sanity check (§1.1) — an unlocked port is not a
   reflector (nothing forwards until both sides lock), a locked port forwards to
   exactly one address.
3. Per-allocation pps + datagram-size caps; per-device mint rate + concurrent caps
   at HQ (§2.2); `RELAYD_MAX_ALLOCATIONS` global ceiling.
4. Byte counters per allocation (§1.2) — the metering hook, and the anomaly signal.
5. Host firewall: inbound = the UDP port range + the TLS front for control; nothing
   else. No SSH from the internet (WG-only management or provider console).

## 5. Metering + telemetry

The ADR makes metering a **prerequisite for video over relay, not a follow-up**
(ADR-040:106-109). Concretely:

- **relayd** keeps per-allocation byte/pps counters, serves them on
  `GET /v1/allocations/:id`, returns finals on DELETE (§1.3).
- **Worker** persists finals into `relay_allocations.bytes_to_client|bytes_to_box`
  on release/expiry, and samples active allocations in the cron so a long-lived
  standing allocation's usage is visible before it dies. Note: adding a second cron
  schedule to `wrangler.toml [triggers]` (`:77-78`) is a deploy — decide cadence
  (suggested `*/15 * * * *`) in the metering ticket, not ad hoc.
- **Box counters**, same `Analytics.metric` surface as WARP-1389
  (`overlay-connect.service.ts:142-146`): `overlay.relay.session.attempted`
  (labels: `reason` = `cgnat|address_dependent|relay_required|forced`),
  `overlay.relay.allocate.failed`. Punch success/failure settlement is untouched —
  the sweep reads real handshakes (`:602-664`) and a relayed tunnel handshakes like
  any other; relay sessions will surface as `overlay.punch.succeeded` with a relay
  attempt counter beside them.
- **Doc extension:** `docs/overlay-connect-punch-telemetry.md` gains a §3 with the
  D1 recipes: relay share = `relay_allocations(scope='session')` per week vs
  `overlay_connect` audit rows; egress per device per week from the byte columns.
  These numbers drive the region-2 decision (ADR-040 follow-up 3) and the video
  policy. Until that policy exists, **relay stays default-off for everyone**
  (`OVERLAY_RELAY_ENABLED=false`) — the relay cannot distinguish camera bytes from
  chat bytes (it is blind by design), so the only honest pre-policy control is the
  enable flag itself.

## 6. Rollout order + verification per stage

Order matters: each stage is inert without the previous and independently
verifiable. Nothing here requires a client release.

**Stage 1 — relayd, loopback-verified (no HQ, no box).**
Build `droplet-fleet-hq/relayd/`. Verify on any Linux host with two netns wg peers
through a local relayd:

```sh
# allocate via control API
curl -s -H "Authorization: Bearer $TOK" -d '{"id":"rly_test1","mode":"session"}' \
  http://127.0.0.1:7300/v1/allocations   # → {box_port:B, client_port:C}
# netns "box": wg set wg0 peer <client-pub> endpoint 127.0.0.1:B persistent-keepalive 25
# netns "client": wg set wg0 peer <box-pub> endpoint 127.0.0.1:C
# PASS: `wg show` on both shows a latest-handshake; ping across tunnel IPs works;
# GET /v1/allocations/rly_test1 shows non-zero bytes BOTH directions;
# stop traffic 90s → allocation gone, ports freed, late datagrams dropped;
# datagrams from a third source after lock are dropped and counted.
```

**Stage 2 — HQ allocation API, deployed inert.**
Worker endpoints + D1 migration ship with `RELAY_CONTROL_URL` unset → allocate
answers 503, everything else unchanged. Verify: vitest handler tests (PoP, skew,
scope checks, rate caps, idempotent re-mint, cascade coverage for
`deleteDevice`/`releaseDevice`); `wrangler dev` against a stub relayd; then deploy
and `curl https://fleet-hq.droplet-us.com/api/overlay/relay/allocate` → 503
`relay_not_configured` (bad-PoP requests must 401/403 BEFORE the 503 so the probe
can't distinguish configured-ness unauthenticated — decide and test the order).

**Stage 3 — relay host live, bound to HQ.**
Provision relay1, start the unit, set `RELAY_PUBLIC_IP`/`RELAY_CONTROL_URL`/secret,
redeploy. Verify: `/healthz` 200; a signed allocate from the test box's identity
(script the PoP with the box's device key, the same signing the tick uses,
`overlay-connect.service.ts:267-281`) returns real ports; two `nc -u` endpoints
exchange bytes through the pair after WG-shaped first datagrams (raw `nc` garbage
must NOT lock — that's the framing filter working); D1 row created `active`, and
`released` with byte finals after DELETE.

**Stage 4 — box emission on the test box, forced.**
Deploy orchestrator with `OVERLAY_RELAY_ENABLED=true` on the test box only.
Force the relay decision — the bench cannot manufacture real CGNAT (the RB5009's
WAN is itself office-LAN private), so two recipes:

- *Deterministic (box-side):* `OVERLAY_RELAY_FORCE=true` in the orchestrator env.
  Restart the container — a compose `restart` does NOT re-read `.env` (known trap);
  recreate the service.
- *Network-honest (edge-side):* kill the punch at the RB5009 with a runtime nft
  rule dropping forwarded UDP dport 51820 toward the box. Add it with `nft insert
  rule inet fw4 forward udp dport 51820 drop` — runtime only, clears on reboot, and
  deliberately NOT via uci, because `uci commit` does not reload nftables. Confirm
  the direct/srflx rungs now time out before testing the fallback.

PASS: Android (off-LAN, e.g. phone on LTE) connects; on the box,
`wg show` / the routing peer list shows the phone peer's endpoint =
`<relay_ip>:<box_port>`; the phone's `box_endpoint` from session-status =
`<relay_ip>:<client_port>`; dashboard loads over the tunnel; relayd byte counters
climb in both directions; `overlay.relay.session.attempted` emitted with
`reason=forced`. For the ladder path: fetch a profile for an enrolled Windows
client and confirm the `relay` rung is present at priority 20 with real
port ≠ 0, and vpnd (post-#32) dials it after the higher rungs fail.

**Stage 5 — soak, then policy.**
A week of telemetry (§5 recipes). Only after that: region/sizing call (ADR-040
follow-up 3), video-over-relay policy (follow-up 4), privacy-language update
(follow-up 5), and the `OVERLAY_RELAY_ENABLED` default flip via the WARP-1767
playbook (config default + `.env.example` + setup.sh migrate line — the
`overlay-connect-deployment.test.ts` pattern pins all three).

## 7. Explicit non-goals of this spec

- No TURN, no framing under the WG socket — settled by ADR-040.
- No client code changes anywhere. Windows gaining the HQ session flow is a named
  follow-on (§3.2), not part of this build.
- No per-surface (video vs chat) discrimination at the relay — it is blind; the
  control is the enable flag plus the metering-informed policy.
- No multi-region scheduling. One region, telemetry decides the second.
