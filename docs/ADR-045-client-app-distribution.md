# ADR-045 — Client-app distribution: the operator stages, the box never fetches

- **Status:** Accepted
- **Date:** 2026-09-03
- **Ticket:** WARP-2666
- **Supersedes nothing.** Builds on ADR-020 (signed-manifest image substrate)
  and the WARP-2046 serving surface.

## Context

WARP-2046 built the whole `/downloads` surface — catalog parser, serve-time
digest gate, platform-aware page, compose mount — and left the producer end
unbuilt. Nothing has ever put an installer in `data/app-downloads/`, so **every
box that has ever shipped has served an empty "Get the app" page.**

Three things kept that invisible for months:

1. `catalog_missing` is deliberately **HTTP 200** with `available:false`
   (`routes/app-downloads.ts`). That is the right call for the API — a box with
   nothing staged is a legitimate state, not an error — but it means the blank
   page is green to `/api/health`, to every uptime probe, to every smoke test
   and to all of the watchdog's checks. There is no failing signal to notice,
   only a missing success. Same shape as WARP-2574 one layer up.
2. `gen-catalog.mjs --check` **passes vacuously** over an empty staging root: a
   catalog with zero platforms matches itself perfectly.
3. Tracked files *asserted the missing step existed*. `.gitignore` said "the
   image build stages them into this directory"; the README called the image
   the trust root; the page told customers "the next box update will bring
   them". Anyone who opened those files to ask why the directory was empty was
   told the answer lived somewhere else.

Meanwhile no artifact exists to stage: `droplet-windows` has zero tags and its
release workflow has never run (WARP-1955 gates the first tag on a
signing-key-custody decision), `droplet-android` has none of its four signing
secrets and no Play listing, and `droplet-ios` has no distribution pipeline at
all — `ios.yml` is a simulator build with `CODE_SIGNING_ALLOWED=NO`.

## Decision

**1. The operator stages; the box never fetches.**

Installers reach a box because a human downloaded them with their own
credentials and ran `scripts/app-downloads/stage.sh`. The appliance makes no
outbound request for them, and **no GitHub token may ever sit on a customer
appliance**. This is not a temporary shape forced by the private repos — it is
the shape that matches the product: an air-gapped-capable box on a customer LAN
should not need reachability to a code host to hand someone an installer.

**2. The trust root is the stage, not the image.**

The serve-time digest gate proves the bytes have not changed *since staging*.
It says nothing about whether they were the right bytes. Any future automated
fetch must verify against a **tracked** record *before* `gen-catalog` pins
anything — otherwise the gate becomes self-referential, pinning whatever it
just downloaded and calling that proof.

**3. A release declares what it must carry, and that declaration is tracked.**

`data/app-downloads/EXPECTED` states a policy per platform — `installer`,
`store`, `blocked` (ticket **and** reason both mandatory) or `absent`.
`scripts/app-downloads/audit.sh` reconciles it against what is staged.

Observing the directory could never have been enough. "It is empty" is true and
uninformative: it cannot distinguish *blocked upstream, ticketed, a human
signed this* from *nobody noticed*, and it goes green the moment one platform
is staged — which is exactly how the other four would go quiet again.

**4. "Could not look" never shares an exit code with "looked, it is fine."**

The auditor's contract, copied from `droplet-host-units audit`: `0` satisfied,
`1` a real gap, `3` clean-but-blocked (each named with its ticket), `4` no
verdict. Exit 4 must never collapse into 0, and no `--allow-*` flag waives it.

**5. The build is the loud gate; the box is the honest one.**

`build-iso.sh` **refuses** to build an image whose `/downloads` would be empty
unless `--allow-blank-downloads` is passed, and echoes the flag and the full
blocked list into the build log. That is the last moment a human can still
decide. `ship-check.sh` reports the same thing before a release.

The box's own watchdog check reports rather than nags: a declared-blocked
release is `not_applicable` **with every blocked platform and ticket named in
the message**, not a red. A box already in the field cannot fix this, so a
permanent red would only teach people to ignore the check. A *declared*
installer that is missing or whose bytes have drifted is `heal_failed` — that
is a box which was supposed to have something and does not.

## Consequences

- **The ISO carries the payload.** `build-iso.sh` maps the staged directory to
  `/droplet/app-downloads` and an autoinstall late-command copies it into the
  cloned checkout, so a box flashed from an ISO built on a staged tree comes up
  non-blank. Git still never delivers an installer — a clone or an OTA deploy
  brings none — so the two remaining ways in are the ISO and an operator.

  That copy step is **bare**, not `curtin in-target`: every other late-command
  is chrooted into `/target`, where `/cdrom` does not exist, and converting it
  "for consistency" would copy nothing forever. `catalog.json` is generated on
  the **builder**, because the autoinstall package list has no node and no
  python3. It is also the only *guarded* late-command in the file: the clone is
  deliberately fatal because a box without the platform is useless, but a box
  without client installers has an honest empty page the audit reports, and
  aborting an otherwise good install over it is the wrong trade.
  `tests/image-payload.test.sh` reconciles the two halves in both directions.

- A reimage from an ISO built with `--allow-blank-downloads` (or from any
  pre-WARP-2666 ISO) still starts blank, so **re-staging stays part of
  commissioning** — `audit.sh` is what tells you which case you got. Staged
  installers survive a factory reset: `factory-reset.sh` touches only
  `data/secrets`, `.data`, `docker/certs`, `docker/secrets` and `.env`.
- No `storeUrl` ships in `platforms.example.json`. The README tells operators to
  copy that file verbatim, so a placeholder there ships a customer a dead
  button — strictly worse than the honest empty state. The two that used to
  live there were exactly that: a Play listing for `ai.warplab.droplet` that
  404s, and the literal string `.../join/REPLACE-ME`.
- iOS will never be `installer`. It becomes `store` when a TestFlight or App
  Store listing exists; iOS cannot install from a local device at all.
- `AppDownloadsStore` no longer memoises catalog **failures**. The host side of
  the read-only mount is writable, so a stage under a running orchestrator is
  real — and a cached failure made it invisible until a container restart,
  indistinguishable from a stage that silently failed. Successes are still
  memoised; the cost is one `ENOENT` per request on a blank box.
- Every authenticated principal reaches both routes, `service` tokens included.
  That is a deliberate consequence of the un-role-gated design (a `family` or
  `guest` member needs the app for the box they were invited to) and is
  recorded here rather than left implicit.
- A retagged upstream release will fail the digest check hard on every box.
  **That is correct, not an outage.**

## Open, and deliberately not decided here

- **The distribution host** for `droplet-windows` (a public releases-only
  mirror vs hosting on droplet-us.com). Not needed for operator staging; it is
  needed before any automated fetch, and the in-app Tauri auto-updater stays
  non-functional until it lands, since its configured endpoint 404s for
  anonymous clients.
- **Play App Signing key custody** must be settled before Android upload #1 and
  is irreversible: it determines whether box-sideloaded and Play builds can
  ever update each other. Do **not** wire the debug APK as a stopgap — its
  applicationId is `ai.warplab.droplet.debug`, a separate app that can never
  update to a release build.
- **The bundle-id split.** iOS is `ai.warp-lab.droplet` (hyphenated); Android is
  `ai.warplab.droplet`. Two reverse-DNS namespaces for one product, and neither
  id can be changed after publication. This needs a product call before either
  store listing exists.
