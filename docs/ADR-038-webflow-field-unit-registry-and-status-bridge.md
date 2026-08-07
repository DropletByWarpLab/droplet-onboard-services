# ADR-038: Webflow field-unit registry + a metadata-only status bridge (the analytics panel stays where it is)

- **Status:** **Proposed** — needs sign-off from Romain (adds a public
  inbound route on the portal) and Stefan (product shape of the
  customer-facing page). Nothing in this ADR is implemented.
- **Date:** 2026-08-07
- **Authors:** Claude (Dev agent), for Stefan Cruceru
- **Related tickets:** WARP-360 (Droplet Analytics portal, parent),
  WARP-962 (fleet visibility live — the commissioning gate),
  WARP-1043 (duplicate telemetry agents), WARP-1179 (null-tier audit
  retention, HIPAA), WARP-420 (HIPAA v1.1 MFA step-up for SSH),
  WARP-813 (trusted-proxy allowlist)
- **Related ADRs / docs:**
  [ADR-028](ADR-028-fleet-telemetry-and-design-answers.md) (fleet
  telemetry v1, the metadata-only decision D4 and the tag-selector
  vocabulary); [ADR-012](ADR-012-phone-home-egress-control.md) (egress
  discipline — the determination for this change is in
  §"Egress determination" below); `droplet-analytics`
  `docs/superpowers/hosting.md` (where the portal runs today)

## Context

The ask: track deployed Droplets **as units in the field**, surface
enough to monitor and troubleshoot them, host that through Webflow —
and carry **no data access**, so that PHI is never in scope.

Three facts shape the answer.

**1. The analytics panel is built; it is not live.** The
`droplet-analytics` portal is a Next.js operator console with a fleet
dashboard (live over a `fleet:overview` WebSocket), per-machine detail
and error views, a fleet map, alerts, an audit log with a HIPAA report
and SSH session recordings, and a frozen agent-API v1.0.0
(`/api/v1/agents/{register,heartbeat,metrics,events,errors,inventory,network,commands/*}`).
It runs on a Mac mini on the LAN behind a Cloudflare Tunnel at
`analytics.warp-lab.ai`, with an AWS migration runbook already written.
The gap is commissioning, not construction: **WARP-962 (Highest) — no
box has ever reported in.**

**2. Telemetry is already metadata-only; the PHI risk is elsewhere.**
ADR-028 decision D4 is enforced in
[`apps/orchestrator/src/services/analytics/types.ts`](../apps/orchestrator/src/services/analytics/types.ts)
and in the `services/fleet-agent/README.md` egress table: heartbeat is
uptime/load/cpu/ram, metrics are `system.*` gauges, network snapshots
are timestamp + default-route interface only, errors are fingerprinted
faults. Explicitly "no file names, no user data, no customer LAN client
detail." **No PHI can reach the portal through the push path.** The
PHI-bearing surface is **Browser-SSH** (`/machines/[id]/ssh`), which
spawns `ssh`/`sshpass` through node-pty and hands an operator a live
shell on a customer appliance. It is mitigated (per-machine
`complianceTier`, forced re-auth, stored-credential rejection, session
recording, 6-year audit retention per §164.316(b)(2)) but it is
unrestricted data access by construction.

**3. Webflow already hosts the brand.** The `Warp Lab Site` Webflow
site serves `warp-lab.ai` and `warp-lab.com` (last published
2026-07-24). Note that `droplet-analytics` `docs/superpowers/hosting.md`
still describes **Squarespace** DNS — that doc is stale and should be
corrected when this lands.

## Decision

**Three planes, split on the data they carry.**

| Plane | Runs on | Carries | Public |
|---|---|---|---|
| **Unit registry + status page** | Webflow (CMS + pages) | operator-entered inventory metadata; a 3-field live status | yes |
| **Operator console** | Portal, unchanged (Mac mini → AWS per `hosting.md` §5) | telemetry, charts, audit, SSH | no — tunnel + credentials |
| **Bridge** | One new read-only portal route | `status`, `lastSeenAt`, `firmwareVersion` — nothing else | capability-URL |

### 1. The operator portal does NOT move to Webflow

Not a preference — the application cannot run there. It is a stateful
Next.js server app that needs persistent TCP to Postgres/TimescaleDB
and Redis, holds a WebSocket channel open, runs in-process retention
sweeps on a 24h timer, and spawns `ssh`/`sshpass` via `child_process` +
node-pty. Webflow Cloud is a Cloudflare Workers runtime; none of those
survive the port, and the SSH terminal alone is disqualifying. (Confirm
the Workers-runtime detail against current Webflow Cloud docs before
citing this externally — the application-side requirements above are
what actually decide it, and those are verified in-repo.)

