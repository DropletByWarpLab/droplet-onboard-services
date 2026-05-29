# ADR-008: Native Mobile — Design System + API Contract

**Status:** Accepted
**Date:** 2026-05-18
**Deciders:** Stefan Cruceru
**Builds on:** ADR-007 (violet brand + dual workspace)
**Supersedes (in part):** earlier ad-hoc native client work on
`feat/native-mobile-clients` and `feat/android-app` — see "Predecessors"
below.

## Context

Droplet is shipping two native companion apps in production:

- **`stefan-cruceru/droplet-ios`** — SwiftUI, Apple-platform-native
- **`stefan-cruceru/droplet-android`** — Kotlin + Jetpack Compose

Two earlier branches in `droplet-pi-platform` produced native scaffolds:
- `feat/android-app` — WebView shell only (dead end; not production-track)
- `feat/native-mobile-clients` — Kotlin Multiplatform + SwiftUI iOS shell
  + Compose Android + full WebDAV file sync. Stefan flagged this branch
  (see `feedback_align_with_shared_brain.md`) for inventing patterns
  without consulting shared_brain. It is NOT being merged.

The HARD RULE (`feedback_align_with_shared_brain.md`) requires me to
align with shared_brain before writing native code. The shared_brain
audit (this conversation, 2026-05-18) surfaced one ADR gap: there is
**no spec for how dashboard design tokens (now violet `#6d28d9` per
ADR-007) translate to SwiftUI + Compose, and no canonical API contract
for non-browser clients.** This ADR fills both gaps.

## Decisions

### 1. Two fully independent native apps. No shared code.

`droplet-ios` is pure Swift / SwiftUI / Apple Swift Package Manager.
`droplet-android` is pure Kotlin / Compose / Gradle KTS.

**No Kotlin Multiplatform.** Stefan call 2026-05-18: KMP's
XCFramework + Gradle plugin toolchain is heavier than the duplication
saves. Drift on API/tokens is mitigated by THIS document + the
companion `docs/mobile-api-contract.md` that both apps consume.

**Future:** if duplication becomes painful, the right move is to add an
OpenAPI spec at `apps/orchestrator/openapi.yaml` and generate typed
clients per platform (Swift OpenAPI Generator + OpenAPI Kotlin Codegen).
The contract markdown below is structured so that migration is mechanical.

### 2. Design tokens — explicit cross-platform mapping

The dashboard's `apps/web-dashboard/src/app/globals.css` tokens are the
source of truth. Native apps mirror them as constants.

#### Color (light mode)

| Token | CSS (`globals.css`) | SwiftUI | Compose (Color.kt) |
|---|---|---|---|
| accent | `#6d28d9` | `Color(red: 0.427, green: 0.157, blue: 0.851)` | `Color(0xFF6D28D9)` |
| accent hover | `#5b21b6` | `Color(red: 0.357, green: 0.129, blue: 0.714)` | `Color(0xFF5B21B6)` |
| accent subtle | `rgba(109,40,217,0.10)` | `Color(...).opacity(0.10)` | `Color(0xFF6D28D9).copy(alpha = 0.10f)` |
| surface primary | `#ffffff` | `Color.white` | `Color.White` |
| surface secondary | `#f2f2f7` | `Color(red: 0.949, ...)` | `Color(0xFFF2F2F7)` |
| surface raised | `#ffffff` | same as primary | same |
| label primary | `#000000` | `Color.black` | `Color.Black` |
| label secondary | `rgba(60,60,67,0.6)` | `Color(...).opacity(0.6)` | `Color(0x99_3C3C43)` |
| label tertiary | `rgba(60,60,67,0.3)` | opacity 0.3 | `Color(0x4D_3C3C43)` |
| separator | `rgba(60,60,67,0.12)` | opacity 0.12 | `Color(0x1F_3C3C43)` |
| system green | `#34c759` | `Color(red: 0.204, ...)` | `Color(0xFF34C759)` |
| system orange | `#ff9500` | apple system orange | `Color(0xFFFF9500)` |
| system red | `#ff3b30` | apple system red | `Color(0xFFFF3B30)` |
| system blue | `#007aff` | apple system blue | `Color(0xFF007AFF)` |
| role owner | `#6d28d9` | violet (same as accent) | `Color(0xFF6D28D9)` |
| role admin | `#2563eb` | `Color(red: 0.145, ...)` | `Color(0xFF2563EB)` |
| role manager | `#0891b2` | cyan | `Color(0xFF0891B2)` |
| role member | `#475569` | slate | `Color(0xFF475569)` |
| role viewer | `#94a3b8` | slate-400 | `Color(0xFF94A3B8)` |
| role guest | `#f59e0b` | amber | `Color(0xFFF59E0B)` |

