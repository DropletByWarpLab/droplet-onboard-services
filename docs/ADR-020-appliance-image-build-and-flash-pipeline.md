# ADR-020: Appliance image build + versioned flash pipeline

- **Status:** Accepted — shipped (status corrected 2026-07-27; see Status audit below)
- **Date:** 2026-06-04
- **Authors:** Stefan Cruceru
- **Related tickets:** WARP-663 (this ticket — Phase 1); ROADMAP **M2.8** (SD card image — this ADR resolves its "architecture call" blocker); ROADMAP **M3.4** (OTA — this ADR defines the manifest/verify substrate it builds on); WARP-244 (cosign release signing — the signing upgrade path); WARP-229 (OpenSSL FIPS provider — why ECDSA-P256 is available host-side).
- **Related ADRs:** [ADR-011](ADR-011-hardware-agnostic-codebase.md) (hardware-agnostic codebase — the image must carry no host-specific defaults); [ADR-018](ADR-018-deployment-topology-and-network-unification.md) (deployment topology — the appliance image and the OpenWrt router image are orthogonal layers, not a "dual image" of one host); [ADR-019](ADR-019-storage-pool-management.md) (storage-pool safety — the typed-confirm + disk-safety-probe + `DRY_RUN`/`TEST_*` pattern this reuses for `droplet-image flash`).

## Context

A `single-box` Droplet is provisioned today by running [`scripts/setup.sh`](../scripts/setup.sh) on an **already-installed** Ubuntu host. It installs Docker, generates per-device secrets, builds/pulls ~22 containers, and first-boot-pulls the model. This is correct and stays the canonical provisioning path — but it presumes a human has already installed an OS and cloned the repo. There is **no shippable artifact**: nothing you can hand to an operator (or a customer) to *flash an SSD and boot a working Droplet*.

At the time of this decision the only image builder that existed was the legacy multi-box `openwrt/build.sh`, which built the bare-metal **router** image (router-host OpenWrt SD card) — a different layer of the system. (That bare-metal router image builder has since been **retired** per ADR-011; the router now runs in a container on single-box, see `openwrt/singlebox-image/`.) [`scripts/build-image.sh`](../scripts/build-image.sh) was a five-line stub that only echoed a build-image TODO.

ROADMAP **M2.8** ("Downloadable image with Ubuntu + Docker + Droplet pre-installed") has been blocked, verbatim, on *"Architecture call: OpenWrt-only image vs. dual-image"* with the next action *"decide image topology."* ROADMAP **M3.4** (OTA) further commits to a *"`releases/` repo (external) [that] holds manifests"* and an agent that *"pulls a signed manifest, verifies it, and applies … updates atomically."*

This ADR makes the topology call, defines the build + versioning + flashing contract, and writes the manifest format so M3.4 inherits it rather than reinventing it. The design priority, adopted verbatim from the owner: **a customer can flash an SSD and boot a working box, and we can always say exactly which version is on any box** — packaging and version control, not a new runtime.

## Decision

### D1 — Topology: a single-box **appliance** image, autoinstall ISO first, golden raw `.img` second

The artifact is the **appliance image** — the x86 single-box *host* (Ubuntu + Docker + the Droplet stack). This is a distinct layer from the **router** image (per ADR-018 the router is its own deployment element, containerized on single-box via `openwrt/singlebox-image/` and, on the legacy multi-box, a separate router host). The M2.8 "OpenWrt-only vs dual-image" framing is therefore resolved as: **neither** — they are orthogonal images for orthogonal layers, each built by its own pinned builder. There is no combined image.

The appliance image ships in two phases:

- **Phase 1 (this ADR / WARP-663): an Ubuntu 24.04 autoinstall ISO.** A pinned, SHA256-verified Ubuntu live-server ISO is repacked with an embedded `nocloud` autoinstall seed (subiquity `user-data` + `meta-data`). On first boot it installs Ubuntu unattended, clones this repo to `/home/droplet/edge-platform`, and runs `scripts/setup.sh --single-box --systemd`. Smaller artifact, reproducible, needs network on first boot. It replicates the documented `docs/SINGLE_BOX.md` quick-start with zero human keystrokes.
- **Phase 2 (follow-on): a preinstalled golden raw `.img`.** OS + Docker + container images preloaded, flash-and-boot, fully offline. Larger artifact, fastest field deploy. Built by the same `droplet-image` CLI under a second `--format raw` path; out of scope for WARP-663.

