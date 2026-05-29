# Mobile API Contract

**Status:** Living document (mirror of the orchestrator routes that mobile clients consume)
**Date:** 2026-05-18
**Companion to:** ADR-008 (Native Mobile — Design System + API Contract)

This document is the source-of-truth contract that the iOS + Android
apps build against. Both apps re-derive their model layer from this doc.
If you change the orchestrator's mobile-relevant routes, update this
doc IN THE SAME PR and the mobile teams will mirror the change.

## Base URL

Native clients store a per-Droplet base URL set during pair flow.
Format: `https://<host>` where `<host>` is one of:
- mDNS hostname: `droplet-c4d4df.local` (LAN)
- DuckDNS subdomain: `mydroplet.duckdns.org` (remote, via TLS or WireGuard)
- raw IP: `192.168.1.5` (manual fallback)

All endpoints below are relative to base URL.

## Auth header

Every protected request:
```
Authorization: Bearer <accessToken>
```

Refresh token is stored separately and only sent to `/api/auth/refresh`.

## Endpoint catalog (mobile-relevant subset)

### Auth (`/api/auth/*`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/auth/login?return=body` | none | `{ username, password }` | `{ user, accessToken, refreshToken }` |
| POST | `/auth/refresh` | refresh | `{ refreshToken }` | `{ accessToken }` |
| POST | `/auth/logout` | Bearer | — | `{ ok: true }` |
| GET | `/auth/me` | Bearer | — | `{ id, username, displayName, role }` |

**Note:** the existing browser flow uses `Set-Cookie` httpOnly. Mobile
flow adds `?return=body` so the tokens come back in JSON. Backend
change required (one-line) — see ADR-008 action item.

### Health (`/api/orchestrator/health`)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/orchestrator/health` | none | `{ status: "ok"\|"degraded"\|"down", components: [...], uptime, version }` |

Called on app launch + every 60s while foregrounded. Drives the
status pill in the chrome.

### Device pairing (`/api/devices/*`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/devices/pair` | Bearer (dashboard) | `{ displayName }` | `{ code, expiresAt }` |
| GET | `/devices/pair/:code/status` | none | — | `{ status: "pending"\|"claimed"\|"expired" }` |
| POST | `/devices/pair/claim` | none | `{ code, username, password }` | `{ accessToken, refreshToken, deviceId, displayName }` |
| GET | `/devices/clients` | Bearer | — | `[{ id, displayName, platform, lastSeen, ... }]` |
| DELETE | `/devices/clients/:id` | Bearer | — | `{ ok: true }` |
| POST | `/devices/push` | Bearer | `{ token, platform: "ios"\|"android" }` | `{ ok: true }` |
| DELETE | `/devices/push/:tokenHash` | Bearer | — | `{ ok: true }` |
| GET | `/devices/push/vapid-public-key` | none | — | `{ key }` (WebPush only — not used by APNs/FCM) |

Pair-flow sequence:
1. Dashboard POST `/devices/pair` → shows QR with `droplet://pair?server=<base>&code=<6-digit>`
2. Phone scans QR → app opens, deep link parsed
3. App shows login form pre-filled with `server`
4. User taps Pair → phone POSTs `/devices/pair/claim` with `{ code, username, password }`
5. Response stores access + refresh tokens in Keychain / EncryptedSharedPreferences
6. App immediately POSTs `/devices/push` with APNs/FCM token

### Cameras (`/api/cameras/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/cameras` | Bearer | `{ cameras, discovered, recentEvents, totalCameras }` |
| GET | `/cameras/:name` | Bearer | full `CameraInfo` |
| GET | `/cameras/:name/thumbnail` | Bearer | image bytes |
| GET | `/cameras/:name/stream-url?protocol=hls\|webrtc` | Bearer | `{ url, expiresAt }` |
| GET | `/cameras/clips?camera=&from=&to=` | Bearer | `[{ id, camera, startedAt, durationMs, thumbnailUrl, downloadUrl }]` |
| GET | `/cameras/clips/:id/download` | Bearer | mp4 bytes |
| POST | `/cameras/clips/:id/share` | Bearer | `{ ttl? }` → `{ url, expiresAt }` |
| GET | `/cameras/groups` | Bearer | `[{ id, name, members }]` |
| GET | `/cameras/pins` | Bearer | `[{ cameraName, sortOrder }]` |
| POST | `/cameras/pins` | Bearer | `{ cameraName, sortOrder? }` → 201 |
| DELETE | `/cameras/pins/:cameraName` | Bearer | `{ ok }` |

