# Mobile API Contract

**Status:** Living document (mirror of the orchestrator routes that mobile clients consume)
**Date:** 2026-05-18 (chat route + SSE wire corrected 2026-06-01 — XR-01/XR-02)
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
| POST | `/auth/login?return=body` | none | `{ email, password, totp?, recoveryCode? }` | `{ user, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }` |
| POST | `/auth/refresh` | refresh | `{ refreshToken }` | `{ accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }` |
| POST | `/auth/logout` | Bearer | — | `{ status: "ok" }` |
| GET | `/auth/me` | Bearer | — | `{ id, username, displayName, role }` |
| POST | `/auth/totp/enroll` | Bearer | — | `{ otpauthUri, qrDataUrl, issuer }` |
| POST | `/auth/totp/verify` | Bearer | `{ code }` (6-digit) | `{ enabled: true, recoveryCodes? }` |
| POST | `/auth/recovery` | Bearer | `{ code }` | `{ ok: true, remaining }` |

**Auth model (ADR-013 directory).** Login authenticates an **email +
password (argon2id)** against the local directory — *not* Nextcloud
credentials. `username` is still accepted as a legacy alias for `email`.
`?return=body` (shipped) returns the JWT pair in the body too (browsers
also get httpOnly `Set-Cookie`). Tokens are HS256; **refresh rotates the
refresh token on every call and denylists the previous one**, so native
clients MUST persist the new `refreshToken` from `/auth/refresh`.

**Second factor.** If the account has TOTP enabled, `/auth/login` returns
`401 { error, code: "TOTP_REQUIRED" }` until a valid `totp` (or unused
`recoveryCode`) is included in the login body. The successful access
token carries an MFA stamp used by `require-recent-mfa` routes. WebAuthn
is not part of the app login path.

**Recovery-code step-up.** `/auth/recovery` is a **Bearer-authenticated**
step-up that consumes one unused recovery code for an already-signed-in
session (body `{ code }` → `{ ok, remaining }`, six-digit `/auth/totp/verify`
is the same shape). It is **not** a pre-login account-recovery endpoint —
pre-login recovery is the `recoveryCode` field on `/auth/login` above.

### Health (`/api/orchestrator/health`)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/orchestrator/health` | none | `{ status: "ok"\|"degraded"\|"down", components: [...], uptime, version }` |

Called on app launch + every 60s while foregrounded. Drives the
status pill in the chrome.

### Device pairing (`/api/devices/*`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/devices/pair` | Bearer (dashboard) | `{ deviceName, deviceType: "desktop"\|"mobile", platform }` | `{ code, expiresAt, pairUrl }` |
| GET | `/devices/pair/:code/status` | Bearer | — | `{ code, used, expired, expiresAt, claimedBy? }` |
| POST | `/devices/pair/claim` | **Bearer** | `{ code, deviceName?, appVersion? }` | `{ deviceId, ncUsername, webdavUrl, appPassword }` |
| GET | `/devices/clients` | Bearer | — | `{ clients: [{ id, deviceName, deviceType, platform, appVersion, lastSeen, status, createdAt }] }` |
| DELETE | `/devices/clients/:id` | Bearer | — | `{ revoked: "<deviceId>" }` |
| GET | `/devices/push/vapid-public-key` | Bearer | — | `{ publicKey }` |
| POST | `/devices/push/subscribe` | Bearer | `{ endpoint, keys: { p256dh, auth }, deviceClientId? }` | `{ id }` |
| DELETE | `/devices/push/subscribe` | Bearer | `{ endpoint }` | 204 |
| POST | `/devices/push/test` | Bearer | — | dispatch result |

**Push status:** only **WebPush (VAPID)** subscribe exists today. A native
**APNs/FCM token-registration endpoint is NOT yet implemented** — native
push delivery (direct-APNs on iOS, FCM on Android) is scaffolded only: the
subscribe + VAPID endpoints above exist, but the orchestrator-side fan-out
sidecar that actually delivers pushes is not yet built. Mobile real-time
push is pending; until then native clients poll `/notifications`.

**Auth vs pairing (corrected 2026-06-01).** `claim` is NOT a login.
Authentication is always `/auth/login`; pairing is an optional,
post-login, **Bearer-authenticated device-enrollment** step that mints a
per-device Nextcloud WebDAV app-password (for the Files surface) and a
`DeviceClient` row (for revocation + push targeting). A client can sign
in with no pair code and still use the app — Files goes through
`/api/files` with the JWT, not direct WebDAV.

Sign-in + optional enrollment sequence:
1. User enters the Droplet `server` URL + email + password. A scanned
   `droplet://pair?server=<base>&code=<code>` QR pre-fills `server` (and `code`).
2. App POSTs `/auth/login?return=body` → stores JWT pair + user. On
   `401 TOTP_REQUIRED`, prompt for `totp` and resubmit.
3. (Optional) If a pair `code` is present, app POSTs `/devices/pair/claim`
   with the **Bearer** + `{ code, deviceName? }` and stores the returned
   `{ deviceId, ncUsername, webdavUrl, appPassword }`. The logged-in
   account must match the code's owner (else `403`). Non-fatal on failure.
4. Dashboard polls `/devices/pair/:code/status` until `used`.

To GENERATE a code, the dashboard (already authenticated) POSTs
`/devices/pair` and renders the QR from `pairUrl`.

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
| POST | `/llm/chat` | Bearer | `{ model, messages: [{ role, content }], stream?: true, conversationId? }` → SSE stream OR JSON |
| DELETE | `/llm/conversations/:id` | Bearer | `{ ok }` |

Chat sends go to the single `POST /api/llm/chat` route (there is **no**
per-conversation `/llm/conversations/:id/chat` endpoint). The conversation
id is carried in the request **body** as `conversationId` (a UUID), not in
the path; omit it to start a new conversation. The body is OpenAI-style:
`messages` is the full turn array (`role` ∈ `system|user|assistant|tool`,
plus `content`), and `stream: true` selects the SSE response below.

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

Each SSE frame is `event: <type>\ndata: <json>\n\n` (orchestrator
`encodeSSE`, `apps/orchestrator/src/types/sse-events.ts`). The token text
arrives on `event: content_delta` (NOT `token`), and the stream terminates
on `event: done` carrying `stop_reason` (NOT `finishReason`):

```
event: content_delta
data: {"text": "Hello"}

event: content_delta
data: {"text": " world"}

event: done
data: {"iterations": 1, "stop_reason": "model_done"}
```

`stop_reason` ∈ `model_done | iteration_limit | error` (an `error` frame
also carries an `error` string). The agent loop also emits these event
types on the same stream — render or ignore as needed:

| `event:` | `data` payload | Meaning |
|---|---|---|
| `content_delta` | `{ text }` | One token/text chunk — append to the active bubble |
| `tool_call` | `{ id, name, args }` | The model invoked an MCP tool |
| `tool_result` | `{ id, ok, data?, status?, message? }` | That tool's result |
| `reasoning_step` | `{ text }` | One deep-reasoning step (only when `captureReasoning:true`; emitted BEFORE `content_delta` on the turn) |
| `done` | `{ iterations, stop_reason, error? }` | Terminal frame |

Native clients should detect end-of-stream on `event: done` /
`stop_reason` (the v1 clients keyed on `finishReason`, which never arrives,
so they terminate only on socket EOF — see XR-02). Routing by `event:`
name is the robust approach; a `data.text`-only parser silently drops the
`tool_call`/`tool_result`/`reasoning_step` frames.

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
