# Mobile API Contract

**Status:** Living document (mirror of the orchestrator routes that mobile clients consume)
**Date:** 2026-05-18 (chat route + SSE wire corrected 2026-06-01 — XR-01/XR-02; error
envelope, VPN/DDNS shapes, and missing endpoints reconciled against `src/routes/*` on
2026-06-28 during the `droplet-ios` build — XR-03)
**Companion to:** ADR-008 (Native Mobile — Design System + API Contract)

This document is the contract that the iOS + Android apps build against. Both apps
re-derive their model layer from this doc. If you change the orchestrator's
mobile-relevant routes, update this doc IN THE SAME PR and the mobile teams will
mirror the change.

> **Source of truth (XR-03).** Where this doc and the shipped orchestrator routes
> disagree, **`apps/orchestrator/src/routes/*` wins** — a cross-repo audit while
> building `droplet-ios` found the doc had drifted from the routes (wrong error
> envelope, wrong VPN shapes, several shipped endpoints undocumented). The native
> apps now target **full parity** with the mobile-relevant route surface, not the
> narrowed subset the early drafts described, so this catalog is being widened
> toward the routes rather than the routes trimmed toward it. When in doubt, read
> the handler.

## Base URL

Native clients store a per-Droplet base URL set during pair flow.
Format: `https://<host>` where `<host>` is one of:
- mDNS hostname: `droplet-c4d4df.local` (LAN)
- named address: `mydroplet.droplet-us.com` (remote, over the Cloudflare Tunnel relay with a per-device publicly-trusted cert — ADR-025A (`droplet-fleet-hq`) / ADR-023)
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
| POST | `/auth/change-password` | Bearer | `{ currentPassword, newPassword }` | `{ status: "ok" }` |

**Self-service password change (WARP-824, added to doc XR-03).** Any signed-in user
rotates their own password here; a verified `currentPassword` is required (the
session cookie alone is not enough). It also clears the server-side
`mustChangePassword` gate, so it is the screen an admin-created temp-password user
is forced through before reaching anything else. Failure shapes (flat envelope, with
`code` siblings): `400 INVALID_PASSWORD` (current password wrong), `400 WEAK_PASSWORD`
(new fails policy), `400 SAME_PASSWORD` (new === current), `400 INVALID_REQUEST`
(missing fields), `429 TOO_MANY_ATTEMPTS` (+ `retryAfterSeconds`, `Retry-After`
header — progressive lock on repeated wrong current password).

**Auth model (ADR-013 directory).** Login authenticates an **email +
password (argon2id)** against the local directory — *not* Nextcloud
credentials. `username` is still accepted as a legacy alias for `email`.
`?return=body` (shipped) returns the JWT pair in the body too (browsers
also get httpOnly `Set-Cookie`). Tokens are HS256; **refresh rotates the
refresh token on every call and denylists the previous one**, so native
clients MUST persist the new `refreshToken` from `/auth/refresh`.

**`?return=body` is native-client-only (WARP-582).** The server refuses the
body-token opt-in when the request carries any browser-only marker header —
`Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Sec-Fetch-Dest`, `Origin`, or
`Referer`. Browsers attach at least one of these to every request they
originate (and the `Sec-Fetch-*`/`Origin` ones are forbidden header names
page script cannot strip), so an in-browser login can never receive tokens
in the JSON body — it gets the normal httpOnly-cookie session instead (the
login still succeeds; only the body-token fields are omitted). The native
HTTP stacks the apps use (OkHttp on Android, URLSession on iOS) send none of
these headers by default — **do not add them to the login/refresh requests**,
or the server will treat the client as a browser and withhold the tokens.
The same gate applies to the passkey `POST /auth/webauthn/authenticate/verify?return=body`.

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

On success, every chat turn returns two response headers the client must read:

- `X-Conversation-Id: <uuid>` — the session id (new or existing). When you omit
  `conversationId` to start a new conversation, this header is the **only** way
  to learn the server-assigned id; capture it and send it back as
  `conversationId` on the next turn to continue the thread.
- `X-Assistant-Message-Id: <uuid>` — the assistant message row id (WARP-329),
  used to match the MQTT `turn-completed` event to the streamed row.

