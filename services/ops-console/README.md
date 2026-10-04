# ops-console

> Bound on the appliance at `127.0.0.1:8089` (host) → `:8087` (container).
> Reach via SSH tunnel: `ssh -L 8089:127.0.0.1:8089 droplet@<poc>`
> then open <http://localhost:8089/> and paste your `OPS_TOKEN`.

Operator-side monitoring + remote-troubleshooting console for a deployed
Droplet appliance. NOT customer-facing — this is the surface Stefan /
Warp Lab uses to see what's happening on a unit in the field.

## What it answers

When a Droplet is sitting in a customer's home and something breaks,
the operator needs to know:

- Which containers are up / unhealthy / restarting?
- What do the recent logs say for any failing service?
- What's the host doing — CPU / memory / disk / network?
- What does the customer-facing dashboard look like RIGHT NOW
  (mirror of `/api/health`)?
- Is the voice loop healthy (mirror of `/voice/status`)?
- Is the screen alive?
- What's the WiFi situation?

ops-console aggregates all of that into one **API-only** support
surface — no HTML UI is served from the device. Warp Lab support
consumes the API over a reverse tunnel using its own tooling on the
support side; per-device admin SPAs are deliberately out of scope
(the customer-facing dashboard already lives in `apps/web-dashboard`,
and the fleet/aggregator UI lives separately on warp-lab.com).

## Architecture

```
Warp Lab support (warp-lab.com fleet plane / local tooling)
    │
    │  HTTPS via reverse tunnel (TBD — Tailscale or WireGuard reach-back)
    ▼
ops-console (FastAPI on :8087, loopback-only bind, profile=ops)
    │
    ├── /healthz                 → unauth liveness for the container HEALTHCHECK
    ├── /ops/health              → authenticated token-check
    ├── /ops/system              → psutil (cpu / mem / disk / network / uptime)
    ├── /ops/containers          → docker ps via docker SDK (scoped to our compose project)
    ├── /ops/containers/{name}/logs?tail=N → docker logs (same scoping)
    ├── /ops/containers/{name}/restart      → docker restart (same scoping)
    └── /ops/services            → fan-out HTTP to each service's /health
```

All `/ops/*` endpoints require `Authorization: Bearer ${OPS_TOKEN}`,
and every request is recorded in the audit log
(`/var/log/ops-console/audit.jsonl`, mounted as the `ops-audit` named
volume so it survives container restarts). `OPS_TOKEN` is generated
by `scripts/lib/secrets.sh generate_env` and backfilled via
`_migrate_ensure_key` for existing installs.

The docker SDK calls are scoped to the
`com.docker.compose.project=droplet` label, so support
can list / inspect / restart only containers in our own stack — never
neighbours that happen to share the docker socket.

## Why a separate service (not bolted onto orchestrator)

- **Trust boundary**: orchestrator is customer-facing; ops-console is
  Warp-Lab-facing. Different auth, different audit log.
- **Always-on**: operator might need to log in when orchestrator is
  itself unhealthy. ops-console must keep running even if orchestrator
  crashes.
- **Docker socket access**: ops-console mounts `/var/run/docker.sock`
  to read container logs + restart containers. Giving the orchestrator
  that capability would expand its blast radius for no customer-side
  benefit.
- **Profile-gated**: `profiles: ["ops"]` means dev installs + customer
  deployments where Warp Lab support isn't enabled don't run it.

## Running

```
# In dev / on the POC:
COMPOSE_PROFILES=linux,full,ops docker compose up -d ops-console

# Reach via:
curl -H "Authorization: Bearer $OPS_TOKEN" http://localhost:8087/ops/health
```

## Field deployment (future, not in this commit)

The MVP only exposes ops-console on the local docker network. To use it
when a Droplet is at a customer site behind NAT, we'll need a reverse
tunnel — either:

- **Tailscale** (third-party, easiest): each appliance joins a Warp Lab
  tailnet at provision time; operator reaches it via tailscale magic-DNS.
- **WireGuard reach-back**: each appliance opens a wg peer to a Warp
  Lab control-plane server; operator hits the appliance via the wg
  tunnel.

Architecture-only for now; no code in this commit. See
`docs/ops-console-reverse-tunnel.md` for the design (future).

## Routes

| Path | Method | Returns |
|---|---|---|
| `/` | GET | 404 JSON — no UI is served from this service |
| `/healthz` | GET | Liveness for the docker HEALTHCHECK (unauth) |
| `/ops/health` | GET | Authenticated token-check |
| `/ops/system` | GET | `{ cpu_percent, mem_percent, disk_percent, uptime_s, ... }` from psutil |
| `/ops/containers` | GET | List of containers in our compose project + status + restart counts |
| `/ops/containers/{name}/logs?tail=N` | GET | Last N log lines as plain text (default 200, max 5000) |
| `/ops/containers/{name}/restart` | POST | Restart a container in our compose project; returns post-restart summary |
| `/ops/services` | GET | `{ summary, results: [{ status, latency_ms, http_status, detail? }] }` per registered service |

## Auth

Single bearer token, set as `OPS_TOKEN` env var, cryptographically
random. Provisioned by `scripts/lib/secrets.sh` (`generate_env` on
fresh installs + `_migrate_ensure_key` on upgrades). Support gets
the token via secure channel (1Password, encrypted chat); never
transmitted in URLs.

```
Authorization: Bearer xyz...
```

If `OPS_TOKEN` is unset the service falls back to an ephemeral random
token and logs only its sha256 fingerprint (never the value) — that's a
dev-only escape hatch so `uvicorn main:app` starts against a bare repo
(set `OPS_TOKEN` yourself to get a usable bearer); on a real device
`./scripts/setup.sh` always provisions a stable value.

### Support window expiry (WARP-3641)

Set `OPS_ACCESS_EXPIRES_AT` (ISO-8601, e.g. `2026-10-04T18:00:00Z`; no zone
means UTC) when enabling the `ops` profile for an engagement. After that
moment every `/ops/*` request gets `403 Support access window has ended`, even
with the right token, until the value is changed and the container is
recreated (`docker compose up -d --force-recreate ops-console`; a plain
restart does not re-read the compose environment). Empty or unset means no
expiry. A value that does not parse closes the window instead of leaving it
open. Each container start writes a `START` line to the audit log naming the
deadline it runs under.

Not done yet, by design (see WARP-3641): per-operator identity (every audit
line still says `support`), rotating `OPS_TOKEN` at the end of a session,
writing "support session opened/closed" rows into the customer's activity
chain, shipping this audit file off the box, and replacing the raw
`docker.sock` mount with a socket proxy that allows only list, inspect, logs
and restart for labelled containers. The socket cannot simply be mounted
read-only: restarting a container is a POST to the Docker API, and a `:ro`
bind mount of a Unix socket does not restrict the API anyway.

## Audit log

Every `/ops/*` request is recorded as one JSONL line in
`/var/log/ops-console/audit.jsonl` (mounted as the `ops-audit` named
volume so it survives container restarts) and mirrored to the
structured logger. Each line carries timestamp, identity, method,
path, status code, latency, and an optional detail field. This is
the trust boundary with the customer — after a support engagement
the audit log shows exactly what was looked at and what was changed.

## Why no rate limiting / fancy auth

This is internal Warp Lab tooling. The reverse tunnel (future) is the
real first line of defence; bearer-token gate behind it stops casual
mistakes. Production hardening (mTLS, OIDC, RBAC across operators)
lands when the fleet grows past 50 units.
