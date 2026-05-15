# Droplet Mobile

Native Android + iOS clients for a Droplet, written from scratch. Kotlin
Multiplatform shared module talks to the orchestrator's REST API for
pairing and to the user's Nextcloud WebDAV mount (mediated by the Droplet's
Nginx) for files and uploads. **Not a Nextcloud fork** — no AGPL
inheritance, no upstream overlay, no rebranded UI. The repo is MIT-licensed.

## What's in here

```
clients/droplet-mobile/
├── settings.gradle.kts            Includes :shared and :androidApp
├── build.gradle.kts
├── gradle.properties
├── gradle/libs.versions.toml
│
├── shared/                        Kotlin Multiplatform
│   └── src/
│       ├── commonMain/
│       │   ├── DropletPairUri / DropletApiClient / PairingRepository
│       │   ├── DropletSession                  (persisted credentials)
│       │   ├── CredentialStore / DeviceInfo / HttpClientFactory  (expect)
│       │   └── files/
│       │       ├── WebDavClient                (PROPFIND / GET / PUT / MKCOL)
│       │       ├── PropFindParser              (regex-based multistatus walker)
│       │       ├── WebDavEntry                 (path + metadata)
│       │       └── FilesRepository             (session-aware façade)
│       ├── commonTest/             URI parser, PROPFIND parser, MockEngine API
│       ├── androidMain/            OkHttp engine, EncryptedSharedPreferences,
│       │                           Build.MODEL device naming
│       └── iosMain/                Darwin engine, KVault-backed Keychain store
│
├── androidApp/                    Kotlin + Compose + Material 3
│   ├── ui/
│   │   ├── welcome/                First-launch landing
│   │   ├── scan/                   CameraX + ML Kit QR
│   │   ├── pairflow/               Sign-in + claim, ONE viewmodel/repo
│   │   ├── home/                   Post-pair hub: files + upload + unpair
│   │   ├── files/                  WebDAV browser + download-to-Downloads
│   │   ├── upload/                 Photo Picker → WebDAV PUT
│   │   └── theme/                  Material 3 palette
│   ├── di/AppModule.kt             Koin bindings
│   └── res/                        Strings, theme, adaptive icon, backup rules
│
└── iosApp/                        SwiftUI shell — generated via xcodegen
    ├── project.yml                 xcodegen spec
    └── iosApp/
        ├── iosAppApp.swift         @main entry
        ├── AppCoordinator.swift    State machine + KMP bridging
        ├── ContentView.swift       Switch over Route
        └── Views/                  WelcomeView, ScanView, PairFlowView, PairedView
```

## Building

### Android

```pwsh
cd clients/droplet-mobile
gradle wrapper --gradle-version 8.11.1   # first time only — generates gradlew.jar
./gradlew :shared:allTests
./gradlew :androidApp:assembleDebug
# → androidApp/build/outputs/apk/debug/androidApp-debug.apk
```

### iOS (requires a Mac with Xcode)

```bash
brew install xcodegen
cd clients/droplet-mobile/iosApp
xcodegen generate
open iosApp.xcodeproj
```

The Run scheme has a pre-build phase that asks Gradle to embed
`DropletShared.framework` into the iOS bundle via `:shared:embedAndSignAppleFrameworkForXcode`.
First-time builds take a few minutes; incremental ones are fast.

### Release signing (Android)

Set four env vars (CI) or properties in `~/.gradle/gradle.properties`
(local — outside the repo):

```
DROPLET_KEYSTORE_PATH=/path/to/droplet-release.jks
DROPLET_KEYSTORE_PASSWORD=…
DROPLET_KEY_ALIAS=…
DROPLET_KEY_PASSWORD=…
```

If any of them are missing the release build still completes — it just
produces an unsigned APK, useful for CI compile-checks.

## What the app does (v1.5)

| Screen | Purpose |
|--------|---------|
| Welcome | First-launch landing — explains the value, single Pair CTA |
| Scan | CameraX + ML Kit QR scanner. droplet:// deep links skip this screen |
| PairFlow | Sign-in form + `/api/auth/login` + `/api/devices/pair/claim` in one VM (one cookie jar) |
| Home | Hub for paired users: account card + Files + Upload + Unpair |
| Files | WebDAV PROPFIND-driven file browser, taps drill into folders, download button writes to system Downloads |
| Upload | Android Photo Picker (no permission needed) → WebDAV PUT to `Photos/<name>` |

## Wire-level contracts

### Orchestrator REST (pair flow)

```
POST /api/auth/login                { username, password }
                                    → 200 + Set-Cookie: droplet_session

POST /api/devices/pair/claim        { code, deviceName, appVersion }
                                    → 200 { deviceId, ncUsername, webdavUrl, appPassword }
```

The cookie set by login is sent automatically on the claim call via Ktor's
`HttpCookies` plugin. Status-code → typed-exception mapping lives in
`DropletApiClient.kt` (every 4xx is its own `data object`).

