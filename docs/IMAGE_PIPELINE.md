# Appliance image build + flash pipeline

> WARP-663 implements [ADR-020](ADR-020-appliance-image-build-and-flash-pipeline.md).
> Read the ADR for the *why* (topology call, alternatives, the M2.8/M3.4 links);
> this doc is the *how* — the operator contract.

The pipeline turns this repo into a **shippable appliance artifact**: a customer
can flash an SSD and boot a working single-box Droplet, and we can always say
exactly which version is on any box. It is packaging + version control, not a new
runtime — provisioning logic stays single-sourced in
[`scripts/setup.sh`](../scripts/setup.sh).

## Topology — two orthogonal images

Per [ADR-018](ADR-018-deployment-topology-and-network-unification.md) the router
and the host are **different layers**, each built by its own pinned builder.
There is **no combined image**.

| Layer | Builder | Artifact | What it is |
|---|---|---|---|
| **Appliance host** (this pipeline) | `scripts/image/build-iso.sh` | `output/droplet-single-box-<version>.iso` | x86 single-box host: Ubuntu + Docker + the Droplet stack. |
| **Router** | `openwrt/singlebox-image/Dockerfile` | `droplet/openwrt-singlebox` image | OpenWrt AP, containerized on single-box. (The legacy multi-box bare-metal router SD-card builder was retired per ADR-011.) |

The appliance image ships in two phases:

- **Phase 1 (WARP-663, this doc): an Ubuntu 24.04 autoinstall ISO.** A pinned,
  SHA256-verified Ubuntu live-server ISO repacked with an embedded `nocloud`
  autoinstall seed. On first boot it installs Ubuntu unattended, clones this repo
  to `/home/droplet/edge-platform`, and runs `setup.sh --single-box --systemd`.
  Smaller, reproducible, needs network on first boot.
- **Phase 2 (deferred): a preinstalled golden raw `.img`.** OS + Docker +
  container images preloaded, flash-and-boot, fully offline. A second
  `--format raw` path on the same `droplet-image` CLI. Out of scope for WARP-663.

## The `droplet-image` CLI

`scripts/droplet-image` is the single operator surface for both "load" (flash)
and "version control" (manifest/list/publish). Dispatcher modeled on
`scripts/droplet-admin`; handlers live in `scripts/lib/image.sh`.

```
droplet-image <subcommand> [flags]
```

| Subcommand | Does | Key flags |
|---|---|---|
| `build` | Build the appliance ISO for a shape at a version. Emits `output/droplet-<shape>-<version>.iso` (+ a sidecar `.sha256`). | `--shape` (default `single-box`), `--version` (default: root `package.json`) |
| `manifest` | Add/refresh this build's entry in `scripts/image/manifest.json` (hashes the built artifact). | `--version` (req), `--shape`, `--file`, `--url`, `--min-disk-gib` |
| `sign` | Detached **ECDSA-P256** signature over the manifest. Private key path from `$DROPLET_RELEASE_SIGNING_KEY` (never a flag, never committed). | `--manifest`, `--sig` |
| `verify` | Verify the manifest signature **and** each local asset's sha256. **Fail-closed.** | `--manifest`, `--sig`, `--pubkey`, `--assets-dir` |
| `list` | List versions from a manifest. | `--manifest` |
| `publish` | Push artifact + signed manifest to `DropletByWarpLab/releases` via `gh release`. **Refuses** (never creates the repo) if repo/asset/creds absent. | `--version` (req), `--shape`, `--file` |
| `flash` | Verify, then write an image to a disk — behind the ADR-019 safety guard. | `--image`, `--device`, `--confirm "<phrase>"` |

### End-to-end (on a Linux build host)

```bash
# 1. Build the ISO (pinned + SHA256-verified Ubuntu base; dockerized xorriso).
./scripts/droplet-image build --version 0.2.0

# 2. Catalogue it in the signed manifest.
./scripts/droplet-image manifest --version 0.2.0

# 3. Sign the manifest (private key NEVER committed — see key custody below).
DROPLET_RELEASE_SIGNING_KEY=/path/to/droplet-release.key \
  ./scripts/droplet-image sign

# 4. Verify before doing anything destructive (fail-closed).
./scripts/droplet-image verify

# 5. Flash a target disk (the confirm phrase MUST name the device).
./scripts/droplet-image flash \
    --image output/droplet-single-box-0.2.0.iso \
    --device /dev/sdX \
    --confirm "ERASE /dev/sdX"

# 6. Publish (deferred / confirmation-gated — see §Publishing).
./scripts/droplet-image publish --version 0.2.0
```

## Manifest schema