Stream URL is short-lived (signed); fetch fresh on every player open.

### LLM (`/api/llm/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/llm/models` | Bearer | `[{ id, name, provider, ... }]` |
| GET | `/llm/conversations` | Bearer | `[{ id, title, updatedAt, model }]` |
| GET | `/llm/conversations/:id` | Bearer | `{ id, title, messages: [...] }` |
| POST | `/llm/conversations` | Bearer | `{ title?, model? }` → `{ id }` |
| POST | `/llm/conversations/:id/chat` | Bearer | `{ message, stream?: true }` → SSE stream OR JSON |
| DELETE | `/llm/conversations/:id` | Bearer | `{ ok }` |

Streaming uses SSE (`Content-Type: text/event-stream`). Native clients
should use a streaming HTTP client (URLSession `bytes(for:)` on iOS,
OkHttp streaming on Android) to render token-by-token.

### Files (`/api/files/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/files?path=/` | Bearer | `{ entries: [{ name, path, size, modified, isDirectory }], parent }` |
| GET | `/files/download?path=…` | Bearer | file bytes |
| POST | `/files/upload` | Bearer | multipart → `{ path, size }` |
| POST | `/files/share` | Bearer | `{ path, ttl? }` → `{ url, expiresAt }` |
| POST | `/files/mkdir` | Bearer | `{ path }` → 201 |
| POST | `/files/rename` | Bearer | `{ from, to }` → `{ ok }` |

V1 mobile uses list + download + share only. Upload + mkdir + rename
are Phase 2.

### Matter / smart home (`/api/matter/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/matter/devices` | Bearer | `[{ id, name, type, room?, state, capabilities }]` |
| POST | `/matter/devices/:id/command` | Bearer | `{ command: "on"\|"off"\|"toggle"\|..., args? }` → `{ ok }` |
| GET | `/matter/events?since=…` | Bearer | `[{ id, deviceId, type, ts, payload }]` |
| DELETE | `/matter/devices/:id` | Bearer | `{ ok }` |
| POST | `/matter/commission` | Bearer | `{ qrPayload }` → `{ deviceId }` (dashboard only in v1) |

Commissioning happens via dashboard QR scanner (WARP-182). Mobile v1
controls existing devices but does NOT add new ones.

### Notifications (`/api/notifications`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/notifications?since=…` | Bearer | `[{ id, type, ts, title, body, deepLink? }]` |
| POST | `/notifications/:id/ack` | Bearer | `{ ok }` |

Native apps fetch on launch and every 5 minutes when foregrounded.
APNs / FCM push is the real-time delivery; this endpoint is for catch-up
+ in-app inbox.

### VPN / remote access (`/api/vpn/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/vpn/status` | Bearer | `{ active, peerCount, endpoint }` |
| GET | `/vpn/peers` | Bearer | `[{ id, name, publicKey, allowedIps, lastSeen }]` |
| POST | `/vpn/peers` | Bearer | `{ name }` → `{ peerId, config: <wg-quick conf>, qr: <png data url> }` |
| DELETE | `/vpn/peers/:id` | Bearer | `{ ok }` |

For phone self-add:
- App POST `/vpn/peers` with `{ name: "<deviceDisplayName>" }`
- Response includes `config` (wg-quick INI) — app parses it and
  configures `NEVPNManager` (iOS) / `WgQuickBackend` (Android)
- Phone toggles VPN on; app's `server` URL keeps working from outside

### Devices index (`/api/devices`)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/devices` | Bearer | unified inventory: cameras + matter devices + network clients |

Used by the Home tab's "Devices" KPI.

### Settings (`/api/settings/workspace` — Phase 4)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/settings/workspace` | Bearer | `{ workspaceType: "home"\|"business" }` |
| POST | `/settings/workspace` | Bearer (owner) | `{ workspaceType }` → `{ ok }` |

This endpoint does not exist yet (Phase 4 of dashboard rehaul). Mobile
defaults to "home" when the endpoint returns 404.

## Error shape

Every 4xx / 5xx response from the orchestrator follows:
```json
{ "error": { "code": "STRING_CONSTANT", "message": "Human readable" } }
```

Native error mapping (subset):
| Code | iOS toast | Android snackbar |
|---|---|---|
| `INVALID_CREDENTIALS` | "Wrong username or password" | "Wrong username or password" |
| `PAIR_CODE_EXPIRED` | "Pair code expired — refresh the QR" | same |
| `PAIR_CODE_INVALID` | "Pair code not recognized" | same |
| `RATE_LIMITED` | "Slow down — try again in a moment" | same |
| `NOT_FOUND` | (page-specific) | (page-specific) |
| `INTERNAL` | "Something went wrong — try again" | same |

