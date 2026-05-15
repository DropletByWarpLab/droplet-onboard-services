# Fleet Management — Design Doc

> **Status:** Spec only. Approved direction (2026-05-15): Pattern B with
> git-tag auto-pull updates and a `/fleet` page on warp-lab.com.
> Implementation will land over 3–4 focused weeks; this doc is the
> contract Stefan can socialise with Romain / Sam before building.

## Problem statement

Once Droplets ship to customer sites, the operator (Stefan / Warp Lab)
needs:

1. **Visibility.** See every deployed device, online/offline, last
   heartbeat, container state, recent service health.
2. **Live troubleshoot.** Click a device → see its `ops-console` (the
   one shipped on `feat/ops-console` this week) without SSH gymnastics
   or customer-side port forwarding.
3. **Update push.** Roll new docker-compose / image / config out to
   all (or a canary subset of) devices. Verify health post-roll.
   Roll back automatically on failure.
4. **Audit.** Every operator action against any customer device is
   logged with who / when / what. SOC2-table-stakes once we move past
   the pilot phase.

## Why Pattern B and not the other two

Earlier discussion (2026-05-15) considered:

* **Pattern A — VPN mesh + per-device links.** Tailscale tailnet plus
  a small "list devices" page that deep-links into each one's
  `ops-console`. Days, not weeks. Rejected because there's no
  central state — when a device is offline you see nothing, no
  history, no audit, no "push update to fleet" mechanism.
* **Pattern C — buy Balena.** Off-the-shelf fleet manager.
  ~$15-30/device/month at scale, vendor lock-in on the host OS.
  Rejected because the per-device cost won't pencil pre-revenue.
* **Pattern B — outbound reverse tunnel + central aggregator.**
  Chosen. Each Droplet dials home to a Warp Lab HQ server; HQ owns
  the database, the rollout UI, and the proxy back into each
  Droplet's `ops-console`. Works through every customer firewall
  (outbound 443/UDP only). Survives Droplet offline (last-known
  state persists). Scales to hundreds of devices on a single $5/mo
  VPS.

## Architecture overview

```
                 customer site                       Warp Lab HQ
   ┌────────────────────────────┐                 ┌─────────────────┐
   │  Droplet appliance         │                 │  hq.warp-lab.com│
   │                            │                 │                 │
   │  ┌──────────────────────┐  │   outbound      │ ┌─────────────┐ │
   │  │ docker-compose stack │  │  WireGuard      │ │ wg server   │ │
   │  │  (today, unchanged)  │  │  51820/udp      │ │  10.99.0.1  │ │
   │  └──────────────────────┘  │                 │ └──────┬──────┘ │
   │  ┌──────────────────────┐  │ ◀────────────▶  │        │        │
   │  │ ops-console :8089    │  │ /ops/* proxy    │ ┌──────┴──────┐ │
   │  └──────────────────────┘  │  via tunnel     │ │ fleet-server│ │
   │  ┌──────────────────────┐  │                 │ │   FastAPI   │ │
   │  │ droplet-agent (NEW)  │──┼─heartbeat 60s──▶│ └──────┬──────┘ │
   │  │ heartbeat + update   │  │ POST /heartbeat │        │        │
   │  │ poller, every 5 min  │◀─┼─manifest poll ──│ ┌──────┴──────┐ │
   │  └──────────────────────┘  │ GET /manifest   │ │  Postgres   │ │
   │                            │                 │ │ devices,    │ │
   └────────────────────────────┘                 │ │ heartbeats, │ │
                                                  │ │ manifests,  │ │
                                                  │ │ audit_log   │ │
   ┌────────────────────────────┐                 │ └─────────────┘ │
   │   warp-lab.com/fleet       │ ◀──── browser ─▶│                 │
   │   Next.js operator UI      │  authenticated  │ ┌─────────────┐ │
   │                            │   NextAuth      │ │ Next.js API │ │
   │   - device list            │                 │ │ proxies to  │ │
   │   - per-device live view   │                 │ │ fleet-server│ │
   │   - rollout publisher      │                 │ └─────────────┘ │
   └────────────────────────────┘                 └─────────────────┘
```

