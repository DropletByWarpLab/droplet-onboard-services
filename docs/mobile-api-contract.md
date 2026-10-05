# Native Client API Contract

> Formerly "Mobile API Contract" (file name kept so existing links keep working). Widened to native desktop clients by WARP-3230 (ADR-062, WARP-3211).

**Status:** Living document (mirror of the orchestrator routes that mobile clients consume)
**Date:** 2026-05-18 (chat route + SSE wire corrected 2026-06-01 — XR-01/XR-02; error
envelope, VPN/DDNS shapes, and missing endpoints reconciled against `src/routes/*` on
2026-06-28 during the `droplet-ios` build — XR-03)
**Companion to:** ADR-008 (Native Mobile — Design System + API Contract)

This document is the contract that the native clients build against: the iOS and
Android apps, and the native Windows client (`droplet-windows`, C# / WinUI 3,
ADR-062). The native clients re-derive their model layer from this doc. If you
change the orchestrator's client-relevant routes, update this doc IN THE SAME PR
and the client teams will mirror the change.

**Native desktop clients.** A desktop client is a native app, not a browser: it
signs in with `POST /auth/login?return=body` (the JWT pair comes back in the
body; the native-only gate described under Auth applies), sends
`Authorization: Bearer` on every route, pins the box's identity as described in
the pairing / sign-in flow, and receives real-time events over
`/api/ws/events` (see "Real-time events"). Since WARP-3038 the box sets no
cookies on a body-token sign-in or refresh; before it, the box also set the
httpOnly session pair on those responses. A client keeps only the body tokens
and must not store any cookie the box sets, whichever version it talks to. Native
SSO sign-in is described under "SSO for native clients" (ADR-063, WARP-3226;
WARP-3212). The passkey sign-in flow is not part of this contract yet (ADR-063,
WARP-3226; it arrives with WARP-238).

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
| GET | `/auth/me` | Bearer | — | `{ id, username, displayName, role, mustChangePassword, session: { endsAt } \| null }` |
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

**The latest the sign-in can last (`session.endsAt`, WARP-2981).** `/auth/me`
carries `session: { endsAt: "ISO-8601" }`: the sign-in time plus the **absolute**
session limit (12 h for every role as shipped). Nothing extends it, token refresh
included. It is a latest time, not a promise: the sign-in can end **sooner**, in
any of three ways, and `endsAt` does not move when it does.

- **Inactivity.** 30 minutes without an authenticated request ends it (every
  role, as shipped). Any authenticated request resets that clock, `/auth/me`
  included (the box records it at most every 30 s). **`/auth/refresh` does not
  reset it**: a token refresh is not activity, so an app that only refreshes its
  token in the background still goes idle, and its next refresh is refused. The
  idle deadline is not offered, because every request moves it.
- **Too many sign-ins.** One person holds at most 5 sign-ins at once. Their next
  sign-in, on any device, ends the oldest one.