## SSE / streaming reads

Chat streaming responses look like:
```
event: token
data: {"text": "Hello"}

event: token
data: {"text": " world"}

event: done
data: {"finishReason": "stop"}
```

Native clients buffer until `event: done`, append text to the active
message bubble per-token.

## Schema migration policy

This contract is APPENDED to, not modified, between mobile app
releases. Breaking changes wait for a coordinated app + orchestrator
release. Field additions are always safe — old apps ignore unknown
fields.

If a route gets a breaking change, gate it behind a versioned path
(`/api/v2/...`) and keep the v1 path alive for ≥1 mobile release.

## Open items

- [ ] OpenAPI generation: should we write `openapi.yaml` and codegen
      Swift/Kotlin clients? Reduces drift but adds a build step.
      Defer — markdown contract is the v1 mechanism.
- [ ] WebSocket / Server-Sent Events for real-time notifications when
      app is foregrounded. Today the only real-time channel is APNs/FCM
      push (background) + polling.
- [ ] WebRTC vs HLS for camera streams. Frigate supports both; HLS is
      simpler client-side, WebRTC has lower latency. v1 ships HLS.
## Project Management (Plane integration)

> Implemented in [WARP-513](https://warp-lab.atlassian.net/browse/WARP-513).
> ADR: [ADR-010](ADR-010-pm-stack-selection.md). Spec:
> [`superpowers/specs/2026-05-27-warp-498-pm-stack-design.md`](superpowers/specs/2026-05-27-warp-498-pm-stack-design.md).

V1 = read-only on mobile. The orchestrator wraps Plane's upstream API
(`X-API-Key`, workspace-slug-centric, `work-items` per spec OQ-set
verified 2026-05-28) and transforms responses into Droplet's existing
mobile envelope per OQ4 resolution. iOS/Android/Windows clients call
the endpoints below; they MUST NOT call Plane directly.

### `GET /api/mobile/pm/workspaces`

List workspaces visible to the caller. Used for `workspace_slug`
discovery before downstream calls.

**Response:**
```json
{
  "workspaces": [
    { "id": "<uuid>", "slug": "<slug>", "name": "<string>" }
  ]
}
```

### `GET /api/mobile/pm/projects?workspace=<slug>&per_page=<n>`

Paginated list of projects under a workspace.

**Query params:**
- `workspace` (required) — workspace slug from `/workspaces`.
- `per_page` (optional) — 1..100, default 50.

**Response:**
```json
{
  "projects": [
    {
      "id": "<uuid>",
      "name": "<string>",
      "identifier": "<short-code>"
    }
  ]
}
```

### `GET /api/mobile/pm/work-items?workspace=<slug>&project_id=<id>&state=<id>&assignee=<id>&per_page=<n>`

Paginated list of work items (issues/tickets — Plane's name).

**Query params:**
- `workspace` (required), `project_id` (required).
- `state` (optional) — filter by state id.
- `assignee` (optional) — filter by assignee id.
- `per_page` (optional) — 1..100, default 50.

**Response:**
```json
{
  "work_items": [
    {
      "id": "<uuid>",
      "name": "<string>",
      "state": "<state-id>",
      "assignees": ["<user-id>"],
      "labels": ["<label-id>"],
      "created_at": "<iso8601>",
      "updated_at": "<iso8601>"
    }
  ]
}
```

### `GET /api/mobile/pm/work-items/{id}?workspace=<slug>&project_id=<id>`

Fetch a single work item with description body.

**Query params:**
- `workspace` (required), `project_id` (required).

**Response:**
```json
{
  "work_item": {
    "id": "<uuid>",
    "name": "<string>",
    "description_html": "<string>",
    "state": "<state-id>",
    "assignees": ["<user-id>"],
    "labels": ["<label-id>"],
    "created_at": "<iso8601>",
    "updated_at": "<iso8601>"
  }
}
```

**Status codes:**
- `200` — found.
- `404` — work item not in this project/workspace.
- `401` — JWT missing or invalid.
- `502` — Plane API unreachable (orchestrator logs the upstream error).

### Out of scope for V1

- Mobile writes (create/update/comment/transition). Mobile is read-only.
- Push notifications when work items change. Webhook receiver
  (WARP-511) lands the event bus; mobile push is a follow-up epic.
- Custom field reads — orchestrator returns default Plane fields only.
- Native UI for project/work-item editing — out of scope.