The second reason is the trust boundary. The portal can SSH into
customer appliances. Today it sits on a LAN box with **zero inbound
ports**, reachable only through an outbound Cloudflare Tunnel, behind
credentials and optionally Cloudflare Access. Co-hosting that with the
public marketing site collapses two deliberately different postures.

### 2. Webflow CMS holds the field-unit registry

A `Field Units` collection — one item per shipped appliance. Every
field is **operator-entered inventory**; no field is fed by telemetry.

| Field | Type | Purpose |
|---|---|---|
| `Name` | Plain text | Human label, e.g. "Photo Studio — Front Desk" |
| `Status Key` | Plain text | Opaque per-unit capability key (see §3). The join to the portal. |
| `Customer` | Reference | Optional link to a Customers collection |
| `Region` | Option | ADR-028 `region` selector |
| `Hardware Revision` | Plain text | ADR-028 `hw` selector |
| `Firmware Channel` | Option (`stable`/`beta`) | ADR-028 `channel` selector |
| `Tier` | Option (`home`/`business`/`enterprise`) | Mirrors `MachineTier` |
| `Deployed On` / `Lease Ends` | Date | Lease-cycle tracking |
| `Notes` | Rich text | Internal only — do not bind to a published element |

`tier` / `channel` / `customer` / `region` / `hw` is deliberately the
**exact ADR-028 tag-selector vocabulary**, so a unit tracked in Webflow
is already addressable by a signed release manifest without
re-provisioning.

**Not in the CMS, ever:** heartbeat history, metric series, event or
error bodies, IP addresses, geo coordinates, SSH configuration, or
anything read out of the telemetry tables. Webflow CMS content is
retrievable through the public Site API and can be emitted into
published HTML — it is a content store, not a data store, and it has no
retention controls and no audit chain.

**`Compliance Tier` is deliberately omitted.** "This site is HIPAA" is
customer-identifying on a public page. Compliance tier stays in the
portal's `Machine.complianceTier`, where it already drives the SSH
restrictions.

### 3. One new read-only bridge route on the portal

```
GET /api/v1/public/status/{statusKey}
```

**Response — exactly this shape, nothing else:**

```json
{
  "status": "online",
  "lastSeenAt": "2026-08-07T12:00:00.000Z",
  "firmwareVersion": "1.4.2",
  "asOf": "2026-08-07T12:00:31.000Z"
}
```

- `status` reuses `computeMachineStatus` unchanged (`< 90s` online,
  `< 5min` degraded, `≥ 5min` offline; `archived` is terminal). No
  second derivation of "healthy" gets invented — that is exactly the
  "no guessing" rule in `CLAUDE.md`.
- **`statusKey` is the capability.** A random 128-bit opaque key per
  machine, distinct from `Machine.id`, revocable and re-mintable from
  `/settings/tokens`. It is *not* the ingest bearer token — that
  credential is machine-scoped and write-capable and must never reach a
  browser. Using an unguessable URL rather than a header token means no
  secret has to be embedded in Webflow page JS beyond the one that
  addresses the unit's own page; whoever can read the key can read
  precisely the three fields that page already renders, for one unit.
- **Deny-by-default serializer.** The route projects an explicit field
  allow-list, with a unit test asserting the response keys against the
  `Machine` model so that adding a column later cannot leak it by
  default. It must never return `hostname`, `displayName`, `customerId`,
  `wanIp`, `geoCountry`/`geoRegion`, `notes`, `complianceTier`,
  `publicKey`/`keyFingerprint`, or any related-table row.
- **No enumeration.** No list endpoint, no sequential identifiers, and
  a per-key + per-IP rate limit reusing the existing `lib/client-ip.ts`
  path. **WARP-813 should land first** — until the trusted-proxy
  allowlist is in, the client-IP arm of any throttle is spoofable.
- Unknown or revoked key → `404` (never `403`, which would confirm the
  key namespace).

## Egress determination (ADR-012 discipline)

**No new device egress, and therefore no `allowed-egress.yaml` entry.**
The appliance does not dial Webflow and gains no new destination — the
box's only outbound fleet path remains
`fleet-telemetry-portal` (`analytics.warp-lab.ai`), already registered.
The new traffic is **browser → portal**, originating on an operator's
or customer's device, not on the appliance. `warp-lab.com` is already
carried as `kind: reference` under `ref-brand-and-fleet-domains`, and
`scripts/check-egress-allowlist.py` excludes `docs/` and markdown, so
this ADR does not trip the gate.