- **Revocation.** Signing out; a password change or a newly enrolled second
  factor (these end the person's other sign-ins); a role change; an admin ending
  the person's sessions.

So an app may warn as `endsAt` approaches, or say "you will be signed out by
21:00 at the latest". It must not say "you will be signed out at 21:00", or treat
a sign-in as good until then: the first `401` ends it, whatever `endsAt` said.
The limits are read when used, so an operator changing them moves `endsAt` for
sign-ins already open; read it again rather than keeping it from sign-in.
`session` is `null` when the box cannot tell (a service token, a token minted
before session records, the session store unreachable). Treat `null`, and a box
too old to send the key, as "show nothing". Only `/auth/me` carries it; the login
and refresh bodies do not.

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

#### SSO for native clients (`/api/sso/oidc/native/*`)

A native client has no WebView to carry the browser flow's state cookie, so it
uses a box-local handoff (RFC 8252 loopback or private-use scheme, with PKCE).
The box stays the OIDC client: the identity provider still redirects to the
box's own `/api/sso/oidc/callback`, and the redirect URI registered at the
provider does not change (ADR-016). List the providers first with
`GET /api/sso/oidc/providers` → `{ providers: ["google" | "entra" | "okta", …] }`.
Design and rationale: ADR-063.

1. The app makes a PKCE pair: `codeVerifier` (43–128 chars of
   `A-Z a-z 0-9 - . _ ~`) and `codeChallenge = BASE64URL(SHA256(codeVerifier))`
   (43 chars, no padding). It opens a loopback listener on a random port and
   path, or uses `droplet://sso/callback`.
2. `POST /api/sso/oidc/native/begin` → `200 { authorizeUrl }`.
3. The app opens `authorizeUrl` in the **system browser** (never an embedded
   WebView). The person signs in at the provider, which redirects to the box.
4. The box validates the sign-in and shows a **consent page** in the browser
   ("Sign in to Droplet?", RFC 8252 §8.6). It sets no cookies and mints no
   code yet. **Continue** is a form `POST` to `/api/sso/oidc/native/consent`
   that mints the handoff code and answers `303` to
   `<redirectUri>?code=<handoff code>&state=<state>`. **Cancel** is a form
   `POST` to the same path that spends the page and answers `303` to
   `<redirectUri>?error=access_denied&state=<state>`. Either button works
   once; after one, the other is refused. The page is good for as long as the
   state (10 minutes).
5. `POST /api/sso/oidc/native/token` with the handoff code and the verifier →
   the `/auth/login?return=body` body.

If the sign-in fails at any point after step 3 (the provider refuses, the
person cancels at the provider, the ID token does not validate, ...) the box
sends the browser to `<redirectUri>?error=<error>&state=<state>` instead, so
the app can stop waiting and show the reason. See **Errors relayed to the app**
below. The app should still give up waiting after the state's 10-minute
lifetime, because a closed browser tab sends nothing.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/sso/oidc/native/begin` | none | `{ provider, redirectUri, codeChallenge, codeChallengeMethod: "S256" }` | `200 { authorizeUrl }` (no cookie, no redirect) |
| GET | `/sso/oidc/callback?code&state` | none (reached from the provider) | — | `200` consent page (no code in it; Continue posts a single-use consent value); or `302 <redirectUri>?error=<error>&state=<state>` |
| POST | `/sso/oidc/native/consent` | none (the consent page's own forms) | `consent=<single-use value>&decision=approve` or `decision=deny` (form-encoded) | approve: `303 <redirectUri>?code=<43-char handoff code>&state=<state>`; deny: `303 <redirectUri>?error=access_denied&state=<state>`; `400 SSO_CONSENT_INVALID` if the page expired or was already used |
| POST | `/sso/oidc/native/token` | none | `{ code, codeVerifier }` | `200 { user: { id, username, displayName, role, mustChangePassword }, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }` |

```json
POST /api/sso/oidc/native/begin
{ "provider": "entra",
  "redirectUri": "http://127.0.0.1:49152/sso/7f3a9c",
  "codeChallenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "codeChallengeMethod": "S256" }

200 { "authorizeUrl": "https://login.microsoftonline.com/…/authorize?…" }
```

```json
POST /api/sso/oidc/native/token
{ "code": "<handoff code from the redirect>", "codeVerifier": "<the app's verifier>" }

200 { "user": { "id": "<uuid>", "username": "…", "displayName": "…", "role": "family", "mustChangePassword": false },
      "accessToken": "<jwt>", "refreshToken": "<jwt>",
      "accessTokenExpiresAt": 1790000000, "refreshTokenExpiresAt": 1790600000 }
```

**`redirectUri` rules.** It must be exactly one of these, in canonical form:

- `http://127.0.0.1:<port>/<path>` or `http://[::1]:<port>/<path>`, where
  `<port>` is 1024–65535 and written without leading zeros. `<path>` may be
  just `/`. No query, no fragment, no user info.
- exactly `droplet://sso/callback`.

Anything else is refused, including the name `localhost`, `https`, another
loopback or LAN address, a missing or default port, shorthand or
non-canonical addresses, and an upper-case scheme. Prefer loopback with a
random port and path: another local app can claim `droplet://`, although it
could only redeem a code for a flow it started with its own verifier.

**Handoff code.** 32 random bytes, base64url (43 chars). The box keeps only its
SHA-256. It is minted when the person presses **Continue**, not when the
consent page is shown, is valid for **60 seconds** from then and for **one**
redemption, and is useless without the app's verifier. A redemption attempt
consumes it **whatever the outcome**, so a wrong verifier burns the code and
the app must start over at `begin`. A person who takes minutes on the consent
page (an identity-provider MFA prompt, say) still gets a fresh 60 seconds; only
an expired state (10 minutes) sends them back to the app to start again. The
`state` in the redirect is the one the box minted; the app should check it
against the `authorizeUrl` it opened.

**Errors relayed to the app.** `<redirectUri>?error=<error>&state=<state>`,
with no `code`. The IdP's own error text is never forwarded.

| `error` | When |
|---|---|
| `access_denied` | the person chose Cancel on the consent page, or cancelled or was refused at the provider |
| `invalid_request`, `unauthorized_client`, `unsupported_response_type`, `invalid_scope`, `temporarily_unavailable`, `interaction_required`, `login_required`, `account_selection_required`, `consent_required` | the provider sent that standard OAuth/OIDC error, or (`invalid_request`) sent neither `code` nor `error` |
| `server_error` | the provider sent an error code that is not in the list above, or the box failed unexpectedly after the provider redirected back |
| `sso_failed` | the ID token did not validate, the provider gave no usable email, or the account is deactivated |
| `sso_email_unverified` | the provider did not verify the email address |
| `sso_domain_not_allowed` | Google account outside `DROPLET_SSO_GOOGLE_ALLOWED_HD` |
| `totp_required` | the account has a local password and TOTP enrolled. SSO does not satisfy that factor: sign in with the password and code instead |

An unknown or replayed `state` is not relayed (the box cannot trust the
redirect it would go to): the browser sees `401 { error: "Invalid or expired
SSO state" }` or `401 { error: "Invalid SSO state" }`.

**`/native/token` answers.** No cookies are set and the response is
`Cache-Control: no-store`. Like `?return=body`, it refuses a browser context
(any `Origin`, `Referer` or `Sec-Fetch-*` header) without consuming the code.
The session is an ordinary one: refresh with `/auth/refresh`, the same idle and
absolute limits, no `lastMfaAt`. The box records the redemption, successful or
not, in the activity log.

| Status | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | `begin`: a field is missing or not a string. `token`: `code` is not 43 base64url chars, or `codeVerifier` is not 43–128 unreserved chars |
| 400 | `INVALID_REDIRECT_URI` | `begin`: `redirectUri` breaks the rules above |
| 400 | `INVALID_CODE_CHALLENGE` | `begin`: `codeChallenge` is not 43 base64url chars, or `codeChallengeMethod` is not `S256` |
| 400 | `SSO_PROVIDER_UNSUPPORTED` | `begin`: `provider` is not `google`, `entra` or `okta` |
| 400 | `SSO_PROVIDER_NOT_CONFIGURED` | `begin`: this box has not configured that provider |
| 401 | `SSO_HANDOFF_INVALID` | `token`: unknown, already used or expired code, or a verifier that does not match |
| 401 | `SSO_ACCOUNT_UNAVAILABLE` | `token`: the account was deactivated or removed after the callback |
| 401 | `TOTP_REQUIRED` | `token`: the account has a local password and TOTP enrolled (same rule as the callback) |
| 403 | `NATIVE_CLIENT_REQUIRED` | `token`: the request carries a browser marker header |
| 429 | — | shared `authRateLimit` (20/min/IP across the sign-in routes); `{ error: "Too many requests, slow down" }` |
| 500 | `SSO_NO_PRISMA` | the directory is not wired |

**Recovery-code step-up.** `/auth/recovery` is a **Bearer-authenticated**
step-up that consumes one unused recovery code for an already-signed-in
session (body `{ code }` → `{ ok, remaining }`, six-digit `/auth/totp/verify`
is the same shape). It is **not** a pre-login account-recovery endpoint —
pre-login recovery is the `recoveryCode` field on `/auth/login` above.

### Health (`/api/orchestrator/health`)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/orchestrator/health` | none | `{ status: "ok"\|"degraded"\|"down", components: [{ name, status, latencyMs, lastCheckedAt }], uptime, version? }` |
| GET | `/orchestrator/health/details` | owner/admin | same shape, plus each component's `error?` reason |

Called on app launch + every 60s while foregrounded. Drives the
status pill in the chrome.

- `version` is the box's committed OTA release tag (e.g.
  `ota-stable-412-gabc1234`, or `git-<sha10>` for an untagged build), not
  semver. The key is **absent** (never `null`) on a box that has never taken
  an OTA update, so decode it as optional or give it a default.
- The public route never carries a component's `error`: it is raw probe text
  that names internal hosts and ports (WARP-3154). Owner/admin clients that
  want the reason read `/orchestrator/health/details`; anyone else gets 401
  (anonymous) or 403.

### Device pairing (`/api/devices/*`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | `/devices/pair` | Bearer (dashboard) | `{ deviceName, deviceType: "desktop"\|"mobile", platform }` | `{ code, expiresAt, pairUrl }` |
| GET | `/devices/pair/:code/status` | Bearer | — | `{ code, used, expired, expiresAt, claimedBy? }` |
| POST | `/devices/pair/claim` | **Bearer** | `{ code, deviceName?, appVersion? }` | `{ deviceId, ncUsername, webdavUrl, appPassword }` |
| GET | `/devices/clients` | Bearer | — | `{ clients: [{ id, deviceName, deviceType, platform, appVersion, kind: "app_pairing"\|"personal_drive", lastSeen, status, createdAt }] }` (the caller's own) |
| DELETE | `/devices/clients/:id` | Bearer | — | `{ revoked: "<deviceId>" }` (the caller's own) |
| GET | `/admin/devices/clients?userId=` | Bearer, owner/admin only | — | `{ clients: [{ …the row above, userId, displayName, personStatus: "active"\|"deactivated"\|"removed" }] }`; `userId` omitted lists everyone. Members, guests: 403 |
| DELETE | `/admin/devices/clients/:id` | Bearer, owner/admin only | — | `{ revoked, appPasswordDeleted: true\|false\|null, warning? }`; `false` = marked revoked but Nextcloud did not confirm deleting the app password, `null` = already revoked. Audited with actor and person |
| GET | `/devices/push/vapid-public-key` | Bearer | — | `{ publicKey }` |
| POST | `/devices/push/subscribe` | Bearer | `{ endpoint, keys: { p256dh, auth }, deviceClientId? }` | `{ id }` |
| DELETE | `/devices/push/subscribe` | Bearer | `{ endpoint }` | 204 |
| POST | `/devices/push/test` | Bearer | — | dispatch result |

`lastSeen` is the pairing time until the client's tool-host connects the WS bridge
(it then moves with each hello and heartbeat). A client that never does, such as a
Finder / File Explorer drive login, keeps the pairing time. Deactivating or deleting
a person revokes all their clients (both kinds) and writes one audit row with the
actor, the person and the counts.

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
   `droplet://pair?server=<base>&code=<code>&spki=<pin>` QR pre-fills `server`
   (and `code`). `spki` (WARP-2954 / ADR-058) is the box's certificate key
   fingerprint — base64 of SHA-256 over the DER SubjectPublicKeyInfo of the
   leaf the box serves, byte-identical to
   `openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64`.
   It is the box saying "this is my key" through its own dashboard: a client
   MAY accept the served certificate for `server`'s host iff its key hashes to
   `spki`, the certificate names that host, and it is inside its validity
   window — with no public CA, no HQ, and nothing installed in the OS trust
   store. It is NOT trust-on-first-use: with no `spki` and no public chain the
   client refuses as before, and a served key that does not match `spki` is an
   identity error ("not the Droplet this QR came from"), never a retry. A
   client that pins it keeps verifying every later connection (API, WebSocket,
   WebView) against the same pin. Absent when the box cannot read its own
   leaf; unknown parameters are ignored by older clients. Reference
   implementation: the native Windows client's C# trust code in `droplet-windows`
   (a port of the retired Rust `trust.rs`, WARP-2953; WARP-3236).
   **Manual connect (WARP-3414).** A client that is given only an address (no
   scanned `spki`) and finds a box with its own certificate MAY show the key's
   fingerprint and ask the admin to compare it. Format, shared by every channel:
   the same SHA-256 as uppercase hex in 4-character groups separated by single
   spaces, 16 groups (`F017 AFA8 6AD7 8BED …`). The reference must come from a
   channel a LAN attacker cannot rewrite, so the box shows it on its own front
   screen (the rail's `Droplet fingerprint` face), in the `setup.sh` output and
   from `droplet-fingerprint` on the box. Settings → Device information and
   Devices → Pair show it too (`fingerprint` on the owner/admin-only
   `GET /api/tls/certificate`), but that is the same connection under
   question, so the dashboard copy says it proves nothing on its own.
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
| GET | `/cameras` | Bearer | `{ cameras }`, the cameras this person may see; `{ cameras: [], _status: "disconnected" }` when the camera service is down (that is not "no cameras") |
| GET | `/cameras/:name` | Bearer | full `CameraInfo` |
| GET | `/cameras/:name/snapshot` | Bearer | current JPEG frame |
| GET | `/cameras/:name/live` | Bearer | MJPEG stream (`multipart/x-mixed-replace`, `Cache-Control: no-store`) |
| GET | `/cameras/:name/events` | Bearer | events for one camera |
| GET | `/cameras/events?limit=` | Bearer | recent events, newest first |
| GET | `/cameras/events/:eventId/thumbnail` | Bearer (owner, admin, family) | image bytes: Frigate's own `Content-Type` (`image/jpeg` when it sends none), `Cache-Control: private, no-store`. `:eventId` is a Frigate event id, `^[a-zA-Z0-9._-]{1,128}$`; errors below the table |
| GET | `/cameras/events/:eventId/snapshot` | Bearer | event JPEG |
| GET | `/cameras/reviews/:reviewId/thumbnail` | Bearer | review item image bytes |
| GET | `/cameras/events/sse` | Bearer | SSE stream of camera events (`data: {json}`; `: heartbeat` every 30 s; first frame `{ "type": "connected" }`) |
| GET | `/cameras/clips?camera=&limit=` | Bearer | `{ clips: [{ id, camera, label, score, start_time, end_time, thumbnail_url, clip_url }] }` (`limit` default 50, max 200; only events that have a clip) |
| GET | `/cameras/clips/event/:eventId` | Bearer | mp4 bytes |
| POST | `/cameras/clips/share` | Bearer (custody roles) | share a clip |
| GET | `/cameras/groups` | Bearer | `[{ id, name, members }]` |
| GET | `/cameras/pins` | Bearer | `[{ cameraName, sortOrder }]` |
| POST | `/cameras/pins` | Bearer | `{ cameraName, sortOrder? }` → 201 |
| DELETE | `/cameras/pins/:cameraName` | Bearer | `{ ok }` |

There is no HLS or WebRTC `stream-url` route and no per-camera `thumbnail`
route: live view is the MJPEG `/cameras/:name/live` stream (send the Bearer
header; the stream is per-connection and never cached) and stills come from
`snapshot`. Camera routes are scoped per person: a client only sees the cameras
it is granted. A save or download asked by a role that is not owner or admin
answers `403 { code: "CAMERA_CUSTODY_REQUIRED" }`.

**Event still (`GET /cameras/events/:eventId/thumbnail`).** `:eventId` is a
Frigate event id, and `thumbnail_url` on `/cameras/clips` points here. Its errors
(`routes/cameras.ts`, `services/camera-access.service.ts`,
`middleware/error-handler.ts`):

| HTTP | Body | When |
|---|---|---|
| 400 | `{ "error": "Invalid event ID format" }` | `:eventId` does not match the pattern |
| 403 | `{ "error": "Forbidden: role not permitted" }` | A role outside owner, admin and family (a guest, a service token) |
| 404 | `{ "error": "module_disabled", "module": "cameras" }` | Cameras is off on the box, or the person's access does not include it |
| 404 | `{ "error": "Not found" }` | A person with per-camera grants asks for an event on a camera they do not hold, or one Frigate does not know: the same body for both. Owner and admin skip this check |
| 404 | `{ "error": "Thumbnail not found" }` | Frigate answers 404: it has no thumbnail for the event (pruned, or never made) or no such event (#2528). Key on the status, not the body: this route has three 404 bodies |
| 500 | `{ "error": "Internal server error", "message": "Something went wrong" }` | Frigate answers any other non-2xx, times out, or cannot be reached |
| 503 | `{ "error": "access_check_unavailable" }` | The grant check could not run (the database, or Frigate's event lookup, failed): retry |

### LLM (`/api/llm/*`)

| Method | Path | Auth | Returns / body |
|---|---|---|---|
| GET | `/llm/models` | Bearer | `{ models: [{ id, name, provider, ... }], defaultModel?: string \| null, degraded?: boolean, degraded_providers?: string[] }` |
| GET | `/llm/conversations` | Bearer | `[{ id, title, updatedAt, model }]` |
| GET | `/llm/conversations/:id` | Bearer | `{ id, title, messages: [...] }` |
| POST | `/llm/conversations` | Bearer | `{ title?, model? }` → `{ id }` |
| POST | `/llm/chat` | Bearer | `{ model, messages: [{ role, content }], stream?: true, conversationId? }` → SSE stream OR JSON |
| DELETE | `/llm/conversations/:id` | Bearer | `{ ok }` |

`GET /llm/models` returns an object, including when its `models` array is
empty. Decode `models` from that object; the response is never a bare array.
`defaultModel` is the installed local model selected for chat, or `null` when
none is selected. `degraded: true` means the local model list may be incomplete
because the AI service is unreachable or reported a provider failure; an empty
list in that state does not prove that no model is installed. The optional
`degraded_providers` names the providers whose model listing failed.

Each message carries `kind` (`message`, or `agent_run_result` for a background run reporting back, WARP-3300) and `meta` (`null`, or `{runId, status, title, summary, artifacts}` on an `agent_run_result`). Its `content` is plain assistant text either way, so a client that ignores `kind` still shows it.

Chat sends go to the single `POST /api/llm/chat` route (there is **no**
per-conversation `/llm/conversations/:id/chat` endpoint). The conversation
id is carried in the request **body** as `conversationId` (a UUID), not in
the path; omit it to start a new conversation. The body is OpenAI-style:
`messages` is the full turn array (`role` ∈ `system|user|assistant|tool`,
plus `content`), and `stream: true` selects the SSE response below.

**Do not replay tool results.** `role: "tool"` and `tool_call_id` are accepted
on the wire and then **discarded** before the turn runs (WARP-2849). There is
no client-side way to carry a previous turn's tool output back into the model's
context today — the schema has never declared the assistant `tool_calls` a tool
result answers, so anything you send is an orphan the ai-gateway rejects
outright. Send `system` / `user` / `assistant` text only. When the server does
discard something it says so, on the two headers below.

**`dashboardPages` is web-only for now (WARP-3116).** The web dashboard sends
the pages its viewer can open, so the assistant can link to them and move the
viewer between them (`find_dashboard_page` / `open_dashboard_page`; see
`docs/LLM_AGENT.md` § Dashboard navigation). A native client that omits it
gets neither tool advertised and no `{ action: "navigate" }` result.
Adopting it means sending the app's own screens as same-origin-shaped paths
and routing on that result, which is a contract change of its own.

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

Two further headers appear **only** on a turn where the server discarded part of
your request (WARP-2849). They are set as a pair, on streaming and
non-streaming alike, including ephemeral turns:

- `X-Tool-Replay-Dropped-Messages: <n>` — `role: "tool"` messages removed.
- `X-Tool-Replay-Stripped-Tool-Call-Ids: <n>` — `tool_call_id` fields removed
  from messages of any other role.

Their **presence** is the signal: on an ordinary turn neither appears, so a
client can treat "header present" as "the model did not see everything I sent"
and surface or log it. Without them the turn is an ordinary `200` whose answer
silently ignores the tool output you supplied.

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
| GET | `/tools?status=&category=` | owner/admin/family | — | `{ specs: [{ id, slug, name, category, description, version, status, ownerId, share, visibility, canShare, safety, writes, reversible, …, stepCount, runCount }] }` — only the routines the caller may see |
| GET | `/tools/:slug` | owner/admin/family | — | full spec (incl. `steps`); `404` when the caller may not see it |
| POST | `/tools` | owner/admin/family | `{ slug, name, category?, description?, share?, safety?, writes?, reversible?, steps: [{ tool, args? }] }` | 201 spec, born `visibility: "PRIVATE"` |
| PATCH | `/tools/:slug` | owner/admin | partial spec (+ `status?`) | spec (`visibility` is not patchable) |
| POST | `/tools/:slug/share` | owner/admin/family | — | spec with `visibility: "WORKSPACE"` — WARP-3354 |
| DELETE | `/tools/:slug/share` | owner/admin/family | — | spec with `visibility: "PRIVATE"` — WARP-3354 |
| POST | `/tools/:slug/runs` | owner/admin/family | run args | run result (confirmation-gated for write/Tier-2 tools) |
| GET | `/tools/:slug/runs` | owner/admin/family | — | run history |

WARP-3354 — **a routine is private to its creator unless shared with the Workspace.**
`visibility` is `"PRIVATE"` (its creator, owners and admins) or `"WORKSPACE"` (every
member). `canShare` is per viewer: true when the caller may share or un-share it (its
creator, an owner or an admin; always false for `daily-report`) — show the action on that,
do not re-derive it from `ownerId`. Owner and admin see every routine. Every `/tools/:slug*` route (detail, runs,
run history, schedules) answers `404 Spec not found` for a routine the caller may not see,
exactly as for an unknown slug. `share` and `unshare` are idempotent and answer the spec;
`403 forbidden_not_creator` for a member who can see a shared routine they did not create;
`409 box_routine_stays_shared` for `daily-report`. Box-provided routines (mined suggestions,
`daily-report`) are `WORKSPACE`. The legacy free-text `share` field is not read by anything.
`POST /tools` by a member (`family`) stores the routine under the requested `slug` plus a short
random suffix (`invoice-reminder-7f3a`), every time, so the slug reveals nothing about other
routines; the name is unchanged and sharing keeps the slug. Read `slug` from the answer, do not
assume the one you sent. A `slug` held by a routine the caller can see is `409 Slug already in use`.
Owner and admin keep the plain `slug` (and the plain 409); so do the box's own routines.

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

#### Coding-tool tokens (`/api/llm-access`)

WARP-3452 / ADR-067. Tokens (`dlk_…`) that let a coding tool use the box's model at
`https://<box>/llm/`. Owner, admin and members only: a guest gets
`403 role_not_allowed` on every route.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | `/llm-access` | owner/admin/family | — | `{ enabled, canCreate, isAdmin, activeModel, contextWindow, tokens: TokenRow[] }` (the caller's own tokens, newest first) |
| PUT | `/llm-access/settings` | owner/admin | `{ enabled }` | same as GET |
| POST | `/llm-access/tokens` | owner/admin/family | `{ label }` (1–64 chars, trimmed) | 201 `{ token, row: TokenRow }`; `token` is shown this once. `409 disabled` while the switch is off |
| POST | `/llm-access/tokens/:id/renew` | own token, or owner/admin | — | `TokenRow` (expires 364 days on); `409 revoked` |
| DELETE | `/llm-access/tokens/:id` | own token, or owner/admin | — | `204` (revoked, row kept) |
| GET | `/llm-access/tokens/all` | owner/admin | — | `{ tokens: Array<TokenRow & { user: { id, displayName } }> }` |

`TokenRow` = `{ id, label, prefix, status: "active"|"revoked"|"expired", createdAt,
expiresAt, lastUsedAt, revokedAt, usage30d: { requests, promptTokens,
completionTokens, errors } }`. Someone else's token id → `404 not_found`. The
`_introspect` and `_usage` routes under the same prefix are for ai-gateway only.

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
| GET | `/matter/devices/events` | Bearer | SSE stream: `data: {json}` frames of `{ type: "connected" }`, `{ type: "state_changed", … }` and `{ type: "connection_changed", … }`, plus `: heartbeat` every 30 s |
| POST | `/matter/devices/:nodeId/command` | Bearer (owner/admin/family) | `{ command, data? }` → `200 { …result, nodeId, command, tier }`; a Tier-2 (lock-like) command answers `202 { status: "confirmation_required", nodeId, command, service, tier, reason, confirmationToken, expiresIn: 60 }` |
| POST | `/matter/devices/:nodeId/confirm` | Bearer (owner/admin/family) | `{ confirmationToken, service }` → `200 { …result, nodeId, confirmed: true }` or `400 { error, code }`; the command comes from the token, never from this body |
| DELETE | `/matter/devices/:nodeId` | Bearer | `{ ok }` |
| POST | `/matter/commission` | Bearer | `{ qrPayload }` → `{ deviceId }` (dashboard only in v1) |

Commissioning happens via dashboard QR scanner (WARP-182). Mobile v1
controls existing devices but does NOT add new ones.

### Notifications (`/api/notifications`)

> **Rewritten for WARP-2804 (notification acknowledgement).** The earlier
> table (`?since=…`, a bare array, `{ ok }` from the ack) described no shipped
> route. The routes below are what the orchestrator serves
> (`apps/orchestrator/src/routes/notifications.ts`).

A person reads and acknowledges **their own** notifications only; every
route is keyed on the signed-in username. All four need a person's sign-in
(Bearer JWT or the session cookie): N3 and N4 answer `403 HUMAN_ONLY` to a
service token.

| # | Method | Path | Body / query | 200 response |
|---|---|---|---|---|
| N1 | GET | `/notifications` | query: `limit` 1–200 (default 50), `cursor`, `state` = `unacked` \| `all` (default `all`) | `{ notifications: NotificationRow[], unread, nextCursor }` |
| N2 | GET | `/notifications/unread-count` | — | `{ unread }` |
| N3 | POST | `/notifications/:id/ack` | `{ via?: "inbox" \| "opened" }` (an empty body acks as `inbox`) | `{ notification: NotificationRow, changed }` |
| N4 | POST | `/notifications/ack-all` | `{ ids: string[] }`, 1–200 ids: the notifications the app **showed** | `{ acked, unread }` |

`NotificationRow`:

```json
{
  "id": "clx…", "kind": "reminder" | "event" | "system" | "ai",
  "title": "…", "body": "…" | null,
  "url": "/calendar" | null, "data": { … } | null,
  "createdAt": "ISO-8601", "deliveredAt": "ISO-8601" | null,
  "channels": "toast,push", "pushOutcome": "sent" | "no_subscribers" | "refused_gate" | "failed" | null,
  "error": "…" | null,
  "ackState": "unacked" | "acked" | "untracked",
  "ackedAt": "ISO-8601" | null,
  "ackMethod": "inbox" | "opened" | "all" | "incident" | null
}
```

- **Unread means `ackState = "unacked"`.** Rows written before WARP-2804 are
  `untracked`: never counted as unread, and still ackable with N3. `unread`
  (N1, N2, N4) counts `unacked` only.
- **`url`** is a same-origin dashboard path (`/workshop?run=…`); map it to the
  app's own screen. **`data`** is small, flat and PHI-free.
- **Paging.** `nextCursor` is opaque (`<ms>.<id>`): pass it back as `cursor`
  for the next (older) page. It is `null` on the last page.
- **N1 is strict about its query.** An unknown key, a `limit` outside 1–200,
  a `state` other than `unacked`/`all`, or a cursor the box did not mint is a
  `400 VALIDATION_ERROR`, never silently ignored. Calling it with no query
  (what the shipped iOS and Android apps do) returns the newest 50.
- **N3 is idempotent; the first ack wins.** Acking an acked row is a 200 with
  `changed: false` and the original `ackedAt`/`ackMethod`. Send
  `{ "via": "opened" }` when the person opened the notification's link,
  and nothing (or `{}`) for a plain "mark read" — the shipped iOS "Mark read"
  POSTs an empty body, which acks as `inbox`.
- **N3's id** must match `^[A-Za-z0-9_-]{1,64}$` (else `400`). Someone else's
  id answers **exactly** like a missing one (`404 NOTIFICATION_NOT_FOUND`), so
  the route never confirms that a notification exists.
- **N4 takes ids, never a time.** Send the ids the app actually displayed. A
  notification that is not the person's, or does not exist, is simply not
  counted (no error). `untracked` rows are left as they are. Both bodies are
  strict: an unknown key is a `400`.
- **Errors on N1–N4 are nested**, unlike the flat envelope described under
  [Error shape](#error-shape): `{ "error": { "code": "…", "message": "…" } }`
  with `code` one of `VALIDATION_ERROR` (400), `HUMAN_ONLY` (403),
  `NOTIFICATION_NOT_FOUND` (404). Key on `code`; `message` is for logs.

**`X-Droplet-Client` (send it on N3 and N4).** The box records what the
acking device *said* it was, labelled as reported (it proves nothing). Send
`X-Droplet-Client: <product>/<version>`, optionally with a comment:
`droplet-ios/1.4.0 (iOS 18.2)`. Grammar:
`^[a-z0-9-]{1,32}/[0-9A-Za-z.+-]{1,24}( \([^()\r\n]{1,48}\))?$`. A header that
does not match is ignored and the box falls back to a coarse User-Agent label
("Safari on iPhone"). The box also records which sign-in acked (the token's
session id) and whether its session store confirmed that sign-in live; none
of the three is ever returned.

Native apps fetch on launch and every 5 minutes when foregrounded. APNs / FCM
push is the real-time delivery once it exists (see "Push status" above); this
endpoint is for catch-up and the in-app inbox.

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

### Active department (`/api/me/active-department` — WARP-2981)

The department a person's app is arranged around (ADR-059, DS-003). It is kept
on the box, so a switch made on one device reaches the others. It **arranges,
never grants**: what the person can reach is the same whatever is chosen.

| Method | Path | Auth | Body | 200 response |
|---|---|---|---|---|
| GET | `/me/active-department` | Bearer (a person) | — | `{ scope, department: ActiveDepartment \| null }` |
| PUT | `/me/active-department` | Bearer (a person) | `{ departmentId: "<uuid>" \| null }` | `{ scope, department: ActiveDepartment \| null }` |

`scope` is always present and says what the person chose:

| `scope` | Meaning | `department` |
|---|---|---|
| `"unset"` | The person has never chosen, on any device. | `null` |
| `"whole_business"` | The person chose Whole business. | `null` |
| `"department"` | The person chose a department. | `ActiveDepartment` |

`ActiveDepartment` is `{ id, slug, name, profile: { template, icon } | null }`.
`profile: null` means the department is not set up yet.

- **Key on `scope`, not on `department` being `null`.** Show Whole business, the
  default for everyone (DS-014), for both `"unset"` and `"whole_business"`. They
  differ in one way: `"unset"` means nobody chose anything, so a choice the app
  already kept on the device may stand. `"whole_business"` was chosen, on this
  device or another, and replaces whatever the device holds.
- **PUT `null` chooses Whole business**, and the box records that choice: the
  next GET answers `"whole_business"`, never `"unset"`. PUT a department's id to
  choose it. PUT answers with the same shape as GET.
- **What to offer.** `GET /api/departments` returns the rows the person may see.
  Offer the `kind: "DEPARTMENT"` rows whose `state` is neither `archived` nor
  `archiving`, sorted by name, plus Whole business. PUT accepts exactly that
  set. With no such row, show no switcher.
- **Each person reads and writes only their own choice.** Nothing in the request
  names a person. A service token gets `403 HUMAN_ONLY`.
- **The box checks the choice again on every read.** If the person has been
  removed from the department, or it has been archived, GET answers
  `"whole_business"`. The box keeps the choice, so it comes back if the
  department is restored or the person is added back.
- **Every PUT refusal looks the same.** A department the person may not choose
  (missing, not theirs, archived or being archived, a team, the household) gets
  one `404 DEPARTMENT_NOT_AVAILABLE` body, so the answer never shows whether a
  department exists. The body is strict: an unknown key, a non-uuid id or a
  missing `departmentId` is `400 VALIDATION_ERROR`.
- **The last write wins** across devices. Read it again on launch and when the
  app comes to the foreground, to pick up a switch made elsewhere. Nothing is
  audited: it is a display preference.
- **Errors are nested**, as on the Notifications routes:
  `{ "error": { "code": "…", "message": "…" } }`. Key on `code`. A `404` with any
  other code, or none, means the box is older than this route: keep the choice
  on the device.

### Agent runs (`/api/agent-runs/*`, WARP-2915)

Background runs the box works on by itself, and the Tier-2 calls they park on for a
person's approval. Source of truth: `apps/orchestrator/src/routes/agent-runs.ts`
(`serializeRun`, `listQuerySchema`, `decideSchema`) and `decideAgentRun` in
`services/agent-run-worker.service.ts`. Shipped clients: Android (droplet-android #46,
`AgentRunModels.kt`) and iOS (droplet-ios #63, WARP-2914).

**Who.** Every route requires role `owner` or `admin`; any other role gets
`403 {"error":"Forbidden: role not permitted"}` (or `"Forbidden: no role on session"`)
from the role gate, before the handler runs. Key on the status: the `error` is a sentence,
not a slug. A person sees only their own runs: another person's run id is a
`404 {"error":"Run not found"}`, never a 403. A native client always acts as itself and
never sends `onBehalfOf` (that field is for the `_service:mcp` principal acting for a chat
user), so it never sees the two `403`s that only that principal can reach
(`"Forbidden: role not permitted to use background runs"`, `"Forbidden: no principal to act for"`).

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/agent-runs` | `?limit` (1-100, default 25), `?cursor`, `?status`, `?workspaceId` | `{ items: Run[], nextCursor: string \| null }` |
| GET | `/agent-runs/:id` | — | `Run` plus `trace` |
| POST | `/agent-runs/:id/cancel` | — | `200 { id, status: "cancelled" }` |
| POST | `/agent-runs/:id/confirm` | `{ decision: "approved" \| "denied" }` | `200 { id, tool, decision, status: "queued" }` |

`POST /agent-runs` (start) and `/agent-runs/schedules` (recurring runs) also exist; the
mobile apps do not use them, so they are not specified here.

**List.** Ordered newest first by `(createdAt desc, id desc)`. It is **not** parked-first:
a run awaiting confirmation sits where its `createdAt` puts it, so a client that wants a
"needs your OK" section filters on `status == "awaiting_confirmation"` (or sends
`?status=awaiting_confirmation`). `status` is one of `queued`, `running`,
`awaiting_confirmation`, `succeeded`, `failed`, `cancelled`; treat an unknown value as
"unknown", not as an error. `nextCursor` is opaque (today `<createdAt ISO>|<id>`): pass it
back verbatim, never build or parse it. It is `null` when the page returned fewer than
`limit` rows, so a full last page yields one extra empty request. A malformed cursor is
`400 {"error":"Invalid cursor"}`; a bad query is `400 {"error":"Invalid query","details":…}`.
List rows carry no `trace`.

**Run.**

| Field | Type |
|---|---|
| `id`, `goal`, `model`, `status` | string |
| `sessionId`, `startedAt`, `endedAt`, `deadlineAt`, `result`, `stopReason`, `error` | string \| null |
| `iteration`, `maxIter`, `attempts` | int |
| `runAfter`, `createdAt`, `updatedAt` | ISO-8601 string |
| `workspaceId`, `cloudGate`, `offLanProvider`, `offLanWithheldTools` | Workshop / off-LAN metadata; clients that do not render it decode past it |
| `pending` | `null`, or the parked call (below) |
| `trace` | detail read only: array of steps |

`pending` is non-null **only** while `status == "awaiting_confirmation"`:
`{ tool, args, summary, parkedAt, decision, decidedAt }`. `summary` is an **object**
(`{ tool, fields: [{ key, kind, detail, value? }], truncatedFields }`), not a string: it is
the PHI-free `ConfirmationSummary` shared with chat confirmations, and `detail` is a size or
shape, never the value. `args` is the raw argument object. It is present because the caller
is the run's owner, but native clients should not render it and do not declare it.

Trace step: `{ tool_call_id, tool, args, iteration, dispatchedAt, text?, isError?,
completedAt?, replayOf?, confirmation?: "parked" \| "confirmed" \| "denied",
unknownOutcome?: true }`. `unknownOutcome` marks a call whose result was lost when the
worker restarted. A run re-parked on the same tool that has such a step may already have
happened, so a client must not tell the person that nothing has been done yet.

**Cancel.** `409 {"error":"Run is already finished","status":<current>}` once the run is
terminal. 404 / 403 as above.

**Confirm.** Errors are `{ "error": <reason>, "id": <run id> }`, where `reason` is a slug:

| Status | `error` | Meaning |
|---|---|---|
| 404 | `not_found` | no such run (the ownership check's 404 says `"Run not found"` instead; treat both the same) |
| 403 | `not_owner` | the run belongs to someone else. In practice a client gets the `"Run not found"` 404 instead, because the ownership check already runs first; `not_owner` only fires on a race, so do not build UI for it |
| 403 | `forbidden_tool_for_role` | the deciding person's role may not approve this tool |
| 409 | `not_parked` | run is not waiting (already decided, cancelled, or finished): re-read it |
| 409 | `attribution_failed` | the box could not resolve who is deciding; nothing changed and the run is still parked |
| 400 | `Invalid decision` (+ `details`) | `decision` is not `approved` or `denied` |

The role gate's 403 is a sentence, not a slug (see **Who**, above); key on the status.
After a successful decision the run is `queued` again and the worker resumes it. There
is no undo. Do not auto-retry a confirm: re-read the run first.

**Deep link.** A run opens in the native apps as **`droplet://run/<id>`**: exactly one
path segment, no query, and `<id>` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Opening
it only shows the run; it never approves, declines, or cancels. The box does not send this
scheme. A push for a run carries the dashboard path
`url: "/workshop?run=<id>"` (`agentRunLink` in `agent-run-worker.service.ts`; `run` is the
only query key, and `tag: "agent-run:<id>"` collapses every notification about one run).
On Android `/workshop?run=<id>`, `/admin/audit?run=<id>` (which forwards to `/workshop`)
and `/agent-runs/<id>` all open the same run page, and the push handler rewrites them to
`droplet://run/<id>` for its content intent. Anything else, or an id that fails the
pattern, opens the inbox.

**Client cross-check (Android #46 vs iOS #63).** No wire mismatch: both read
`pending.summary` as the chat `ConfirmationSummary` object (the bug WARP-2914 fixed on iOS
was modelling it as a string), both drop `args`, and both accept the same run-id rule.
Differences that are not contract issues: iOS handles the 404 in both shapes (the
`"Run not found"` sentence and the `not_found` slug) while Android keys 404 on status,
and Android's `parkedCallMayHaveRun` (the `unknownOutcome` re-park case) is Android
copy that the iOS card may not carry.

## Error shape

> **Corrected 2026-06-28 (XR-03), narrowed 2026-09-29 (WARP-2975).** Earlier drafts
> of this section described a **nested** envelope `{ error: { code, message } }` for
> the whole API. On 2026-06-28 **no** orchestrator route emitted that shape: a sweep
> of `src/routes/*` found ~621 flat `error` responses and **zero** nested ones. A few
> route families have emitted it since; they are listed under
> [Nested envelope](#nested-envelope-on-some-routes) below, and every other
> client-facing route is still flat. The fictional codes the old table listed
> (`PAIR_CODE_EXPIRED`, `PAIR_CODE_INVALID`, `RATE_LIMITED`, `INTERNAL`) do not
> exist in any handler.

Every 4xx / 5xx response **outside those families** is a **flat** object whose
`error` is a **string**:

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

### Nested envelope on some routes

These routes answer `{ "error": { "code": "…", "message": "…" } }`:
`error` is an **object**, and there is no top-level `code`.

- `/notifications` N1–N4 (`routes/notifications.ts`; `POST /notifications/send`
  keeps the flat shape).
- `/me/active-department` (`routes/me-department.ts`).

Both shapes reach the same client, so check whether `error` is an object or a
string before reading `code`. `code` is an UPPER_SNAKE slug to key on; do not parse
`message`.

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

`stop_reason` ∈ `model_done | iteration_limit | error | context_budget |
repetition | no_progress | needs_details` (an `error` frame also carries an
`error` string). The last four mean the loop stopped calling tools early: the
context filled up, the model repeated an identical call, its searches kept
finding nothing, or half the turn's steps went on searches that found
nothing usable (`needs_details`, WARP-3347). The final text is still a normal
answer. `needs_details` says the guard fired, not what the answer is: it
usually asks the person for the missing detail, but it can be a plain answer
when the results were already enough. Treat any value you do not recognise
like `model_done`. The agent loop also emits these event
types on the same stream — render or ignore as needed:

| `event:` | `data` payload | Meaning |
|---|---|---|
| `content_delta` | `{ text }` | One token/text chunk — append to the active bubble |
| `tool_call` | `{ id, name, args }` | The model invoked an MCP tool |
| `tool_result` | `{ id, ok, data?, status?, message? }` | That tool's result |
| `reasoning_step` | `{ text }` | One deep-reasoning step (only when `captureReasoning:true`; emitted BEFORE `content_delta` on the turn) |
| `model_loading` | `{ model, sizeGb }` | WARP-903 — the selected model needs a cold load (30-60 s to first token). Emitted first, at most once; render a loading state until the next frame, or ignore. `sizeGb` is decimal GB or null |
| `tool_use_validation` | `{ status, claims, tools }` | WARP-2544 / WARP-3348 — the delivered answer still claims a completed action the tool trace does not support (its correction pass failed, so a status line was appended). At most once per turn, immediately BEFORE `done`. `status` is `"unsupported"` (none of the claimed actions was attempted) or `"contradicted"` (a claimed action was attempted and did not run: waiting for approval, declined, refused or failed); `tools` lists those writes. See the note below |
| `done` | `{ iterations, stop_reason, error? }` | Terminal frame |

**`tool_use_validation` is ADVISORY, not a retraction.** Since WARP-3348 the
answer of a tool turn is checked BEFORE it is sent: a claimed action that did
not happen gets one correction pass, and if that fails the answer goes out with
a plain status line appended ("Nothing was sent."). This frame is emitted only
in that last case, when the delivered text still contains the false sentence
above the status line. Render it *beside* the answer — "this may not have
actually happened" — never by mutating or hiding the delivered text. Ignoring
the frame is valid and matches pre-WARP-2544 behaviour; it is additive and
breaks no existing client.

It exists because the tools on this product are physical (cameras, locks,
network rules, power), so a model sentence claiming an action that never
succeeded is a safety and trust problem rather than a cosmetic one. `claims`
carries the model's own sentences that triggered it (capped at 160 chars each)
and `tools` names the claimed writes that were attempted and did not run.

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

## Real-time events (`/api/ws/events`)

A WebSocket bridge that forwards the box's MQTT events for the signed-in person.
Source: `apps/orchestrator/src/services/ws-bridge.service.ts`.

- **URL:** `wss://<host>/api/ws/events` (matched by prefix; any other upgrade
  path is answered `404`).
- **Auth:** at upgrade time, either the session cookie (browsers) or a Bearer
  access token passed as the WebSocket subprotocol `bearer.<accessToken>`
  (native clients use this). The token is validated like an HTTP request: a
  revoked user or an ended session is refused. Failure is a plain
  `401 Unauthorized` on the upgrade and no WebSocket is established. The
  server does not echo a selected subprotocol, so a client must not require one
  back. The token is checked only at upgrade: refresh it before it expires,
  and reconnect with the new one.
- **Topics:** there is no subscribe message. The server subscribes each
  connection to the person's own topics only: `droplet/files/<username>/#`
  (and `droplet/files/<userId>/#`), `droplet/devices/<username>/#`,
  `droplet/index/<username>/#`, `droplet/notifications/<username>`,
  `droplet/chat/<username>/#`, `droplet/agent-runs/<username>` and
  `droplet/team-chat/<username>`. Other people's topics are never forwarded.
- **Frames:** server to client JSON text frames
  `{ "topic": "<mqtt topic>", "payload": <json> }`. Client-sent frames are
  ignored. The server sends a WebSocket ping every 25 s (the client library
  answers with a pong automatically).
- **Notification frames.** A frame on `droplet/notifications/<username>` carries
  a notification the box has just recorded and is delivering:
  `{ id, kind, title, body, at, url?, data?, priority? }`
  (`publishNotificationToast`, `services/notifications.service.ts`). `id` is N1's
  row id (send it to N3 to acknowledge), `kind` is N1's, `body` is a string or
  `null`, and `at` is UTC ISO-8601. `url` and `data` are N1's; they are **absent**,
  not `null`, when the notification has none or the box refused them.
  `priority` is present, as `"alert"`, only on an alert. There is no `tag`: that
  is a web push field.
- **Team chat frames (Messages).** A frame on `droplet/team-chat/<username>`
  says something changed in a conversation the person belongs to, and carries
  **IDs and a kind only, never message text, titles or names**:
  `{ kind: "message" | "read" | "conversation", conversationId, messageId? }`.
  `message`: a message was posted (or its meeting card changed, for example an
  RSVP); `messageId` names it. `read`: the person's own read cursor moved (sent
  to that person's own sockets only, so a colleague's reading is never
  announced). `conversation`: a conversation was created. Re-read through the
  usual routes, which keep their gates: `GET /team-chat/threads/:id/messages`
  for that conversation, `GET /team-chat/threads` for the list and
  `GET /team-chat/unread-count` for the badge. Only members receive a frame for
  a conversation, and an external guest only for conversations they were added
  to. Frames are best-effort and not replayed, so keep a slow poll as a
  fallback, and re-read after a reconnect. The polls stay valid for older clients.
- **Reconnect:** on close, reconnect with exponential backoff and jitter, and
  stop once sign-in has ended. Events are not replayed, so after a reconnect
  re-fetch state (`GET /notifications`, files, devices).

## Open items

- [ ] OpenAPI generation: should we write `openapi.yaml` and codegen
      Swift/Kotlin/C# clients? Reduces drift but adds a build step. The
      markdown contract is still the mechanism; a generated client for the
      desktop subset is a possible follow-up.
- [x] Real-time channel while the app is foregrounded: shipped as the
      `/api/ws/events` WebSocket bridge (see "Real-time events") plus the
      camera and Matter SSE streams. APNs/FCM push remains the background
      channel on mobile.
- [ ] WebRTC vs HLS for camera streams. Frigate supports both; HLS is
      simpler client-side, WebRTC has lower latency. v1 ships MJPEG live
      (`/cameras/:name/live`); HLS/WebRTC are not served to clients.
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

**Roles (WARP-3369).** Owner, admin and member (`family`) only. An external
guest (`guest`) reads nothing of the company's work: every `/api/mobile/pm/*`
route answers `404 { "error": "module_disabled", "module": "projects" }` for
that role, as does `/api/pm/*` (and every `/api/crm/*` and `/api/money/*` route
the same with `"module": "crm"` / `"money"`, WARP-3365). The one exception
(Romain, 2026-09-30): a work item ASSIGNED to a guest is shared with them, so on
`/api/pm` a guest may `GET /work-items/:id`, `GET` and `POST /work-items/:id/comments`,
`POST /work-items/:id/transition` and `GET /projects/:id/states` for an item
assigned to them (the same 404 for any other item, existing or not). Clients hide
the entry rather than show the error.

**Service desk (WARP-3528, ADR-069).** A service desk is a project of kind
`SERVICE_DESK` and a ticket is a work item in one, served by `/api/support/*` and
never by these routes. Every `/api/mobile/pm/*` and `/api/pm/*` route treats a
desk, its states and labels, its tickets, their comments, history and links as
not existing (the same 404 as an unknown id), and no list or summary counts them.
The contract below is unchanged.

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