Dark mode mirrors the dashboard's `.dark` block — accent goes to
`#a78bfa`, surfaces invert, role colors get softer pastel variants.

#### Type

- **iOS:** SF Pro (system) at the Apple HIG scale. We do NOT bundle
  Inter on iOS — using the system face means perfect Dynamic Type +
  accessibility + no font-file CocoaPod.
- **Android:** Inter via `androidx.compose.ui.text.googlefonts` (the
  GoogleFontsManager API) at the Apple HIG scale. Falls back to system
  sans if the download fails.
- **Display face (Instrument Serif for AI hero):** loaded via Google
  Fonts on both platforms. iOS uses `CTFontManagerRegisterFontsForURL`
  for the family registered in `Info.plist`; Compose uses the same
  Google Fonts API.

Type scale (mirrors `type-*` utilities in dashboard CSS):

| Token | Size / line | iOS API | Compose `TextStyle` |
|---|---|---|---|
| large-title | 34/41 700 | `.largeTitle` weight `.bold` | `fontSize = 34.sp, lineHeight = 41.sp, fontWeight = Bold` |
| title-1 | 28/34 700 | `.title` `.bold` | `28.sp, 34.sp, Bold` |
| title-2 | 22/28 700 | `.title2` `.bold` | `22.sp, 28.sp, Bold` |
| title-3 | 20/25 600 | `.title3` `.semibold` | `20.sp, 25.sp, SemiBold` |
| headline | 17/22 600 | `.headline` | `17.sp, 22.sp, SemiBold` |
| body | 17/22 400 | `.body` | `17.sp, 22.sp, Normal` |
| callout | 16/21 400 | `.callout` | `16.sp, 21.sp, Normal` |
| subheadline | 15/20 400 | `.subheadline` | `15.sp, 20.sp, Normal` |
| footnote | 13/18 400 | `.footnote` | `13.sp, 18.sp, Normal` |
| caption-1 | 12/16 400 | `.caption` | `12.sp, 16.sp, Normal` |
| caption-2 | 11/13 400 | `.caption2` | `11.sp, 13.sp, Normal` |

#### Spacing / radii / shadows

| Token | Value | iOS | Compose |
|---|---|---|---|
| radius-sm | 8 | `RoundedRectangle(cornerRadius: 8)` | `RoundedCornerShape(8.dp)` |
| radius | 12 | 12 | 12.dp |
| radius-lg | 16 | 16 | 16.dp |
| radius-xl | 20 | 20 | 20.dp |
| radius-pill | 9999 | `Capsule()` | `RoundedCornerShape(50)` |

Tile shadow / hero shadow render as platform-idiomatic surfaces:
- iOS: `.shadow(color: .black.opacity(0.10), radius: 12, x: 0, y: 8)`
- Compose: Material 3 `Surface` `tonalElevation = 2.dp` plus a custom
  `Modifier.shadow(elevation = 8.dp, shape = RoundedCornerShape(20.dp))`

#### Icons

- **iOS:** SF Symbols 5 (native). Map lucide names → SF Symbol names in
  `Icons.swift`. Examples: `Home` → `house`, `MessageSquare` →
  `message`, `Video` → `video`, `FolderOpen` → `folder`, `Network` →
  `network`, `Cpu` → `cpu`, `Sparkles` → `sparkles`, `LayoutDashboard`
  → `square.grid.2x2`. Stroke weight comes from the symbol's variant.