Rationale for ISO-first: it reuses `setup.sh` verbatim (single source of provisioning truth — no second copy of the install logic to drift), is small enough to iterate and CI-smoke quickly, and de-risks the harder golden-image work behind a shipping milestone.

### D2 — The "loading and version control software" is a `droplet-image` CLI

A bash CLI at `scripts/droplet-image` (dispatcher modeled on [`scripts/droplet-admin`](../scripts/droplet-admin)), with handlers in `scripts/lib/image.sh`:

| Subcommand | Does |
|---|---|
| `build` | Build the appliance image for a `--shape` (default `single-box`) at a `--version`; emit to `output/`. |
| `manifest` | Add/refresh this build's entry in `manifest.json` (version, shape, file, url, size, sha256, gitSha, buildDate, minDiskGiB). |
| `sign` | Produce a detached signature over `manifest.json` using the private signing key (path in `$DROPLET_RELEASE_SIGNING_KEY`). |
| `verify` | Verify the manifest signature **and** each listed asset's sha256 against the tracked public key. Fail-closed. |
| `list` | List available versions from a local or releases-repo manifest. |
| `publish` | Push the artifact + signed manifest to the releases repo via `gh release`. |
| `flash` | Verify, then write a chosen image to a chosen SSD/USB — behind the ADR-019 safety guard (D-below). |

The CLI is the single operator surface for both "load" (flash) and "version control" (manifest/list/publish). No GUI in Phase 1.

### D3 — Version store: a new `DropletByWarpLab/releases` repo

Signed manifests and release assets live in a new `DropletByWarpLab/releases` repo (matching M3.4's documented `releases/` plan), with large binaries attached as GitHub **release assets** (`gh release`). `manifest.json` carries a `url` per image so asset *location* is abstracted — if an ISO exceeds GitHub's per-asset limit we compress (`.iso.zst`) or move the binary to object storage without changing the manifest contract or the CLI. **Creating that repo, generating the signing keypair, and the first `publish` are confirmation-gated and out of scope for WARP-663** (Phase 1 lands the CLI + manifest + builder; it does not perform a live publish).

### D4 — Versioning: semver via git tags, single source in `package.json`

Releases are `vMAJOR.MINOR.PATCH` git tags; the root [`package.json`](../package.json) `version` is the single source the CLI reads. Every manifest entry also records the exact `gitSha`, so a box's version is never ambiguous. WARP-663 bumps `0.1.0 → 0.2.0` to mark the first version with a buildable artifact.

### D5 — Signing: OpenSSL ECDSA-P256 now, cosign (WARP-244) next

Detached signatures use **OpenSSL ECDSA over P-256** (`openssl dgst -sha256 -sign/-verify`). This is FIPS-approved per [`docs/security/fips-allowed-algorithms.md`](security/fips-allowed-algorithms.md), needs no new host dependency (the OpenSSL FIPS provider already ships per WARP-229), and integrity hashing uses SHA-256 (`hashlib`). The **public** verify key is tracked at `scripts/image/keys/droplet-release.pub`; the **private** key is never committed (referenced only via `$DROPLET_RELEASE_SIGNING_KEY`, covered by `.gitignore` + `scripts/test-security.sh` gitleaks). Cosign keyless/keyed signing (WARP-244) is the documented upgrade path and replaces the openssl primitive without changing the manifest contract. **Minisign/Ed25519 is explicitly rejected** — Ed25519 is on the forbidden list in `fips-allowed-algorithms.md`.

### D6 — No secrets are ever baked into an image

Images carry **no** per-device secrets. The autoinstall identity uses a locked initial password that must be changed on first login; all real secrets (`JWT_SECRET`, `DEVICE_SECRET`, DB/MQTT/Nextcloud passwords, TLS) are generated at first boot by [`scripts/lib/secrets.sh`](../scripts/lib/secrets.sh), exactly as on a `setup.sh` install today. This keeps every built image identical and safe to distribute, and keeps the security model (fail-closed, `0600` secret files, no secrets in tracked files) intact.

The same provisioning-window rule applies to **privilege**. The seed grants `droplet` passwordless sudo (`/etc/sudoers.d/droplet-firstboot`) solely so the unattended `droplet-firstboot` unit can run `setup.sh`; the unit's `ExecStartPost` deletes the drop-in the moment provisioning succeeds. Steady state on a shipped box is `sudo`-group membership gated by the operator's password — unattended privileged operations go through root systemd units the bridge cannot escalate into (`NoNewPrivileges` stays on): the storage-pool apply via its narrow polkit start grant (`50-droplet-device-bridge.rules`), the Wi-Fi writes via the `droplet-openwrt-attach.path` watcher (WARP-843: the sandboxed bridge only rewrites its droplet-owned env file; root re-applies) — none of which call sudo. A blanket `NOPASSWD: ALL` that persisted past first boot would make the account password a remote root credential over SSH — the same class of default-identity shortcut D6 rejects.

### D7 — `flash` reuses the ADR-019 destructive-op safety guard

Writing an OS image to a block device is as data-destroying as `mdadm --create`. `droplet-image flash` therefore reuses the [`droplet-storage-pool.sh`](../scripts/host/droplet-storage-pool.sh) pattern verbatim in spirit: an explicit target device, a typed **confirm-phrase that must name the device**, and pre-flight probes that **refuse** a device that is mounted, holds a filesystem with data, or is/backs the OS disk. The same `DROPLET_IMAGE_DRY_RUN` + `DROPLET_IMAGE_TEST_{MOUNTED,OSDISK,HASDATA}` injection hooks make the refusals unit-testable without root or a real disk.

### D8 — This is the M3.4 OTA substrate

The signed `manifest.json` + `verify` (signature + per-asset sha256, fail-closed) + the `releases` repo are exactly what an OTA agent needs. M3.4's "pull a signed manifest, verify it, apply atomically" agent consumes this contract; it is not re-specified here, but no part of this design precludes it (A/B partitions and the apply step are M3.4's to add).

