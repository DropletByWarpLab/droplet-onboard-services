# WARP-2067 — factory-mint: seed a per-device HQ provisioning token at ISO build

**Goal:** a box flashed at the factory boots, self-registers into the fleet-HQ
registry, and issues its `droplet-us.com` cert with **zero** manual seeding —
no SQL inserts, no SSH-in (the old manual path is
`droplet-fleet-hq/docs/HQ-DEPLOY-RUNBOOK.md` §C, which does not scale past the
lab box).

**The good news, verified:** the box-side consumer already exists end-to-end
(WARP-983). `scripts/lib/secrets.sh:773-783` seeds `DROPLET_PROVISION_TOKEN`
from the provisioning environment into `.env`; the orchestrator self-provisions
on the HQ 404 with a PoP signature over
`droplet-provision:v1:<token>:<device_id>:<key_fingerprint>`
(`apps/orchestrator/src/services/tls-issuance.service.ts:204-212`, provision
call at `:548-567`), then retries issuance. HQ mints tokens at
`POST /api/admin/provision-token` (`droplet-fleet-hq/worker/src/handlers.ts:349-361`).
WARP-2067 is therefore pure **delivery plumbing**: get a freshly minted token +
a unique device id into the environment that `setup.sh` runs in on first boot.

---

## 0. Prerequisites, in order (do not start coding before these hold)

1. **fleet-hq #15 + #17 merged AND deployed AND live-verified** —
   `curl https://fleet-hq.droplet-us.com/readyz` → 200. Until then pass the
   workers.dev URL explicitly (see `HQ_ISSUANCE_URL` below).
2. **onboard #1615 (the `HQ_ISSUANCE_URL` default flip, `scripts/lib/secrets.sh:756`)
   merged** — sequenced strictly after (1); a default pointing at NXDOMAIN
   silently strands boxes on the self-signed cert (`secrets.sh:747-750`).
3. **The `DROPLET_DEVICE_ID` env-override fix (§2) — BLOCKING.** Verified
   defect: today the seed at `scripts/lib/secrets.sh:728` is
   `DROPLET_DEVICE_ID=$(hostname 2>/dev/null || echo droplet)` — it reads the
   hostname **unconditionally and ignores any environment value**, unlike its
   neighbors `TUNNEL_TOKEN=${TUNNEL_TOKEN:-}` (`:772`) and
   `DROPLET_PROVISION_TOKEN=${DROPLET_PROVISION_TOKEN:-}` (`:783`). The
   migrate-path twin at `:1034` has the same shape. Without this fix every
   factory box lands in `.env` as `DROPLET_DEVICE_ID=droplet` (autoinstall sets
   hostname `droplet`, `scripts/image/autoinstall/user-data:42`) and the SECOND
   box to provision 409s at HQ — `registerDevice` is first-writer-wins per
   device_id with a key-conflict 409 (`handlers.ts:340-341`).
4. Factory operator has `ADMIN_TOKEN` (from 1Password; it gates the mint,
   `handlers.ts:350`) available as an environment variable on the build host.

---

## 1. Device identity scheme

- **`device_id = droplet-<serial>`**, lowercase, from the unit's
  chassis/motherboard serial as printed on the label the factory already reads.
  Validate in build-iso.sh: `^droplet-[a-z0-9][a-z0-9-]*$` (device_id feeds the
  HMAC-derived public label, and the human-friendly name is assigned later via
  the separate admin `assign-name` path — `handlers.ts:363-369` — so the id
  never needs to be pretty, only unique and stable).
- The **hostname stays `droplet`** (`user-data:42`) — deployment shape, not
  identity. device_id and hostname are decoupled by the §2 fix; the
  orchestrator and the device-identity sidecar both read the env value
  (`apps/orchestrator/src/config.ts:527-530`).
- Label the physical box with the device_id at flash time; it is the join key
  for every HQ audit row and support conversation.

## 2. secrets.sh fix (one line + its migrate twin)

```sh
# scripts/lib/secrets.sh:728  (seed block)
DROPLET_DEVICE_ID=${DROPLET_DEVICE_ID:-$(hostname 2>/dev/null || echo droplet)}
# scripts/lib/secrets.sh:1034 (migrate backfill)
_migrate_ensure_key DROPLET_DEVICE_ID "${DROPLET_DEVICE_ID:-$(hostname 2>/dev/null || echo droplet)}"
```

Behavior-preserving for every existing box (no env value → same hostname
fallback), and `_migrate_ensure_key` only appends when the key is absent
(`secrets.sh:929-931` comment), so no deployed `.env` changes on re-run.

## 3. build-iso.sh changes

Current flag surface is `--shape` / `--version` only
(`scripts/image/build-iso.sh:73-81`). Add:

```
--device-id droplet-<serial>   # opt-in: build a PER-DEVICE seeded ISO
```

plus environment inputs (never argv — argv leaks into `ps`/shell history):

- `HQ_ADMIN_TOKEN` (required with `--device-id`) — the HQ `ADMIN_TOKEN`.
- `HQ_ISSUANCE_URL` (default `https://fleet-hq.droplet-us.com` once §0.1-0.2
  hold; explicit workers.dev URL before that).
- `HQ_MINT_TTL_SEC` (default `2592000` = 30 days; see §4).

**Without `--device-id` the build is byte-for-byte unchanged** — the generic
ISO keeps ADR-020 §D6's "no per-device secret is baked, every built ISO is
byte-identical" property (`user-data:12-17`). The device build is an explicit,
documented deviation: that ISO now *contains a one-time credential* and must be
handled like one (flash it, don't publish it, track it by device_id). The blast
radius of a leaked seeded ISO is bounded by design: the token is single-use
(consumed on provision, `handlers.ts:342`), hash-stored at HQ (`:348, :358`),
TTL-bounded, and only lets the holder register *that* device_id before
first-use/expiry; every mint and provision is audit-logged (`:343, :359`).

### 3a. The mint call (runs inside build-iso.sh, after the sha256 gate, before repack)

```bash
resp=$(curl -fsS -X POST "${HQ_ISSUANCE_URL}/api/admin/provision-token" \
  -H "Authorization: Bearer ${HQ_ADMIN_TOKEN}" \
  -H 'content-type: application/json' \
  -d "{\"device_id\":\"${DEVICE_ID}\",\"ttl_sec\":${HQ_MINT_TTL_SEC}}")
TOKEN=$(jq -r .token <<<"$resp")          # 64 hex chars, returned ONCE (handlers.ts:356-360)
EXPIRES=$(jq -r .expires_at <<<"$resp")
```

Fail the build on any non-200 — a box flashed without a valid token boots fine
but dead-ends at the HQ 404 forever (`secrets.sh:776-779`).

### 3b. Where the token lands — a rendered per-device user-data

The stock build maps the tracked seed read-only into the xorriso container
(`build-iso.sh:188-189, 216-217`). For a device build, render a copy into
`WORK_DIR` and map that instead; the tracked
`scripts/image/autoinstall/user-data` is never modified. The rendered copy
differs in exactly two ways:

**(i) One added late-command** (alongside the existing clone/chown at
`user-data:95-113`) that writes the provisioning environment onto the target:

```yaml
  - |
    curtin in-target --target=/target -- bash -c '
      mkdir -p /etc/droplet
      printf "DROPLET_DEVICE_ID=%s\nDROPLET_PROVISION_TOKEN=%s\n" \
        "droplet-<serial>" "<TOKEN>" > /etc/droplet/provision.env
      chown root:droplet /etc/droplet/provision.env
      chmod 640 /etc/droplet/provision.env'
```

Ownership matters: **root-owned, group-readable, never droplet-writable** — the
file feeds a unit and a droplet-writable EnvironmentFile consumed by anything
privileged is the known LPE shape this repo already guards against
(droplet-writable EnvFile→root invariant).

**(ii) The firstboot unit heredoc (`user-data:119-137`) gains one line** in
`[Service]` and one cleanup in `ExecStartPost`:

```ini
EnvironmentFile=-/etc/droplet/provision.env
```

The `-` prefix is load-bearing: the generic (identity-less) ISO has no such
file, and a bare `EnvironmentFile=` on a missing path fails the whole unit —
same failure class as the `ReadWritePaths=` incident. Extend `ExecStartPost`
(currently marker-then-sudoers-rm, `user-data:131`) to also
`sudo rm -f /etc/droplet/provision.env` **after** the `.firstboot-done` stamp:
by then secrets.sh has copied both values into
`/home/droplet/edge-platform/.env` (seed `:783`, `:728` post-fix), and a spent
token shouldn't linger in a second world-invisible-but-unnecessary file.

Why this delivery point: the firstboot unit `ExecStart`s
`setup.sh --single-box --systemd` (`user-data:130`), setup.sh calls the
secrets.sh seed, and the seed expands `${DROPLET_PROVISION_TOKEN:-}` /
`${DROPLET_DEVICE_ID:-...}` **from the process environment** — which
`EnvironmentFile=` populates. No new plumbing, no second copy of provisioning
logic (ADR-020 §D1: setup.sh stays the single source of truth).

### 3c. Output naming

`OUT_ISO=droplet-<shape>-<version>-<device_id>.iso` when `--device-id` is set
(`build-iso.sh:98` today). The sha256 sidecar (`:236`) follows the new name.
Print the token's `expires_at` in the step-5 summary so the flash operator sees
the shelf-life deadline.

---

## 4. TTL / warehouse handling — mint at flash

The mint clamps `ttl_sec` to **60s..30d, default 1d**
(`handlers.ts:355`: `Math.min(Math.max(Number(body?.ttl_sec) || 86400, 60), 30 * 86400)`).
30 days is the ceiling — you cannot buy more shelf life with a bigger number.
Consequences:

- **Mint at flash, not at mass ISO build.** The token's clock starts at mint
  (`:357`). Build/flash the seeded ISO when a unit is being prepared to ship,
  not weeks ahead. (The generic base ISO can be pre-built and cached — only the
  render+mint+repack step is per-device, and the expensive download/verify is
  already skip-if-present, `build-iso.sh:147-154`.)
- **A box that first-boots after expiry** gets 401 `provisioning token expired`
  (`handlers.ts:335`) and stays on the self-signed bootstrap cert. Recovery for
  stale stock: re-mint for the same device_id and either re-flash, or (cheaper,
  no re-image) boot the box and place the new token in the provisioning
  environment / `.env` — the migrate path picks it up (`secrets.sh:944-948`)
  and the orchestrator retries on its issuance tick.
- **Re-boots are safe:** a consumed token re-presented by the same device/key
  is idempotent-OK, not an error (`handlers.ts:331-333`); registration commits
  before consumption so a crash between the two self-heals (`:337-343`).
- Track minted-but-unprovisioned units via the audit trail:
  `mint_token` rows without a matching `provision` row
  (`GET /api/admin/audit?device_id=...`, `handlers.ts:418-424`).

---

## 5. Verification recipe — seeded ISO boots a VM into the HQ registry

Run on a Linux host with Docker (the builder's own gate, `build-iso.sh:25-27`).

1. **Mint + build** with a throwaway id:
   `HQ_ADMIN_TOKEN=... ./scripts/image/build-iso.sh --device-id droplet-vmtest-$(date +%m%d)`.
   Confirm the summary prints the per-device ISO name + `expires_at`.
2. **Static check — the seed landed and the tracked seed didn't change:**
   `xorriso -indev output/droplet-*-vmtest-*.iso -osirrox on -extract /server/user-data /tmp/ud`
   → `/tmp/ud` contains the `provision.env` late-command and
   `EnvironmentFile=-/etc/droplet/provision.env`; `git status` shows
   `scripts/image/autoinstall/user-data` untouched.
3. **Boot it:** QEMU/KVM, ≥8G RAM, a blank ≥80G disk (the curtin layout needs
   room for the 64G root LV + free extents, `user-data:61-76`), NAT network
   with internet (firstboot clones the repo + pulls images, `user-data:28-35`).
   Let autoinstall + the firstboot unit run to completion
   (`systemctl status droplet-firstboot` → inactive/dead with
   `/var/lib/droplet/.firstboot-done` present).
4. **On the VM:**
   `grep -E '^(DROPLET_DEVICE_ID|DROPLET_PROVISION_TOKEN)=' /home/droplet/edge-platform/.env`
   → the vmtest id and the 64-hex token; `test ! -f /etc/droplet/provision.env`
   (cleaned up); `test ! -f /etc/sudoers.d/droplet-firstboot` (existing
   invariant, `user-data:139-149`).
5. **Watch the handshake:**
   `docker compose -f docker/docker-compose.yml logs orchestrator | grep -Ei 'tls-issuance|provision'`
   → the 404-then-provision-then-retry sequence (WARP-983,
   `tls-issuance.service.ts:496+`), ending in an issued state.
6. **On HQ (the ground truth):**
   `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "https://fleet-hq.droplet-us.com/api/admin/audit?device_id=droplet-vmtest-<date>"`
   → a `mint_token ok` row and a `provision ok` row.
7. **Idempotence:** reboot the VM; no 409, no duplicate registration
   (`handlers.ts:331-333`); audit shows `idempotent=true` at most.
8. **Cleanup:** deregister the test device
   (`DELETE /api/issuance/registration`, device-authed — or leave the row and
   note it; deregister DELETES the registry row, `secrets.sh:775-777`).

**Acceptance = steps 2, 4, 5, 6 all green on one uncut run.**

---

## 6. Explicitly out of scope

- Raising the 30-day TTL cap (an HQ contract change; file separately if the
  factory pipeline proves 30d too tight).
- Phase-2 golden raw `.img` (`build-iso.sh:14-15`) — the same render-and-inject
  applies, but that path doesn't exist yet.
- Friendly names — `POST /api/admin/assign-name` after provisioning, existing
  HQ-ops surface (`handlers.ts:363-416`).
- Real-TPM identity (WARP-230/IDX-002) — the mock backend signs real DER and
  the PoP flow is backend-agnostic (`secrets.sh:717-727`).