- **Android:** `com.composables:icons-lucide` (mirror of lucide-react).
  Same names as dashboard. Active state uses `strokeWidth = 2`, inactive
  `strokeWidth = 1.5`.

This dual approach keeps each platform feeling native (SF Symbols are
free and platform-perfect) while keeping the lucide vocabulary that the
dashboard + design system use as the canonical icon name.

### 3. Authentication — Bearer JWT with refresh

The orchestrator (`apps/orchestrator/src/middleware/auth.ts`) already
accepts `Authorization: Bearer <jwt>` on every protected route. Bearer
is checked BEFORE the `droplet_session` cookie. Native clients use
Bearer; no new orchestrator path is needed.

**One required orchestrator change** before mobile can ship: add
`?return=body` to `POST /api/auth/login` so the JWT is returned in the
response body in addition to the existing `Set-Cookie` header. Native
clients cannot easily read `Set-Cookie` (especially iOS where
URLSession won't expose it for cross-origin), so the body return is the
clean path. This is a non-breaking additive change.

Token lifecycle:

1. **Pair:** dashboard generates a 6-digit pair code (existing
   `/api/devices/pair` POST). User scans the QR (`droplet://pair?server=…&code=…`).
2. **Claim:** native client calls `POST /api/devices/pair/claim` with
   `{ code, username, password }`. Orchestrator validates the code,
   creates a `DeviceClient` row, generates a Nextcloud per-device app
   password, encrypts it, and returns `{ accessToken, refreshToken,
   deviceId, displayName }`.
3. **Store:** access token in iOS Keychain (`kSecAttrAccessible`
   `WhenUnlockedThisDeviceOnly`) / Android EncryptedSharedPreferences
   (Tink AEAD). Refresh token same store, separate key.
4. **Use:** add `Authorization: Bearer <accessToken>` to every request.
5. **Refresh:** on 401, call `POST /api/auth/refresh` with refresh
   token, update access token, retry the original request once.
6. **Revoke:** user taps "Forget this Droplet" → `DELETE
   /api/devices/clients/:id` → orchestrator revokes the Nextcloud app
   password + marks the row revoked → client wipes Keychain.

The `feat/native-mobile-clients` branch implements roughly this flow
with `PairingRepository` (KMP). The new apps re-implement the flow in
pure Swift / pure Kotlin per the no-shared-code rule above.

### 4. Base URL discovery

**Primary:** QR code at dashboard `/settings/pair` (existing route, see
`apps/web-dashboard/src/app/settings/`) encodes
`droplet://pair?server=<https-url>&code=<6-digit>`. Native client
deep-link handler parses both query params, stores `server` in app
state, and POSTs to `<server>/api/devices/pair/claim` with the code.

**Fallback:** manual entry — user types the IP or hostname (e.g.
`https://droplet-c4d4df.local`). Native client validates the URL with a
hit to `/api/orchestrator/health` (no-auth) before showing the login form.

**mDNS discovery** (`_droplet._tcp.local`): Phase 2 enhancement —
auto-fills the URL field if a Droplet is on the LAN. iOS uses
`NWBrowser` (NetworkExtension framework), Android uses `NsdManager`.

**WireGuard remote access:** orthogonal — once paired, user can opt
into Phone-as-WG-Peer via `Settings → Remote access → Enable
WireGuard`. This calls `POST /api/vpn/peers` and the app configures the
system VPN profile via `NEVPNManager` (iOS) / `WgQuickBackend` from the
official WireGuard Android app's open-source library. After that the
app's `server` URL keeps working over LTE.

### 5. Workspace inheritance

The dashboard's Home/Business workspace setting (`useWorkspace`,
ADR-007) lives on the **Droplet**, not the client. Once Phase 4 of the
dashboard work promotes the localStorage flag to a Prisma column +
`/api/setup/workspace` endpoint, the native client reads it on every
launch and adapts:

- Home workspace → 5-tab bottom nav: Home / AI / Cams / Files / More.
  "More" drawer shows Devices, Network (read-only), Remote-access,
  Settings.