Both headers are set on streaming **and** non-streaming responses. They are
omitted only for ephemeral turns (`ephemeral: true`, e.g. the setup-wizard
sample prompt), which are not persisted.

### LLM extras — shipped routes the early drafts omitted (XR-03)

> These were all shipped as orchestrator route files but absent from the mobile
> doc. Added for parity. RBAC noted per verb; all use the flat error envelope.

#### Chat projects (`/api/llm/projects`)

Per-user "projects" (a name + optional system prompt that scopes a set of chats).

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/llm/projects` | Bearer (any role) | — | `{ projects: [{ id, name, systemPrompt, chatCount, createdAt, updatedAt }] }` |
| POST | `/llm/projects` | Bearer | `{ name, systemPrompt? }` | 201 `{ project }` |
| PATCH | `/llm/projects/:id` | Bearer | `{ name?, systemPrompt? }` | `{ project }` |
| DELETE | `/llm/projects/:id` | Bearer | — | `204` (chats survive via FK SET NULL) |

Scoped to the caller (`userId`); another user's project id → `404 project_not_found`.
Unauthenticated → `401 auth_required`.

#### Assistant memory facts (`/api/memory/facts`)

What the assistant remembers about the household (WARP-845 audience model).

| Method | Path | Auth | Body / query | Returns |
|---|---|---|---|---|
| GET | `/memory/facts?category=&active=&limit=` | owner/admin/family/guest | — | `{ facts: [...] }` |
| POST | `/memory/facts` | owner/admin/family | `{ category, fact, evidenceChatId?, audience? }` | 201 `{ fact }` |
| PATCH | `/memory/facts/:id` | owner/admin/family | `{ category?, fact?, active?, audience? }` | `{ fact }` |
| DELETE | `/memory/facts/:id` | owner/admin/family | — | `204` |

`category` ∈ `Tone | Workflow | Scope | Schedule | Other`; `audience` ∈
`owner | admin | family | guest` (minimum-role ladder). owner/admin manage all
facts; family/guest are scoped to facts within their audience rank (applied to reads
AND writes) — a write above your rank → `403 audience_above_role`. `limit` 1..500
(default 100).

#### Scenes / smart-home routines (`/api/scenes`)

A scene batches Matter device actions and runs them in order (partial-failure
tolerant). Mobile can list + run; authoring is owner/admin.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/scenes` | owner/admin/family/guest | — | `{ scenes: [{ id, name, icon, createdBy, createdAt, updatedAt, actionCount }] }` |
| GET | `/scenes/:id` | owner/admin/family/guest | — | `{ id, name, icon, createdBy, …, actions: [{ id, idx, deviceNodeId, command, args }] }` |
| POST | `/scenes` | owner/admin | `{ name, icon?, actions: [{ deviceNodeId, command, args? }] }` | 201 scene |
| PATCH | `/scenes/:id` | owner/admin | `{ name?, icon?, actions? }` | scene |
| DELETE | `/scenes/:id` | owner/admin | — | `{ id, deleted: true }` |
| POST | `/scenes/:id/run` | owner/admin/family | `{ confirmationToken? }` (+ `?confirm=true`) | run result OR 202 confirmation (see below) |
| GET/POST | `/scenes/:id/schedules` | owner/admin | `{ rrule }` (POST) | schedule list / created schedule |
| PATCH/DELETE | `/scenes/:id/schedules/:sid` | owner/admin | `{ enabled }` (PATCH) | schedule / `{ id, deleted: true }` |

**Run is confirmation-gated.** Without `?confirm=true` (dashboard) or a valid
single-use `confirmationToken` (chat "Approve & run" chip), `POST /scenes/:id/run`
returns `202 { status: "confirmation_required", confirmationToken, sceneId, name,
actionCount, message }`. Re-POST the `confirmationToken` to actually run; the success
body is the execution `run` (per-action `results`). A wrong/expired token →
`403 confirmation_invalid`; too many pending → `429 too_many_pending_confirmations`.
Schedules use an `rrule` (FREQ=DAILY|WEEKLY subset; unsupported → `400 Unsupported RRULE`).

#### User-authored tool specs (`/api/tools`)

