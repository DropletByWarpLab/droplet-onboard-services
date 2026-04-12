# Droplet Native Clients

Custom-branded forks of the Nextcloud desktop, iOS, and Android clients.

Each client is an AGPL-3.0 fork with a **minimal rebrand overlay** — we change
icons, colors, strings, bundle IDs, and the `droplet://` URL scheme, but keep
the sync engine and all features from upstream. Features come from upstream;
the overlay is purely cosmetic + onboarding.

## Directory structure

```
clients/
├── desktop/    Qt6/C++ — fork of github.com/nextcloud/desktop
│   ├── overlay/         Brand override files
│   └── .github/         CI workflows
├── ios/        Swift — fork of github.com/nextcloud/ios
│   ├── overlay/         Brand override files
│   └── .github/         CI workflows
└── android/    Kotlin — fork of github.com/nextcloud/android
    ├── overlay/         Brand override files
    └── .github/         CI workflows
```

## Setup

1. **Fork the upstream repos** into your GitHub org:
   - `nextcloud/desktop` → `your-org/droplet-desktop`
   - `nextcloud/ios` → `your-org/droplet-ios`
   - `nextcloud/android` → `your-org/droplet-android`

2. **Apply the overlay** from this directory by copying the files into the fork.
   Each `overlay/` dir contains only the files that differ from upstream.

3. **Build + publish** via the GitHub Actions workflows in `.github/workflows/`.

## AGPL-3.0 obligations

All three Nextcloud clients are AGPL-licensed. This means:

- **Publish the fork source** on GitHub from day 1
- **Link to the source** from each client's About dialog
- **Ship the AGPL text** in installers and App Store metadata

## Sync protocol

All three clients speak **WebDAV + OCS** natively. They connect to
`https://<droplet>/nextcloud/` via the Nginx gateway. No custom protocol
work is needed — the orchestrator's `/nextcloud/` reverse proxy passes
`/remote.php/dav/` through unchanged.

## `droplet://` URL scheme

Each platform registers a `droplet://` URL scheme so the dashboard's QR code
pairing flow can hand off to the native client:

```
droplet://pair?server=https://droplet.local&code=8E3QN3
```

The client parses this URL, pre-fills the server field, and completes pairing
by calling `POST /api/devices/pair/claim` with the code + user credentials.