`scripts/image/manifest.json` is the signed release catalogue;
`scripts/image/manifest.schema.json` is its JSON-Schema (draft-07).
`scripts/image/gen-manifest.py` (pure stdlib — `hashlib`/`json`/`argparse`, no
third-party deps) builds + validates it. The same signed manifest is the **M3.4
OTA substrate**: the OTA agent pulls it, `verify`s it (signature + per-asset
sha256, fail-closed), and applies updates atomically — it inherits this contract
rather than reinventing it.

```jsonc
{
  "schemaVersion": 1,
  "images": [
    {
      "shape": "single-box",            // enum: single-box | multi-box
      "version": "0.2.0",               // semver, matches the git tag + package.json
      "format": "iso",                  // enum: iso (Phase 1) | raw (Phase 2)
      "file": "droplet-single-box-0.2.0.iso",
      "url": "https://github.com/DropletByWarpLab/releases/releases/download/v0.2.0/droplet-single-box-0.2.0.iso",
      "size": 3221225472,               // bytes
      "sha256": "<64 hex>",             // verify recomputes + compares
      "gitSha": "<40 hex>",             // exact commit the image was built from
      "buildDate": "2026-06-04T00:00:00Z",
      "minDiskGiB": 32
    }
  ]
}
```

The tracked `manifest.json` is intentionally an **empty catalogue** today — no
image is published in Phase 1 (the first publish is deferred; see below). `url`
abstracts asset *location* so a too-large ISO can move to compression
(`.iso.zst`) or object storage without changing the CLI contract or the manifest
shape.

## Releases-repo layout

