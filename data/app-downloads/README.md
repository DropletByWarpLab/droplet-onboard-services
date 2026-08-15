# Client-app downloads — staging directory

This is where the Droplet client apps (Windows installer, Android APK, iOS
build) are staged so the box can serve them to a browser at `/downloads`.

The apps ship **inside the appliance image**. Nothing here is fetched from
the internet at runtime, which is the point: a customer on a LAN with no
internet can still install the client app for the box in front of them.

## How it works

```
data/app-downloads/            →  mounted read-only at /opt/droplet/app-downloads
  platforms.json               →  hand-authored: versions, store URLs, notes
  catalog.json                 →  GENERATED — pins every asset's size + sha256
  windows/
    Droplet_0.2.0_x64-setup.exe
    Droplet_0.2.0_x64-setup.exe.sig   (Tauri minisign envelope, optional)
    latest.json                        (Tauri updater manifest, optional)
  android/ ios/ macos/ linux/          (same shape, all optional)
```

The orchestrator (`services/app-downloads/store.ts`) re-hashes an asset
against its `catalog.json` digest **before serving a single byte**, and
refuses on mismatch. Running the generator is therefore what makes an
artifact servable at all — a binary dropped in here without regenerating
the catalog will not be served.

## Staging an artifact

1. Build the installer in its own repo (`droplet-windows`, `droplet-android`).
2. Copy it into the matching platform directory here.
3. Copy `platforms.example.json` to `platforms.json` and set the version.
4. Generate the catalog:

```bash
node scripts/app-downloads/gen-catalog.mjs --dir data/app-downloads
```

5. Verify it is current (this is also the image-build / CI guard):

```bash
node scripts/app-downloads/gen-catalog.mjs --dir data/app-downloads --check
```

`--check` exits non-zero when the staged bytes disagree with the catalog,
which is what stops a stale catalog shipping next to swapped binaries.

## What is and isn't committed

Installers are binaries built from other repos — they are **git-ignored**
here and staged by the image build. Only `.gitignore`, this README, and
`platforms.example.json` are tracked. A dev checkout therefore mounts an
effectively empty directory, and `/downloads` honestly reports that no
apps are staged rather than erroring.

## Trust model — read before "hardening" this

Two gates, and it matters which one is load-bearing:

- **Digest (always on, fail-closed).** Every byte is re-hashed against the
  catalog pin at serve time. The artifacts ship with the appliance image
  and are mounted read-only, so that image is the trust root; the box's
  remaining job is proving the bytes it hands over are the bytes that
  shipped. This gate works today.

- **Cosign signature over `catalog.json` (opt-in, off by default).**
  Enabled with `DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE=1`. It is off on
  purpose: the OTA trust anchor is still the WARP-535 placeholder, so
  turning it on before the key ceremony makes **every download a 503**.
  The flag exists so the ceremony can upgrade the posture without a code
  change — and so the UI never claims "signed" for something nobody
  verified.

The Windows `.sig` is the **Tauri updater's minisign envelope** (key
`F5E6E366DCF9B85E`). It is declared, digest-checked and served verbatim,
but the box never verifies it: Ed25519 is forbidden on-box by
`docs/security/fips-allowed-algorithms.md` without a registered
exception, and the box has no reason to hold that opinion. That signature
exists for the *client's own updater* and for a customer who wants to
verify the download independently before running it.
