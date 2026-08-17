# iOS away-mode connect — completion handoff (WARP-1387 · WARP-1591)

Epic [WARP-1382](https://warp-lab.atlassian.net/browse/WARP-1382). This packet is written for an
implementer with zero context. Every claim below was verified by reading the cited code on
2026-08-16; refs are named so you can re-verify before trusting anything.

**Refs this was written against**

| Repo | Ref | Why it matters |
|---|---|---|
| droplet-ios | branch `feat/warp-1477-overlay-qr-enroll` @ `796ca96` (10 commits ahead of origin/main; enroll shipped to main in #34) | The enroll flow + the key-discard defect. The discard exists on BOTH refs. |
| droplet-android | `origin/main` @ `5487a77` (connect flow landed in #28 = `236587c`, WARP-1804) | The ONLY complete client — the contract reference. The local clone is parked on a design branch; read `origin/main`, not the working tree. |
| droplet-onboard-services | `origin/main` @ `f1d638d6` | The box contract. Hardening PRs #1609–#1611 and the #1615-draft URL flip are assumed merged; where their post-merge behavior differs from origin/main it is called out. |
| droplet-windows | `origin/main` @ `48c27bb`; PR #32 assumed merged | The tolerant-candidate-parsing posture to mirror. |

Governing ADRs (all in this repo's `docs/`): ADR-031 (own WG overlay), ADR-037
(overlay tunnel key custody, accepted 2026-08-05 — resolves WARP-1591), ADR-040 (blind relay
fallback, accepted 2026-08-15 — NOT built; the `relay` candidate kind exists at priority 20 in
`apps/orchestrator/src/services/overlay-placement.service.ts` (`PRIORITY` map) but no code path
emits it), ADR-023 (split-horizon per-device TLS).

---

## 1. Where iOS actually is

Enrollment works end-to-end (WARP-1477). Connection does not exist, and enrollment actively
sabotages it:

- **The key-discard (WARP-1591).**
  `Droplet/droplet/Features/RemoteAccess/OverlayEnrollStore.swift:98-101` self-generates a
  Curve25519 keypair inside `begin(link:label:)`, sends the public half in the stage POST, and
  drops the private half on the floor — the comment says so outright ("The private half is not
  retained"). The box persists that public key, and on approval `provisionOverlayPeer`
  (`apps/orchestrator/src/services/overlay-profile.service.ts`) mints a real `VpnPeer` row and a
  router-side wg0 peer against the QR-device cap. Every iOS enrollment therefore permanently
  consumes a capped slot with a peer whose private key does not exist anywhere in the world.
  ADR-037 documents exactly this, citing the same line.
- **Nothing is persisted.** `pendingId` is a private in-memory var
  (`OverlayEnrollStore.swift:58`), cleared by `reset()` (:129-133). The `.linked` terminal state,
  the server, the box name — all gone at process death. The profile fetch is PoP-signed **over the
  pending_id**, so without a persisted pending_id there is nothing to fetch a profile *for*.
  (The ECDSA identity key itself survives — it lives in the Keychain,
  `Core/Overlay/OverlayIdentity.swift:92-108` — so the signing half of a two-phase flow is
  already durable.)
- **The UI says so.** `OverlayEnrollView.swift:207`: "Turning on remote access from here is
  coming in a future update."
- **The VPN plumbing exists, HOME-mode only.** `Core/VPN/VPNTunnelStore.swift` installs a
  `NETunnelProviderManager` for bundle id `ai.warp-lab.droplet.tunnel` (:71), hands the whole
  wg-quick conf to the extension as `providerConfiguration["wgQuickConfig"]` (:179), and
  parse-validates before touching the system (:124-134). `droplet-tunnel/PacketTunnelProvider.swift`
  (:32-65) parses that conf with WireGuardKit and starts the adapter. Catalyst is explicitly
  unsupported (:82-88).
- **Conf assembly for a box that never sees the private key already exists.**
  `Core/Overlay/OverlayCrypto.swift:103-135` — `OverlayConf.withInterfacePrivateKey` injects
  `PrivateKey =` into an `[Interface]` block. It was built for this flow and has no caller yet.
- **The by-token HTTP layer is done.** `Core/Networking/APIClient.swift:145-235`: stage POST and
  status GET, no Authorization ever attached, https-only server validation (:204-210), pure
  request builders with unit tests.
- **Rogue-QR gate is missing.** `Core/Pairing/PairingLink.swift:65-71` accepts ANY https `server`
  from the scanned QR. ADR-037 §"Rogue-QR binding" mandates a known-Droplet-domain suffix check
  (or explicit consent naming the host) as a class fix across all three clients. iOS has neither.

## 2. WARP-1591 goes first, and it has a box half

ADR-037's decision: **the WG private key is born inside whatever component owns the tunnel and
never leaves it**, and consequently (option 2 of WARP-1591) **no WG public key is registered
until the tunnel owner exists and has minted one**. Enrollment stages *identity* (the ECDSA
P-256 key); the WG key is attached later. That kills the burned-slot failure structurally: an
enrollment can no longer mint a peer nobody can connect as.

**The wire change this needs does not exist yet.** Verified on onboard `origin/main`:

- `apps/orchestrator/prisma/schema.prisma:1644` — `wgPublicKey String` on
  `PendingOverlayEnrollment` is **required**.
- No attach route exists (grep `wg-key|attach` over `apps/orchestrator/src/routes/vpn.ts` — the
  only hits are the `wg_key_conflict` dedupe at approve, :1335/:1342).
- The approve path (`vpn.ts` ~:1290-1345) dedupes on `pending.wgPublicKey` and provisions the
  peer from it; the profile route (`ROUTE_PROFILE`, `vpn.ts:1072`) looks the peer up by
  `pending.wgPublicKey`.

So the execution order is **box first, iOS second** — exactly the coordination ADR-037's
"Negative / owned" section predicts. The box work (spec below) must merge and deploy to the test
box before the iOS connect flow can be verified at all.

### 2.1 Box wire change (spec)

1. **Stage POST** `POST /api/vpn/overlay/devices/by-token`: `wg_public_key` becomes **optional**
   (schema migration: `wgPublicKey String?`). Validation stays `WG_PUBLIC_KEY_RE`
   (`apps/orchestrator/src/services/overlay-link.service.ts` — `/^[A-Za-z0-9+/]{43}=$/`) when
   present. Clients that still send it at stage (Android, and iOS until its second PR lands)
   keep working unchanged — this is additive.
2. **New attach route** `POST /api/vpn/overlay/devices/by-token/:pending_id/wg-key`, NO bearer.
   Auth: `X-Overlay-PoP` over a NEW domain-prefixed message
   `droplet-overlay-enroll-wg-key:v1:<pending_id>` — reuse `verifyPopOverMessage`
   (overlay-link.service.ts), which already accepts both raw `r||s` and DER and fails closed.
   A distinct prefix is non-negotiable: the status (`droplet-overlay-enroll-status:v1:`) and
   profile (`droplet-overlay-enroll-profile:v1:`, `overlay-link.service.ts:52`) prefixes exist
   precisely so no captured signature authorizes a different verb. Body: `{ wg_public_key }`.
   Semantics:
   - unknown pending_id or bad PoP → 401 `unauthorized`, identical to /status and /profile (no
     existence leak);
   - state `pending` → store the key on the row (it will be provisioned at approve, the current
     path);
   - state `approved` and no key yet → store the key AND run `provisionOverlayPeer` now (this is
     the normal two-phase sequence: owner approves, then the device attaches);
   - same key already attached → 200, idempotent;
   - different key already attached, or key collides with an active peer / another approved row →
     409 `wg_key_conflict` (mirror the approve-path dedupe, `vpn.ts:1335-1342`);
   - rate-limit inside the shared `bytoken` budget like its siblings.
3. **Profile route**: an `approved` row with `wgPublicKey == null` returns a NEW contracted
   verdict — 409 `{ error: "wg_key_required" }` — distinct from `not_approved` (keep waiting) and
   `tunnel_not_ready` (owner re-approve). Clients react by attaching, not by polling or asking
   the owner for anything.
4. **Approve path**: when the row has no key, skip the peer-dedupe and `provisionOverlayPeer`
   (nothing to provision); approval is pure owner consent. **Open decision to settle in the PR:**
   the approve path also fires the box→HQ vouch — check whether that vouch carries the WG key,
   and if so either defer the vouch to attach time or rely on fleet-hq's enroll key-change guard
   (fleet-hq #15 added one; read its actual semantics rather than assuming).
5. **Tests**: mirror `vpn-overlay-qr-enroll.test.ts` coverage for every verdict above, plus the
   replay case (a /status or /profile PoP presented to /wg-key must fail).

### 2.2 iOS store changes

- Delete the keypair generation from `OverlayEnrollStore.begin` (:98-101 today) and drop
  `wgPublicKey` from the stage call once the box change is deployed (`OverlayStageRequest`,
  `Core/Overlay/OverlayModels.swift:27-39`, makes the field optional).
- **Persist the enroll outcome.** New small store (Keychain-backed, same pattern as
  `Core/Auth/KeychainStore.swift`): `pendingId` written at STAGE time (Android learned this the
  hard way — approval may only be observed after process death), `server`, `boxName`, and a
  `tokenEnrolled` flag set only on the approved terminal. Mirror Android's split: this flag means
  "a QR enrollment was approved", nothing else (`CredentialStore.kt`, F1 note).
- **WG tunnel key custody.** The key is minted at connect time (the "tunnel owner exists"
  moment — the user flips Connect and the `NETunnelProviderManager` is being installed), stored
  in the **App Group keychain** (`kSecAttrAccessGroup = group.ai.warp-lab.droplet` — both
  targets already carry that app group in their entitlements; there is no separate
  `keychain-access-groups` entitlement and none is needed, the app-group ID is a valid keychain
  access group), public half attached via the new `/wg-key` route, then the profile is fetched
  and the tunnel brought up. The extension reads the private key from the shared keychain;
  the conf handed over `providerConfiguration` carries the PLACEHOLDER, and
  `OverlayConf.withInterfacePrivateKey` injects the real key **inside the extension** — the
  private key never rides through `saveToPreferences`.
- **Accessibility classes** (asked for explicitly, so here is the table):

  | Item | Class | Why |
  |---|---|---|
  | ECDSA identity key (`OverlayIdentity`, tag `ai.warp-lab.droplet.overlay-identity`) | `WhenUnlockedThisDeviceOnly` (unchanged, :99) | Only app-foreground flows sign (enroll, attach, profile fetch). |
  | WG tunnel private key (new, App Group) | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | The extension can be (re)started by the system with no foreground app — after a reboot-then-background-reconnect, a `WhenUnlocked` item is unreadable and `startTunnel` fails unrecoverably. ADR-037's iOS table row says `WhenUnlockedThisDeviceOnly`; this is a deliberate, argued deviation — record it in the PR description and as an ADR-037 erratum note. |
  | Cached profile JSON + pending_id (new) | `AfterFirstUnlockThisDeviceOnly`, App Group | The extension needs the profile for candidate switching; it is topology, not key material, but it lives with the key. |

- **Migration for already-burned slots: none on iOS.** iOS never persisted anything, so there is
  no client state to migrate. The burned slots live on boxes. Post-#1610 the box frees a slot
  when the owner deletes/revokes the device (and HQ-revokes on owner delete), and the cap counts
  live peers rather than approved-forever rows (on origin/main the cap still counts
  `pendingOverlayEnrollment.state == "approved"` rows — `vpn.ts:1292-1305`,
  `overlay_device_cap_reached`). So the cleanup runbook is: owner opens dashboard → Remote
  access → deletes the dead iOS entries. ADR-037 notes no customer boxes are in this state; the
  lab/test box may need the prune.

## 3. The connect flow — mirror Android, it is the contract reference

Android's WARP-1804 implementation (`origin/main`, commit `236587c`) is complete and
battle-reviewed. The iOS work is a port of its *behavior*, not its structure. Reference map:

| Concern | Android file (all under `app/src/main/kotlin/ai/warplab/droplet/`) | What to take |
|---|---|---|
| Profile fetch + typed verdicts | `network/ApiClient.kt` (`overlayEnrollProfile`) | PoP over `droplet-overlay-enroll-profile:v1:<pending_id>`; verdicts gated on the CONTRACTED `error` string **and** status, never bare status — the fetch targets the public origin, so any middlebox can fake a status but only the box sends these bodies. Uncontracted responses throw = "origin unreachable" = use the cache. |
| Profile DTO | `network/model/OverlayModels.kt` (`OverlayProfileResponse`, `OverlayEndpointCandidate`) | `kind` is a **plain String**, not an enum — that is the windows-#32 posture (serde `#[serde(other)] Unknown`) in Kotlin form. iOS must do the same: decode `kind` as `String`, skip unknowns with a log, never fail the decode. `relay` will start arriving when ADR-040 ships; a client that chokes on it ships a time bomb. |
| Candidate ladder | `vpn/overlay/OverlayProfileConnector.kt` | `dialOrder`: drop non-IP-literal hosts (candidates are ALWAYS IP literals; the per-device FQDN is public-NXDOMAIN by design and must NEVER be dialed as a WG endpoint — re-check client-side, don't trust the server), sort priority **descending** (server sends best-first — lan 120 → direct 100 → mapped 80 → srflx 60 → relay 20 — but never depend on arrival order), dedupe on normalized host:port (bracketed v6 == bare v6; fleet-hq #15 added bracketed-v6 endpoint validation server-side, so both spellings are live), cap at 6. Per-rung handshake window 6 s; whole-ladder budget 45 s. Three-way bring-up outcome: `Handshook` / `NoHandshake` (try next rung) / `Failed` (backend refused — abort the whole ladder with the backend's own message, don't burn remaining rungs). Teardown on any unsettled exit, non-cancellable. |
| Connect orchestration | `screens/remote/RemoteAccessScreen.kt` (`connectSmart`, `connectViaProfile`, `shouldOfferConnect`, `resolveWgEnrollKey`) | Opportunistic re-fetch before dialing (fresh replaces cache; 503 `tunnel_not_ready` aborts with the server's message; 401 revokes the enrollment and clears the cache; 409 with state denied/expired = device removed, terminal). Offer the toggle on connect-ABILITY (cached profile OR fetchable), not on an on-LAN feature-detect. ONE key-resolution function shared by enroll and connect — divergence means a tunnel that can never handshake. Don't report "Connected" when the tun comes up; report it on the first real handshake. |
| Stage/approval persistence | `vpn/overlay/TokenEnrollCoordinator.kt` | pending_id persisted at STAGE; profile fetched + cached the moment approval is observed (the poll just proved the split-horizon origin reachable — off-LAN it will not be later); dead verdicts clear the pending_id. |

### iOS-specific design decision: the ladder lives in the extension

On Android the app process owns `GoBackend`, so the app walks the ladder. On iOS, walking it from
the app would mean reinstall-manager + restart-tunnel per rung — slow, `NEVPNStatus` flapping,
and the private key riding through preferences. Put the ladder in
`PacketTunnelProvider.startTunnel`:

- The app passes the profile JSON (non-secret) via `providerConfiguration`; the extension reads
  the WG key from the App Group keychain, assembles the conf per candidate
  (`OverlayConf.withInterfacePrivateKey` — move it into a target both app and extension
  compile, or a small shared framework), and dials rungs itself.
- Handshake detection: `WireGuardAdapter.getRuntimeConfiguration()` exposes
  `last_handshake_time_sec` — poll it inside the 6 s window per rung; use
  `adapter.update(tunnelConfiguration:)` to switch rungs without tearing the tun down.
- `startTunnel` completes with success on first handshake, or with a typed error after the 45 s
  budget; surface which rung connected via `handleAppMessage` (currently a stub,
  `PacketTunnelProvider.swift:80-83`) so the UI can say something honest.
- Keep the away tunnel a SEPARATE `NETunnelProviderManager` profile from "Droplet (Home)"
  (`VPNTunnelStore.swift:73`) — one localizedDescription per mode, or users can't tell which
  toggle they flipped in Settings.

### The box contract, verified (write the iOS client against this)

`GET {server}/api/vpn/overlay/devices/by-token/:pending_id/profile`
(`apps/orchestrator/src/routes/vpn.ts:1072`, `ROUTE_PROFILE`), NO bearer, header `X-Overlay-PoP` =
base64 ECDSA-P256/SHA-256 over ASCII `droplet-overlay-enroll-profile:v1:<pending_id>` — **DER or
raw r||s both accepted** (`verifyPopOverMessage` tries `ieee-p1363` then `der`, fail-closed), so
iOS's `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` DER output
(`OverlayIdentity.swift:52-54`) is fine as-is.

- 200 → `{ address ("<ip>/32"), server_public_key, allowed_ips[], dns[], persistent_keepalive,
  endpoint_candidates[{kind, host, port, priority}] }` — candidates pre-sorted best-first
  (`buildOverlayProfile` sorts descending), AllowedIPs+DNS selected as a PAIR from the peer's
  mode (a resolver outside every routed range would send DNS out the default route and NXDOMAIN
  the split-horizon name — the box makes that unrepresentable, don't "fix" it client-side).
  Never a default route.
- 401 `{error:"pop_required"}` (missing header) / `{error:"unauthorized"}` (unknown id or bad
  PoP — indistinguishable on purpose) — terminal; clear the cached profile and enrollment.
- 409 `{error:"not_approved", state}` — keep waiting; if state is denied/expired, terminal.
- 409 `{error:"wg_key_required"}` — NEW post-WARP-1591 verdict: attach the key, then re-fetch.
- 503 `{error:"tunnel_not_ready", message}` — approved but unprovisioned; surface the server's
  own message (owner re-approve is the recovery). Do not dial the cached profile after this.
- 429 `{error:"rate_limited"}` — back off.
- Anything else → treat as origin unreachable (the NORMAL off-LAN case: the FQDN is
  public-NXDOMAIN by design) → fall back to the cached profile.

Re-fetching is the same endpoint — there is deliberately no separate refresh route; a fetch is
idempotent for an approved device and picks up placement changes (`vpn.ts:573-576, 180`).

### The JWT-vs-host caveat (scope it, don't chase it)

`APIClient.baseURL` is captured at sign-in and can be a LAN-only name — the doc comment's own
example is `https://droplet-c4d4df.local` (`APIClient.swift:25-26`). mDNS does not traverse a WG
tunnel, so with the tunnel up and away, the app's *authed API* may still be unreachable even
though the box subnet is. What is actually true, verified:

- Access/refresh JWTs are NOT host-bound — `jwt.service.ts` signs `{sub, username, type}` with no
  `aud`/`iss` — so presenting the same bearer at `https://<name>.droplet-us.com` works.
- Passkeys ARE host-bound (rpID per host — a known, separately-tracked property), and the
  ADR-023 cert is minted for the FQDN, not `.local`.

**Scope for WARP-1387: the tunnel and the box subnet.** Acceptance is "tunnel up, handshake real,
`https://<name>.droplet-us.com` loads with a padlock over the tunnel" — via the tunnel's DNS
(the profile's `dns` is in the routed range). Making `APIClient` itself fail over from a `.local`
baseURL to the FQDN origin when away is a real feature with auth-surface implications — file it
separately; do not smuggle it into the connect PR.

### Rogue-QR gate (in scope, it is two lines and ADR-mandated)

`DeepLinkParser` (`PairingLink.swift:65-71`) must additionally require the overlay-enroll
`server` host to end in the known Droplet domain (`.droplet-us.com`) or match the already-paired
box host. ADR-037 calls this a class fix across all three clients; Android ships an allowlist,
iOS ships nothing.

## 4. What CI can and cannot verify

`.github/workflows/ios.yml`: `macos-15` runner, Xcode 26 explicitly selected (the pbxproj's
`SWIFT_DEFAULT_ACTOR_ISOLATION=MainActor` is Swift 6.2-only and Xcode 16 ignores it silently —
do not touch the pin), **simulator** destination, `-only-testing:dropletTests`,
`CODE_SIGNING_ALLOWED=NO`.

Therefore CI **can** verify: DTO decode (including unknown-kind tolerance and the
bracketed-v6 dedupe), pure request builders (PoP header shape, path encoding), ladder ordering
logic (keep `dialOrder` pure, mirror Android's `OverlayLadderSafetyTest`), conf assembly
(`OverlayConf` tests exist), verdict-mapping tables, and store logic behind protocol seams.
Write all of it — Android's test list on #28 is the checklist
(`OverlayProfileApiTest`, `OverlayProfileModelsTest`, `OverlayProfileVerdictGatingTest`,
`OverlayLadderSafetyTest`, `OverlayProfileConnectorTest`, `ConnectAvailabilityTest`).

CI **cannot** verify: anything involving `NEPacketTunnelProvider` (no NE in the simulator, no
signing in CI, so even entitlement regressions pass green), Keychain access-group behavior, the
real handshake, or the App Group hand-off. **A green CI run is not evidence the feature works.**

### Required on-device verification recipe (test box)

Prerequisites: a physical iPhone; a signing identity carrying the packet-tunnel NE entitlement +
app group `group.ai.warp-lab.droplet` for BOTH targets; the test box (192.168.9.250, behind the
RB5009 — its WAN is the office LAN, private) running current main with the WARP-1591 box change
deployed. Note the RB5009 placement means truly-public `direct` candidates are not reachable from
the internet; "away" is exercised from an adjacent network (phone on cellular), which still
leaves the LAN rung undialable and forces the ladder.

1. **Enroll two-phase.** Dashboard → Remote access → show QR → scan in-app → owner approves.
   Expect: `.linked`, pending_id persisted (kill the app mid-poll and relaunch to prove it),
   WG key attached, profile cached. Box-side proof: orchestrator audit events for the stage,
   approve, wg-key attach, and `overlay_profile_issued` (`vpn.ts:1161`); `wg show wg0` on the box
   lists the device's public key with its assigned /32.
2. **On-LAN connect.** Flip Connect on the office Wi-Fi. Expect the `lan` rung to handshake
   inside one window. Proof: `wg show wg0 latest-handshakes` is fresh for the device key; on the
   phone, `https://<name>.droplet-us.com` loads the dashboard with a padlock (split-horizon DNS
   over the tunnel).
3. **Away connect.** Wi-Fi off, cellular on. Flip Connect. Expect the lan rung to fail its 6 s
   window and a later rung to handshake; the UI must show "Connecting" throughout — never
   "Connected" on a dead rung — and the connected-rung report should name the kind. Re-verify
   handshake + FQDN-over-tunnel.
4. **Honesty paths.** (a) Owner deletes the device → next connect surfaces the removed/terminal
   state and clears the cache; the freed slot is re-enrollable (post-#1610). (b) Kill the box's
   overlay interface (or revoke + re-approve mid-flight) and confirm the 503 message is the
   server's own words. (c) Reboot the phone, do NOT unlock-launch the app, toggle the VPN from
   Settings → the extension must still read its key (this is the AfterFirstUnlock class doing
   its job).
5. Record the run (commands + outputs) in the PR description. "Verified on the live box" without
   the transcript is shape-blind and does not count.

## 5. Order of work

1. **Box: two-phase wire change** (§2.1) — its own PR against this repo; deploy to the test box.
2. **iOS: WARP-1591 store changes** (§2.2) — enroll stages identity only, persists pending_id,
   mints + attaches the WG key at connect intent. Gate: cannot merge before 1 is deployed.
3. **iOS: connect flow** (§3) — profile fetch, ladder in the extension, UI toggle, rogue-QR gate.
   Gate: needs 2.
4. **Cleanup:** owner-prunes any burned slots on the lab/test box (revoke now frees them).

Both iOS stories are the executable decomposition of the WARP-1387 umbrella; link them to it and
to WARP-1591/ADR-037 when filing.