- Business workspace → same 5 tabs by default, but "More" drawer
  surfaces additional admin entries: People, Roles, Groups, Activity,
  Plan & Billing. Owner-only items are gated on `me.role`.

The workspace setting is read-only from mobile in v1 — only the
dashboard's setup wizard can change it. Phase 6 may add a mobile-side
toggle.

### 6. Push notifications

- **iOS:** APNs via Firebase Cloud Messaging FOR HABIT — we will go
  direct-APNs without FCM since FCM-on-iOS adds dependency surface for
  no value. APNs token POSTed to `/api/devices/push` on pair + every
  app launch.
- **Android:** FCM. Token POSTed to same endpoint.

Backend already has the route group (`apps/orchestrator/src/routes/device-clients.ts`
`/api/devices/push/*`) and a VAPID public-key endpoint. The orchestrator
sidecar that fans out push events is TBD — currently scaffolded only.
Mobile v1 ships subscription only; the actual push delivery wires up in
Phase 6.

### 7. Versioning + release

- **iOS:** SemVer in `Info.plist`. Build numbers monotonic from CI.
  TestFlight first; App Store after 4 weeks of internal pilot.
- **Android:** SemVer + monotonic versionCode in `build.gradle.kts`.
  Internal track on Play Console first; production after pilot.

Both apps poll `/api/orchestrator/health` on launch; if `version`
returned by the orchestrator is older than the client's minimum
supported orchestrator version (constant in the app), show a "Please
update your Droplet" interstitial.

## Predecessors — what to salvage from `feat/native-mobile-clients`

NOT being merged. The new repos start clean. From the audit (see
this conversation's notes), salvageable IDEAS — to be re-implemented in
pure Swift / pure Kotlin per the no-shared-code rule:

- Pairing repository logic (URL parsing, code-claim handshake)
- WebDAV client shape (but we're NOT building file sync v1 — see file
  strategy below)
- Android auto-upload (Phase 2 enhancement; not v1)
- Credential store patterns (Keychain / EncryptedSharedPreferences)

## File-sync strategy

Stefan call 2026-05-18: **no sync engine in either app.** Files tab is
a thin browser:
- `GET /api/files?path=/` to list
- `GET /api/files/download?path=…` to download
- `GET /api/files/share?path=…` to copy a public share link

Users who want two-way sync install the official Nextcloud Files app
alongside (which is already supported by the Nextcloud server that
ships with every Droplet).

## Companion documents

- `docs/mobile-api-contract.md` — endpoint catalog with request/response
  shapes (mirror of the route map from this session's recon)
- ADR-007 — violet brand + dual workspace (the dashboard side)

## Action items

1. [x] Approve violet `#6d28d9` for native (ADR-007 covers this)
2. [ ] Add `?return=body` to `POST /api/auth/login` so JWT lands in
       response body — dashboard ignores this query param; native uses it
3. [ ] Create empty `stefan-cruceru/droplet-ios` repo via GitHub
       Desktop (Stefan)
4. [ ] Create empty `stefan-cruceru/droplet-android` repo via GitHub
       Desktop (Stefan)
5. [ ] Scaffold both repos per this ADR (in progress this session)
6. [ ] Pair-flow QA on a physical iPhone + Android device (post-scaffold)
7. [ ] APNs key + FCM service account (Stefan / Romain)
8. [ ] App Store + Play Store listing copy (post-MVP)

## Future-agent notice

**Do not introduce Kotlin Multiplatform to either app.** Decision is to
stay native per platform. If duplication ever becomes painful, the next
step is OpenAPI codegen (spec at `apps/orchestrator/openapi.yaml`), not
KMP. Supersede this ADR if you disagree — don't quietly add a `shared/`
module.

**Do not reintroduce WebView for the dashboard.** It was tried on
`feat/android-app` and abandoned as a dead end. Native UI throughout.

**Do not rename the design tokens between platforms.** The color/type
table above is the cross-platform truth; keep names in sync (accent =
accent, type-headline = .headline = TextStyle.Headline).