## Consequences

- **Positive:** M2.8's blocker is resolved with a shipping artifact; provisioning logic stays single-sourced in `setup.sh`; integrity + versioning are signed and FIPS-clean; the flash path inherits a battle-tested safety guard; M3.4 inherits a ready manifest contract.
- **Cost / caveats:** the real **flash + unattended-boot** path can only be validated on a Linux host with hardware (documented manual acceptance gate — it cannot run in CI or on a Windows control host). The ISO is large (~2.5–3 GB) and may exceed GitHub release-asset limits, forcing compression or object storage at publish time. Ubuntu point-release rotation breaks the pinned URL+SHA until bumped (fails loudly by design).
- **Naming hygiene:** every new surface uses `single-box` / `appliance` only — no `poc`/`dev`/`test`/`prototype` (enforced by the `lifecycle-naming` ship-check).

## Alternatives considered

- **Golden raw `.img` first (debos / mkosi).** Rejected as the *first* step: larger, slower to iterate, and it would duplicate the provisioning logic that `setup.sh` already owns. Kept as Phase 2 where its offline flash-and-boot speed is worth the cost.
- **A combined "dual" OpenWrt+Ubuntu image** (the M2.8 framing). Rejected: per ADR-018 the router and the host are different layers; bundling them couples two independently-versioned artifacts. Each keeps its own builder.
- **Minisign / signify (Ed25519).** Rejected: Ed25519 is forbidden by the FIPS policy. OpenSSL ECDSA-P256 is the compliant, zero-new-dependency equivalent; cosign is the strategic upgrade.
- **Off-the-shelf only (balenaEtcher + GitHub Releases + a runbook).** Rejected: no integrity verification, no one-command flow, no machine-readable version catalog for M3.4 to build on.
- **A Tauri/Electron GUI flasher.** Deferred: a much larger build/test surface and a second app to maintain; the CLI fully serves the internal "for us" need now. Revisit if non-technical field operators need it.
- **Baking secrets / a default identity into the image.** Rejected outright (D6): every shortcut ships with the customer; per-device first-boot secret generation is non-negotiable.

## Status audit — 2026-07-27

Flipped `Proposed` → `Accepted`. Evidence on `main`: `scripts/build-image.sh`,
the `scripts/image/` tree and the `droplet-image` CLI all exist, and
`docs/IMAGE_PIPELINE.md` documents the pipeline as the supported path. The
autoinstall seed this ADR specifies is also the reason `/home/droplet/edge-platform`
is the canonical on-box clone path referenced by the systemd unit and host scripts.
