# ADR-062: Native per-platform desktop clients

- **Status:** Accepted, 2026-09-30, by Stefan Cruceru. **Deciders:** Stefan Cruceru and Romain Jouffret. Stefan decided the direction on 2026-09-26: the Windows client is the native C# / WinUI 3 client, built along the 2026-09-25 roadmap and the tickets already open under [WARP-3223](https://warp-lab.atlassian.net/browse/WARP-3223) (recorded there and on [WARP-3211](https://warp-lab.atlassian.net/browse/WARP-3211)). Stefan accepted this file on 2026-09-30 and merged it ahead of Romain's sign-off, so the notes it adds to other ADRs carry no "proposed" qualifier. Romain's answers R1-R16 on WARP-3223 are the roadmap's recommended defaults and stay **provisional until he confirms them**; every row below that rests on one names it, and a changed answer amends that row.
- **Date:** 2026-09-26
- **Tickets:** [WARP-3211](https://warp-lab.atlassian.net/browse/WARP-3211) (this file) · epic [WARP-3223](https://warp-lab.atlassian.net/browse/WARP-3223) · precedent [WARP-3030](https://warp-lab.atlassian.net/browse/WARP-3030) (DropletAgent, native macOS) · sign-in sibling [WARP-3226](https://warp-lab.atlassian.net/browse/WARP-3226) (ADR-063)
- **Supersedes in part:** [`ADR-009`](ADR-009-canonical-system-architecture.md) (the Tauri lock and the Mac Catalyst rows) and [`ADR-060`](ADR-060-native-windows-hello-relying-party.md) (the Tauri-shell mechanics; see [Reconciliation with ADR-060](#reconciliation-with-adr-060)).
- **Amends:** [`ADR-008`](ADR-008-native-mobile-design-system-and-api-contract.md), [`ADR-014`](ADR-014-llm-client-dispatched-actions.md) and [`ADR-056`](ADR-056-agentic-extensibility.md), in this PR. [`ADR-037`](ADR-037-overlay-tunnel-key-custody.md) and [`ADR-045`](ADR-045-client-app-distribution.md) are amended by their own PRs (see [Supersedes and amends](#supersedes-and-amends)).
- **Siblings:** ADR-061, the native Linux client (GTK 4 / libadwaita, no web view), claimed by [WARP-3203](https://warp-lab.atlassian.net/browse/WARP-3203) and cited by `droplet-linux` #1; filed by #2514. ADR-063, native desktop sign-in extensions (passkey and native SSO), [WARP-3226](https://warp-lab.atlassian.net/browse/WARP-3226), filed by #2446.
- **Number:** claimed here, in `docs/`, on `stage`. Checked 2026-09-26 across all 689 refs on `origin` (`stage` and every open PR head): the only `docs/ADR-*` file above ADR-056 is ADR-060 (#2395). No ref carries an ADR-061, -062 or -063 file. An org-wide code search finds `ADR-061` only in `droplet-linux` and `ADR-062` / `ADR-063` nowhere. The handbook register runs to ADR-059. So 061 is WARP-3203's claim, 062 is the next free number, and 063 is kept for WARP-3226. Re-checked 2026-09-30 before merge: on `stage` the only `docs/ADR-*` file above ADR-056 is still ADR-060; the open PRs add ADR-061 (#2514, WARP-3203) and ADR-063 (#2446) and nothing else in this range.

> **What this file is.** The platform decision for Droplet's desktop clients, and the list of what it changes in other ADRs. It builds nothing. Line references are to `stage` at `3029b383b`. "The roadmap" is *Roadmap: landing and finishing the native WinUI 3 Droplet client* (2026-09-25), the plan of record on WARP-3223. Its outline for this file is §5.1, drafted as "ADR-060" before `stage` took that number.

## Context

- **ADR-009 locked Windows to Tauri without comparing the alternatives.** "Do not pick an Electron/WPF/WinUI 3 stack for Windows. Tauri is locked" (`ADR-009:217-220`). Its only reasons were reusing the dashboard build, a small exe, and the shell extras (`:174-176`). Its pointer to "a future ADR-006" (`:189-190`, `:219`) is dead: `ADR-006` is an unrelated file.
- **Tauri never shipped.** `droplet-windows` has 0 tags and 0 releases (checked 2026-09-26; `ADR-045:32-33` says the same). There is no installed base, so the switch needs no data migration: the native client starts from a clean slate.
- **ADR-008 already points the other way.** Its 2026-06-01 reconciliation makes native clients sign in themselves (`?return=body`, `TOTP_REQUIRED`) and says "Android + Windows to follow" (`ADR-008:319-327`). The Tauri shell instead hosts the dashboard's cookie login in WebView2 and never holds a Bearer, so its own background calls (tunnel status, the push bridge) have no session.
- **The Mac and Linux went native first.** DropletAgent (WARP-3030, 2026-09-23) is a native SwiftUI macOS app that replaces the dashboard on the Mac, not Mac Catalyst, which contradicts `ADR-009:107` and `:213-215` without an ADR. `droplet-linux` is a native GTK 4 client with no web view (ADR-061, WARP-3203). DropletAgent is the direct precedent for a native Windows client.
- **The port is bounded.** The Tauri shell's logic worth keeping (trust, pairing, discovery, recovery, tray, the vpnd client, installer semantics) is estimated at 5.5-6.5k lines of non-test C# plus 3.5-4k lines of tests once ported, and its roughly 245 Rust tests become the spec. The skeleton and the first slices are already on `droplet-windows` (`feat/native-windows-client`, `feat/native-windows-signin`).

## Decision

**Droplet's desktop clients are native per platform.** On Windows that is a C# / WinUI 3 client in `droplet-windows`, replacing the Tauri shell (macOS: row 11; Linux: ADR-061):

| # | Topic | Decision | Rests on (WARP-3223) |
|---|---|---|---|
| 1 | Stack | C# on .NET 10 LTS, WinUI 3 on Windows App SDK 2.x, unpackaged. .NET is self-contained. The Windows App SDK is self-contained, or framework-dependent if the toast spike (WindowsAppSDK#6774, WARP-3242) needs it. No trimming, Native AOT or single-file publish. `StartupHookSupport=false`. A per-machine MSI installs into `%ProgramFiles%\Droplet`. x64 only, on Windows 10 22H2+ and Windows 11; the installer refuses ARM64 | Stefan: S1, S7 |
| 2 | UI and API | Every screen is native and calls `/api/*` with a Bearer token, per ADR-008's 2026-06-01 reconciliation: `POST /api/auth/login?return=body`, the `TOTP_REQUIRED` challenge, rotating refresh with the token in the body. No cookies and no `Origin` header. When a friendly name 307-redirects to the box's FQDN, the client follows the redirect itself and then stores and uses the FQDN (.NET drops `Authorization` on a cross-host redirect) | Romain: R2 |
| 3 | Embedded web | None in v1: no WebView2 anywhere. Help and every section that is not native yet hand off to the system browser, and only when the box presented a public certificate chain **and** its FQDN resolves locally to a live box. Otherwise the app says, in finished copy, that the section needs the web dashboard, which this PC cannot open yet | Romain: R7 |
| 4 | Trust | Never trust-on-first-use. The pinned-pairing rules of WARP-2953 (`droplet-windows` `trust.rs`, ported to C# with its tests) plus bundled Mozilla roots. **Recorded divergence:** DropletAgent trusts LAN hosts on first use; Windows refuses a typed address that has neither a pin nor a public chain, and explains why. Windows keeps its model because it is implemented and tested, and because it vouches for the enrolment of a machine-wide SYSTEM tunnel | - |
| 5 | Secrets | Tokens in DPAPI (CurrentUser) under `%LOCALAPPDATA%\ai.warp-lab.droplet`, written atomically; only the primary instance refreshes. **Hello replay (M2):** after a password sign-in the person may keep the password for Windows Hello sign-in. It is encrypted under a key derived from a `KeyCredentialManager` (TPM-backed Windows Hello) signature, so decrypting it takes a Hello gesture. If the key-derivation spike (roadmap S11) shows the signature is not deterministic, no password is stored and the person types it. DPAPI plus `UserConsentVerifier` alone is **rejected**: it is a UI gate, not a cryptographic one. **Residual risk:** any process running as the same user can ask for a Hello prompt, but it cannot decrypt the password without one | Romain: R3 |
| 6 | Session policy | The box is unchanged: 30 min idle, 12 h absolute, 5 sessions per user (`config.ts:554-558`); no desktop session class leaves AAL2. Every Bearer request and every WebSocket upgrade slides the idle clock (`middleware/auth.ts:348`, `:416`; `session.service.ts:227-235`, `:299-304`) and refresh does not (`routes/auth.ts:1551`), so the client sets these rules: the tray takes tunnel state from vpnd only; the watchdog calls public health with no Bearer; `GET /api/vpn/status` runs only at user-visible moments; while the window is hidden, the WebSocket re-upgrades at most once per 30 min; sign-out closes the WebSocket and clears toasts | Romain: R4 |
| 7 | vpnd | Kept, reached over its named pipe. The pipe protocol is frozen at v1 in `droplet-vpnd/PROTOCOL.md` (written with the vpnd protocol PR). Client identity is Authenticode + the install directory + a pinned publisher subject + an exact image allow-list, required before the first signed MSI. The details, and the shared-PC policy (the tunnel is a machine resource), go into ADR-037 through its own amendment | Stefan: S8 · Romain: R15 |
| 8 | Updates and telemetry | Updates are served by the paired box through the ADR-045 catalog. The client checks the SHA-256 over its pinned channel and runs WinVerifyTrust with the publisher pin. **No Ed25519** (forbidden on-box, `app-downloads/catalog.ts:33`). One UAC prompt per update in v1. No internet update checks and no telemetry; a local log plus a redacted "Save diagnostics" export | Romain: R10 |
| 9 | Toasts | A toast never carries content (no message text, title or file name), for every box notification category and for downloads | Romain: R13 |
| 10 | Invariants | The bundle id `ai.warp-lab.droplet`; `droplet://` registered in HKLM by the installer; the install directory `%ProgramFiles%\Droplet`; the repo name `droplet-windows` | Stefan: S12 |
| 11 | macOS | The native SwiftUI DropletAgent (WARP-3030). Mac Catalyst is abandoned | - |
| 12 | Cross-client rules | DropletAgent's cross-cutting rules are adopted by reference, except trust (row 4): an offline screen instead of sign-in when the box is unreachable; a `/me` 5xx never signs the person out; bootstrap runs once per app; a pair link acts only when no server is saved; no `Origin` header; tests use isolated hosts only | - |
| 13 | Models and nav | API models are hand-written, source-generated records, each citing its route as `file:line`. OpenAPI stays deferred. **Trigger (proposed default, Romain to confirm):** the first contract drift that reaches a shipped native client, meaning a route a client uses changes shape without the matching `docs/mobile-api-contract.md` edit in the same PR. Navigation follows `stage`'s WARP-2967 grouping, narrowed by department (ADR-059); gated items are hidden | Romain: R8, R9 |
| 14 | Out of scope | Passkey sign-in through `webauthn.dll` and native SSO: ADR-063 (WARP-3226). The ADR-014 tool host is out of v1; the transport a desktop client uses to reach it gets its own ADR | Romain: R1, R12 |

Sign-in therefore arrives in this order: password + TOTP + recovery code, with a forced password change held in memory only (M1); Hello replay (M2); passkeys only after [WARP-3144](https://warp-lab.atlassian.net/browse/WARP-3144) and ADR-063; native SSO in v1 only if its box half is merged and promoted in time (Romain: R2).

## Consequences

- **Positive**
  - One native model across platforms: every client renders its own screens against `/api` with a Bearer token.
  - Calls outside a web page finally carry a Bearer: `GET /api/vpn/status` and the live-events WebSocket work, which the Tauri shell's own calls could not.
  - No WebView2 runtime to ship or patch, and no web-view cookie state to leak.
- **Negative**
  - C# is a sixth language for the team (after TypeScript, Swift, Kotlin, Rust and Python).
  - We own monthly patching of the self-contained .NET runtime.
  - Each update needs an admin UAC prompt in v1.
  - Toasts are at risk from WindowsAppSDK#6774 in an unpackaged app until the toast spike (WARP-3242) clears it.
  - A Windows App SDK major version arrives roughly every 6 months.
  - Help and web editing are unavailable on self-signed boxes, because the browser hand-off needs a public chain (row 3).
  - WARP-2175's shared Rust desktop core goes away.

## Alternatives considered

- **Keep Tauri.** It reuses the dashboard, but every screen stays the web dashboard in WebView2: sign-in is a cookie flow the shell cannot see, background calls carry no Bearer, and passkeys fail on pinned and IP pairings (ADR-060's context). It never shipped, so leaving it costs no installed base.
- **WPF on .NET 10.** The most mature option, with the same standard library. It looks and integrates less like current Windows and has the same packaging and tray gaps.
- **A Rust UI toolkit** (Slint, egui, iced). It keeps the shell's Rust logic, but these toolkits draw their own widgets instead of Windows controls, and there is no production Rust binding for WinUI / XAML. That is not native.
- **A C# UI over a Rust core through FFI.** It avoids porting trust, discovery and overlay code, at the cost of two toolchains and an FFI surface to maintain. The logic to port is bounded and ports with its tests.

A residual WebView2 for Help and the Collabora editor was also weighed; it is not in v1 (row 3).

## Reconciliation with ADR-060

ADR-060 (Accepted, conditional on its own spike S2) decided that pinned and IP pairings get Windows Hello through a native `webauthn.dll` relying party **in the Tauri shell**, with the WebView2-hosted dashboard doing enrolment and holding the session. This file retires that shell (the Tauri tree is deleted under [WARP-3233](https://warp-lab.atlassian.net/browse/WARP-3233)), and the native client has no WebView and holds its own tokens (rows 2, 3, 5).

**Superseded for Windows: the Tauri-shell mechanics.**

- §3: the ceremony run by the Tauri shell through the Rust `windows` crate. The shell-side relying party is not built.
- §4 steps 1, 2 and 4: the `window.__dropletShell.features.nativeHello` descriptor, the in-WebView "Set up Windows Hello" button, the `ENROL_TICKET` carried from the dashboard to the shell, and the `/_shell/hello/enrol` navigation intercept. A native client already holds its own Bearer, so nothing has to be carried out of a web view.
- §5: the `/_shell/hello/sign-in` intercept, the verify-returns-only-a-code handoff, the WebView redeeming that code through `NavigateWithWebResourceRequest`, the cookie-setting `redeem` route, the `SESSION_HANDOFF` rows and the `Sec-Fetch-*` binding. A native client has no web session to hand anything to.
- §7, "the shell never holds a password or a session token". The native client holds its own tokens in DPAPI, as iOS and Android hold theirs in the Keychain and EncryptedSharedPreferences (ADR-008), and in M2 a Hello-replay password under row 5's key.
- Rollout: (c) the dashboard's native adapter and `/_shell/hello/*` page; (d) and (e), shell 0.3.0 (v0.3.0 is now the native client's internal release); and, inside (a) and (b), everything that serves the handoff (`AuthHandoff`, `redeem`).
- D3 (hide the in-WebView passkey button in the Windows app): moot, since there is no WebView.
- The Gate's items 4 and 5 (WebView2 `Sec-Fetch-*` values and cookie persistence on an `ALWAYS_ALLOW` origin): moot. Items 1-3 (`webauthn.dll` accepts the rpID, `@simplewebauthn/server` verifies it, the Hello dialog copy) become evidence for ADR-063 if it adopts the native rpID.

**Still standing.**

- **D2** (user verification required on the web passkey routes, and a step-up before web passkey registration): client-independent. `stage` now requires UV (`routes/webauthn.ts:297`, `:353`, `:553`, `:607`) and a credential step-up on `register/options` (`:258`), both from #2436 (WARP-3193); WARP-3144 remains the ticket of record.
- **The context analysis:** the dashboard's passkeys cannot reach pinned or IP pairings (Chromium's TLS-error state, IP rpIDs refused, a request-derived rpID that breaks on every address heal). That is why no Windows client routes a passkey through a browser.
- **What ADR-060 left unchanged:** the web routes, the request-derived rpID for them, and the Mac, iOS and Android apps.
- **The native relying party itself** — §1 (the per-box rpID `<label>.native.droplet-us.com`), §2 (the `WebAuthnClientKind` column), §4 steps 3, 5 and 6 (local accounts only; native register options and verify), §6 (the SPKI channel check), the matching parts of Rollout (a) and (b), and the security analysis — is neither adopted nor rejected here. It is input to ADR-063, which decides the native passkey design and must adopt it or say why not. ADR-063's outline currently reads "RP ID comes from Host only", the opposite of §1's rule.
- **ADR-060's rejection of a DPAPI + `UserConsentVerifier` password replay** stands; row 5 rejects it too. Row 5's scheme is different: the key is derived from a TPM-backed Hello signature on the PC and nothing new crosses the wire. ADR-060's rejected `KeyCredentialManager` alternative was a device key with a bespoke challenge protocol verified by the box.

**Windows Hello on the native client** is therefore Hello replay in M2 (row 5; no box change), then passkeys through ADR-063 once WARP-3144 is settled. Until ADR-063 is Accepted, ADR-008's "WebAuthn is not part of the app login path" (`ADR-008:327`) stands for the native desktop clients, and the exception ADR-060 wrote under it (`:329`) applies to the Tauri shell only.

## Supersedes and amends

Lines are at `stage` `3029b383b`, before this PR's edits.

| Document | Lines | Change | Lands in |
|---|---|---|---|
| ADR-009 | `:108`, `:174-176`, `:200`, `:217-220` (Tauri lock) | Superseded | This PR (notes) |
| ADR-009 | `:107`, `:171-173`, `:199`, `:213-215` (Catalyst) | Superseded | This PR (notes) |
| ADR-009 | `:186-190` (dead ADR-006 pointer) | Fixed | This PR |
| ADR-008 | `:306-327` | Adopted for Windows | This PR |
| ADR-008 | `:1`, `:34-37`, `:299-300` | Scope widened to the native desktop clients | This PR |
| ADR-008 | `:165-167` | DPAPI row added | This PR |
| ADR-008 | `:56-68` | WARP-3023 pointer added | This PR |
| ADR-008 | `:145-146` | No note needed: the WARP-3038 bug (the code preferred the cookie) was fixed on `stage` by #2521, and the Bearer now wins (`middleware/auth.ts:231`) | #2521 |
| ADR-008 | `:325-327` (WebAuthn rule), `:329` (ADR-060 exception) | For native desktop clients, changes only through ADR-063 | This PR |
| ADR-014 | `:25`, `:102` | Stack-neutral wording; transport decided later | This PR |
| ADR-056 | `:18`, `:30`, `:31`, `:34`, `:66-80`, `:102`, `:110` | Wording only | This PR |
| ADR-060 | §3, §4 steps 1, 2 and 4, §5, §7, Rollout (c)-(e) and the handoff half of (a)-(b), D3, Gate items 4-5 | Superseded for Windows ([above](#reconciliation-with-adr-060)) | This PR (pointer) |
| ADR-037 | `:84-116`, `:133-137`, `:145` | Names the C# client; pipe identity and gate (row 7); shared-PC policy; write-only token; MSI; rogue-QR binding in C#; optional-key item superseded; `PROTOCOL.md` v1 | Its own amendment PR (#2470), before the vpnd hardening lands |
| ADR-045 | `:32-33`, `:115-119` | The Tauri updater text replaced by row 8 | ADR-045 Amendment 1 ([WARP-3246](https://warp-lab.atlassian.net/browse/WARP-3246), #2519), on `stage` |

## Open questions

- **The Hello prompt's owner window.** ADR-060 rejected a `KeyCredentialManager` design partly because the Rust `windows` 0.61.3 crate has no HWND interop for it, so the prompt could open behind the app. Whether the C# client can parent the prompt to its window is not verified; the Hello replay work (M2) has to answer it.
- **The OpenAPI trigger** in row 13 is a proposed default for Romain to confirm or replace.

## Follow-ups

- The handbook registry row for this file and the architecture-guard skill's Tauri rules: [WARP-3224](https://warp-lab.atlassian.net/browse/WARP-3224), merged the same day as this file (no `droplet-windows` PR merges before both).
- `shared_brain`: describe `droplet-windows` as a native C# client, [WARP-3225](https://warp-lab.atlassian.net/browse/WARP-3225).
- ADR-063, native desktop sign-in: [WARP-3226](https://warp-lab.atlassian.net/browse/WARP-3226).
- `droplet-linux` README (`:7`) calls the native Windows client "ADR-060"; it is this file.