## Components

### 1. `droplet-agent` (new service on each Droplet)

Runs as a sidecar container in the existing docker-compose stack.
Profile `agent` (default-on for any production deploy; off in dev so
local boxes don't try to dial HQ).

**Responsibilities:**

1. **Dial outbound WireGuard tunnel** to `hq.warp-lab.com:51820`
   using a per-device key generated at provisioning. Tunnel IP on the
   `10.99.0.0/16` HQ subnet. Tunnel stays up forever — if it drops,
   exponential backoff reconnect (1s → 60s cap).

2. **Heartbeat every 60 s:** `POST https://hq.warp-lab.com/api/fleet/heartbeat`
   with mTLS client cert (provisioned at install) carrying:

   ```json
   {
     "device_id": "drp-photo-studio-001",
     "hostname": "droplet-sys",
     "hwid_sha256": "<machine-id hashed>",
     "agent_version": "0.1.0",
     "current_tag": "release-2026-05-15-v1",
     "uptime_s": 9842301,
     "container_summary": { "ok": 18, "unhealthy": 0, "missing": 0 },
     "service_health": { "ok": 4, "degraded": 0, "down": 0, "unknown": 11 },
     "host": { "cpu_percent": 14, "mem_percent": 17, "disk_percent": 58 },
     "last_error": null
   }
   ```

   No customer data, no logs, no PII — just operational shape.

3. **Update poll every 5 min:** `GET /api/fleet/manifest?device_id=…`
   returns:

   ```json
   {
     "target_tag": "release-2026-05-15-v1",
     "verify_services": ["orchestrator", "ai-gateway"],
     "verify_timeout_s": 300,
     "rollback_on_failure": true
   }
   ```

   If `target_tag != current_tag`:

   1. Acquire local update lock (one update at a time per device).
   2. `git fetch && git checkout <target_tag>`. Tags are
      signature-verified (`git tag -v`) against the Warp Lab signing
      key embedded at provision time. **Unsigned or wrong-signer tag
      = refuse to update; report to HQ.**
   3. `docker compose -f docker/docker-compose.yml up -d --build`.
   4. Wait `verify_timeout_s` for every name in `verify_services`
      to report `ok` via the colocated ops-console's `/ops/services`.
   5. **On success** — POST `update-success` to HQ; new `current_tag`
      will show in next heartbeat.
   6. **On failure** — `git checkout <previous_tag>` and
      `docker compose up -d` again. POST `update-rolled-back` with
      the failure reason. Operator gets a Slack ping.

4. **Tunnel proxy listener:** binds `127.0.0.1:8090` inside the
   wireguard interface. HQ can `curl https://10.99.0.<n>:8090/ops/*`
   and the agent forwards to the local ops-console at `127.0.0.1:8089`.
   The wireguard ACL on HQ restricts which operator accounts can
   reach which device IPs.

**Image / size:** Tiny Python service. <50 MB final image. The
`wg` userspace path means no kernel-module install on the host —
works under the existing Pi / Jetson kernels untouched.

### 2. `fleet-server` (new service on HQ)

FastAPI app on `hq.warp-lab.com`. Same conventions as the rest of the
codebase (`services/fleet-server/` mirrors `services/ai-gateway/`
layout — `main.py + tests/` + Dockerfile).

**Routes:**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/fleet/heartbeat` | mTLS device cert | ingest |
| `GET`  | `/api/fleet/manifest` | mTLS device cert | what tag should I be on |
| `POST` | `/api/fleet/update-result` | mTLS device cert | update success / rollback report |
| `GET`  | `/api/fleet/devices` | operator NextAuth | list all devices |
| `GET`  | `/api/fleet/devices/{id}` | operator | one device detail + heartbeat history |
| `ANY`  | `/api/fleet/devices/{id}/proxy/{path:path}` | operator | proxy through wg tunnel to ops-console |
| `POST` | `/api/fleet/rollouts` | operator | publish a new target_tag for a device group |
| `GET`  | `/api/fleet/audit` | operator | operator action log |

**Database:** Postgres on the same HQ host. Four tables:

- `devices` — id, customer, hostname, hwid, wg_ip, mtls_cert_fp, provisioned_at
- `heartbeats` — device_id, ts, json payload (last 90 days; auto-prune)
- `manifests` — group_name, target_tag, verify_services, rollback_on_failure, published_at, published_by
- `audit_log` — operator_id, action, device_id, ts, request, response_code

**Tunnel proxy implementation:** `httpx.AsyncClient` with the
WireGuard interface as the source. Every operator request gets
logged to `audit_log` with full request line + response code.

### 3. `warp-lab.com/fleet` — operator UI

New page in the existing Next.js app at `apps/web-marketing/src/app/fleet/`
(or wherever the warp-lab.com source lives — confirm with Romain).
Auth gating: NextAuth with `role === "operator"`. Initially
Stefan-only; per-operator scopes when team grows.

**Pages:**

* `/fleet` — device list table (hostname, customer, online, last
  heartbeat, current_tag, health summary). Click row → device detail.
* `/fleet/devices/[id]` — live view. Embeds the device's
  `ops-console` UI via the proxy. Shows heartbeat history graph.
  Rollout history. Audit log slice for this device.
* `/fleet/rollouts` — operator publishes a target tag. Pick devices
  (single / group / fleet). Confirm. Watches the heartbeats roll
  through `current_tag = target_tag`.
* `/fleet/audit` — operator action log, filterable.

## Update mechanism — git tag + signature

The Warp Lab signing key is generated once, distributed to all
Droplets at provisioning, and kept ONLY in 1Password + Stefan's
hardware token (Yubikey).

**Publishing flow:**

1. Stefan develops on a branch, merges to `main`.
2. CI passes on `main`.
3. Stefan tags: `git tag -s release-2026-05-15-v1 -m "..."` and pushes.
4. CI on tag push: builds + publishes images to GHCR with that tag.
5. Stefan opens `/fleet/rollouts`, picks `release-2026-05-15-v1`,
   targets `group:photo-studio` (canary), confirms.
6. Within 5 min, photo-studio Droplet sees the new manifest, pulls,
   updates, reports back. Health check passes → update sticks.
7. Stefan watches heartbeats for 24 h. If clean, expands rollout to
   `group:all`.

**Why git-tag-based and not image-tag-based:** the Droplet stack
already lives in git (compose file, all configs). One canonical
truth, signed, atomic. Image tags are derived FROM the git tag in
CI so they stay in lockstep.

## Security posture

Every layer assumes the previous failed:

1. **Customer LAN compromise.** Outbound-only tunnel: attacker on
   customer LAN can't pivot through Droplet to HQ. Droplet's
   ops-console binds `127.0.0.1:8089` only.
2. **Droplet host compromise.** mTLS device cert can be revoked
   from HQ. Audit log shows last operator actions. Update rollback
   path means a bad update can't permanently brick the device.
3. **HQ compromise.** Worst case. Mitigations:
   - Image-signing key isn't on HQ (Yubikey only).
   - HQ can't forge new device certs without the offline CA.
   - Audit log mirrored to an append-only sink (S3 with
     `s3:ObjectLockConfiguration`) for forensic recovery.
4. **Operator account compromise.** All operator actions logged.
   Push to production gates on a second-operator approval once team
   grows past Stefan.
5. **Customer privacy.** Heartbeat payload contains operational
   shape only — no filenames, no user data, no IPs except internal
   tunnel addresses. Documented in customer agreement.

## Implementation phases

### Phase 1 — week 1: foundations

**Goal: have heartbeats arriving from the POC.**

- [ ] Stand up HQ VPS (Hetzner CX22 €5/mo, Ubuntu 24.04). Or
      Cloudflare Worker + D1 for the smallest possible MVP — picks
      this after a Romain conversation about long-term EU residency
      requirements.
- [ ] DNS: `hq.warp-lab.com` → HQ. TLS via Let's Encrypt.
- [ ] WireGuard server on HQ: subnet `10.99.0.0/16`, listening
      51820/udp.
- [ ] Generate per-Droplet keys for the POC + first 4 pilots.
      Stored in 1Password keyed by `device_id`.
- [ ] `services/droplet-agent/`: minimal heartbeat-only build.
      No update polling yet, no tunnel proxy yet — just dial WG,
      POST heartbeat every 60 s.
- [ ] `services/fleet-server/`: `POST /api/fleet/heartbeat` ingest,
      `GET /api/fleet/devices` list. Postgres + alembic.
- [ ] Deploy both. Confirm POC heartbeats arriving at HQ.

**Effort:** 5-6 days of focused work.

### Phase 2 — week 2: live proxy

**Goal: click a device in /fleet → see its live ops-console.**

- [ ] Tunnel-proxy listener in `droplet-agent`.
- [ ] `/api/fleet/devices/{id}/proxy/{path}` in fleet-server.
- [ ] Skeleton `/fleet` page on warp-lab.com — list devices,
      per-device detail with iframe to the proxied ops-console.
- [ ] NextAuth gate. Stefan-only via email allow-list.

**Effort:** 4-5 days.

### Phase 3 — week 3: updates

**Goal: publish a tag in /fleet/rollouts → Droplet updates → confirmed.**

- [ ] Update-poller in `droplet-agent` (git fetch + checkout +
      `docker compose up`).
- [ ] Signature verification against the Warp Lab signing key.
- [ ] Health-check + rollback path.
- [ ] `/api/fleet/manifest` + `/api/fleet/update-result` in fleet-server.
- [ ] `/fleet/rollouts` UI: publish manifest, watch devices update.
- [ ] Run a real update against the POC to validate the round trip.

**Effort:** 5-6 days.

### Phase 4 — week 4: hardening

**Goal: production-ready.**

- [ ] mTLS instead of shared-secret for device → HQ.
- [ ] Audit log with append-only S3 mirror.
- [ ] Slack webhook for: device offline >5 min, update rolled back,
      operator action on customer device.
- [ ] Disaster-recovery rehearsal: kill HQ, verify Droplets keep
      working, restart HQ, verify reconnect within 5 min.

**Effort:** 4-5 days.

## Open questions before implementation starts

1. **HQ host choice.** Hetzner CX22 ($5/mo, EU), Cloudflare Worker
   + D1 (serverless, no host to maintain), or AWS Lightsail
   ($3.50/mo, hub + spokes). Picks one before phase 1 day 1.

2. **Signing key custody.** Yubikey HW token? Or 1Password +
   passphrase-encrypted? The former is harder to lose; the latter
   is faster to set up.

3. **Manifest scope per group.** Initially each customer is its own
   group (1 device). At >10 customers, do we need richer grouping
   (e.g. "all photo-studios on v2 hardware")? Probably yes. Build
   the schema with that in mind.

4. **Field-replaceable agent.** If the agent itself has a bug that
   breaks heartbeat, how does it get updated? Answer: agent is
   inside the same compose stack, so a normal git-tag rollout
   updates it. BUT — if the agent breaks the rollout system, you
   need an out-of-band recovery path. Bootstrap: cron job on the
   host that resets to a known-good agent image if no successful
   update poll in 24 h.

5. **Field-replaceable wg keys.** If wg key for one device leaks,
   how does it get rotated? `/api/fleet/devices/{id}/rotate-wg-key`
   endpoint that returns a new key; agent applies and reconnects.
   Build this in phase 1.

## What we have today

* `services/ops-console/` shipped on `feat/ops-console`. Live on the
  POC at `127.0.0.1:8089`. This is the per-Droplet UI that
  `/fleet/devices/[id]` will proxy through. Already token-gated,
  already supports the operator actions we need (list / logs /
  restart). No changes required for fleet integration.
* `feat/ops-console` `ef79378` — empirically-corrected probe URLs.
  This is the API the heartbeat consumes (calls `/ops/services` and
  packs the summary into the heartbeat payload).

## Decision log

* **2026-05-15:** Stefan approved Pattern B (central aggregator)
  over Pattern A (Tailscale-only) and Pattern C (Balena).
* **2026-05-15:** Git tag + auto-pull on a 5-min timer chosen for
  update mechanism over watchtower, manual SSH, and deferring.
* **2026-05-15:** /fleet lives on warp-lab.com (not a separate
  domain, not on the ops box).
