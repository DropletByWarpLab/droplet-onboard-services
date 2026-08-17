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
| `GET {releases}` (update-poll, its own opt-in) | 5 min | nothing sent (optional auth header); response = release metadata |
| `GET` asset URLs from that response (`release.json` / `.sig`) | per new release | nothing sent; response = manifest + signature bytes |

`{releases}` = `DROPLET_OTA_RELEASES_URL` (GitHub Releases `latest`
endpoint of the canonical publisher). Asset URLs come from the releases
endpoint's own response — never from manifest content.

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

## Update poll (WARP-1025 — the ratified ADR-028 mount)

The signed release-manifest poll mounts here as one more apscheduler
job, per WARP-961/[ADR-028](../../docs/ADR-028-fleet-telemetry-and-design-answers.md)
(Accepted 2026-07-03) — same process as telemetry, no second agent.
**Its own opt-in** (`DROPLET_UPDATE_POLL_ENABLED=1`, default OFF):
checking for signed releases and sharing telemetry are different
operator consents; either half runs without the other.

Every ~5 minutes ([`update_poll.py`](update_poll.py)):

1. **Discover** — find the newest release for this box's channel, then
   download its `release.json` + `release.json.sig` assets. On `stable`
   that is a GET of the GitHub Releases `latest` endpoint
   (`DROPLET_OTA_RELEASES_URL`, the same deployment knob the
   orchestrator's WARP-538 poller reads). Other channels publish as
   prereleases, which `latest` skips by design, so they read the
   releases list instead and take the newest `ota-<channel>-*` entry
   (WARP-1670). That tag match is a cheap pre-filter over unsigned
   metadata — step 2 still decides on the signed manifest.
2. **Verify** — the full WARP-537 trust chain
   ([`release_verify.py`](release_verify.py), a Python port of the
   orchestrator's `update-agent/{manifest,verify}.ts`, tested against
   the same golden fixtures): baked-in trust anchor
   ([`cosign.pub`](cosign.pub) — fails closed on the WARP-535
   placeholder until the key ceremony, `scripts/README.md`) → vendored
   `cosign verify-blob` (pinned + checksummed in the
   [`Dockerfile`](Dockerfile)) → schema gates (anti-rollback,
   forward-compat, shape). Unsigned/tampered/invalid manifests are
   **rejected + audited**: a warn `update.signature_failed` /
   `update.verify_failed` log event plus a fingerprinted report on the
   errors queue (pushed to the portal when telemetry is on). Unverified
   bytes never touch the candidate record.
3. **Target** — the ratified ADR-028 tag-selector vocabulary: release
   `channel` must equal the box channel, and every selector in the
   optional `release.scope` object (`tier`/`channel`/`customer`/
   `region`/`hw` + `device_id` canary) must match the box's tags
   (`DROPLET_TIER`, `DROPLET_UPDATE_CHANNEL`, `DROPLET_CUSTOMER`,
   `DROPLET_TELEMETRY_GEO_REGION`, `DROPLET_HARDWARE_REVISION`, and the
   registered portal machine id). Unknown selector keys can never
   match — targeting fails closed.
4. **Record/report** — write `update-candidate.json` (state dir) and
   log `update.candidate_recorded`. **No apply, no actuation, no
   control channel**: acting on a candidate stays with the
   orchestrator's OTA apply chain (WARP-539/540) pending the WARP-538
   reconciliation (see the WARP-1025 PR).

Fail-open like every other job: endpoint unreachable, 5xx, and TLS
failures are typed outcomes; anything unexpected is swallowed by the
tick wrapper. A failing poll can never degrade the box.

## State

`/var/lib/droplet/fleet-agent` (compose volume `fleet-agent-state`):

- `identity.json` — machine_id + ingest token from the one-time
  registration (chmod 0600 best-effort). Never tracked in git.
- `heartbeat-spool.jsonl` — bounded offline heartbeat buffer
  (`DROPLET_TELEMETRY_SPOOL_MAX`, default 1000 ≈ 8 h at 30 s).
- `update-candidate.json` — latest signature-VERIFIED update candidate
  from the WARP-1025 update-poll (git sha, tag, channel, scope,
  manifest sha256, per-service digests). Only verified manifests are
  ever summarized here; a corrupt record fails open to "no candidate".

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
| `DROPLET_HOSTNAME` / `DROPLET_TIER` / `DROPLET_HARDWARE_REVISION` | registration payload; tier/hw double as targeting tags | container hostname / `home` / unset |
| `DROPLET_UPDATE_POLL_ENABLED` | update-poll opt-in (WARP-1025); anything but `1`/`true` = off | off |
| `DROPLET_OTA_RELEASES_URL` | GitHub Releases `latest` endpoint (same knob as the orchestrator poller) | canonical publisher |
| `DROPLET_OTA_GITHUB_TOKEN` | bearer for a private releases repo; empty = no auth header | empty |
| `DROPLET_UPDATE_POLL_SEC` | poll cadence | `300` |
| `DROPLET_UPDATE_CHANNEL` | release channel this box tracks — `stable` (built from `main`) or `stage` (built from `stage`, WARP-1670). This also selects HOW releases are discovered: `stable` reads GitHub's `latest`, every other channel reads the releases list and takes the newest `ota-<channel>-*` entry, because stage publishes as a prerelease and `latest` skips those. | `stable` |
| `DROPLET_CUSTOMER` | `customer` targeting tag (ADR-028 selector vocabulary) | unset |

## Tests

```sh
cd services/fleet-agent
python -m pip install -r requirements-dev.txt   # Python 3.12
python -m pytest
```

All portal + GitHub traffic is `respx`-mocked; collectors are injected
fakes, so the suite runs anywhere (including Windows dev hosts without
/proc). The `test_release_verify.py` / `test_update_poll.py` suites exec
the REAL cosign binary over the shared WARP-537 golden fixtures
(`apps/orchestrator/src/services/update-agent/__fixtures__/`) — install
cosign locally (or set `DROPLET_COSIGN_BIN`); CI installs it via
`sigstore/cosign-installer`. A missing binary fails those tests loudly,
never skips.
