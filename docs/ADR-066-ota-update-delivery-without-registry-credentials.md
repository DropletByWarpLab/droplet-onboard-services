# ADR-066: OTA updates are delivered anonymously; integrity comes only from signatures

> **Superseded by [ADR-068](ADR-068-fleet-identity-private-ota-and-telemetry.md) (2026-10-03).** The images stay private, and boxes pull them from a read-only HQ registry with a device-authenticated token. Decisions §1 and §3–§6 below still hold; §2 (public packages) and the "no device identity" privacy consequence do not.

- **Status:** Superseded by ADR-068, 2026-10-03: Romain withdrew anonymous delivery ("I don't want our images public for now", WARP-3423 comment 15566). Previously Accepted, 2026-10-01, by Romain Jouffret ("go public, run the secret scan first. Build the whole system for update so we can use it on all machines now.") — [WARP-3423](https://warp-lab.atlassian.net/browse/WARP-3423), implemented by [WARP-3429](https://warp-lab.atlassian.net/browse/WARP-3429) (publish side, #2570) and [WARP-3430](https://warp-lab.atlassian.net/browse/WARP-3430) (box side, #2571), on top of [WARP-3419](https://warp-lab.atlassian.net/browse/WARP-3419) (#2566).
- **Builds on:** [`ADR-020`](ADR-020-appliance-image-build-and-flash-pipeline.md) (signed manifest), [`ADR-028`](ADR-028-fleet-telemetry-and-design-answers.md) (signed update channel, no Warp servers), [`ADR-045`](ADR-045-client-app-distribution.md) ("no GitHub token may ever sit on a customer appliance"), WARP-1670 (stage / stable channels), [`SECURITY.md`](SECURITY.md#supply-chain).
- **Number:** 061–063 are claimed by open PRs and 064 by the voice-authority draft (WARP-3328); this takes 066. Re-check before merge.

## Context

On 2026-10-01 the test box could not install `ota-stage-404-g3c71b82` through the product path, for two independent reasons, and every earlier stage "first hop" had been a local build that hid both:

1. **The apply looked the release up on `/releases/latest`**, which skips prereleases — and every stage release is one (WARP-3419).
2. **The release images are private on GHCR and no box has a credential.** The helper authenticates only when `DROPLET_OTA_GITHUB_TOKEN` is set; nothing provisions it, and ADR-045 forbids it. The registry answered `401`, which the apply then misreported as `image_signature_failed` (WARP-3423).

Research done the same day (industry survey, registry options, update-security literature, and a map of our own code):

- **No vendor's integrity depends on the download credential.** Open and prosumer appliances (Home Assistant OS, Umbrel, TrueNAS, UniFi) serve public signed artifacts; commercial vendors that sell updates as an entitlement (Fortinet, Foundries.io, AWS Greengrass) gate the download with a short-lived credential minted from the device's own key. A static credential copied onto every device (Azure IoT Edge, Portainer Edge) is the pattern to avoid.
- **GHCR cannot mint a short-lived pull credential.** GitHub App installation tokens are refused for pulls and fine-grained tokens have no Packages permission; only a long-lived classic PAT works. A "portal exchanges the TPM key for a GHCR token" broker is therefore impossible.
- **The GitHub REST API is the wrong discovery channel for a fleet:** unauthenticated it allows 60 requests per hour per IP, so about 15 boxes behind one office NAT exhaust it.
- **The source is already public** (`droplet-onboard-services`), and a static audit of `publish-release.yml` found no secret passed into any image build. Keeping the images private hides nothing the repository does not already show.

## Decision

### 1. Integrity comes from signatures; the transport carries no credential

What a box trusts is unchanged and fully offline: the cosign-signed `release.json` (key baked into the image), the per-image keyless signatures verified offline against the `publish-release.yml@refs/heads/(main|stage)` identity, and the channel inside the signed manifest. Every download is anonymous HTTPS. No box holds a registry or GitHub credential.

### 2. First-party images are public on GHCR

- **The gate before a package is flipped:** every version it holds is secret-scanned and the findings triaged — config (Env and build history), every layer extracted on its own, signatures and attestations — with the repo's pinned gitleaks (`ghcr-secret-scan.yml`, `scripts/release/scan-ghcr-secrets.py`). Making a package public is irreversible and exposes all its versions, hence all of them.
- **State on 2026-10-02:** all 25 packages scanned (about 3,500 versions). `droplet-ai-gateway` needed eight parallel shards plus a rescan of three versions a connection reset had skipped; every version now scanned with no errors. No package is public yet. Triage found no credential. Every hit is one of: a fake key in a compiled test file whose source is already in the public repository; the official Python base image's `GPG_KEY`, the public fingerprint of the CPython release-signing key; a false match in third-party files or compiled code; or the per-build Next.js keys below.
- **Per-build Next.js keys in `droplet-web-dashboard`:** `.next/prerender-manifest.json` (`previewModeId`, `previewModeSigningKey`, `previewModeEncryptionKey`) and `.next/server/server-reference-manifest.json` (`encryptionKey`) are generated by every build and shipped in the image. They protect draft/preview mode and Server Action closures, and the dashboard uses neither: no `"use server"` module, no `draftMode()` or preview data, no `serverActions` config. So publishing them exposes nothing an attacker can use today, and every box already shares the same value because every box runs the same image. **Decision for Romain before `droplet-web-dashboard` goes public:** accept on that basis (recommended), with a guard test that fails the build if either feature is ever introduced without the key being supplied per box (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`) — or hold that one package private until the guard exists.
- Every publish scans each image **before** it is pushed and fails on a non-vendor finding not in the reviewed baseline (`scripts/release/image-secret-baseline.txt`). A real secret is rotated, never baselined. The base image's `GPG_KEY` is allow-listed in the image gitleaks config by its exact shape (40 hex characters), not in the baseline, and config findings fingerprint per variable, so a baseline line can never excuse a whole image config.
- Every publish fails, before the release exists, if any package does not hand out an anonymous pull token. A new service whose package is still private can therefore never silently break OTA for the fleet; the fix is a one-time "make public" click in the package settings.

### 3. Discovery is a signed channel pointer at a fixed download URL

`publish-release.yml` maintains a rolling prerelease, `ota-index` (never `latest`, and outside the `ota-<channel>-` tag prefix older pollers filter on). After a release is fully created it uploads `channel-<channel>.json` and its cosign signature (same key as `release.json`):

```json
{"schemaVersion":1,"kind":"droplet-ota-channel-pointer","channel":"stage","tag":"ota-stage-…","gitSha":"…","builtAt":"…","manifestSha256":"…","publishedAt":"…"}
```

The box fetches `<DROPLET_OTA_DOWNLOAD_BASE>/ota-index/channel-<channel>.json`, verifies it with the same anchor as the manifest, requires its channel to be the box's, then fetches `<base>/<tag>/release.json` and requires its sha256 to equal `manifestSha256`. A pointer and a manifest can never parse as each other. Only a `404` on the pointer (the index not yet published) falls back to the old API discovery.

### 4. Every release file is a plain download by tag

`configs.tar.gz` and client installers come from `<base>/<tag>/<name>` — no REST API, no `latest`, and a row with no tag is a transient retry rather than a guess.

### 5. A box never moves backwards

The poller refuses a release whose signed `builtAt` is not strictly newer than the newest installed (`committed`) release, so a replayed older pointer cannot downgrade a box. The apply re-checks the same floor and the box's channel before any side effect, and retires a row that fails it, because a row can sit parked between creation and install (for example while a package is still private) and a newer release may have installed meanwhile. The poller also retires unclaimed parked rows older than the release it is about to offer. A box with no installed release (a local build) has no floor.

### 6. A refused registry login is not a bad signature

The helper prints `registry-auth:` when the registry answers 401/UNAUTHORIZED/DENIED; the apply treats it as a transient retry with its own event (`update.registry_auth_failed`). `image-verify:` stays reserved for a real signature refusal.

## Consequences

- **Egress:** a box needs `github.com` (release downloads), the release-asset CDN, `ghcr.io` and `pkg-containers.githubusercontent.com` — recorded in `docs/security/allowed-egress.yaml`.
- **Privacy:** an update check sends no device identity; GitHub sees an IP and a time. That is the honest reading of "never phones home" for updates.
- **No per-device revocation or entitlement.** Anyone can download a release. If updates must stop when a lease ends, or the images must become private again, the path is a registry we run (Zot or Distribution on object storage) that accepts a short-lived token our portal mints after a TPM proof — which needs the real TPM backend, not `mock`. That would be its own ADR.
- **Existing boxes need one manual hop.** A box running code from before #2571 cannot follow the pointer; it reaches the new code once by local build (as the test box did on 2026-10-01) or by a one-off `DROPLET_OTA_RELEASES_URL` override to the release's by-tag URL.

## Not decided here (follow-ups)

- Third-party images and AI models still come from Docker Hub by tag and have no update path; mirror them under our namespace, pin by digest and list them in the signed manifest (Docker Hub allows 100 anonymous pulls per 6 hours per IP).
- Metadata freshness and key rotation: an expiry on the pointer and a TUF-style root (tuf-on-ci) so a frozen mirror and a lost key are both recoverable.
- The manifest key is a CI secret; ADR-028 says it belongs on hardware keys with a human present.
- First install clones the default branch and builds locally; it should install from a signed release through the same path.
- `services/fleet-agent/update_poll.py` still uses the API discovery.
- Host OS, NVIDIA driver and firmware updates are outside the manifest.

## Alternatives considered

| Option | Why not |
|---|---|
| A GitHub token on every box | Forbidden by ADR-045; extractable, long-lived, shared, tied to a GitHub account. |
| Portal mints a short-lived GHCR token | GHCR refuses every short-lived token type. |
| Our own registry gated by TPM-minted tokens | Right answer if images must be private or gated; deferred until it is needed and the TPM backend is real. |
| Managed cloud registries (ECR, ACR, Artifact Registry) | About $650–1,000 of egress per release at 1,000 boxes, plus a cloud identity on every box. |
