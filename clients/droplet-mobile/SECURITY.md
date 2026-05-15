# Security model — Droplet Mobile

This document describes how `clients/droplet-mobile/` (the native Android +
iOS app) handles secrets, what it stores, and what it deliberately does
*not* try to defend against. Read alongside the per-platform
`CredentialStore` implementations.

## What gets stored

Exactly one persisted blob per platform — the `DropletSession` JSON:

```json
{
  "serverUrl":   "https://droplet.local",
  "username":    "stefan",
  "displayName": "Stefan",
  "deviceId":    "dc_…",
  "deviceName":  "Pixel 8 (Stefan)",
  "webdavUrl":   "https://droplet.local/nextcloud/remote.php/dav/files/stefan/",
  "appPassword": "xxxxx-yyyyy-zzzzz"
}
```

- `appPassword` is the **per-device** Nextcloud app password minted by the
  orchestrator at pair time. The plaintext is returned **once** by
  `POST /api/devices/pair/claim`; the server never returns it again.
- `appPassword` is **not** the user's login password. Login flow is
  username + password → `POST /api/auth/login` → session cookie (in
  memory, lifetime of the `PairingRepository`). The cookie is never
  persisted; only the minted app password is.
- `appPassword` is scoped to this device only. Forgetting the device on
  the dashboard revokes it server-side; further WebDAV calls 401.

## Where it's stored

| Platform | Mechanism | Master key |
|----------|-----------|------------|
| Android  | `EncryptedSharedPreferences` (Tink) file `droplet_session.xml` | AES-256-GCM, generated and sealed in the AndroidKeyStore (`MasterKey.KeyScheme.AES256_GCM`) on first launch |
| iOS      | `KVault` → `Keychain Services` `kSecClassGenericPassword` entry service=`com.droplet.mobile.session`, account=`session_v1` | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — readable only after the user has unlocked the device once after reboot; never synced to iCloud Keychain |

Both stores are also opted out of:

- **Cloud backup** (Android: `android:allowBackup="false"` + explicit
  exclusion in `backup_rules.xml` and `data_extraction_rules.xml`).
- **Device-to-device transfer** (Android: same `data_extraction_rules.xml`
  `device-transfer` exclude; iOS: `…ThisDeviceOnly` Keychain attribute).

Re-pairing on a new device is the supported workflow — the old session
just sits revoked-on-server until the dashboard cleans it up.

## What never gets stored

- The user's **login password.** It only lives in memory inside the
  `PairFlowViewModel` while the form is on screen; it's gone the moment
  the view-model is cleared.
- The **session cookie** from `/api/auth/login`. Held in Ktor's
  `HttpCookies` in-memory jar bound to the `PairingRepository`. Repository
  is discarded after pair completes.
- The **scanned pair code.** Surfaced in the nav arg URL while the user
  is on the PairFlow screen; not persisted.

## TLS trust policy

- **Debug builds** (`./gradlew :androidApp:assembleDebug`): trust any
  certificate served by the hostname the app is pairing against. This is
  the only way a fresh install can pair against a LAN Droplet whose
  self-signed certificate isn't yet in the device's trust store. Gated
  by the generated `BuildConfig.ALLOW_SELF_SIGNED` constant; there is no
  runtime opt-in.
- **Release builds**: platform CA only. The Droplet must serve a
  CA-validated certificate — DuckDNS + Let's Encrypt or a private CA
  that the device already trusts.

The TLS allow-list is per-hostname, not blanket trust-all. The
`OkHttp.hostnameVerifier` rejects certificates from any host outside
the allow-list even in debug.

## Threat model

What this app defends against:

- **Lost or stolen device.** The credential blob is encrypted at rest;
  an attacker who pulls the prefs file off a bricked phone can't read
  the `appPassword` without the AndroidKeyStore master key (or iOS Secure
  Enclave).
- **App-level data exfiltration.** Other apps on the device can't read
  the encrypted prefs / Keychain entry — Android's per-app sandbox and
  iOS's Keychain ACL gate access.
- **Cloud backup leak.** The blob is excluded from Google One backup,
  Auto Backup, and iCloud Keychain sync.
- **Replay after revoke.** Once a device is forgotten in the dashboard,
  the orchestrator's `DELETE /api/devices/clients/:id` revokes the
  `appPassword` upstream in Nextcloud. Further WebDAV calls 401 even if
  the client still holds the plaintext.

What this app does **not** defend against:

- **Rooted / jailbroken devices.** AndroidKeyStore + iOS Secure Enclave
  are bypassable on rooted devices by an attacker with hardware-level
  access. Out of scope for v1; high-assurance users should pair from a
  managed device.
- **Compromised dashboard session.** If an attacker has the user's
  Nextcloud password they can generate a new pair code, pair their own
  device, and read the same files. This is by design — the device
  pairing flow inherits dashboard trust.
- **MitM on initial pair with self-signed acceptance** (debug builds
  only). An attacker on the LAN with a malicious self-signed cert could
  intercept the pair flow in debug. Release builds eliminate this by
  enforcing platform CA.
- **Network traffic analysis.** WebDAV traffic is HTTPS but the
  filenames + sizes are observable inside the encrypted channel
  metadata leaks (request paths, response sizes). No padding.

## Lifecycle

```
user pairs:
  → POST /api/auth/login (password in memory, cookie set in memory)
  → POST /api/devices/pair/claim (server mints appPassword, returns it once)
  → CredentialStore.save(session)   ← only the appPassword persists from here
  → PairingRepository.close() (cookie jar GC'd)

user uses the app:
  → CredentialStore.load() → DropletSession
  → WebDAV calls with Basic auth = (username, appPassword)

user forgets device:
  → CredentialStore.clear()
  → Optional: DELETE /api/devices/clients/:id (TODO — implement before v2)
```

## Things still TODO before any production release

- [ ] Wire `DELETE /api/devices/clients/:id` into the Forget flow so the
      app password is revoked server-side, not just deleted client-side.
- [ ] Audit ProGuard / R8 output for unintentional leaks — confirm
      `appPassword` strings don't end up in stack traces in release builds.
- [ ] Add screenshot protection (`FLAG_SECURE` on PairFlowScreen so the
      password field is redacted in the recent-apps card).
- [ ] iOS biometric gate (`LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`)
      before reading the Keychain entry, so face/touch is required to
      open the app after first launch.
- [ ] Rotate the AndroidKeyStore master key on a schedule (`MasterKey`
      doesn't currently expose rotation; need to re-encrypt the blob
      under a new key periodically).
- [ ] Decide whether to ship a `network_security_config.xml` cert
      pinning bundle for known Droplet CAs in release builds.

## Reporting a vulnerability

If you find a security issue in this client, do **not** open a public
GitHub issue. Email `security@warp-lab.com` instead; we'll work with you
on disclosure timing.
