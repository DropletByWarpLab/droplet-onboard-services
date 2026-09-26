# Client-app downloads — staging directory

This is where the Droplet client apps (Windows installer, Android APK, iOS
build) are staged so the box can serve them to a browser at `/downloads`.

Whatever is here is served **by the box itself**. Nothing is fetched from
the internet at runtime, which is the point: a customer on a LAN with no
internet can still install the client app for the box in front of them.
Getting an artifact here in the first place is a separate problem, and
today it is a manual one — see "Nothing stages these for you" below.

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

## Nothing stages these for you

The box gets its code by `git clone` from GitHub (see
`scripts/image/autoinstall/user-data`) and the installers are git-ignored,
so git never delivers one. Exactly three things put an installer on a box:

1. an operator running `stage.sh` on it;
2. the box's OTA update, for what `clients.lock.json` pins (below);
3. since WARP-3174, the ISO it was installed from: `build-iso.sh` builds a
   staging root from this checkout's `data/app-downloads` plus every
   installer the lock pins (fetched and size/sha256-verified by the same
   `fetch-client-apps.py` the OTA release uses, via `stage-lock.sh`),
   audits THAT root, maps it into the ISO at `/server/app-downloads`, and
   the autoinstall copies it into the clone. An image built while the lock
   is empty and nothing is staged carries nothing.

A box with none of those has an empty staging root, and `/downloads`
correctly reports that no apps are staged.

## Staging an artifact

On a box, from the repo root:

```bash
./scripts/app-downloads/stage.sh ~/Droplet_0.2.0_x64-setup.exe
```

That copies it in, records the version, regenerates `catalog.json`,
restarts the orchestrator (which memoises the catalog and would otherwise
keep serving the old one), and proves the running container sees the
result. `--verify-only` re-runs just the last check; `--dry-run` prints
what it would do.

Off-box — an image build, or a staging root you are assembling by hand —
skip the wrapper and drive the engine directly:

```bash
node scripts/app-downloads/stage.mjs --dir data/app-downloads <installer>
```

Both end in the same two generator calls, and the second one is the point:

```bash
node scripts/app-downloads/gen-catalog.mjs --dir data/app-downloads
node scripts/app-downloads/gen-catalog.mjs --dir data/app-downloads --check
```

`--check` exits non-zero when the staged bytes disagree with the catalog,
which is what stops a stale catalog shipping next to swapped binaries.

### More than one platform, or more than one format

`stage.mjs` stages one platform per call — a `.exe` and an `.apk` carry
different versions, so mixing them in one call is refused. Stage each
platform with its own call and let only the **last** one restart the
orchestrator; every restart takes the whole API down for ~40 s, not just
this page:

```bash
./scripts/app-downloads/stage.sh --no-restart --min-os "Windows 10 (1809) or newer" \
    ~/Droplet_0.2.0_x64-setup.exe ~/Droplet_0.2.0_x64_en-US.msi
./scripts/app-downloads/stage.sh --min-os "Android 8.0 or newer" ~/Droplet_0.3.0.apk
```

Every installer format you stage is offered on the page: the platform's
`primary` (the NSIS `-setup.exe` on Windows) is the button, and the rest —
the MSI here — are listed beneath it with their own size and digest
(WARP-2889). Name the APK with its version in the filename
(`Droplet_0.3.0.apk`, not `app-release.apk`) or pass `--version`: the page
shows the version the filename carries, and the asset name IS the filename
the customer downloads.

### Do not leave the previous release in place

`gen-catalog`'s `pickPrimary()` takes the first `-setup.exe` in **sorted**
order, so `Droplet_0.1.2_…` beats `Droplet_0.2.0_…` and the download
button quietly hands out the older build — with a catalog that parses and
a digest that verifies. `stage.sh` clears the platform directory for this
reason. If you stage by hand, delete the old installer yourself.

## What is and isn't committed

Installers are binaries built from other repos — they are **git-ignored**
here, so git can never deliver one to a box. Only `.gitignore`, this
README, and `platforms.example.json` are tracked. Every checkout, and every
freshly imaged box whose image carried nothing, therefore mounts an
effectively empty directory, and
`/downloads` honestly reports that no apps are staged rather than
erroring. `catalog.json` and the staged binaries are local state, and it is worth
being exact about what erases them, because "re-stage to be safe" is how
a box ends up serving last release's installer:

- **`git pull` / an OTA deploy — survive.** They are git-ignored, so
  nothing in a deploy touches them. The *catalog* can go stale against a
  new client release, though: `scripts/app-downloads/audit.sh` reports
  `STALE` for that, and it is the only thing that will.
- **A factory reset — survives.** `scripts/factory-reset.sh` removes
  `data/secrets`, `.data`, `docker/certs`, `docker/secrets` and `.env`,
  and runs no `git clean`. It never touches this directory. (Verify
  before trusting this line: `grep -c app-downloads scripts/factory-reset.sh`
  → 0.)
- **A reimage — replaced by what the ISO carries.** First boot clones a
  fresh checkout, then copies the ISO's staging root in (WARP-3174), so a
  reimaged box has exactly the installers its image was built with, and a
  hand stage from before the reimage is gone. Re-stage anything the image
  did not carry.

