# Droplet Android — dashboard companion app

Native Android shell around the Droplet web dashboard
(`apps/web-dashboard/`). Renders the dashboard in a hardened WebView, plus
adds the things a browser can't do well: QR pair scanning, mDNS LAN
discovery, multi-appliance switching, and `droplet://pair` deep links from
email / NFC / iOS hand-off.

> **Not** to be confused with `../android/`, which is a brand overlay for a
> fork of the Nextcloud Android sync client. That one syncs files; this one
> drives the dashboard. They ship side-by-side as two separate APKs with
> different package IDs:
>
> | App | Package ID | Purpose |
> |---|---|---|
> | `clients/android/` | `com.warplab.droplet.files` (TBD) | File sync (Nextcloud fork) |
> | `clients/android-app/` | `ai.warplab.droplet` | Dashboard / control plane |

## Why a WebView, not a native port

The dashboard is ~30 Next.js pages — calendar, cameras with per-camera
dynamic routes + recordings + settings, chat, clips, devices, events, files
(devices/favorites/recents/shared/trash), login, network, remote-access,
settings, setup, users. A native Compose port is 3-6 engineer-months and
drifts the moment the dashboard ships a new page.

A WebView shell gives us:
- **100% feature parity day one** — every dashboard feature works, including
  HLS streams from Frigate, qrcode SVGs, react-markdown chat, SWR caching,
  Matter `/api/matter/*` calls.
- **Free updates** — when the appliance pulls a new orchestrator image, the
  app reflects it immediately. No Play Store release cycle.
- **Tiny binary** — under 10 MB; native plugins only for the parts a browser
  truly can't do.

The native shell handles only:
| Concern | Module |
|---|---|
| QR pair scanning | `ui/scanner/` (CameraX + ML Kit barcode) |
| mDNS LAN discovery | `discovery/DropletNsdDiscovery.kt` (`_droplet._tcp.local`) |
| Multi-appliance switcher | `ui/servers/`, `data/ServerRepository.kt` (DataStore) |
| `droplet://pair?…` deep links | `pair/PairUrl.kt` + Manifest intent filter |
| Push (future) | `push/DropletFcmService.kt` (scaffold, disabled) |

## Project layout

```
clients/android-app/
├── app/
│   ├── build.gradle.kts                       # AGP 8.7, Kotlin 2.0, Compose
│   ├── proguard-rules.pro
│   └── src/
│       ├── main/
│       │   ├── AndroidManifest.xml            # droplet:// intent filter + perms
│       │   ├── kotlin/ai/warplab/droplet/
│       │   │   ├── DropletApp.kt              # Application: process singletons
│       │   │   ├── MainActivity.kt            # Single-activity host + deep link routing
│       │   │   ├── data/                      # DataStore-backed paired-server repo
│       │   │   ├── discovery/                 # NSD/mDNS scanner
│       │   │   ├── nav/DropletNavHost.kt
│       │   │   ├── pair/                      # PairUrl parser + URL validator
│       │   │   ├── push/                      # FCM scaffold (gated; see file header)
│       │   │   └── ui/
│       │   │       ├── dashboard/             # WebView host (the actual "app")
│       │   │       ├── onboarding/            # Onboarding + manual URL
│       │   │       ├── pair/                  # Deep-link handoff screen
│       │   │       ├── scanner/               # CameraX + ML Kit QR scanner
│       │   │       ├── servers/               # Discovery + switcher
│       │   │       └── theme/                 # Material 3 colour + typography
│       │   └── res/                           # Strings, themes, icons, network policy
│       └── test/                              # JVM unit tests
├── build.gradle.kts                           # Root build script
├── settings.gradle.kts                        # Includes :app
├── gradle/libs.versions.toml                  # Single source of truth for versions
└── gradle.properties
```

## Build

You need:
- **JDK 17** (Android Gradle Plugin 8.x requires it)
- **Android SDK 35** + build-tools 35.0.0+ (the `compileSdk` in `app/build.gradle.kts`)
- Android Studio Koala (2024.1+) or any IDE with a Kotlin 2.0 plugin

### First-time setup

The Gradle wrapper script + jar aren't checked into this skeleton (you've
just received the source). Generate them once with a system `gradle`:

```bash
cd clients/android-app
gradle wrapper --gradle-version 8.10.2 --distribution-type bin
```

Or, easier: open `clients/android-app/` in Android Studio and let it
generate the wrapper as part of the project sync.

### Debug build

From the repo root (uses the npm wrapper script):

```bash
npm run android-app:build
# APK at: clients/android-app/app/build/outputs/apk/debug/app-debug.apk
```