What *does* change is the **portal's inbound attack surface**: a
capability-addressed public route on an origin that today serves only
authenticated operator pages and machine-authenticated ingest. That is
a `droplet-analytics` security review, not an egress review, and it is
the reason this ADR is Proposed rather than Accepted. The review
checklist is the four bullets in §3.

## PHI position

- **Telemetry plane:** metadata-only by ADR-028 D4, enforced in code.
  No PHI, unchanged by this ADR.
- **Webflow plane:** inventory metadata plus three status fields. No
  PHI by construction — there is no path by which patient data could
  reach a CMS item or the bridge response.
- **The real exposure is Browser-SSH, and this ADR does not fix it.**
  If the stated posture is "troubleshooting only, no data access," the
  clean move is to **not deploy the SSH surface to `complianceTier:
  hipaa` machines at all**, rather than rely on the tier flag being set
  correctly at onboarding. Land WARP-420 (MFA step-up on SSH open) and
  clear WARP-1179 (`audit_events` rows with a null tier are never swept
  — an open HIPAA-adjacent retention gap awaiting sign-off).

## Consequences

### Positive

- Field units become trackable next to the brand site, in a surface
  non-engineers can edit, without any telemetry leaving the portal.
- The registry speaks the ADR-028 selector vocabulary from day one, so
  fleet tracking and release targeting share one language.
- The customer-facing "is my unit healthy" answer stops requiring an
  operator to open the ops console.
- The blast radius of the new public route is three metadata fields for
  one unit, bounded by a revocable key.

### Negative

- A third plane to keep consistent: a unit exists in the portal
  (`Machine`) and in Webflow (`Field Unit`), joined by `statusKey`.
  Drift is possible and nothing reconciles it automatically in v1.
- The portal gains its first public inbound route. Small, but it is a
  category change and it needs the review above.
- Webflow CMS item limits and Site API rate limits apply to the
  registry; this is fine for inventory cadence and would not be for
  telemetry — which is precisely why telemetry is excluded.

### Neutral

- The portal's hosting plan (`hosting.md` §2/§5, Mac mini → AWS) is
  untouched. This ADR narrows only what is *additionally* surfaced.

## Alternatives considered

- **Host the whole portal on Webflow.** Rejected — the runtime cannot
  support Postgres/Redis over persistent TCP, WebSockets, in-process
  sweeps, or `child_process` SSH, and it collapses the ops/marketing
  trust boundary.
- **Sync heartbeats into Webflow CMS items so the CMS *is* the fleet
  view.** Rejected — turns a content store into a telemetry store with
  no retention policy, no audit chain, publicly retrievable content,
  and rate limits unsuited to a 30 s heartbeat.
- **iframe the portal into a Webflow page.** Rejected — removes no
  hosting requirement and framing an SSH-capable console is a
  clickjacking surface.
- **Skip Webflow; add a customer status page to the portal.** Viable
  and simpler, but it puts customer traffic on the ops-console origin
  and loses the registry-beside-the-brand-site benefit. Worth
  reconsidering if the security review on §3 comes back heavy.
- **Reuse the ingest bearer token for the status read.** Rejected — a
  machine-scoped write credential must never be handed to a browser.

## How to apply

1. **Sign-off** on §3's public route (Romain) and the page shape
   (Stefan). Until then, nothing is built.
2. **`droplet-analytics`:** land WARP-813 (trusted-proxy allowlist), so
   the throttle's client-IP arm is sound before a public route exists.
3. **`droplet-analytics`:** add `Machine.statusKey` (nullable, unique,
   opaque 128-bit), the `/settings/tokens` mint/revoke control, the
   `GET /api/v1/public/status/{statusKey}` route with the
   deny-by-default serializer, and the field-allow-list unit test.
4. **Webflow:** create the `Field Units` collection per §2 and the
   per-unit status page that fetches the bridge route.
   **Not created by this ADR** — it is a change to the live production
   site and needs an explicit go.
5. **`droplet-analytics`:** correct `docs/superpowers/hosting.md` §1.3
   — DNS for `warp-lab.ai` is Webflow, not Squarespace.
6. **Independently of all of the above:** WARP-962 still gates
   everything. A status page reads from a portal that has never seen a
   real box; commission one first.
