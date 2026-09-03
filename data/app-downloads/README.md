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

Read this before believing any comment that says the artifacts arrive with
the image. **They do not, and never have.** The box gets its code by
`git clone` from GitHub (see `scripts/image/autoinstall/user-data`), the
installers are git-ignored, and no build step, `setup.sh` path or CI job
copies one in. Every box therefore boots with an empty staging root, and
`/downloads` correctly reports that no apps are staged — which is the
honest answer to a real absence, not a bug in the page.

Until an artifact source exists that a box can reach on its own — a
published `droplet-windows` release, or an OTA payload — staging is an
operator action. `stage.sh` is that action.

## Staging an artifact

On a box, from the repo root:

```bash
./scripts/app-downloads/stage.sh ~/Droplet_0.2.0_x64-setup.exe
```

That copies it in, records the version, regenerates `catalog.json`,
restarts the orchestrator, and proves the running container sees the
result. `--verify-only` re-runs just the last check; `--dry-run` prints
what it would do.

Be precise about why the restart is there, because it is only half
required (WARP-2666). The store memoises a **successful** catalog read for
the life of the process, so **replacing** a catalog the box is already
serving needs the restart or it keeps handing out the old build. It no
longer memoises **failures**, so the *first* stage onto a box that had
nothing is picked up live. If you skip the restart, skip it knowing which
of those two you are doing.

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

### Do not leave the previous release in place

`gen-catalog`'s `pickPrimary()` takes the first `-setup.exe` in **sorted**
order, so `Droplet_0.1.2_…` beats `Droplet_0.2.0_…` and the download
button quietly hands out the older build — with a catalog that parses and
a digest that verifies. `stage.sh` clears the platform directory for this
reason. If you stage by hand, delete the old installer yourself.

## What is and isn't committed

Installers are binaries built from other repos — they are **git-ignored**
here, so git can never deliver one to a box. Only `.gitignore`, this
README, and `platforms.example.json` are tracked. Every checkout and every
freshly imaged box therefore mounts an effectively empty directory, and
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
- **A reimage — survives IF the ISO carried a payload.** This changed in
  WARP-2666. The installer is still not in the repo, but `build-iso.sh`
  now bakes whatever is staged here onto the ISO at
  `/droplet/app-downloads`, and an autoinstall late-command copies it into
  the freshly cloned checkout. So a box flashed from an ISO built on a
  staged tree comes up with `/downloads` already populated — which is the
  whole point.

  It does **not** survive a reimage from an ISO built with
  `--allow-blank-downloads`, or from any ISO built before that change.
  After a reimage, `bash scripts/app-downloads/audit.sh` is the thing that
  tells you which of the two you got. Do not assume; ask it.

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
  what it proves. **The trust root is the operator's stage**, not the
  image: the artifacts do not ship with the image, they are put here by a
  human who downloaded them with their own credentials. The digest proves
  the bytes have not changed *since that stage*. It says nothing about
  whether they were the right bytes to begin with — that is what the
  operator's own verification of the release download is for, and why
  `clients.lock.json` records what was staged.

  This distinction stops mattering the day anything fetches automatically:
  a gate that pins whatever it just downloaded is self-referential. Any
  future fetch must verify against the tracked lock *before* `gen-catalog`
  pins anything.

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