Or directly:

```bash
cd clients/android-app
./gradlew :app:assembleDebug
```

Install on a connected device:

```bash
cd clients/android-app && ./gradlew :app:installDebug
```

### Other npm-wrapped tasks

```bash
npm run android-app:test     # JVM unit tests
npm run android-app:lint     # Lint check
npm run android-app:bundle   # Release AAB (needs keystore env)
```

These all dispatch via `scripts/android-app.sh`, which short-circuits with
a helpful error if JDK isn't on PATH — so contributors who only work on
Node services aren't blocked by the Android toolchain.

### Release build

Release builds require a keystore. Local one-off:

```bash
keytool -genkey -v -keystore release.keystore -keyalg RSA -keysize 4096 \
        -validity 10000 -alias droplet
export DROPLET_ANDROID_KEYSTORE_PATH="$(pwd)/release.keystore"
export DROPLET_ANDROID_KEYSTORE_PASSWORD="…"
export DROPLET_ANDROID_KEY_ALIAS="droplet"
export DROPLET_ANDROID_KEY_PASSWORD="…"
./gradlew :app:bundleRelease       # AAB for Play
./gradlew :app:assembleRelease     # APK for sideload
```

CI signs from GitHub Actions secrets — see `.github/workflows/android-app.yml`.

### Run tests

```bash
./gradlew :app:testDebugUnitTest
```

JVM-only — no emulator required. Robolectric is not used; tests exercise the
pure-Kotlin slices (PairUrl, UrlValidator). Higher-level instrumented tests
would go under `app/src/androidTest/` (placeholder dir exists for when we
add them).

## How the app boots

1. **Cold start** — `MainActivity.onCreate`:
   - If the intent is `ACTION_VIEW` with a `droplet://pair?…` data URL, the
     activity routes to `PairHandoffScreen` after the theme paints.
   - Else, routes through `Bootstrap` which checks
     `ServerRepository.servers` and forks to:
     - **`OnboardingScreen`** if zero paired Droplets (first install)
     - **`DashboardWebViewScreen`** otherwise

2. **Onboarding paths**:
   - `OnboardingScreen` → user picks Scan / Discover / Manual
   - `QrScannerScreen` decodes a `droplet://pair?…` QR → upserts the server
   - `DiscoveryScreen` lists `_droplet._tcp.local` services on the LAN
   - `ManualUrlScreen` validates raw input via `UrlValidator`

3. **Dashboard**:
   - `DashboardWebViewScreen` builds a WebView with the dashboard URL,
     enables JS / DOM storage / media playback, disables file access.
   - Tracks load progress, surfaces a Compose error screen on main-frame
     errors with Retry + Switch actions.
   - Hardware back routes through WebView history before activity finish.

4. **Multi-Droplet**:
   - Tap the swap icon in the top-right of the dashboard → `ServerSwitcherScreen`
   - Pick a different paired Droplet to switch the WebView origin.
   - Tap the **pencil** icon to rename the Droplet — e.g. "Living room" vs
     "Office". The rename is preserved across re-pair (a fresh QR scan of an
     already-known Droplet won't overwrite the name), enforced via the
     `ServerRepository.markPaired` helper.
   - Tap the **delete** icon to forget — removes the paired record AND
     clears cookies for that origin.

## Network policy

`res/xml/network_security_config.xml` allows cleartext only on:
- `.local` (mDNS)
- RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)

Public HTTPS uses the system trust store. The user's installed CA store is
also trusted *for LAN domains only* — so a customer can import the
appliance's self-signed root cert to get HTTPS on LAN during the gap
between unboxing and DDNS setup.

**TODO before GA:** once the appliance ships with a managed-PKI cert,
remove the cleartext exception and add cert pinning to the Warp Lab root.

## Pairing flow on the wire

Generated by `apps/orchestrator/src/routes/device-clients.ts`:

```
POST /api/devices/pair
  → { code, expiresAt, pairUrl }
  pairUrl = "droplet://pair?server=https%3A%2F%2Fdroplet.local&code=8E3QN3"

[user scans QR with this app]
  → MainActivity ACTION_VIEW intent
  → PairUrl.parse → upsert paired server
  → DashboardWebViewScreen loads https://droplet.local
  → WebView's pair completion page POSTs /api/devices/pair/claim
    with the session cookie set during dashboard login
```

The native shell does NOT call `/pair/claim` directly — that endpoint
requires the user's session, which lives in the WebView cookie jar. The
WebView's pair page already handles it.

## Integration with the monorepo