Saved multi-step "tools"/macros the LLM agent can run (slug-addressed).

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/tools?status=&category=` | owner/admin/family | — | `{ specs: [{ id, slug, name, category, description, version, status, ownerId, share, safety, writes, reversible, …, stepCount, runCount }] }` |
| GET | `/tools/:slug` | owner/admin/family | — | full spec (incl. `steps`) |
| POST | `/tools` | owner/admin/family | `{ slug, name, category?, description?, share?, safety?, writes?, reversible?, steps: [{ tool, args? }] }` | 201 spec |
| PATCH | `/tools/:slug` | owner/admin | partial spec (+ `status?`) | spec |
| POST | `/tools/:slug/runs` | owner/admin/family | run args | run result (confirmation-gated for write/Tier-2 tools) |
| GET | `/tools/:slug/runs` | owner/admin/family | — | run history |

`safety` ∈ 1..3; `slug` matches `SLUG_RE` (2..80 chars). Missing spec → `404 Spec not found`.

WARP-1580 — the `requireRole` column above is the coarse ADR-004 floor only. `POST
/tools/:slug/runs` additionally resolves the caller's ADR-032 §3 tool reach and refuses
a spec that names a tool their access role does not grant:
`403 { error: "forbidden_tool_for_role", detail, slug, tool }`. The refusal is
whole-spec and pre-dispatch — no step runs and no `ToolRun` row is written. Callers with
no `AccessRole` (every user on a box today), service principals and the owner are
unaffected. A caller whose scope cannot be resolved is refused the same way (fail-closed).
Lock-flavoured `control_device` args are additionally refused at dispatch, surfacing as a
`207` run whose failing step carries `LOCK_OPERATION_NOT_PERMITTED`.

#### Brain memory / indexed attachments (`/api/files/brain`)

The "AI memory" store of files the chat has ingested (BrainMemoryItem). Per-user.

| Method | Path | Auth | Body / query | Returns |
|---|---|---|---|---|
| GET | `/files/brain?limit=&offset=&source=&originatingChatId=` | Bearer | — | `{ items: [...], total, limit, offset }` |
| POST | `/files/brain/upload` | Bearer | multipart `file` | ingested item (`413 file_too_large` over limit) |
| GET | `/files/brain/export?all=1` or `?chatId=` | Bearer | — | zip stream (items + manifest) |
| GET | `/files/brain/:itemId` | Bearer | — | item |
| GET | `/files/brain/:itemId/download` | Bearer | — | file bytes |
| POST | `/files/brain/:itemId/transcribe-now` | Bearer | — | transcription kick-off |
| DELETE | `/files/brain/:itemId` | Bearer | — | delete |

`limit` ≤ 200 (default 50). Unauthenticated → `401 auth_required`.

#### Speech-to-text (`/api/stt`)

Voice dictation — one-shot transcription, NOT streaming.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/stt?rate=16000` | owner/admin/family/guest | raw PCM bytes (≤10 MB) | `{ text }` |

Body is raw audio bytes (not multipart/JSON); `rate` 8000..48000 (default 16000).
`429 stt_busy` (+ `Retry-After`) when the 2-slot concurrency limit is hit — just
retry; `400 empty_audio` / `400 invalid_rate`; `503 stt_unavailable` when the STT
sidecar is down.

### Files (`/api/files/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/files?path=/` | Bearer | `{ entries: [{ name, path, size, modified, isDirectory }], parent }` |
| GET | `/files/recents?limit=` | Bearer | `{ items: [FileEntry] }` |
| GET | `/files/search?q=&mime=&limit=` | Bearer | `{ items: [FileEntry] }` |
| GET | `/files/thumbnail?path=&x=&y=` | Bearer | image bytes |
| GET | `/files/download?path=…` | Bearer | file bytes |
| POST | `/files/upload` | Bearer | multipart → `{ path, size }` |
| POST | `/files/share` | Bearer | `{ path, ttl? }` → `{ url, expiresAt }` |
| POST | `/files/mkdir` | Bearer | `{ path }` → 201 |
| POST | `/files/rename` | Bearer | `{ from, to }` → `{ ok }` |

V1 mobile uses list + download + share only. Upload + mkdir + rename
are Phase 2.

