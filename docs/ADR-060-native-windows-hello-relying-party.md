# ADR-060: Native Windows Hello relying party for the Windows app

- **Status:** Accepted, **conditional on spike S2** (§Gate). Decision D1 was taken on 2026-09-25 under Stefan Cruceru's delegation: pinned and IP pairings get Windows Hello through a native `webauthn.dll` relying party in the Windows shell, if S2 passes. Until S2's evidence is linked from WARP-3137 and a one-line PR drops the word "conditional" above, the amendments below do not take effect and no Stage 2 implementation PR merges. If S2 fails, the same one-line PR marks this file Rejected, and ADR-008's sentence stands as written.
- **Date:** 2026-09-25
- **Ticket:** [WARP-3137](https://warp-lab.atlassian.net/browse/WARP-3137)
- **Amends:** [`ADR-008`](ADR-008-native-mobile-design-system-and-api-contract.md) 2026-06-01 scope note (line 327, "WebAuthn is not part of the app login path"); the `droplet-windows` README rule "the thin shell never handles login credentials" (`README.md:143`, `:170` at `c187bd3`); and, for the native relying party only, the request-derived rpID rule in `apps/orchestrator/src/services/webauthn-config.ts:4-12`.
- **Builds on:** [`ADR-013`](ADR-013-builtin-directory-vs-nextcloud.md) (directory login), [`ADR-023`](ADR-023-public-ca-per-device-tls-via-hq-dns01.md) (per-device public-CA TLS), [`ADR-009`](ADR-009-canonical-system-architecture.md) (the Tauri shell), [`ADR-045`](ADR-045-client-app-distribution.md) (client distribution), ADR-058 (device certificates; the handbook's `DEVICE-CERTIFICATES-ARCHITECTURE-BRIEF.md`, whose pinned-pairing baseline is WARP-2953 / WARP-2954), WARP-1157 (LAN passkeys).
- **Number:** claimed here, in `docs/`, on `stage`. Checked 2026-09-25: none of the 649 refs on `origin` (every open PR head and `stage` included) carries a `docs/ADR-*` file above `ADR-056`; the handbook's register (README table, `main` at `043fcc7`) runs to ADR-059, and its one open PR (#75) claims nothing above it; `shared_brain` `main` (`7df90d1`) holds no ADR-057-or-higher file or reference; an org-wide code search for `ADR-060` returns nothing. 057-059 are handbook briefs not yet filed here. A claimed number reserves nothing, so re-check before merge.

> **What this file is.** The record of D1 and the design it accepts ("Approach B" in the WARP-3137 design review). It builds nothing. Line references are to `stage` at `0bf06936` and to `droplet-windows` at `c187bd3` (0.2.2).

## Context

**How the Windows app signs in today.** The shell pairs to a box, then navigates WebView2 to the box's own dashboard, which runs the ordinary cookie login (password, TOTP, SSO). The shell never sees a credential; the JWT pair lives in WebView2's HttpOnly cookies (`droplet-windows` README `:143`). ADR-008's scope note says WebAuthn is not part of the app login path, and `lib/browser-context.ts:10-12` records that the shell never uses `?return=body`.

**The ask.** Windows Hello sign-in, the counterpart of the Mac app's Touch ID. The Mac's Touch ID is not WebAuthn: it is a biometry-gated Keychain `{email, password}` replay (DropletKit `BiometricSignIn`, WARP-2855).

**Why the dashboard's own passkeys cannot deliver it on most PCs.** The dashboard ships WebAuthn passkeys (`routes/webauthn.ts`, `/login/passkey`, Settings > Passkeys), and inside WebView2 the platform authenticator is Windows Hello. But most 0.2.2 pairings are pinned self-signed addresses (a LAN IP or `.local`; WARP-2953), not the certified `<name>.droplet-us.com`:

- A pinned page is shown because `webview_trust.rs:106` answers WebView2's certificate error with `ALWAYS_ALLOW`. That puts the page in Chromium's TLS-error state, where WebAuthn has been disabled since M110.
- An IP address can never be an rpID. `isIpRpId` (`webauthn-config.ts:87-97`) and `refuseUnsupportedOrigin` (`routes/webauthn.ts:107-121`) refuse the ceremony.
- The web rpID is derived from the request host (`webauthn-config.ts:77-85`), so a passkey enrolled on one address stops working when the pairing heals to another.

**Why it matters.** The access token lives 15 minutes and the refresh token 7 days (`jwt.service.ts:62-63`), but the session itself ends after 30 minutes idle or 12 hours absolute (`config.ts:546-549`). People see `/login` several times a day.

**Stage 1, recorded for clarity.** Windows Hello through the dashboard's existing WebView passkeys on certified addresses, WebView2 153 or newer, gated on spike S1. It needs no ADR change, is not built at the time of writing, and does not reach pinned or IP pairings. This file is Stage 2.

## Decision

| # | Decision | Answer | Taken by · date |
|---|---|---|---|
| D1 | Should pinned and IP pairings get Windows Hello at all? | **Yes**, through a native relying party in the Windows shell (§1-§7), **conditional on S2** (§Gate) | Stefan Cruceru (delegated) · 2026-09-25 |
| D2 | Enforce user verification on the web passkey routes and require a password re-check before web `register/options` | **Yes** — built in [WARP-3144](https://warp-lab.atlassian.net/browse/WARP-3144), where Romain reviews it. The native routes below enforce both from day one either way | Stefan Cruceru (delegated) · 2026-09-25 |
| D3 | Hide the in-WebView passkey button inside the Windows app when the page is not on its certified address | **Yes** — built in WARP-3137 Stage 1; browsers unchanged | Stefan Cruceru (delegated) · 2026-09-25 |

### 1. A per-box native relying party

- **rpID** is `<label>.native.droplet-us.com`. The label is 16 random bytes in lowercase base32 (26 characters, `[a-z2-7]`), minted on the box's first native enrolment and stored in a new singleton row, `NativeRelyingParty` (following `ApplianceSetup`, `schema.prisma:4760`). It is never the request host, never derived from the TLS key, never an env var, and never `DROPLET_DEVICE_ID`, which defaults to the non-unique `"droplet"` (`config.ts:756`). A factory reset or database wipe mints a new label, and people re-enrol.
- **Origin** is the constant `droplet-windows:shell`. `@simplewebauthn/server` 14.0.2 compares the origin by string equality and the rpID by SHA-256, so a non-https origin verifies. The origin string is not an anti-phishing control for a native client, since any native process can write any origin. It keeps native and web credentials apart and names the client in the audit trail. The rpID hash already makes the two sets cryptographically disjoint.
- **The name is unservable, and stays so.** `native` joins `BOX_NAME_RESERVED` (`packages/shared-types/src/box-name.ts:42`) and the HQ `RESERVED` list it mirrors. Invariant: nothing under `native.droplet-us.com` ever resolves or holds a certificate.
- **Recorded exception.** `webauthn-config.ts:4-12` ("rpID + origin are derived FROM THE REQUEST") stays the rule for the web routes. The native relying party is the one exception, anchored in the database.

### 2. Credentials say which client made them

- New `enum WebAuthnClientKind { BROWSER WINDOWS_SHELL }` and `client WebAuthnClientKind @default(BROWSER)` on `WebAuthnCredential` (`schema.prisma:3294`). The migration defaults existing rows to `BROWSER`. It is an explicit column, never inferred from `rpId` (the repo's no-guessing rule).
- Native routes accept only `WINDOWS_SHELL` rows whose `rpId` is the native rpID. The web `authenticate/verify` refuses `WINDOWS_SHELL` rows explicitly: the rpID hash would fail anyway, and the explicit check makes the intent auditable.

### 3. The shell runs the ceremony natively

- The shell calls `webauthn.dll` through the `windows` crate (0.61, feature `Win32_Networking_WindowsWebServices`: `WebAuthNAuthenticatorMakeCredential`, `WebAuthNAuthenticatorGetAssertion`), behind a trait so the orchestration is tested against a fake authenticator. Platform attachment, user verification required. The `HWND` is the main window's, so the Hello dialog is parented to the app by construction, with no WebView2 runtime floor.
- The shell builds `clientDataJSON` itself (`WEBAUTHN_CLIENT_DATA` takes caller-supplied bytes): `type`, the echoed `challenge`, `origin: "droplet-windows:shell"`, `crossOrigin: false`, and `dropletTls.spkiSha256` (§6).
- Every call to the box goes over the shell's own verified channel: `trust::client_config` with the pairing's pin or the bundled webpki roots (`trust.rs:233-235`), redirects off. The WebView is not involved until the handoff (§5).
- The shell refuses an options response whose rpID differs from the one it stored, or does not match `^[a-z2-7]{26}\.native\.droplet-us\.com$`.
- The shell persists only public data: a `droplet.json` key `native_hello = {rpId, credentialId, userName}`. Forget Droplet (`clear_pairing_store`, `lib.rs:2042`) deletes it and, on `webauthn.dll` API version 4 or later, deletes the platform credential (best effort). A 401 from native verify drops the record the same way.

### 4. Enrolment

1. A person already signed in inside the WebView opens Settings > Passkeys. "Set up Windows Hello on this PC" shows only when `window.__dropletShell.features.nativeHello` is true. That is the one read-only shell descriptor, which lands with Stage 1 or, if Stage 1 has not landed, with this stage: a UX hint only, never a security input, with no IPC; the shell's capabilities stay `"local": true`.
2. The dashboard calls `POST /api/auth/webauthn/native/enrol-ticket` (protected, `authRateLimit`) with the person's password, which the box re-verifies exactly as `/auth/login` does. The box returns a 32-byte ticket that expires in 120 seconds and stores only its SHA-256, in a new `AuthHandoff` row (`kind: ENROL_TICKET`, `userId`, `expiresAt`). Expired rows are pruned alongside expired challenges.
3. **Local accounts only in v1.** SSO- and SCIM-provisioned rows have no local password, and WARP-2858 already refuses to give them a box login their IdP cannot reach (`provisionSource`, `schema.prisma:2816`). `enrol-ticket` refuses them with a coded error.
4. The dashboard navigates to `https://<paired address>/_shell/hello/enrol` carrying the ticket (in the fragment, or the query if the bench shows `on_navigation` does not see fragments). The shell's `on_navigation` hook (`lib.rs:227`) classifies exactly the paired origin plus exactly that path, and cancels the navigation at `NavigationStarting`. The ticket never leaves the WebView and never reaches nginx's log, and `redact_url_for_log` already drops URL paths from the shell log. A plain browser that follows the link lands on a dashboard page that says to open the Droplet app.
5. The shell posts the ticket to `native/register/options`. The box consumes it atomically (winner takes it, as the overlay by-token redeem does at `routes/vpn.ts:994-996`), mints a registration challenge through the existing single-use, 5-minute challenge service, and returns the native `rp`, the `user`, and `excludeCredentials` (this person's `WINDOWS_SHELL` rows), with user verification required.
6. The shell calls `MakeCredential` and posts the result to `native/register/verify`. The box verifies it with `expectedOrigin: "droplet-windows:shell"`, `expectedRPID` the native rpID and `requireUserVerification: true`, runs the channel check (§6), stores the row with `client: WINDOWS_SHELL`, and writes an activity row, "Windows Hello registered".

### 5. Sign-in and the session handoff

1. `/login` shows "Sign in with Windows Hello" when the descriptor flag is set. It links to `/_shell/hello/sign-in`, which the shell intercepts. v1 has no automatic prompt, so signing out never loops straight back into Hello.
2. The shell posts to `native/authenticate/options` (user verification required), checks the returned rpID, and calls `GetAssertion` with its stored credential id.
3. It posts the assertion to `native/authenticate/verify` together with `verifierHash = SHA-256(v)`, where `v` is 32 fresh random bytes. The box runs every existing check (single-use challenge, counter regression, the `DEACTIVATED` gate at `routes/webauthn.ts:626`), plus `client: WINDOWS_SHELL`, the native rpID, `requireUserVerification: true`, and the channel check. It returns **only** `{code}`: 32 bytes, 60 seconds, single use, stored as its SHA-256 in an `AuthHandoff` row (`kind: SESSION_HANDOFF`, bound to the user, the credential and `verifierHash`). No cookie and no token leaves this route.
4. The shell makes the WebView itself redeem the code. On the UI thread it builds `CreateWebResourceRequest("https://<paired>/api/auth/webauthn/native/redeem", "POST", {code, v}, "Content-Type: application/json")` and calls `NavigateWithWebResourceRequest`. It never uses `WebviewWindow::set_cookie`, which would put the refresh token in shell memory. On a pinned pairing the request is allowed by the existing certificate hook, because it is the same host and pin. The shell zeroizes `code` and `v` afterwards.
5. `redeem` requires the handoff binding (below), consumes the code atomically, checks `SHA-256(v)`, and re-checks `DEACTIVATED`. It then runs the session half of `issueSession` (`routes/webauthn.ts:165-202`: `createSession`, `registerRefreshSession`, the HttpOnly `droplet_session` and `droplet_refresh` cookies), factored out so password, passkey and native sign-in share one code path, and answers `303` to `/`. It never sends a JSON body and never honours `?return=body`. The activity row reads "<name> signed in with Windows Hello".
6. **The handoff binding.** `redeem` accepts only a navigation the user agent started: `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Site: none`, plus `Content-Type: application/json`, which no HTML form can send. That blocks login CSRF with a code minted for someone else's account. If S2 shows WebView2 does not send `Sec-Fetch-Site: none` on `NavigateWithWebResourceRequest`, the binding becomes a header the shell sets on the request, which no cross-site page can attach to a navigation. S2's evidence picks one, it is recorded on WARP-3137, and there is no fallback to no binding.

**After a heal** (IP to `.local` to the certified name) the rpID is unchanged. The new origin has no cookie, so the person lands on `/login`, taps Hello, and the redeem sets cookies on the new host, with no re-enrolment. A re-keyed pinned certificate rotates the pairing identity, not the rpID.

### 6. The channel check

`clientDataJSON` carries the SPKI pin of the certificate the shell verified, and the authenticator signs over it. The box compares it with `servedCertPin()` (`lib/served-cert-pin.ts:78`), the same base64 SHA-256 SPKI pin the shell computes (`served-cert-pin.ts:19-22`). A relay through a machine the shell wrongly trusted is therefore visible to the box without trusting the shell's word. On a mismatch the box re-reads the served pin once, to cover a renewal that swapped `droplet.crt` between the handshake and verify, and then refuses. A `null` served pin refuses. The check never fails open. The shell also requires the pin it captured on `options` to equal the one on `verify`.

### 7. The restated shell rule

**The shell never holds a password or a session token.** It may transiently hold a WebAuthn assertion, an enrol ticket, a handoff code and its verifier, each single-use, short-lived and zeroized after use. It persists only public data (rpID, credential id, user name). The private key never leaves Windows Hello. That is stricter than the Mac app, which keeps the raw password in Keychain.

- ADR-008's scope note carries an amendment pointer to this section (this PR).
- The `droplet-windows` README (`:143`, `:170`) is rewritten to this rule in the shell 0.3.0 PR, not here.
- `lib/browser-context.ts:10-12` stays true (the shell never uses `?return=body`); the routes PR adds why.
- **Not decided here:** the dormant push bridge's WS bearer token (README `:143`, `:160-178`). Minting it stays pending its own contract, the notifier's (WARP-2892), and its DPAPI slot stays empty until then.

### What does not change

The web routes keep the request-derived rpID, the IP refusal and their current user-verification settings (D2 is separate). The Mac, iOS and Android apps are unchanged. No new env var, no IPC grant to the remote origin, and no change to `webview_trust.rs`.

## Gate: spike S2

S2 is a throwaway Rust binary in a scratch directory, not a PR. It runs on a real Windows 11 PC with a Windows Hello PIN, against a lab box. **It passes only if all five hold:**

1. **`webauthn.dll` accepts the native rpID.** `WebAuthNAuthenticatorMakeCredential` and `WebAuthNAuthenticatorGetAssertion` both succeed with rpID `<26 base32 chars>.native.droplet-us.com`, platform attachment, user verification required, and a caller-built `clientDataJSON` carrying `origin: "droplet-windows:shell"` and a `dropletTls` member.
2. **The real library verifies the result.** The attestation and the assertion pass `@simplewebauthn/server` 14.0.2 (the version `apps/orchestrator` pins) with that `expectedOrigin`, that `expectedRPID` and `requireUserVerification: true`, and the authenticator data carries the UV flag.
3. **The Hello dialog is captured.** A screenshot of what the dialog shows for this rpID and RP name, and a design-review judgement that the copy is acceptable. If it shows the raw label, S2 records that, and the friendlier display is decided before the shell PR, not by rejecting this file.
4. **The handoff binding is chosen.** The `Sec-Fetch-Site` and `Sec-Fetch-Mode` values WebView2 sends on a `NavigateWithWebResourceRequest` POST are recorded, the §5 binding is picked from them, and a cross-site form POST to the same URL is shown refused by that binding.
5. **The cookies stick on a pinned origin.** On an `ALWAYS_ALLOW` (pinned) origin, the `Set-Cookie` on the `303` persists and the next navigation carries it.

**What S2 gates.** This file may merge before S2, as the record of a conditional decision. No Stage 2 implementation PR (data model, routes, dashboard adapter, shell FFI, shell handoff) merges until S2's evidence (screenshots, verifier output, recorded headers) is linked from WARP-3137 and the status line above is flipped. If item 1 fails, S2 retries under another label on a Warp Lab-controlled domain before this file is marked Rejected; a different rpID shape is an amendment to this file, never a silent change. `.invalid` is not an acceptable fallback without its own review. If item 2, 4 or 5 fails, this file is marked Rejected.

## Rollout

- **Box, all to `stage`, in order:** (a) the data model: `WebAuthnClientKind`, `NativeRelyingParty`, `AuthHandoff`, the purge wiring, and `native` in the reserved names (its migration timestamp sorts after the chain tip, including #2350's schema change); (b) the native routes, `redeem`, the web refusal of `WINDOWS_SHELL` rows, a test that runs the real `@simplewebauthn/server` against a software authenticator using the native origin and rpID, and the full negative-case matrix; (c) the dashboard's native adapter, the `/_shell/hello/*` fallback page, native rows labelled "Windows Hello" in Settings, and a native relying party section in `docs/ONBOARDING_WEBAUTHN.md`. They ride the next `stage` to `main` promotion.
- **Shell, `droplet-windows` 0.3.0** (a new auth surface, not a patch): (d) the FFI shim behind its trait and the descriptor's `features.nativeHello`; (e) the orchestration, the navigation intercept, the handoff, the `native_hello` store key, Forget cleanup, the README rule rewrite, and the bench results. The shell reaches customers only through the updater and signing path WARP-1955 decides, and ADR-045's rule stands (the operator stages; the box never fetches).
- **No flag day.** Old shell with a new box: no descriptor flag, so no button, and web passkeys are unchanged. New shell with an old box: the old dashboard has no button, so the intercept never fires; the shell also treats a 404 from the native routes as "not available". Both new: Windows Hello.
- **Bench, before the shell PR merges:** Windows 11 24H2 and 25H2, and Windows 10 22H2; PIN, face and fingerprint; pinned IP, pinned `.local` and the certified name; a heal from IP to the certified name with no re-enrolment; a re-keyed bootstrap certificate and a re-scanned QR; Forget removes the platform credential; an RDP session; a Windows 11 plugin passkey manager with platform attachment; fragment against query delivery to `on_navigation`; and every path the shell uses (LAN, overlay) reaching the gateway that serves `droplet.crt`.
- **Reviews.** Romain is the required security reviewer on (b) and (e).
- **Copy.** Until 0.3.0 and the box release are both out, product copy never claims Windows Hello without the "certified address" qualifier.
- **Effort.** About 11-13 days after S2.

## Security analysis

WebAuthn in a browser gets its phishing resistance from the browser binding the origin. A native client has no browser, so each property is rebuilt explicitly.

1. **Remote phishing.** A browser origin may only ask for an rpID equal to, or a registrable suffix of, its own host. No site is served at or under `<label>.native.droplet-us.com` (§1's invariant), and another customer's `<name>.droplet-us.com` is a sibling, not a parent. So no web page can ask Windows Hello for this credential. The label is per box, so a credential for box A is never offered to box B.
2. **LAN impostor or man-in-the-middle.** The ceremony runs only over the shell's verified channel: the pinned SPKI for QR-paired boxes, or the bundled webpki roots for the certified name. The shell does not trust the OS store, so an enterprise TLS-inspection root is refused too. The channel check (§6) lets the box detect a relay the shell got wrong.
3. **Replay and relay.** Challenges are single-use and expire in 5 minutes; the signature counter must advance; the enrol ticket (120 s) and the handoff code (60 s) are single-use, stored hashed and consumed atomically. A leaked code is useless without `v`, and the binding (§5.6) stops a cross-site page from redeeming one.
4. **User verification.** Required on every native route, so every native sign-in is a Hello PIN or biometric, whatever D2 decides for the web routes.
5. **What the shell holds.** §7. Nothing on disk to steal.
6. **Local malware: not defended, and no worse than today.** Windows does not bind an rpID to the calling binary, so a malicious process running as the same user could request this rpID, but it still has to pass the Hello prompt. Such a process can already read the WebView2 profile's cookies; browsers have the identical exposure.
7. **Enrolment with a stolen session.** A stolen dashboard cookie cannot enrol a Hello credential: `enrol-ticket` re-verifies the password (§4.2). The web `register/options` still needs only a session until D2.
8. **The new session-issuing endpoint.** `redeem` is hashed, atomic, rate-limited (`authRateLimit`), audited and bound (§5.6). Offboarding still works: the `DEACTIVATED` gate runs on verify and again on redeem, and removing the Settings row disables the credential.
9. **Session lifetime.** Unchanged. Sessions expire on the box's clock, and each Hello tap is a fresh proof of possession, not a replay of a stored secret.

## Consequences

- **Gains.** Windows Hello on every pairing shape: pinned IP, pinned `.local` and the certified name. It survives heals and re-keys, needs no WebView2 runtime floor, and the shell stores no secret.
- **Costs.** An explicit amendment of ADR-008 and the shell README rule. A new session-issuing endpoint on the box. A coordinated box release plus shell 0.3.0. Four client sign-in shapes (web, the Mac's Keychain replay, mobile bearer, Windows native) raise support cost, and this path is Windows-only.
- **Two Hello credentials on certified boxes.** A person may hold a Stage 1 WebView passkey and a native one. Settings labels both, and the shell prefers native.
- **Plugin passkey managers.** On Windows 11 24H2 and later, a plugin manager (1Password, Bitwarden) may capture the credential instead of the TPM. It still works and is still phishing-resistant, but it is synced rather than "this PC"; Settings shows the backup flags.
- **Orphaned platform credentials.** If Forget's delete fails, or after a factory reset, a credential with no server counterpart stays visible in Windows Settings. Harmless.

## Alternatives rejected

- **Stage 1 alone (WebView passkeys only).** No ADR change and the cheapest, but it cannot reach pinned or IP pairings, which are most 0.2.2 installs. It ships as Stage 1 for certified boxes, not as the answer.
- **A Mac-style password replay (DPAPI password behind `UserConsentVerifier`).** DPAPI without extra entropy is readable by any process running as the same user, and `UserConsentVerifier` is a UI gate, not a cryptographic one (WARP-1418). It puts a password in the shell, the one thing §7 forbids.
- **A `KeyCredentialManager` device key with a bespoke challenge protocol.** The same ADR cost as this design, more effort (about 16 days), a bespoke RSA protocol instead of standard WebAuthn verification, and either the first remote-origin IPC grant (WARP-2908) or a shell-local password screen for enrolment. `windows` 0.61.3 has no `KeyCredentialManager` HWND interop, so the Hello prompt can open behind the app window.
- **The shell mimics a browser against the existing routes.** Still fails on IP pairings, breaks on every heal, forges a browser origin, and needs the shell to hold a session cookie to enrol.
- **`--ignore-certificate-errors`, or any WebAuthn-on-broken-TLS bypass.** Chromium does not re-enable WebAuthn for it, and it is a trust regression.
- **Installing the box's CA in the Windows root store.** A system trust change that breaks the pinned pairing's "nothing installed" property (WARP-2953), and IP rpIDs would still be illegal.
- **Moving every box to its certified name first.** Needs HQ, LAN DNS authority and a re-pair (ADR-058's direction, not a sign-in fix), and air-gapped boxes never qualify.
- **WebView2 password autosave.** No biometric gate, and a silent ADR-008 violation.

## Open questions

- What the Hello dialog displays for the native rpID, and whether a friendlier immutable label is needed (S2 item 3).
- How Windows 11 24H2+ plugin passkey managers behave with platform attachment (bench).
- Whether SSO and SCIM accounts get native enrolment later, through a fresh IdP sign-in in place of the password step. Default: not offered in v1.
- Whether the Mac app adopts the same native relying party through `ASAuthorization` (unverified for this rpID scheme).
