# fleet-agent — fail-open portal telemetry (WARP-963 v1)

The box-side half of Droplet fleet visibility: ONE on-device agent that
pushes operational telemetry to the Warp Lab analytics portal
([`droplet-analytics`](https://github.com/DropletByWarpLab/droplet-analytics))
over its **frozen** agent API (`docs/superpowers/agent-api.openapi.yaml`
v1.0.0 in that repo).

**OFF by default.** The agent dials nothing unless the operator both
sets `DROPLET_TELEMETRY_ENABLED=1` **and** provisions credentials (a
one-time `DROPLET_TELEMETRY_PROVISIONING_CODE` minted in the portal's
`/settings/tokens`, or an identity persisted by a previous
registration). Compose additionally gates the container behind the
`telemetry` profile, so a default box never even starts it.

**Fail-open by construction.** Every scheduler tick swallows and logs
every exception; portal outages spool heartbeats to a bounded on-disk
buffer (oldest drop first) and replay when connectivity returns. The
agent observes the box; it can never degrade it.

## Egress audit (ADR-012 discipline)

Everything this service can ever dial, in one table. There are no other
destinations; every attempt is logged on the `fleet_agent.egress`
logger. Payloads are operational shape only — no file names, no user
data, no customer LAN client detail.

| Endpoint | Cadence | Payload class |
|---|---|---|
| `POST {portal}/agents/register` | once, first enabled boot | hostname, tier, firmware version |
| `POST {portal}/agents/heartbeat` | 30 s (server-tunable) | uptime, load, cpu, ram (+ optional operator-pinned geo) |
| `POST {portal}/agents/metrics` | 60 s | `system.*` gauge samples |
| `POST {portal}/agents/errors` | push (5 s flush) | fingerprinted agent-internal faults |
| `POST {portal}/agents/inventory` | 6 h + boot | firmware/kernel/machine shape |
| `POST {portal}/agents/network` | 5 min | ts + default-route iface only (v1) |
| `GET {portal}/agents/commands/poll` | long-poll `wait=25` | — |
| `POST {portal}/agents/commands/{id}/result` | per command | explicit "unsupported" result |

`{portal}` = `DROPLET_TELEMETRY_PORTAL_URL`. Contract headers on every
request: `Authorization: Bearer dpl_<machineId>_<secret>`,
`X-Droplet-Id`, `X-Droplet-FW`, and a client-picked UUIDv4
`X-Idempotency-Key` on POSTs. `429 Retry-After` is honored per endpoint
— the client does not dial while a window is open.

## Commands: v1 = observe only

The portal's command queue (`ssh.tunnel.open`, `container.restart`,
`config.reload`, `diagnostic.run`, `ota.pin_channel`, …) is polled and
every command is answered with an explicit `status: "error"` /
"unsupported in fleet-agent v1" result. **No remote actuation of any
kind is performed.** Turning any command type on is a deliberate,
security-reviewed follow-up under the WARP-961 agent-unification
decision — not a config flip.

## Update poll: intentionally not here

`docs/FLEET_MANAGEMENT_DESIGN.md` gives the eventual agent a third duty
(signed git-tag manifest poll + self-update). That half is NOT in this
service: WARP-538 tracks the orchestrator-side update poller, and
WARP-961 owns the decision of unifying it with this agent. The design
answers required to unblock that are proposed (NOT yet ratified) in
[`docs/ADR-028-fleet-telemetry-and-design-answers.md`](../../docs/ADR-028-fleet-telemetry-and-design-answers.md).
See the marked block in [`agent.py`](agent.py).

## State

`/var/lib/droplet/fleet-agent` (compose volume `fleet-agent-state`):

- `identity.json` — machine_id + ingest token from the one-time
  registration (chmod 0600 best-effort). Never tracked in git.
- `heartbeat-spool.jsonl` — bounded offline heartbeat buffer
  (`DROPLET_TELEMETRY_SPOOL_MAX`, default 1000 ≈ 8 h at 30 s).

## Environment

| Var | Meaning | Default |
|---|---|---|
| `DROPLET_TELEMETRY_ENABLED` | master opt-in; anything but `1`/`true` = off | off |
| `DROPLET_TELEMETRY_PORTAL_URL` | agent-API base | `https://analytics.warp-lab.ai/api/v1` |
| `DROPLET_TELEMETRY_PROVISIONING_CODE` | one-time register code | empty |
| `DROPLET_TELEMETRY_STATE_DIR` | runtime state dir | `/var/lib/droplet/fleet-agent` |
| `DROPLET_TELEMETRY_GEO_COUNTRY` / `_GEO_REGION` | operator-pinned fleet-map location; invalid/empty → omitted entirely | unset |
| `DROPLET_TELEMETRY_SPOOL_MAX` | heartbeat spool bound | `1000` |
| `DROPLET_FIRMWARE_VERSION` | reported in `X-Droplet-FW` + payloads | `0.0.0+unknown` |
| `DROPLET_HOSTNAME` / `DROPLET_TIER` / `DROPLET_HARDWARE_REVISION` | registration payload | container hostname / `home` / unset |

## Tests

```sh
cd services/fleet-agent
python -m pip install -r requirements-dev.txt   # Python 3.12
python -m pytest
```

All portal traffic is `respx`-mocked; collectors are injected fakes, so
the suite runs anywhere (including Windows dev hosts without /proc).
