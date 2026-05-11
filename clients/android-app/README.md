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

```bash
cd clients/android-app
./gradlew :app:assembleDebug
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

Install on a connected device:

```bash
./gradlew :app:installDebug
```

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
   - "Forget" removes the paired record AND clears cookies for that origin.

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

This module is intentionally **not** in `package.json`'s workspaces. Gradle
is the build system; the root Turborepo doesn't know about it. The
`.github/workflows/android-app.yml` workflow is independent and triggers on
changes under `clients/android-app/**`.

If you want a one-shot "build everything" command at the repo root, add
something like:

```jsonc
// turbo.json
{
  "tasks": {
    "android-app:build": {
      "cache": false,
      "outputs": ["clients/android-app/app/build/outputs/**"]
    }
  }
}
```

…plus a top-level `package.json` script that shells out to gradlew. Left
out for now because it'd require Java on every node-only contributor's
machine.

## TODO / known stubs

| File | What's stubbed | Why |
|---|---|---|
| `app/src/main/res/drawable/ic_launcher_foreground.xml` | Placeholder droplet teardrop | Brand asset pending Romain |
| `push/DropletFcmService.kt` | Class disabled | Needs `google-services.json` + orchestrator `POST /push-token` route |
| `network_security_config.xml` | Cleartext + user CAs for LAN | Tighten once managed PKI ships |
| `gradle/wrapper/gradle-wrapper.jar` | Not checked in | Generate via `gradle wrapper` on first build |
| `app/src/androidTest/` | Empty | Add instrumented tests post-MVP |
