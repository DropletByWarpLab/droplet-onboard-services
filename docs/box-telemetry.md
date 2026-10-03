# What a Droplet sends to Warp (box telemetry)

WARP-3504, ADR-068 (`docs/ADR-068-fleet-identity-private-ota-and-telemetry.md` once it lands from
`docs/adr-068-fleet-identity-private-ota`). Contract: "Fleet identity, private OTA and operational
telemetry: shared contract v1", §4.

Every enrolled Droplet sends Warp **operational** data: that it is alive, which release it runs, how
busy it is, which services are up, how much the assistant was used (counts only) and the warnings and
errors its software logged. It is always on for an enrolled box (part of the managed lease), and the
owner can read exactly what was sent: **Settings → What this Droplet sends**, or
`GET /api/telemetry/last` (owner and admin only).

**Customer data never leaves the box.** The list below is a closed allowlist, enforced in code, not a
policy.

## What is sent

| Kind | When | Portal endpoint | Carries |
|---|---|---|---|
| `heartbeat.v1` | every 5 minutes | `POST /api/v1/telemetry/heartbeat` | release tag, git sha, channel; host kernel and distro; boot time and uptime; each compose service's name, state, health and restart count; CPU, memory and disk %; network byte counters; GPU load, VRAM and temperature (when the card reports all four); counts over the window of assistant messages, background runs, active members and OTA checks, downloads, installs, rollbacks and failures; error counts by class |
| `events.v1` | within a minute | `POST /api/v1/telemetry/events` | `boot`, `service.crash`, `service.recovered`, OTA steps, `token.refused`, `disk.low` (each: a type, a time, an optional stable code, an optional release tag) |
| `logs.v1` | within a minute | `POST /api/v1/telemetry/logs` | warn, error and fatal records of the orchestrator: service, level, a stable code, a masked message of at most 500 characters, and a count (identical records in a window are merged; at most 500 records per send) |

Every request carries `Authorization: Bearer <HQ device JWT>` with scope `telemetry:ingest`. The
machine is identified by the token (`sub` = key fingerprint, `did` = HQ device id), never by the body.

## What is never sent

Prompts or responses; file names, paths or contents; names, emails or ids of members, guests or anyone
else; hostnames the customer chose; LAN IPs, MACs or device lists; camera data; business data.

How that is enforced:

- **The builders are pure functions with a closed field allowlist**
  (`apps/orchestrator/src/services/box-telemetry/builders.ts`). They take typed facts (numbers, enums,
  short identifiers), copy them field by field, and end in a strict zod parse
  (`contract.ts`, unknown keys rejected at every level). There is no pass-through of an object of
  unknown shape, so a field the contract does not name cannot be sent.
- **Every free-text position is pinned to a narrow shape:** a compose service name, a stable code, a
  release tag, a hex sha, a kernel or distro string, and the log `msg`.
- **Log messages are masked on the box** (`redact.ts`) before anything is queued: the existing secret
  scrub, then web addresses, emails, MACs, IPv6 and IPv4 addresses, Windows and POSIX paths, quoted
  fragments, host and file names and long tokens (24+ characters with a digit); then control
  characters collapsed and the cut to 500 characters. Only pino's own `msg` is used, never an error's
  message, stack or structured fields. The portal masks the same shapes again.
- **Validated twice:** when built, and again when read back from the buffer, just before the POST.

## Where each fact comes from