### WebDAV (post-pair)

Basic auth using the per-device `appPassword` minted by the claim. URL is
the `webdavUrl` returned at claim time (e.g. `https://droplet.local/nextcloud/remote.php/dav/files/<user>/`).

```
PROPFIND <webdavUrl>/<path>         Depth: 1 → multistatus XML
GET      <webdavUrl>/<path>         → file body
PUT      <webdavUrl>/<path>         → 201/204
MKCOL    <webdavUrl>/<path>         → 201/405 (already exists)
```

`PropFindParser` is a deliberately-narrow regex-based walker — it handles
Nextcloud's namespace prefix variations + entity-escaped names + URL-
encoded segments, but isn't a general XML parser.

## TLS trust policy

- **Debug** (`assembleDebug`): trusts any cert served by the paired
  Droplet's hostname. Lets a fresh install pair against a LAN Droplet
  whose self-signed cert isn't in the device's trust store.
- **Release** (`assembleRelease`): platform CA only. The Droplet must
  have a DuckDNS-issued Let's Encrypt cert (or a private CA the device
  trusts) for production traffic.

Gated by the generated `BuildConfig.ALLOW_SELF_SIGNED` constant + the
OkHttp engine's `hostnameVerifier`. There's no runtime opt-in.

## Storage

| Platform | Where | What |
|----------|-------|------|
| Android  | EncryptedSharedPreferences `droplet_session` | One JSON blob — AES-256 GCM, AndroidKeyStore master key |
| iOS      | KVault → Keychain Services `com.droplet.mobile.session` | One JSON blob — `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no iCloud Keychain sync |

Both stores are excluded from cloud backup and device-to-device transfer.

## Auto-upload (Android)

Watermark-driven WorkManager job. **Watch mode only — does not back-fill
history** on first enable. The watermark starts at `now`; only photos
with `MediaStore.DATE_ADDED >= watermark` are eligible.

```
PhotoUploadWorker (every 6h, UNMETERED + battery-not-low)
  → AutoUploadSettings.lastRunAtSeconds()
  → PhotoEnumerator.queryImagesSince(watermark)
  → for each photo:
      • setForeground(progress notif)
      • FilesRepository.upload("Photos/<displayName>", bytes, mime)
      • on success: bump watermark to that photo's DATE_ADDED + 1
  → settings.setLastSuccessAtSeconds(now)
```

The watermark advances **after each successful PUT** so a killed run
loses at most one in-flight file. WebDAV PUTs are idempotent (replace),
so any re-upload simply overwrites the same path — no duplicates.

UI: `UploadScreen` has an "Auto-upload new photos" card at the top with
a Switch, last-sync timestamp, and "Run now" button. First flip-on
triggers a permission rationale + request for `READ_MEDIA_IMAGES` (or
`READ_EXTERNAL_STORAGE` on pre-13) and `POST_NOTIFICATIONS`. Manual
picker still ships below for one-off uploads.

## What's NOT here yet

- **iOS file download.** The shared `FilesRepository.download(path)`
  returns Ktor's `ByteReadChannel`; Swift can call it but the bridge
  to write into `FileManager.urls(for: .documentDirectory)` needs an
  iosMain helper (likely `FilesRepository.downloadToFile(remote, local)`)
  that this pass skipped.
- **iOS auto-upload.** No PHPicker-style background watcher; the iOS
  shell ships manual upload only. `BGTaskScheduler` + `PHPhotoLibrary`
  observer is the path forward.
- **Two-way sync** — clearly v2+. Architecture is download-on-demand
  only.
- **Push notifications** — explicitly out of scope per the
  "no webhooks" project doctrine.
- **Server-side device revoke on Forget** — the client currently
  clears local credentials but doesn't `DELETE /api/devices/clients/:id`.
  Tracked in [SECURITY.md](SECURITY.md).

## Notes for someone picking this up

- The `PairingRepository` is intentionally short-lived (one per pair
  flow). Each instance has its own Ktor `HttpClient` + cookie jar.
- The `FilesRepository` is rebuilt every time you enter the Files,
  Upload, or auto-upload Worker — that picks up the current paired
  session's URL + TLS allow-list. Switching paired Droplets just works.
- `PropFindParser` returns a "self" entry for the directory the user
  PROPFIND'd. `WebDavClient.list` strips it before handing entries
  to the UI.
- `PhotoUploadWorker` uses `KoinComponent` + `inject()` for its deps
  (FilesRepository, AutoUploadSettings). WorkManager constructs the
  worker itself; Koin's `koin-androidx-workmanager` artifact is on
  the classpath in case the worker DSL is needed later.
- `AutoUploadSettings.lastRunAtSeconds()` and `MediaStore.DATE_ADDED`
  are both seconds-since-epoch (NOT milliseconds). The DataStore key
  is named explicitly to remind future-you.
