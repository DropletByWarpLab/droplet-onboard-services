# Operator surfaces — auth + deployment pattern

> **Scope.** This document covers Warp-Lab-operator-facing services (today
> just `services/ops-console/`) that are **deliberately separate from the
> customer-facing dashboard** described in [`admin-dashboards.md`](admin-dashboards.md).
> Customer-facing admin pages and operator surfaces live under different
> trust boundaries and must follow different auth rules. If you're building
> a page for the END USER (or even the customer's own admin user), this is
> the wrong doc — read `admin-dashboards.md` instead.

## What an "operator surface" is

An operator surface is a UI or API the Warp Lab support / on-call team
uses to inspect and control a deployed Droplet **without** going through
the customer's identity system. Examples that exist or are planned:

| Service | Path on appliance | Role |
|---------|------------------|------|
| `services/ops-console/` | `:8089` (host port) | Container list, logs, restart, service probes |
| (future) `services/ops-fleet-aggregator/` | central HQ host | Aggregates per-Droplet ops-console proxies (see `FLEET_MANAGEMENT_DESIGN.md`) |

The customer doesn't see these. They run under a compose profile
(`ops`) that is **off by default**; they ship enabled only on deployments
where Warp Lab has explicit support access.

## Why this trust boundary is separate from the dashboard

Three reasons, in order of weight:

1. **Different identity domain.** The dashboard authenticates the
   *customer* (Nextcloud session, role: `owner` / `family` / `guest`).
   An operator surface authenticates a *Warp Lab employee*. Promoting a
   customer's `owner` session to operator capabilities would let any
   customer factory-reset their own appliance — which is fine — but also
   let them invoke Warp-Lab-only diagnostics. Keep them disjoint.

2. **Different availability requirement.** Operators may need to log in
   precisely when the orchestrator is unhealthy. The customer dashboard
   depends on orchestrator + Nextcloud + Redis being up; the operator
   surface must keep working when those are not.

3. **Different audit trail.** Operator actions need to be attributed to
   a Warp Lab employee for compliance (SOC 2 / HIPAA pilots). Mixing
   them with the customer's audit log dilutes both.

## The pattern

### Deployment

- **Compose profile**: `ops` (NOT `linux` or default). Add to the
  customer's `COMPOSE_PROFILES` env only on deployments where Warp Lab
  support is enabled. Do not bake into the customer-facing setup wizard.
- **Network exposure**: bound to a host port (today `:8089`) reachable
  only via a reverse tunnel from HQ. Never publish to the open internet.
  When the fleet aggregator lands, this becomes a per-Droplet upstream
  the HQ-side aggregator proxies.
- **Volumes**: minimum needed. ops-console mounts `/var/run/docker.sock`
  read-write (deliberate — that's how `ops/containers/{id}/restart`
  works). Any service that mounts Docker sockets is by definition
  privileged and MUST live behind operator auth, not customer auth.

### Auth (today — v0)

Single shared bearer token, named per service (`OPS_TOKEN` for
ops-console). Pattern, mirroring the inbound shape used for
`SERVICE_TOKEN_VOICE` in `apps/orchestrator/src/middleware/auth.ts`:

```python
import os, secrets
from fastapi import Header, HTTPException

_TOKEN = os.environ.get("OPS_TOKEN") or secrets.token_urlsafe(32)
if not os.environ.get("OPS_TOKEN"):
    # Loud at startup — never silently generate a prod token.
    print(f"[ops-console] WARN: OPS_TOKEN unset; ephemeral token = {_TOKEN}",
          file=sys.stderr)

def require_ops_auth(authorization: str | None = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer")
    presented = authorization[len("Bearer "):].encode()
    expected = _TOKEN.encode()
    # Constant-time compare so a token-guessing attacker can't time-slice.
    if not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="invalid bearer")
```

Hard rules (apply to every operator surface that adopts this pattern):

- **Constant-time compare.** Use `secrets.compare_digest` (Python) or
  `crypto.timingSafeEqual` (Node) on equal-length buffers. Never `==`.
- **Token storage.** Operator gets the token via 1Password or encrypted
  chat. Never in a URL, never logged. Token rotates by changing the env
  and restarting the service — no migration dance.
- **No cookie path.** Bearer header only. Cookies are for human browser
  sessions and would tempt a customer to send the token from their
  browser via an XSS or CSRF chain.
- **Log every authenticated call.** Method + path + status, NOT the
  body. The audit trail is the second line of defence after the tunnel.

### Auth (v1 — when we outgrow v0)

`auth.py`'s docstring in `services/ops-console/ops/auth.py` calls out the
trip-wire:

> When the operator team grows past ~5 people or the fleet grows past
> 50 units, this gets replaced with proper OIDC + per-operator audit.

OIDC against a Warp Lab IdP (Okta / Google Workspace / similar), with
per-operator JWTs, per-action audit rows, and Yubikey step-up for
destructive actions. That's a separate design doc when we get there.

## Common-case wiring

### Frontend served by the operator service itself

ops-console serves a tiny vanilla-JS UI from the same FastAPI process
(see `services/ops-console/ops/static/`). The UI's first action on load
is to prompt for the bearer token via a `prompt()` and stash it in
`sessionStorage`. **Do not** persist to `localStorage` — the token must
expire when the tab closes.

### Backend route gate

Every `/ops/*` route depends on the auth callable:

```python
@app.get("/ops/containers", dependencies=[Depends(require_ops_auth)])
async def list_containers() -> list[dict]:
    ...
```

A route without that `Depends` is a bug; CI should grep for missing
dependencies (TODO: add a vitest-style enforcement test).

## When NOT to follow this pattern

If the service is:

- Customer-facing → use `admin-dashboards.md` (Nextcloud session +
  owner/admin role).
- Internal service-to-orchestrator → use the orchestrator's
  `SERVICE_TOKEN_*` pattern (see `apps/orchestrator/src/middleware/auth.ts`
  `matchServiceToken`) — a shared bearer named for the calling service
  (e.g. `SERVICE_TOKEN_VOICE` for voice-io). Same constant-time compare,
  different inbound direction, different role (`service` not operator).
- Public health check → no auth, but `/api/health` style:
  unauthenticated, minimal info disclosure, never include version /
  hostname / counts in the body.

## Glossary

- **Operator** — a Warp Lab employee with on-call / support access. Not
  the customer.
- **Customer admin** — the customer's own admin user. Authenticates via
  Nextcloud, lands on the dashboard's `/admin/*` pages. Does NOT see
  operator surfaces.
- **Tunnel** — reverse SSH or WireGuard tunnel from the Droplet to the
  Warp Lab HQ host. The first line of defence; the operator token is
  the second.

## See also

- [`admin-dashboards.md`](admin-dashboards.md) — customer admin pattern
- [`FLEET_MANAGEMENT_DESIGN.md`](FLEET_MANAGEMENT_DESIGN.md) — fleet
  aggregator design that consumes per-Droplet ops-console surfaces
- `services/ops-console/README.md` — ops-console-specific notes
- `services/ops-console/ops/auth.py` — reference auth implementation
- `apps/orchestrator/src/middleware/auth.ts` `matchServiceToken` —
  the sibling pattern for service-to-service inbound auth