**`/files/recents` (WARP — added to doc XR-03).** Returns the caller's most-recently-
modified files as `{ items: [FileEntry] }` (NOT `{ entries }` — this route uses
`items`), `limit` 1..200 (default 50). `/files/search` (`q` ≥ 2 chars; `q` shorter
than 2 returns `{ items: [] }`; `mime` optional filter) and `/files/thumbnail`
(`x`/`y` clamped 16..1024, default 256, image bytes or `404`) are likewise shipped
and mobile-relevant. All three back the native file browser's Recents / Search /
preview tiles.

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

> **Corrected 2026-06-28 (XR-03).** Every shape in the old table was wrong:
> `/vpn/status` is richer than `{ active, peerCount, endpoint }`; `/vpn/peers` is
> wrapped in `{ peers: [...] }` with different field names; the mint body is
> `{ deviceLabel }` not `{ name }`; the mint response is `{ peer, conf }` with **no
> `qr` field** (the client renders the QR from `conf`); and `DELETE` returns
> `{ status, id }` not `{ ok }`. VPN **writes are owner/admin-only** (WARP-171).

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/vpn/status` | Bearer | `VpnStatusInfo` (see below) |
| GET | `/vpn/peers` | Bearer | `{ peers: [{ id, userId, deviceLabel, publicKey, assignedIp, status, createdAt, revokedAt }] }` |
| POST | `/vpn/peers` | **owner/admin** | `{ deviceLabel }` → 201 `{ peer: { id, userId, deviceLabel, publicKey, assignedIp, status, createdAt }, conf }` |
| DELETE | `/vpn/peers/:id` | **owner/admin** | `{ status: "revoked", id }` |

`GET /vpn/peers` returns its own peers for a family caller, **all** peers for
owner/admin. `status` ∈ `active | revoked` (revoked rows are tombstoned, not
deleted, for audit + a brief "removed just now" row).

**`VpnStatusInfo` (any authenticated user).** Two shapes by whether wg0 is
bootstrapped:

```jsonc
// not bootstrapped yet (no peers ever minted):
{ "configured": false, "endpointConfigured": <bool>, "publicFqdn": <string|null>,
  "message": "VPN not yet bootstrapped — POST /api/vpn/peers to start." }

// bootstrapped:
{ "configured": true,
  "endpointConfigured": <bool>,          // true once an endpoint host is known
  "endpointHost": <string|null>,         // ADMIN-ONLY — null for family (leaks public reachability)
  "publicFqdn": <string|null>,           // ADR-023 per-device FQDN; safe for all roles
  "listenPort": <number>,
  "serverPublicKey": <string>,
  "addresses": <string[]>,
  "peerCount": <number> }