Signed manifests + release assets live in a **new `DropletByWarpLab/releases`
repo** (matching M3.4's documented `releases/` plan). Large binaries attach as
GitHub **release assets** per tag:

```
DropletByWarpLab/releases
└── (per git tag vX.Y.Z) GitHub release
    ├── droplet-single-box-X.Y.Z.iso        ← asset
    ├── manifest.json                        ← signed catalogue
    └── manifest.json.sig                    ← detached ECDSA-P256 signature
```

## Signing & key custody

Detached signatures use **OpenSSL ECDSA over P-256** (`openssl dgst -sha256
-sign` / `-verify`). This is FIPS-approved per
[`docs/security/fips-allowed-algorithms.md`](security/fips-allowed-algorithms.md);
**Ed25519 / minisign is explicitly forbidden** by that policy. Cosign (WARP-244)
is the strategic upgrade path and replaces the openssl primitive without changing
the manifest contract.

- **Public verify key:** `scripts/image/keys/droplet-release.pub` — tracked.
  `verify` reads it (or `--pubkey`).
- **Private signing key:** **never committed** (`.gitignore`d as
  `scripts/image/keys/*.key`), referenced only via `$DROPLET_RELEASE_SIGNING_KEY`.
- The `.pub` checked in today is a **placeholder** (its private half was
  generated then destroyed). The real keypair is minted + escrowed at the first
  publish. Full generation + **rotation** procedure (superset-trust):
  [`scripts/image/keys/README.md`](../scripts/image/keys/README.md).

## No secrets in any image (ADR-020 §D6)

Every built image is byte-identical and safe to distribute. The autoinstall
identity is user `droplet` with a **locked initial password** (`!` sentinel — no
valid password, no access; the operator sets one on first login, SSH password
auth is off). All real secrets (`JWT_SECRET`, `DEVICE_SECRET`, DB/MQTT/Nextcloud
passwords, TLS) are generated **at first boot** by
[`scripts/lib/secrets.sh`](../scripts/lib/secrets.sh), exactly as on a `setup.sh`
install today.

Privilege follows the same window: the seed's `NOPASSWD` drop-in
(`/etc/sudoers.d/droplet-firstboot`) exists only so the unattended
`droplet-firstboot` unit can run `setup.sh`, and the unit's `ExecStartPost`
deletes it once provisioning succeeds. After that, `droplet`'s sudo is
password-gated; unattended privileged paths use root systemd units the bridge
cannot escalate into — the storage-pool apply via its narrow polkit start
grant, the Wi-Fi writes via the `droplet-openwrt-attach.path` watcher
(WARP-843: the bridge only rewrites its droplet-owned env file; root
re-applies) — never sudo. `tests/image-pipeline.test.sh` §(e)
asserts the grant is written, removed after the `.firstboot-done` marker, and
that no other `NOPASSWD` grant sneaks into the seed.

## `flash` safety guard (ADR-019)

Writing an OS image to a block device is as destructive as `mdadm --create`, so
`flash` reuses the [`scripts/host/droplet-storage-pool.sh`](../scripts/host/droplet-storage-pool.sh)
pattern verbatim in spirit:

1. A typed **confirm-phrase that must NAME the target device** (`--confirm "ERASE
   /dev/sdX"`). Missing or wrong-device phrase → refuse.
2. Pre-flight **probes that refuse** a device that is mounted, holds a populated
   filesystem, or is/backs the OS/boot disk.
3. If a sidecar `<image>.sha256` exists, the image is checksum-verified before
   writing.

The refusals are **unit-testable without root or a real disk** via injection
hooks (`tests/image-pipeline.test.sh` exercises every one):

```bash
DROPLET_IMAGE_DRY_RUN=1            # print the dd instead of running it
DROPLET_IMAGE_TEST_MOUNTED=/dev/sdX   # simulate the target being mounted
DROPLET_IMAGE_TEST_OSDISK=/dev/sdX    # simulate the target being the OS disk
DROPLET_IMAGE_TEST_HASDATA=/dev/sdX   # simulate the target holding a populated fs
```

## Publishing is deferred (ADR-020 §D3)

**Creating `DropletByWarpLab/releases`, generating the signing keypair, and the
first `publish` are confirmation-gated and out of scope for WARP-663.** WARP-663
lands the CLI + manifest + builder; it does **not** perform a live publish.
`droplet-image publish` fail-loudly **refuses** — it never creates the repo or
mints credentials — when the repo, the asset, or `gh` auth is absent.

## The manual flash + boot acceptance gate

The static + unit tests (below) validate everything that can run on CI / a
Windows control host. Two things can **only** be validated on a Linux host with
hardware — this is the documented manual acceptance gate, NOT a CI step:

1. **Real ISO build:** `./scripts/droplet-image build` on a Linux host with
   Docker + ~10 GB free. Produces `output/droplet-single-box-<version>.iso`.
   (The dockerized `xorriso` repack cannot run on the Windows control host.)
2. **Real flash + unattended boot:** flash the ISO to an SSD, boot a single-box,
   confirm the autoinstall completes, the box clones the repo, the
   `droplet-firstboot` unit runs `setup.sh --single-box --systemd`, the stack
   comes up, and the dashboard is reachable.
3. **`/downloads` matches what the release declares** (WARP-2666). Open the
   dashboard's *Get the app* page on the booted box and confirm it shows what
   `data/app-downloads/EXPECTED` says it should — then actually **run** the
   installer it offers, on a clean machine, and confirm the app launches and
   pairs with the box.

   This one is manual because no automated gate can see it. The build
   pre-flight proves a catalog exists and its digests match; only a human can
   catch a catalog that is present, valid and digest-correct while describing
   the **wrong build**. Every appliance ISO before this gate existed shipped
   an empty page, and nothing — CI, `/api/health`, the watchdog — said so,
   because "no apps staged" answers HTTP 200.

   ⚠ Installers do **not** survive a reimage: they are git-ignored and the
   ISO carries no repo payload, so a freshly flashed box starts blank and
   must be re-staged (`./scripts/app-downloads/stage.sh`). They *do* survive
   a factory reset.

Sign-off on these three is required before the **first** publish.

## Bumping the pinned Ubuntu base

The builder pins a specific 24.04 LTS point release + its real SHA256 (fetched
from `https://releases.ubuntu.com/24.04/SHA256SUMS`). When Ubuntu rotates the
point release, the pinned URL 404s and the build fails **loudly** (by design — it
never ships an unverified base). To bump:

```bash
curl -s https://releases.ubuntu.com/24.04/SHA256SUMS | grep live-server-amd64.iso
# update UBUNTU_VERSION + UBUNTU_ISO_SHA256 at the top of scripts/image/build-iso.sh
# re-run the builder on a Linux host + re-validate the boot gate
```

## Tests

| What | Command | Runs on |
|---|---|---|
| Unit (CLI help, sign↔verify round-trip, manifest validate, flash refusals) | `npm run test:image` / `bash tests/image-pipeline.test.sh` | anywhere with openssl + python3 |
| Static (build-image non-stub, schema valid, sample manifest validates, shellcheck) | `bash scripts/test/ship-check.sh image-pipeline` | anywhere with python3 + shellcheck |
| Regression (the check catches a stubbed build-image.sh) | `bash scripts/test/ship-check.test.sh` | anywhere |
| Real ISO build + flash + boot | manual | **Linux host + hardware** |

CI runs the first three via `.github/workflows/image-pipeline-tests.yml`
(`workflow_dispatch`-only, matching the repo's other manual-only workflows).

> **Note (WARP-663 handoff):** the Dev push token lacked the GitHub `workflow`
> OAuth scope, so the workflow file could not be pushed from the Dev branch. Its
> exact content is staged at
> [`docs/image-pipeline-tests.workflow.yml.txt`](image-pipeline-tests.workflow.yml.txt);
> the Manager (with a `workflow`-scoped token) moves it to
> `.github/workflows/image-pipeline-tests.yml` when opening the PR.