## `clients.lock.json`: installers the OTA release carries (WARP-3120)

The tracked lock pins each client installer a release carries, today only
the Droplet for Mac DMG, published as a GitHub release asset of
DropletByWarpLab/DropletAgent:

```json
{ "schemaVersion": 1,
  "clients": [ { "platform": "macos", "version": "0.2.0",
                 "source": { "repo": "DropletByWarpLab/DropletAgent", "tag": "mac-v0.2.0" },
                 "file": "Droplet-0.2.0.dmg", "size": 50331648,
                 "sha256": "<64 hex>" } ] }
```

DropletAgent's `scripts/release-dmg.sh --publish` prints the entry.

- **Publish** (`.github/workflows/publish-release.yml`, "Fetch client apps"):
  `scripts/release/fetch-client-apps.py` downloads each entry with the
  `DROPLET_CLIENT_APPS_TOKEN` secret (fine-grained, contents:read on
  DropletAgent only) and refuses it unless size and sha256 equal the lock.
  The entry goes into the cosign-signed `release.json` (`clients`), and the
  file is attached to the OTA release. An empty lock needs no token; a lock
  that pins an entry fails the publish without it.
- **Apply** (`update-agent/apply.ts`, step 3c): the box downloads the file
  from the OTA release, checks it against the signed manifest, and the host
  helper (`docker/ota/apply-update.sh stage-client-apps`) runs
  `stage.sh --no-restart` on it, then the update dir's copy is deleted. When
  the catalog already serves that version with that sha256, nothing is
  downloaded (most updates carry the same pinned DMG). A failure is logged
  (`update.client_apps_skipped`) and never fails the box update. The
  orchestrator sees the new catalog without a restart (`store.ts` re-reads
  `catalog.json` when its inode, size or mtime change).
- **Channel:** a lock bump is a normal PR, so stage boxes get the new Mac
  build first and stable boxes on the promotion.
- A box rollback keeps the newly staged installer (the platform directory
  was replaced). Harmless: it is a newer, Warp Lab-signed build.
- **Image** (`scripts/image/build-iso.sh`, step 0, WARP-3174):
  `scripts/app-downloads/stage-lock.sh` fetches the same entries through
  `fetch-client-apps.py` (token: `GH_TOKEN`, else
  `DROPLET_CLIENT_APPS_TOKEN`, else the builder's `gh auth token`) and
  stages them before the pre-flight audit. A pinned entry it cannot fetch
  or verify fails the build; `--allow-blank-downloads` does not waive it.

## What EXPECTED is for

`EXPECTED` is the tracked declaration of what a release must carry, one
row per platform, with `installer` / `store` / `blocked` / `absent`
policies. `scripts/app-downloads/audit.sh` reconciles it against what is
actually staged and is read by the image build, `ship-check` and the
box's own watchdog.

It exists because observing this directory is not enough. "It is empty"
is true and uninformative, and any check that only looks at the bytes
goes green the moment one platform is staged — which is how the other
four would go quiet again. A `blocked` row must name a ticket *and* a
reason, so "blocked, and a human signed that" stays distinguishable from
"nobody noticed". Flipping a row to `installer` asserts that a release
now **must** carry it: do that in the same change that makes the artifact
real, never ahead of it.

## Trust model — read before "hardening" this

Two gates, and it matters which one is load-bearing:

- **Digest (always on, fail-closed).** Every byte is re-hashed against the
  catalog pin at serve time. This gate works today — but be precise about
  what it proves. For a hand stage **the trust root is the operator's
  stage**: the artifacts are put here by a human who downloaded them with
  their own credentials (an image carries a builder's hand stage on the
  same terms). The digest proves
  the bytes have not changed *since that stage*. It says nothing about
  whether they were the right bytes to begin with — that is what the
  operator's own verification of the release download is for, and why
  `clients.lock.json` pins what the OTA release carries (for those, the
  trust root is the tracked lock, and the signed manifest carries it to the
  box).

  This distinction stops mattering the day anything fetches automatically:
  a gate that pins whatever it just downloaded is self-referential. Any
  future fetch must verify against the tracked lock *before* `gen-catalog`
  pins anything.

- **Cosign signature over `catalog.json` (opt-in, off by default).**
  Enabled with `DROPLET_APP_DOWNLOADS_REQUIRE_SIGNATURE=1`. It is off on
  purpose: `update-agent/cosign.pub` has been a real P-256 key since the
  2026-07-30 key ceremony, but nothing signs an on-box-generated
  `catalog.json` today, so turning it on makes **every download a 503**.
  The flag exists so signing `catalog.json` can upgrade the posture
  without a code change — and so the UI never claims "signed" for
  something nobody verified.

The Windows `.sig` is the **Tauri updater's minisign envelope** (key
`F5E6E366DCF9B85E`). It is declared, digest-checked and served verbatim,
but the box never verifies it: Ed25519 is forbidden on-box by
`docs/security/fips-allowed-algorithms.md` without a registered
exception, and the box has no reason to hold that opinion. That signature
exists for the *client's own updater* and for a customer who wants to
verify the download independently before running it.