```

`endpointHost` is gated to owner/admin (it can expose the box's public
reachability); family users still get `endpointConfigured` so the "Add device"
button can light up without leaking the hostname. POST/DELETE error shapes (flat
envelope): `400 { error: "Invalid request", details }`, `503` (no endpoint host
configured, or routing service disabled), `507` (VPN subnet IP-exhausted),
`404 { error: "Peer not found" }`.

**`GET /vpn/status` failure shape (WARP-1283).** When the box's routing service
is unavailable (unreachable, timed out, or supervision disabled), the route
returns a typed flat envelope: `503 { error: "<customer-safe copy>",
code: "ROUTING_UNAVAILABLE" }`. **Behavior change for external clients:**
previously a sidecar outage surfaced the global error-handler shape
`{ error: "Service unavailable", message: "VPN status: fetch failed",
code: "UNREACHABLE" }`; this route now returns the typed shape above with **no
`message` field** — branch on `code`, not on `message` or the old error text
(`error` is calm customer-safe copy, safe to show verbatim). Genuinely
unexpected failures still surface the global-handler `500` shape.

For phone self-add (writes need an owner/admin session):
- POST `/vpn/peers` with `{ deviceLabel: "<deviceDisplayName>" }`
- Response includes `conf` (wg-quick INI, returned **ONCE** — the private key is in
  it and is never returned again) — app parses it and configures `NEVPNManager`
  (iOS) / `WgQuickBackend` (Android). There is **no `qr` field**: render the QR
  client-side from `conf`.
- Phone toggles VPN on; app's `server` URL keeps working from outside.

### Remote access — named address (no dynamic-DNS API)

> Updated for WARP-974. Remote access no longer uses a dynamic-DNS endpoint. The
> box is reachable at its provisioned named address `<name>.droplet-us.com` over
> the outbound Cloudflare Tunnel relay (ADR-025A, `droplet-fleet-hq`) with a per-device publicly-trusted
> cert (ADR-023). There is **no `/api/ddns/*` surface** for clients to configure —
> the named address is set at provisioning and drives `VpnStatusInfo.endpointHost`.
> Clients toggle the relay from the app's "Connect" control (Cloudflare WARP);
> there is nothing here to `PUT`.

### Devices index (`/api/devices`)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/devices` | Bearer | unified inventory: cameras + matter devices + network clients |

Used by the Home tab's "Devices" KPI.

### Settings (`/api/settings/workspace` — Phase 4)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/settings/workspace` | Bearer | `{ workspaceType: "business" }` |
| POST | `/settings/workspace` | Bearer (owner) | body `{ workspaceType: "business" }` → `{ workspaceType }` |

WARP-1341: this is a **business-only** build. `workspaceType` is always
`"business"` — GET never returns `"home"`, and a POST with `"home"` is a
`400 invalid_body`. Missing-row default is `"business"`, so mobile can treat
a 404 the same way.

## Error shape

> **Corrected 2026-06-28 (XR-03).** Earlier drafts of this section described a
> **nested** envelope `{ error: { code, message } }`. **No orchestrator route emits
> that shape** — a sweep of `src/routes/*` found ~621 flat `error` responses and
> **zero** nested ones. The fictional codes the old table listed (`PAIR_CODE_EXPIRED`,
> `PAIR_CODE_INVALID`, `RATE_LIMITED`, `INTERNAL`) do not exist in any handler.

Every 4xx / 5xx response is a **flat** object whose `error` is a **string**:

```json
{ "error": "auth_required" }
```

with **optional sibling fields** at the top level (never nested under `error`):

```json
{ "error": "Invalid request", "code": "WEAK_PASSWORD", "details": { "formErrors": [], "fieldErrors": { "newPassword": ["…"] } }, "retryAfterSeconds": 30 }
```

| Field | Type | When present |
|---|---|---|
| `error` | string | **Always.** See the value-inconsistency note below. |
| `code` | string (UPPER_SNAKE machine slug) | On many — not all — handled errors (`WEAK_PASSWORD`, `INVALID_PASSWORD`, `TOTP_REQUIRED`, `TOO_MANY_ATTEMPTS`, `CLAIM_CODE_INVALID`, `TOKEN_MISSING`, `USERS_NO_PRISMA`, `P2025`, …). This is the field clients should key off when present. |
| `details` | object (`{ formErrors, fieldErrors }`) | On request-validation 400s — it is Zod's `error.flatten()`. |
| _route-specific_ | varies | A few routes add their own siblings, e.g. `retryAfterSeconds` (rate-limit/lock 429s), `allowed` (enum-filter 400s), `sceneId` (scene confirmation), `id` / `status` (idempotent deletes). |

**The `error` value is inconsistent — do not parse it.** It is sometimes a stable
machine slug and sometimes a human sentence, set per-handler:

- **lower_snake machine slug** (programmatic; safe-ish to switch on, but prefer
  `code`/`status`): `auth_required`, `not_found`, `invalid_request`, `forbidden`,
  `unauthenticated`, `admin_required`, `rate_limited`, `audience_above_role`,
  `project_not_found`, `conversation_not_found`, `stt_busy`, `stt_unavailable`,
  `empty_audio`, `invalid_rate`, `too_many_pending_confirmations`,
  `confirmation_invalid`, `turn_in_flight`, …
- **human sentence** (display-only; never switch on it): `"Scene not found"`,
  `"Peer not found"`, `"Invalid camera name"`, `"Invalid request"`,
  `"Not authenticated"`, …

Because of this, the **canonical client mapping is the dashboard's
`apps/web-dashboard/src/lib/friendly-errors.ts`** — `translateError(err, domain)`.
Native clients should mirror its dispatch order rather than read `error` directly:

1. `err.code` (UPPER_SNAKE slug) → per-domain friendly copy.
2. else `err.status` (number, e.g. `401`, `502`, `504`) → per-domain copy.
3. else infer a code from `err.message` (substring match) → per-domain copy.
4. else a fixed per-domain fallback string. **Never** surface `error`/`message`
   verbatim — orchestrator strings leak terminology (`OCS 401`, `ECONNREFUSED`).

Real codes/statuses that file maps today (subset; see the file for the full
per-domain tables): `auth` → `INVALID_CREDENTIALS`, `WEAK_PASSWORD`,
`INVALID_PASSWORD`, `SAME_PASSWORD`, `TOTP_INVALID`, `RECOVERY_INVALID`,
`CLAIM_CODE_INVALID`, `401`; `device` → `502`/`503`/`504` (Matter commissioning);
`files`/`knowledge` → `NOT_FOUND`, `UPLOAD_TOO_LARGE`, `UNSUPPORTED_TYPE`; `push` →
`NOT_CONFIGURED`, `PERMISSION_DENIED`, `UNSUPPORTED`.

**TOTP login gate (real shape).** A login that needs a second factor returns
`401 { "error": "Two-factor authentication required", "code": "TOTP_REQUIRED" }`
(flat, with the `code` sibling) — resubmit `/auth/login` with `totp` (or
`recoveryCode`). Switch on `code`, not the sentence.

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
| `model_loading` | `{ model, sizeGb }` | WARP-903 — the selected model needs a cold load (30-60 s to first token). Emitted first, at most once; render a loading state until the next frame, or ignore. `sizeGb` is decimal GB or null |
| `tool_use_validation` | `{ status, claims, tools }` | WARP-2544 — the answer claims a completed action the tool trace does not support. At most once per turn, immediately BEFORE `done`, and only when the check does not pass. `status` is `"unsupported"` (the turn dispatched nothing) or `"contradicted"` (every call to some tool failed). See the note below |
| `done` | `{ iterations, stop_reason, error? }` | Terminal frame |

**`tool_use_validation` is ADVISORY, not a retraction.** By the time it is
emitted the answer has already reached the client as `content_delta` frames, so
it cannot un-send anything. Render it *beside* the answer — "this may not have
actually happened" — never as a correction of what was already shown, and never
by mutating or hiding the delivered text. Ignoring the frame is valid and
matches pre-WARP-2544 behaviour; it is additive and breaks no existing client.

It exists because the tools on this product are physical (cameras, locks,
network rules, power), so a model sentence claiming an action that never
succeeded is a safety and trust problem rather than a cosmetic one. `claims`
carries the model's own sentences that triggered it (capped at 160 chars each)
and `tools` names the tools whose calls all failed.

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
## Project Management (native PM)

> Backed by the native PM module owned by the orchestrator
> ([ADR-026](ADR-026-native-pm-supersedes-plane.md), superseding the embedded
> Plane stack). The mobile read contract below is unchanged — only the backend
> behind it changed.

V1 = read-only on mobile. The orchestrator serves PM from its own Postgres
(`Pm*` Prisma models) via the native `/api/pm/*` routes and transforms the
result into Droplet's existing mobile envelope. The mobile surface stays
workspace-slug-centric, with a single seeded `home` workspace. iOS/Android/
Windows clients call the `/api/mobile/pm/*` endpoints below behind the normal
dashboard session/JWT.

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

Paginated list of work items (issues/tickets).

**Query params:**
- `workspace` (required), `project_id` (required).
- `state` (optional) — filter by state. Accepts either the native `PmState` id (UUID) **or**, for backwards compatibility, the legacy Plane state name/slug (e.g. `in_progress` / `In Progress`), which is resolved to the matching state server-side (WARP-888). An unrecognised value yields an empty list rather than an error.
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
- `500` — orchestrator/database error (logged server-side).

### Out of scope for V1

- Mobile writes (create/update/comment/transition). Mobile is read-only.
- Push notifications when work items change — a follow-up epic.
- Custom field reads — the mobile read endpoints return the default fields only.
- Native UI for project/work-item editing — out of scope.
