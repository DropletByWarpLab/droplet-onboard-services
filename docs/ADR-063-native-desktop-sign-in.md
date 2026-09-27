# ADR-063: Native desktop sign-in extensions: passkeys and the SSO handoff

- **Status:** Proposed. **Decider:** Romain Jouffret (security review, roadmap §3). Proposed by Stefan Cruceru. This file becomes **Accepted** when Romain approves the PR that lands it and that PR flips this line. It merges only as Accepted, so the pointers it adds to ADR-008 and ADR-060 carry no "proposed" qualifier. It rests on Romain's answers R2, R5 and R6 on [WARP-3223](https://warp-lab.atlassian.net/browse/WARP-3223), which are the roadmap's recommended defaults and stay **provisional until he confirms them in review**; each decision below names the answer it rests on.
- **Date:** 2026-09-26
- **Tickets:** [WARP-3226](https://warp-lab.atlassian.net/browse/WARP-3226) (this file) · epic [WARP-3223](https://warp-lab.atlassian.net/browse/WARP-3223) · gates OBS-5 [WARP-3212](https://warp-lab.atlassian.net/browse/WARP-3212) (native SSO) and OBS-6 [WARP-238](https://warp-lab.atlassian.net/browse/WARP-238) (passkey step-up) · related [WARP-3144](https://warp-lab.atlassian.net/browse/WARP-3144) (passkey user verification), [WARP-3229](https://warp-lab.atlassian.net/browse/WARP-3229) (OBS-2, RP from `Host` only), [WARP-3228](https://warp-lab.atlassian.net/browse/WARP-3228) (OBS-1, one session mint), [WARP-1400](https://warp-lab.atlassian.net/browse/WARP-1400) (durable Nextcloud credential)
- **Builds on:** ADR-062, native per-platform desktop clients (#2444, Proposed), whose row 14 hands passkeys and native SSO to this file; [`ADR-008`](ADR-008-native-mobile-design-system-and-api-contract.md)'s 2026-06-01 reconciliation; [`ADR-013`](ADR-013-builtin-directory-vs-nextcloud.md) (directory login); [`ADR-016`](ADR-016-fleet-sso-provisioning-model.md) (per-box IdP federation).
- **Amends:** [`ADR-008`](ADR-008-native-mobile-design-system-and-api-contract.md) `:325-327` ("WebAuthn is not part of the app login path"), for the native desktop clients. **Supersedes in part:** [`ADR-060`](ADR-060-native-windows-hello-relying-party.md)'s native relying party, for Windows (see [Reconciliation with ADR-060](#reconciliation-with-adr-060)). Both get a one-line pointer in this PR.
- **Number:** claimed here, in `docs/`, on `stage`. Checked 2026-09-26: on `stage` (`3029b383b`) the only `docs/ADR-*` file above ADR-056 is ADR-060; across every `origin` ref the only other one is ADR-062 on #2444; the open PRs' file lists hold no other ADR file; an org-wide code search finds `ADR-063` nowhere. ADR-061 is the Linux client's claim ([WARP-3203](https://warp-lab.atlassian.net/browse/WARP-3203)). A claimed number reserves nothing: re-check before merge.

> **What this file is.** The decision on the two sign-in paths the native desktop clients add after password + TOTP: passkeys through Windows' `webauthn.dll`, and SSO through a box-local RFC 8252 handoff. It builds nothing. Line references are to `stage` at `3029b383b`. "The roadmap" is *Roadmap: landing and finishing the native WinUI 3 Droplet client* (2026-09-25), the plan of record on WARP-3223. Its outline for this file is §5.2, drafted as "ADR-061" before that number went to the Linux client. "The branch" is `feat/native-windows-auth` (backed up on `origin`, never merged), which the roadmap splits into OBS-1 to OBS-7.

## Context

- **The native client signs in by itself.** ADR-062 makes the Windows client a native C# app that calls `/api/*` with a Bearer token (row 2): password + TOTP in M1, then Hello replay in M2 (row 5). ADR-008 still says "WebAuthn is not part of the app login path" (`ADR-008:325-327`), and no route lets an app finish an SSO sign-in.
- **SSO accounts cannot use the native client at all.** An SSO- or SCIM-provisioned account has no local password (WARP-2858). The SSO flow ends with session cookies set on a browser (`routes/sso.ts:530-576`), which a native app cannot read, and ADR-062 row 3 allows no web view.
- **The passkey routes already serve native callers.** `/api/auth/webauthn/{register,authenticate}/{options,verify}` exist, and `authenticate/verify` returns tokens with `?return=body` behind the native-only gate (`routes/webauthn.ts:216-239`, WARP-582). Since #2436 (WARP-3193):
  - every ceremony requires user verification (`:297`, `:353`, `:553`, `:607`);
  - registration needs a credential step-up (`:258`, `:308`);
  - a passkey sign-in by an account with TOTP must also pass TOTP (`:676-706`).

  WARP-3144 is still open in Jira as the ticket of record for user verification.
- **The RP is not derived from `Host` alone.** `deriveWebAuthnRp` builds the rpID and origin from the request and prefers `X-Forwarded-Host` (`services/webauthn-config.ts:50-61`). The gateway never sets that header; it sends `Host $host` (`docker/nginx/nginx.conf:249-256`), so the value can only come from the client. IP hosts are refused (`webauthn-config.ts:94-97`, `routes/webauthn.ts:113-125`).
- **ADR-060 designed a different native passkey** for the Tauri shell: a per-box rpID `<label>.native.droplet-us.com`, a `WebAuthnClientKind` column, native routes and an SPKI channel check, all conditional on its spike S2, which has not run. ADR-062 retires the shell and hands that design to this file to adopt or decline.
- **The SSO box half is written.** The branch's commits d37a457 and a0fc280 add `POST /api/sso/oidc/native/begin` and `POST /api/sso/oidc/native/token` with PKCE S256 and a hashed one-time handoff code. The roadmap's review (§1b, row 41) found three gaps:
  - IdP errors never reach the app;
  - there is no RFC 8252 §8.6 consent step;
  - redemption is recorded only in the log, not the activity log.
- **Passkey and SSO sessions have no Files.** Only a password sign-in mints the person's Nextcloud app password (WARP-1400). Without it, `/api/files/*` answers `401 "Nextcloud session is missing"` (`routes/files.ts:205-210`, `:903-906`).

## Decision

### Passkeys through `webauthn.dll`

| # | Decision | Rests on |
|---|---|---|
| P1 | **The RP comes from `Host` only.** The box derives the rpID (the host name, no port) and the expected origin (`https://<Host>`) from the `Host` header, never from `X-Forwarded-Host`. The one exception is development, where the dashboard's dev proxy sets that header. OBS-2 (WARP-3229) builds this for every client, and the native passkey client does not ship before it. ADR-060 §1's per-box native rpID is **not adopted** ([below](#reconciliation-with-adr-060)) | R5 |
| P2 | **The dashboard's routes, unchanged.** The native client enrols through `register/*` (Bearer, behind #2436's credential step-up) and signs in through `authenticate/*`, calling `authenticate/verify` with `?return=body`. There are no native-only routes, tables or columns. A passkey is bound to the name it was made on: one made in a browser on that name also works in the app, and the other way round | R2 |
| P3 | **What the client checks.** Every call runs over the client's verified channel (ADR-062 row 4: the pairing's pin or the bundled roots), on the address the pairing uses after the FQDN redirect (ADR-062 row 2). The client refuses options whose `rpId` is not exactly the lower-case host name of that address, and options that do not require user verification. It never runs a ceremony for an IP address. It builds `clientDataJSON` itself (`type`, the challenge verbatim, `origin: "https://<host>"` exactly as the box derives it, `crossOrigin: false`). It calls `WebAuthNAuthenticatorMakeCredential` / `GetAssertion` with that `rpId`, user verification **required**, and its main window's `HWND`. It refuses to send a response whose authenticator data lacks the UV flag. It stores nothing about passkeys, and Forget deletes no platform credential: on a named address that credential is also the browser's | – |
| P4 | **A passkey is a primary credential only if user verification is required** (WARP-3144). It may replace the password because the PIN or biometric is checked on every ceremony, which `stage` enforces since #2436. If a passkey route ever stops requiring user verification, the native client stops offering passkey sign-in (P3). This file keeps the second-factor gate #2436 put after a passkey (`routes/webauthn.ts:676-706`). An account with TOTP sends its code with the assertion. The client handles `TOTP_REQUIRED` as on the password path, and re-runs the ceremony with the code because the challenge is spent. Whether a verified passkey should satisfy that gate on its own (the branch's "W1") is [question 1](#open-questions) | R6 |
| P5 | **Step-up mints no new session.** A route may answer `mfa_required` or `mfa_stale` (`middleware/require-recent-mfa.ts:29-58`). The client then proves presence with a passkey against a Bearer-authenticated step-up pair (OBS-6, WARP-238). **The assertion must come from the caller's own passkey.** The step-up challenge is minted for `req.user.id` and this `sid`, and verify refuses it for any other user or `sid`. Verify also refuses any credential whose `userId` is not `req.user.id`, before checking the signature. The options' `allowCredentials` lists only that person's credentials on this rpID, but it is advisory only: the authenticator's response can name any credential. So OBS-6 does not reuse `authenticate/verify`'s lookup as it stands. There, `consumeChallenge` checks only the ceremony type (`services/webauthn-challenge.service.ts:71-83`), and the credential is found by its id alone, with the user taken from it (`routes/webauthn.ts:583-598`, `:632`). Reused literally, anyone holding the Bearer token, a stolen one for example, could stamp `lastMfaAt` on that session with any passkey on the box, including one on their own account, and pass every gate that [question 1](#open-questions) lists. The challenge row stores a `userId` but no `sid` today (`prisma/schema.prisma:3394-3414`), so OBS-6 adds the `sid` binding. Verify requires user verification and runs `authenticate/verify`'s counter and `DEACTIVATED` checks. Success returns one new access token for the **same** `sid`, stamped `lastMfaAt`, and writes an activity row. It creates no session row, no refresh token and, for a Bearer caller, no cookie, so the 5-session cap and the idle and absolute clocks are untouched. Today the only way to get a fresh stamp is a new sign-in, which mints a second session | R2, R6 |
| P6 | **ADR-008 `:325-327` is amended.** For the native desktop clients, WebAuthn is part of the app login path under P1-P5. The iOS and Android apps are unchanged | – |

### SSO through an RFC 8252 handoff

| # | Decision | Rests on |
|---|---|---|
| S1 | **Two legs, one IdP client.** The box stays the confidential OIDC client, and the IdP still redirects to `https://<box>/api/sso/oidc/callback`. ADR-016's redirect URI (`ADR-016:23`) and every IdP registration are therefore **unchanged**. The app runs a second, box-local leg, in this order: `POST /api/sso/oidc/native/begin`; the **system browser** (never a web view: RFC 8252 §8.12, ADR-062 row 3); the IdP; the box's callback; the consent page (S5); a redirect to the app carrying a handoff code; `POST /api/sso/oidc/native/token`. The state row carries an explicit flow kind (`BROWSER` or `NATIVE`), and the callback reads its branch from it, never from a null column | R5 |
| S2 | **The redirect allow-list is exactly the one in a0fc280** (`LOOPBACK_REDIRECT_RE` and `APP_SCHEME_REDIRECT` in `routes/sso.ts`). A `redirectUri` is one of: `http://127.0.0.1:<port>/<path>`; `http://[::1]:<port>/<path>`; or exactly `droplet://sso/callback`. The port is 1024-65535 with no leading zeros, the path is unreserved characters and `/`, and there is no user info, query or fragment. The name `localhost` is refused (RFC 8252 §8.3). The Windows client uses loopback on a random port and path (roadmap WIN-27) | – |
| S3 | **PKCE S256 only.** `begin` takes a 43-character base64url challenge. `token` takes a verifier of 43-128 unreserved characters and compares it in constant time. `plain` is refused | – |
| S4 | **The handoff code is 60 s, single-use and hashed.** It is 32 random bytes, base64url, and the box keeps only its SHA-256. It is valid for **60 seconds** and **once**: the first redemption attempt claims it atomically, whatever the outcome. `/native/token` refuses a browser context (the WARP-582 markers) before the claim, and re-reads the person (`DEACTIVATED` is refused). It answers exactly the `/auth/login?return=body` body, with `Cache-Control: no-store` and no cookie. The session comes from the shared session mint (OBS-1, WARP-3228) with the normal limits and no `lastMfaAt` | – |
| S5 | **Consent interstitial for `NATIVE` flows** (RFC 8252 §8.6). Any program on the PC can call `begin` with its own loopback redirect and PKCE pair, and an IdP with a live session may finish without a click. So after the IdP leg the callback never redirects straight to the app. It shows a box page in the system browser that names the person, the box and "the Droplet app on this computer", with **Continue** and **Cancel**. Only Continue parks the handoff code and redirects: it is a POST carrying a single-use value bound to the state row, and the page cannot be framed. Cancel relays `access_denied`. The page lives no longer than the state row (10 minutes, `services/sso-login-state.service.ts:22`) | R5 |
| S6 | **IdP and box errors are relayed to the app.** Once the callback has matched a `NATIVE` state row, every outcome goes to that row's redirect URI as `?error=<code>&state=<state>`, with no `code`. That covers an IdP error or cancellation (today a missing `code` is a browser-side 400, `routes/sso.ts:436-440`), a failed ID-token check, an unverified email, a Google domain that is not allowed, a deactivated account, #2436's `TOTP_REQUIRED` refusal (`:500-523`) and Cancel. The codes are a closed set, documented in `mobile-api-contract.md` by OBS-5, and the IdP's `error_description` is never forwarded. An unknown or expired state has no redirect to use, so its error stays in the browser, and the app gives up when the state's 10 minutes run out | R5 |
| S7 | **The second factor is never weaker than in the browser.** An account the browser callback refuses with `TOTP_REQUIRED` gets the same refusal, relayed as `error=totp_required`, and signs in with password + code instead | – |
| S8 | **Redemption is audited.** The activity log, not only `logger.warn`, records: each handoff the person approved; each redemption that opens a session ("signed in via <provider> SSO (Droplet app)", with the person as the actor); and each refused redemption (an unknown, expired or reused code, a verifier mismatch, an unavailable account, a browser context), at warn with an anonymous actor. No row carries the code, the verifier, a token or a claim | R5 |

### The Nextcloud credential is deferred to WARP-1400

Passkey and SSO sessions carry no Nextcloud app password. Making one durable for them is [WARP-1400](https://warp-lab.atlassian.net/browse/WARP-1400), which needs its own security sign-off; this file does not decide it. The branch's paired-device fallback (e653576) is **not** adopted (roadmap OBS-7, R5). Until WARP-1400 lands, such a session has Files only while an earlier password sign-in's token survives in Redis. Otherwise the native client makes its one refresh-and-retry (ADR-008 §3, step 5), then shows Files as needing a password sign-in on this box. It never signs the person out over it.

## Reconciliation with ADR-060

ADR-062 superseded ADR-060's Tauri-shell mechanics. It handed the native relying party (§1, §2, §4 steps 3, 5 and 6, §6) to this file. This file **declines** it for the native client:

- **Its purpose is met another way.** It existed to give pinned and IP pairings Windows Hello from a shell that must never hold a secret. The native client holds its own tokens, and Hello replay (ADR-062 row 5) gives Windows Hello on every pairing shape with no box change.
- **It needs new box surface; P2 needs none.** It needs a new singleton, a new column, a handoff table, four native routes, a reserved HQ name and a channel check, all still behind spike S2. P2 adds nothing to the box for passkey sign-in.
- **It splits each person's passkeys in two per box**, a web one and a native one. P2 keeps one set per name.
- **Its phishing argument protects browsers, not a native caller.** No web page can ask for the native rpID, but ADR-060's own security analysis (item 6) records that Windows does not bind an rpID to the calling binary. For a native client the protection is the verified channel plus the rpID check (P3), under either design.

**What declining costs.**

- There is no passkey on an IP pairing; the box refuses IP rpIDs anyway.
- A passkey stops working when the pairing moves to another name, for example from `.local` to the certified name. The person signs in with the password or Hello replay and enrols again.
- If Hello replay's key spike (roadmap S11) fails, IP pairings have no Windows Hello at all. ADR-060's design is then the documented way back, through an amendment to this file.

**Superseded for Windows once this file is Accepted:** D1's mechanism (its answer, Windows Hello on pinned and IP pairings, is delivered by Hello replay), §1, §2, §4 steps 3, 5 and 6, §6, the rest of Rollout (a)-(b), Gate items 1-3, and the security analysis. With ADR-062's part, nothing of ADR-060 is built, and spike S2 need not run. **Still standing:** D2 (built by #2436), the context analysis, and "What does not change" for the web routes.

## Consequences

- **Positive**
  - SSO- and SCIM-provisioned people can use the native client. Today they cannot sign in to it at all.
  - One passkey per box name serves both the dashboard and the app, and passkey sign-in needs no new box routes, tables or columns.
  - A step-up no longer costs a second session.
  - The SSO box half serves any native client that can open the system browser and a loopback listener, including the Linux client (ADR-061). The IdP side is untouched.
- **Negative**
  - There are no passkeys on IP pairings, and a passkey is tied to one name ([above](#reconciliation-with-adr-060)).
  - Two new unauthenticated endpoints, `begin` and `token` (one of them session-issuing), plus the consent POST. All three sit behind `authRateLimit`.
  - Every native SSO sign-in takes one more click (Continue).
  - Another local program can claim `droplet://sso/callback`. PKCE makes any code it catches useless, and the Windows client uses loopback. The scheme is also not the reverse-domain form RFC 8252 §7.1 asks for ([question 2](#open-questions)).
  - A program running as the same user can start either ceremony: Windows does not bind an rpID to the calling binary, and anyone can call `begin`. It still has to get past the Hello prompt, or the IdP and the consent page. ADR-060 recorded the same exposure (security analysis, item 6).
  - An account with TOTP types its code after a passkey (P4) and cannot use native SSO (S7), unless question 1 or 3 is answered otherwise.
  - Passkey and SSO sessions have no Files until WARP-1400.

## Alternatives considered

- **Adopt ADR-060's native relying party.** Declined ([above](#reconciliation-with-adr-060)).
- **Passkeys through the system browser**, with the dashboard running the ceremony and handing the session to the app like SSO. It has the same one-name limit as P1, adds a leg, and puts a browser round trip in every sign-in.
- **The app as the IdP's OIDC client.** Each customer would register a public native client at their IdP on top of ADR-016's per-box registration, and the box would have to trust tokens it did not obtain. ADR-016 keeps the box as the only client.
- **An embedded web view for the IdP page.** Forbidden by RFC 8252 §8.12 and by ADR-062 row 3.
- **The OAuth device grant (RFC 8628) for the second leg.** It is meant for devices without a browser. On a desktop it adds a code to type and gives nothing loopback does not.
- **The branch's paired-device Nextcloud fallback** (e653576). It reuses one client's credential for another; it is parked for WARP-1400.

## What this gates

- **OBS-5 (WARP-3212)** merges only after this file is Accepted, and only with S1-S8. The roadmap's before-merge fixes (a), (b) and (c) are S6, S8 and S5. OBS-5 also adds the SSO section of `mobile-api-contract.md` and the `lib/browser-context.ts` comment.
- **OBS-6 (WARP-238)** merges only after this file is Accepted and question 1 is answered. P5 is its scope. It also adds the passkey section of `mobile-api-contract.md`.
- **The clients.**
  - WIN-27 (native SSO, optional in v1) merges only after OBS-5 is merged and promoted to `main` (roadmap G12).
  - The passkey client (v1.1, roadmap Phase 6) waits for OBS-2 and for this file to be Accepted. Before it merges, a bench on Windows 10 22H2 and Windows 11 shows four things. First, `webauthn.dll`, called from the unpackaged app, makes and uses a credential with the paired host name as `rpId` (both the certified name and a `.local` name), user verification required and a caller-built `clientDataJSON`. Second, the result verifies against the unchanged routes. Third, the Hello prompt opens over the app window. Fourth, a Windows 11 plugin passkey manager behaves.
- **Not gated:** OBS-2 stands on its own as a security fix, and OBS-1 is a behaviour-preserving refactor.

## Open questions

1. **Is a verified passkey assertion a recent MFA?** The proposal is: yes for a step-up on an existing session (P5), and no change at sign-in (P4), where #2436's gate stays. The step-up case is different because that session already passed every factor the account has, and the assertion is a fresh PIN or biometric check with an authenticator the person enrolled. If the answer is no for step-up too, OBS-6 has nothing to build. The client then signs in again for a step-up, as the dashboard does today, at the cost of a second session.

   **What a yes opens.** On `stage`, only `require-recent-mfa` reads `lastMfaAt`, so a step-up stamp passes every gate built on it:
   - `POST /api/admin/device-identity/reseal` (`routes/admin-device-identity.ts:80-83`) and `POST /api/admin/files/:id/reindex` (`routes/admin-files.ts:73-76`), both for admins only, with a 60 s window;
   - for an account with confirmed TOTP, #2436's credential step-up, with a 300 s window (`middleware/require-credential-step-up.ts:59-65`). It guards passkey registration (`routes/webauthn.ts:258`, `:308`) and `POST /auth/totp/verify` (`routes/auth.ts:2586`). For an account without TOTP, that gate does not read the stamp;
   - extension promote, only if WARP-2923 turns its gate on (`routes/extensions.ts:89`, off today).

   A stamp from another person's passkey would open all of these, which is why P5 binds the challenge and the credential to the caller.

2. **Keep `droplet://sso/callback`?** The Windows client uses loopback. RFC 8252 §7.1 asks for private-use schemes in reverse-domain form (for example `ai.warp-lab.droplet:/sso`), and `droplet://` is not. The proposed default is the list as built in a0fc280, because `droplet://` is the scheme the installer registers (ADR-062 row 10) and PKCE protects the code. Dropping the entry later is a one-line change.
3. **A second factor inside the native SSO leg.** `/native/token` could take the TOTP code. That would let TOTP accounts use native SSO, and would close #2436's open residual (IdP-provisioned accounts with TOTP are not gated) for native flows. It is not proposed here, because it changes #2436's policy.

## Follow-ups

- The handbook's ADR register gets a row for this file, next to ADR-062's (WARP-3224).
- `docs/mobile-api-contract.md`: the SSO section with OBS-5, and the passkey section with OBS-6 (roadmap §5.4). The widening for native clients is OBS-3's.
- WARP-3144 reads To Do in Jira, although #2436 built its fix on `stage`. Closing it is left to its owner.