This module is intentionally **not** in `package.json`'s workspaces — Gradle
is the build system, not npm. But four convenience scripts are exposed at
the root for parity with the rest of the repo:

```bash
npm run android-app:build    # → :app:assembleDebug
npm run android-app:test     # → :app:testDebugUnitTest
npm run android-app:lint     # → :app:lintDebug
npm run android-app:bundle   # → :app:bundleRelease  (needs keystore env)
```

All four dispatch via `scripts/android-app.sh`, which detects whether JDK is
on PATH and prints an actionable hint if not — so Node-only contributors
aren't forced to install the Android toolchain.

The path-scoped `.github/workflows/android-app.yml` workflow is independent
of `turbo.json` (Gradle has its own dependency graph; reusing Turbo's task
graph would just add a layer of indirection). It triggers on changes under
`clients/android-app/**`.

## Architecture decisions worth knowing

### Why a Kotlin/Compose shell + WebView, not React Native or Capacitor

| Approach | Why we didn't pick it |
|---|---|
| **React Native** | Would let us reuse some React knowledge from the dashboard, but porting 30 pages of Next.js + SWR + HLS + react-markdown + qrcode is months of work. Lose feature parity the moment the dashboard ships a new page. |
| **Capacitor / Cordova / TWA** | Same WebView underneath, but adds a JS toolchain + Capacitor's own plugin system on top of Android Studio's tooling. The other native client (`clients/android/`, the Nextcloud fork) is already Kotlin, so two Kotlin engineers can share patterns and CI. |
| **Native Compose port** | 6+ months of duplicate UI work to match dashboard feature parity, then ongoing drift on every dashboard release. |
| **Kotlin/Compose shell + WebView** ← *chosen* | WebView renders the live dashboard at 100% parity. Native only handles QR scanning, mDNS, deep links, multi-server switching, push (future). New dashboard features ship without an app release. APK <10 MB. |

### Why not React Native's existing Nextcloud fork

`clients/android/` is for **file sync** (Nextcloud Android, AGPL). This app
is for **dashboard / control plane** — chat, cameras, network admin,
Matter, etc. They have different bundle IDs (`com.warplab.droplet.files`
vs `ai.warplab.droplet`) and ship side-by-side. Users install both for
the full experience.

### Why the WebView reloads when returning from the switcher

Compose Navigation removes a destination's composable from composition
when you navigate away. `remember`-scoped state is wiped, so the WebView
rebuilds when the user returns. We accept this trade-off because the
appliance's HTTP cache + the dashboard's SWR hot cache make the reload
mostly indistinguishable from an in-place refresh.

A real fix would be to host the WebView in an `androidx.lifecycle.ViewModel`
scoped above the NavHost, but Android lifecycle + WebView interaction has
known leak patterns (ViewModel survives config change → can outlive the
Activity context the WebView captured). We're leaving that refactor for a
follow-up PR where it can get its own design review.

## Remaining work — external dependencies

These can't be done from this codebase alone:

| Task | Blocked on |
|---|---|
| Wire FCM push notifications | (a) Firebase project + `google-services.json` (b) orchestrator `POST /api/devices/clients/{id}/push-token` route + topic registration |
| Tighten network security to pin Warp Lab managed PKI root | Managed-PKI rollout shipping with the appliance |
| Replace placeholder launcher icon | Romain's brand book |
| HTTPS App Links (`pair.warp-lab.ai`) | (a) `.well-known/assetlinks.json` published (b) `PairUrl.parse` extended to accept the HTTPS form |
| Hold WebView across navigation (no reload on switcher round-trip) | Design review on ViewModel-scoped WebView lifecycle |
| Instrumented tests (Espresso/Compose UI) | Emulator on CI; out of scope for v0.1 |

## TODO / known stubs in this codebase

| File | What's stubbed | Action when ready |
|---|---|---|
| `app/src/main/res/drawable/ic_launcher_foreground.xml` | Placeholder droplet teardrop | Replace SVG path with Romain's asset |
| `push/DropletFcmService.kt` | Class body commented out (no `: FirebaseMessagingService()` base) | Uncomment + add `google-services.json` per linked external task |
| `network_security_config.xml` | Cleartext + user CAs allowed on LAN | Drop the `<domain-config>` block; add `<pin-set>` for the managed-PKI root |
| `gradle/wrapper/gradle-wrapper.jar` | Not checked in | CI regenerates via `gradle wrapper` per run; Android Studio sync generates locally |
| `app/src/androidTest/` | Empty dir | Add Compose UI tests once emulator is on CI |