| Field | Source |
|---|---|
| `release` | newest committed `DeviceUpdate` row (tag, sha, channel); a box that never took an OTA release reports tag `factory-image`, sha `unknown`, on the update agent's channel; a committed row with no tag reports `git-<first 10 of the sha>`, as the health page does |
| `os` | Docker Engine `/info` (the **host's** kernel and distro) |
| `uptime` | `os.uptime()` (host-wide) |
| `services[]` | Docker Engine API over the socket the OTA agent already uses: compose-labelled containers, inspected for health and `RestartCount` |
| `usage.cpuPct`, `memPct` | `node:os` (host-wide) |
| `usage.diskPct` | `statfs` of the OTA volume, i.e. the system disk, same formula as `df` |
| `usage.netRxBytes`, `netTxBytes` | `/proc/net/dev` of the orchestrator container: bytes crossing the control plane's own interface, not the whole LAN |
| `usage.gpus[]` | the host device-bridge `GET /gpu` (the Models page source); a card appears only when utilisation, VRAM used, VRAM total and temperature are all known |
| `activity.chatTurns`, `agentRuns`, `activeUsers` | COUNT queries over `ChatMessage` (user turns), `AgentRun`, and distinct actors in `ActivityRow`; the numbers only |
| `activity.ota` | `DeviceUpdate` counts for the window; `checks` from the update poller's own tick count; refused releases added to `failures` |
| `activity.errorsByClass` | the log tap's error and fatal counts by code, per window |
| events | boot at start; container state transitions (60 s poll, 5 min cooldown per service; the service name rides in `code` as `<service>:<reason>`); the update agent's status changes and poll outcomes; HQ token refusals; disk at or above 90 % |
| logs | the orchestrator's own pino logs at warn and above (`lib/log-tap.ts`, wired in `lib/logger.ts`) |

Three event types in the contract are **not emitted** by this version: `shutdown` (the portal sees a gap in heartbeats), `ota.check` (the count rides the heartbeat instead of one event per 15-minute poll) and `gpu.error`. OTA events: a release fetched and verified is `ota.download` (code `release_found`), an install is `ota.apply`, a rollback `ota.rollback` and a refusal or failure `ota.failed`, each with the failure reason as its code. The contract's events carry no service field, so a service event's `code` is `<service>:<reason>` (for example `ai-gateway:exit_137`).

What the portal must allow, per box: up to one POST a minute to each of events and logs, one heartbeat every 5 minutes, and after an outage a catch-up of at most 20 buffered bodies a minute (a 429 slows it down; `Retry-After` is honoured).

Log source B (other compose services' logs through the Docker logs API) is **not built**. Those
services mostly log plain text (Python `logging` format strings), so it needs a per-service line parser
and an allowlist; a follow-up.

## Always on, and what idle means

The sender runs whenever HQ will issue a `telemetry:ingest` token (WARP-3503's `HqTokenService`):

- `not_enrolled` or `revoked`: **idle**. Nothing is built or sent, HQ is asked again every 5 minutes,
  one info log line per hour. A `token.refused` event is queued once and goes out if the box is ever
  enrolled.
- HQ or the portal unreachable (network, 5xx, 429): payloads are buffered and delivery backs off
  (1 min, doubling, up to 30 min; `Retry-After` honoured).
- The portal answers 400, 413 or 422: that one body is malformed and is dropped and counted, never
  retried.
- `DROPLET_TELEMETRY_DISABLED=1` (lab and dev only, not in the UI) turns the sender off.
- No `HQ_ISSUANCE_URL` (dev, CI): the sender does not start.

State is explicit on `GET /api/telemetry/last`: `disabled | unconfigured | starting | ok | retrying |
not_enrolled | revoked`.

## Buffer

`<DROPLET_OTA_UPDATES_DIR>/telemetry/state.json` (mode 0600, written by rename): built `*.v1` bodies
waiting for the portal, the last accepted body of each kind, and the send counters. At most 600 bodies
and 8 MiB; over either, the **oldest are dropped first** and counted. It sits on the OTA volume, which
survives an orchestrator recreate and is wiped by a factory reset. A directory that cannot be written
degrades to memory only, with one warning.

## Daily summary

One `ActivityRow` per day (kind `system`, 23:55 local): "Sent operational health data to Warp", with
counts only (health snapshots, events, log records, KB, and any refusals, rejections or dropped
payloads).

## Retention (portal side, defaults)

Raw heartbeats, events and logs for 30 days; daily per-machine aggregates for 13 months. Both are
tunable on the portal.

## Relationship to the fleet-agent

This **supersedes** the double-gated `services/fleet-agent` telemetry profile
(`DROPLET_TELEMETRY_ENABLED` + the `telemetry` compose profile) for an enrolled box. The fleet-agent is
left untouched and still works as before when someone turns it on; it registers with a provisioning
code and a `dpl_` token, the portal's legacy path. The orchestrator's own older analytics façade
(`apps/orchestrator/src/services/analytics`, `ANALYTICS_ENABLED`) is likewise untouched.
