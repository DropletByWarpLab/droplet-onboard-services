# Droplet native clients

Three platforms, two strategies:

| Platform | Strategy | Location |
|----------|----------|----------|
| Android  | **Native from-scratch** (Kotlin + Compose, KMP-ready) | [`droplet-mobile/`](./droplet-mobile/) |
| iOS      | Branded fork of [`nextcloud/ios`](https://github.com/nextcloud/ios) | [`ios/overlay/`](./ios/overlay/) |
| Desktop  | Branded fork of [`nextcloud/desktop`](https://github.com/nextcloud/desktop) | [`desktop/overlay/`](./desktop/overlay/) |

The desktop + iOS clients are AGPL-3.0 forks with a minimal rebrand overlay
(icons, colors, strings, bundle IDs, `droplet://` URL scheme); the sync
engine and feature set come from upstream. See each platform's `overlay/`
directory for the override files.

The Android client was **rewritten as a native app** — see
[`droplet-mobile/README.md`](./droplet-mobile/README.md) for architecture,
the REST contract it speaks against the orchestrator, and the build
instructions. The shared module is set up for Kotlin Multiplatform so iOS
can migrate off the Nextcloud fork when the feature parity gap closes.

## `droplet://` URL scheme

All three platforms register a `droplet://` URL scheme so the dashboard's
QR-code pairing flow can hand off to the native client:

```
droplet://pair?server=https://droplet.local&code=8E3QN3
```

Each client parses this URL, runs the user through sign-in, and completes
pairing by calling `POST /api/devices/pair/claim` with the code + the
user's session cookie.

## AGPL-3.0 obligations (iOS + Desktop only)

Because both clients are AGPL-licensed Nextcloud forks:

- **Publish the fork source** on GitHub from day 1
- **Link to the source** from each client's About dialog
- **Ship the AGPL text** in installers and App Store metadata

The new Android client is MIT-licensed and carries no AGPL inheritance.

## Sync protocol (iOS + Desktop)

The Nextcloud-derived clients speak **WebDAV + OCS** natively. They connect
to `https://<droplet>/nextcloud/` via the Nginx gateway. No custom protocol
work is needed — the orchestrator's `/nextcloud/` reverse proxy passes
`/remote.php/dav/` through unchanged.

The native Android client uses the orchestrator's first-party REST API
(`/api/auth/login`, `/api/devices/pair/claim`) for pairing; file APIs will
follow the same JSON-over-HTTPS shape rather than re-implementing WebDAV.
