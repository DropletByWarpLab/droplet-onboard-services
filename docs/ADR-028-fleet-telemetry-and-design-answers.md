# ADR-028: Fleet telemetry v1 (portal-push agent) + proposed answers to the fleet-design open questions

- **Status:** Proposed — **NOT accepted.** The three recommendations in
  §"The three open questions" are drafted for human ratification and
  bind nothing until Romain and Stefan sign off (they are the same
  three blocking choices `FLEET_MANAGEMENT_DESIGN.md` has carried as
  "🟡 Awaiting Romain review" since 2026-05-15). The v1 telemetry slice
  in §"What ships now" is the only part implemented, and it is
  flag-gated OFF by default.
- **Date:** 2026-07-01
- **Authors:** Claude (Dev agent), for Stefan Cruceru
- **Related tickets:** WARP-963 (one on-device agent — this v1 slice),
  WARP-961 (agent unification decision, blocked on the questions below),
  WARP-538 (orchestrator update poller), WARP-333/334/335 (the three
  open questions as filed), WARP-340 (fleet management parent),
  WARP-974 (remote-access epic)
- **Related ADRs / docs:** [`FLEET_MANAGEMENT_DESIGN.md`](FLEET_MANAGEMENT_DESIGN.md)
  (Pattern B design, spec only);
  [ADR-023](ADR-023-public-ca-per-device-tls-via-hq-dns01.md) (HQ is a
  serverless Cloudflare Worker today);
  [ADR-012](ADR-012-phone-home-egress-control.md) (egress discipline this
  agent's audit table follows)

## Context

`FLEET_MANAGEMENT_DESIGN.md` (2026-05-15, Pattern B approved) designs a
`droplet-agent` that dials a Warp Lab HQ VPS for heartbeat + update
manifest + tunnel proxy. Phase 1 has been blocked ever since on three
operator-level choices (HQ host, signing-key custody, manifest scope).

Two facts have changed since that doc was written:

1. **The analytics portal shipped the whole telemetry half.** The
   `droplet-analytics` repo carries a **frozen** agent API
   (`docs/superpowers/agent-api.openapi.yaml` v1.0.0) with server-side
   ingest implemented for register / heartbeat / metrics / errors /
   inventory / network snapshots and a pull-model command queue. The
   only missing piece was a box-side client.
2. **HQ went serverless.** `droplet-fleet-hq` is a Cloudflare Worker
   (ADR-023 cert issuance). There is no Warp Lab VPS today, and Workers
   cannot terminate WireGuard — so the design doc's "one €5 box does
   heartbeat + WG + proxy" shape no longer matches reality.
3. **2026-07-01 founder decision: NO VPS, no Warp-operated external
   servers.** WG-shaped relay traffic is dead; remote access is
   Cloudflare-native — Zero Trust WARP-to-Tunnel over per-box virtual
   networks (VNETs), per ADR-025A in `droplet-fleet-hq` PR #9. The
   analytics portal keeps telemetry ingest. Question 1's answer below
   is aligned to this decision.

WARP-963 (Highest) wants ONE fail-open on-device agent. Waiting for the
three answers to ship *any* fleet visibility would leave the fleet dark
for no technical reason: the portal-push half has a frozen contract and
zero dependency on the blocked choices.

## Decision (the part that is real today)

### What ships now — WARP-963 v1 slice

`services/fleet-agent/` — a standalone Python 3.12 service that pushes
operational telemetry to the analytics portal per the frozen contract:

- **Flag-gated OFF twice:** compose profile `telemetry` AND
  `DROPLET_TELEMETRY_ENABLED=1` + credentials. A default box runs no
  container and dials nothing.
- **Fail-open everywhere:** every scheduler tick swallows + logs every
  exception; heartbeats spool to a bounded on-disk buffer during portal
  outages and replay (idempotent on `(machine_id, ts)` by contract).
  The agent can never degrade the box.
- **Observe-only:** every portal command (`ssh.tunnel.open`,
  `container.restart`, …) is answered with an explicit "unsupported"
  result. No remote actuation in v1 — enabling any command type is a
  security-reviewed follow-up under WARP-961, not a config flip.
- **Update poll intentionally absent:** WARP-538 owns the
  orchestrator-side update poller; folding it into this agent is
  exactly the WARP-961 unification decision that waits on this ADR's
  ratification. A marked stub in `services/fleet-agent/agent.py`
  documents the mount point.
- **Egress audited** (ADR-012 discipline): one table in
  `services/fleet-agent/README.md` lists every endpoint the service can
  ever dial; every attempt logs on `fleet_agent.egress`.

This slice neither prejudges nor depends on the three open questions.

## The three open questions — proposed answers (for ratification)

> ⚠ **Proposals only.** Confirm or override each; WARP-961 / Phase 1 of
> the fleet design unblocks the moment all three are signed off.

### 1. HQ host choice — proposed: no servers at all (portal for telemetry, Cloudflare-native for remote access)

**Original options:** Hetzner CX22 (€5/mo) vs Cloudflare Worker + D1 vs
AWS Lightsail, as one host for heartbeat + WG + proxy.

**Proposed answer (updated 2026-07-01, founder decision): NO VPS and no
other Warp-operated external servers.** The original question assumed a
host; neither traffic shape needs one.

- **HTTP-shaped fleet traffic (heartbeat, metrics, inventory, fleet
  list/detail UI): the analytics portal, as shipped.** The server side
  already exists, is contract-frozen, and is implemented — re-building
  heartbeat ingest anywhere else would be a parallel second fleet plane
  with zero added capability. The design doc's `fleet-server`
  heartbeat/devices routes are **superseded for telemetry** by the
  portal, which keeps telemetry ingest.
- **Remote access (ops-console reach into a box; the WARP-974 one-tap
  path): Cloudflare-native — Zero Trust WARP-to-Tunnel over a per-box
  virtual network (VNET), per ADR-025A in `droplet-fleet-hq` PR #9.**
  WG-shaped relay traffic is dead: an earlier draft of this answer (a
  Hetzner CX22 terminating an outbound WireGuard relay) is withdrawn.
  The box side is the same outbound `cloudflared` tunnel the box
  already runs (the `relay` compose profile, WARP-974); the client side
  is the Cloudflare WARP client enrolled in the Zero Trust org, routed
  to exactly one box's VNET. No Warp-operated endpoint to run, patch,
  or scale.

**Cost:** zero net-new servers — the portal hosting that already
exists, plus the Cloudflare account that already runs HQ and the
box tunnels.

### 2. Signing-key custody — proposed: Yubikey 5 NFC × 2 (unchanged)

The original recommendation stands, strengthened by the split above:

- **Migration-cost asymmetry:** starting on 1Password and moving to
  hardware later means rotating trust on every deployed Droplet;
  starting on Yubikey means the key was *never* on disk — a one-line
  auditor proof.
- The signing key stays **off the portal, off Cloudflare, off HQ**
  regardless of question 1's outcome (defense assumption: HQ compromise
  must not yield update-signing capability — unchanged from the design
  doc's security posture).
- **Cost:** $110 one-time (primary + backup), ~half a day of gpg/slot
  setup, once.

### 3. Manifest scope schema — proposed: tag-based selectors (unchanged), with the portal's machine vocabulary

Fixed groups become a schema migration the moment slicing changes;
every mature fleet system converged on tag selectors. Confirm the
original proposal with one addition: **the tag vocabulary is shared
with the analytics portal's machine model** (`tier`, `channel`,
`customer`, `region`, `hw`), so the fleet map and the rollout targeting
speak the same language and a machine registered once (WARP-963 v1) is
already addressable by a future manifest without re-provisioning:

```json
{ "customer": "photo-studio", "region": "eu-central",
  "hw": "v2.6", "channel": "stable", "tier": "business" }
```

Canary = `{"device_id": "…"}`; customer rollout = `{"customer": "…"}`;
fleet-wide = `{"channel": "stable"}`. Schema set once in phase 1;
richer expressions later without migration.

## Consequences

### Positive

- Fleet visibility ships now, gated and reversible, without waiting on
  the blocked decisions.
- The three blocking questions get concrete, current-reality proposals
  instead of a stale 2026-05 framing (the old "one VPS for everything"
  option is no longer buildable as written — Workers can't do WG, and
  the portal already owns telemetry).
- One agent remains the end-state (WARP-963): update-poll and any HQ
  heartbeat land in `services/fleet-agent/` as additional apscheduler
  jobs after WARP-961, not as new sidecar services.

### Negative

- Until WARP-961 lands, "what version should I be on" (WARP-538
  orchestrator poller) and "how healthy am I" (this agent) report
  through different planes. Accepted as a v1 seam; the unification
  ticket exists precisely to close it.
- Two fleet surfaces (portal telemetry + Cloudflare Zero Trust remote
  access) instead of the design doc's single box — the price of the
  no-servers posture and of not re-implementing a working ingest plane.

### Neutral

- `FLEET_MANAGEMENT_DESIGN.md` remains the architecture record for
  Pattern B, the update mechanism (git tag + signature) and the
  security posture; this ADR narrows only *where* each plane runs and
  *what shipped first*. The design doc should gain a pointer to this
  ADR once ratified.

## Alternatives considered

- **Wait for the three sign-offs before shipping any agent.** Rejected:
  the portal half is frozen and server-complete; the fleet stays dark
  for governance reasons, not technical ones. The v1 slice is additive
  and OFF by default.
- **Build the heartbeat half against a new fleet-server VPS now
  (design-doc-literal).** Rejected: duplicates a working, frozen,
  already-hosted ingest plane and pre-empts exactly the decision
  (question 1) that is awaiting human review.
- **Implement command execution (ssh.tunnel.open) in v1 since the
  contract defines it.** Rejected: remote actuation on customer boxes
  needs its own security review and the WARP-961 decision; v1 answers
  "unsupported" explicitly so the portal sees a live, honest agent.

## How to apply

- Ratify/override the three answers above (Romain + Stefan). Record the
  outcome by flipping this ADR to Accepted (or amending it) and
  updating `FLEET_MANAGEMENT_DESIGN.md`'s open-questions block.
- On ratification of question 1: nothing to provision — enroll the
  fleet in the Cloudflare Zero Trust org and point the ops-console
  remote-access work (design doc phase 2) at the per-box VNET route
  (ADR-025A, `droplet-fleet-hq` PR #9).
- WARP-961 then decides the update-poll mount (WARP-538 poller folding
  into `services/fleet-agent/` as an apscheduler job) — the stub in
  `agent.py` marks the spot.
