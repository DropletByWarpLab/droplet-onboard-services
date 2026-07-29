# ADR-019: Storage pool (software-RAID) management

- **Status:** Accepted — shipped (status corrected 2026-07-27; see Status audit below)
- **Date:** 2026-06-04
- **Authors:** Stefan Cruceru
- **Related tickets:** BUG-3 (drives page + RAID/drive-pool management)
- **Related ADRs:** [ADR-011](ADR-011-hardware-agnostic-codebase.md) (hardware-agnostic codebase — no host-specific device assumptions); the smart-home / network safety-tier framework (`apps/orchestrator/src/services/safety-tier.service.ts`, `network-safety.service.ts`) whose confirm-token machinery this reuses; WARP-612 drive eject (`/api/storage/drives/:uuid/eject`) whose auth-gated host-action pattern this extends.
- **Related hardware decision:** [`pcb-claude-tool/docs/MODULAR_PLATFORM_SPEC.md`](../../pcb-claude-tool/docs/MODULAR_PLATFORM_SPEC.md) **O-006** — Storage controller = Switchtec PM50036 + **Linux `mdadm` software RAID** ("Cheaper; sufficient for SMB workload; future v3 may upgrade to HW RAID if customer demand justifies"). The v2.6 Storage brick fans out to **up to 8 mixed drives** (4× 3.5" SAS rear hot-bay + 4× M.2 NVMe front hot-bay).

## Context

The dashboard already has a read-only drives surface (`/files/drives` →
`DrivesPanel.tsx`, backed by `GET /api/storage/drives` →
`services/oled-display/device-bridge.py` `GET /drives`). It lists each mounted
volume with size / SMART / bus, and the device-bridge can safely **eject** a
hot-plug drive (WARP-612). What it does **not** have is any notion of a
**storage pool / RAID array**: today `DrivesPanel` fakes a "Total pooled
storage" figure by *summing the bytes of every mounted drive client-side*. That
number is a fiction — it implies a pool that does not exist, and it would be
flat wrong the moment a real mirror (RAID1) or parity array (RAID5/6) existed,
where usable capacity is far less than the raw sum.

The hardware roadmap (O-006) commits the v2.6 Storage brick to **`mdadm`
software RAID** across up to 8 mixed SAS/NVMe drives. There is no *software* ADR
for how the control plane (orchestrator + device-bridge + dashboard) should
read, present, and — when the owner explicitly asks — *create or destroy* those
arrays. This ADR writes that contract.

Creating, destroying, formatting, or re-leveling a RAID array is the single most
**data-destroying** capability anywhere in the product. A wrong `mkfs` or
`mdadm --create` on a populated disk is unrecoverable. So the design priority,
stated by the owner and adopted here verbatim, is **safety and optionality over
features**:

> **RAID / pool setup is OPTIONAL — never a requirement.** The box must fully
> function with no pool configured; the setup-wizard storage step is skippable;
> nothing ever auto-creates or auto-formats a pool or a disk.

## Decision

### D1 — Technology: `mdadm` software RAID (per O-006)

We manage pools with **Linux `mdadm`** (md software RAID), reading state from
`/proc/mdstat` and `mdadm --detail`. No hardware-RAID controller dependency, no
ZFS/btrfs-native pooling. This matches the locked hardware decision O-006 and
keeps the same code path working across every deployment shape (`single-box`,
`multi-box`, `v2-6`) since md is in-kernel everywhere.

### D2 — Pools are owner-driven and OPTIONAL. Nothing is ever automatic.

- The box boots, indexes files, runs cameras, and serves the dashboard with
  **zero pools** configured. A pool is never required for any feature.
- **Nothing auto-creates or auto-formats** a pool or a disk — not at first boot,
  not at setup, not by a reconciler, not by the AI. There is no "default pool".
- The setup wizard's storage step is **skippable** and **creates no pool**. (It
  is, today, a drive *naming* step — it already never formats anything. This ADR
  keeps it that way and makes the "storage setup is optional, no pool is
  created" guarantee explicit and tested.)
- `GET /api/storage/pools` returns `[]` **honestly** when no array exists — it
  never synthesizes a fake pool from loose drives. The dashboard renders an
  explicit "No storage pool configured" state, not a fabricated capacity.

### D3 — Explicit state enums (handbook rule 10: state is explicit, never derived from absence)

State is carried in explicit enum columns, never inferred from `IS NULL` or from
the presence/absence of a row. Canonical precedent: WARP-218
`BrainMemoryItemStatus`.

```
PoolStatus  = active | degraded | resyncing | failed | none
DiskRole    = active | spare | failed | unassigned
ArrayLevel  = raid0 | raid1 | raid5 | raid6 | raid10 | jbod
```

- **`PoolStatus.none`** is a first-class value (a pool record can exist in a
  pre-create / torn-down state without us guessing from null columns). "No pool
  at all" is the *absence of any `StoragePool` row* — distinct from a row whose
  status is `none`.
- `PoolStatus` is the source of truth for the dashboard's banner: `degraded` /
  `failed` drive the red "array degraded" banner; `resyncing` drives the rebuild
  progress affordance.
- The device-bridge maps raw `mdadm` state strings → these enums in one place
  (`_pool_status_from_mdadm`) so the dashboard never parses `mdstat` text.

### D4 — Safety-tier contract for destructive ops

Storage operations are classified into the same three-tier model the smart-home
(`safety-tier.service.ts`) and network (`network-safety.service.ts`) subsystems
already use:

| Tier | Storage operations | Gate |
|---|---|---|
| **Tier 1 — read-only** | list pools, get pool detail, list pool members, SMART health | No confirmation. Safe to auto-execute and safe for the AI to read. |
| **Tier 2 — owner-confirmed write** | *(none today — all writes here are data-destroying, so they are Tier-3-class)* | — |
| **Tier 3 — data-destroying, owner-only, AI-blocked** | `pool_create`, `pool_destroy`, `pool_format`, `pool_set_level`, `pool_add_spare`, `pool_remove_disk` | Human owner/admin **only**, behind a **single-use, short-TTL confirmation token bound to {service, resourceId}**. **Never callable by the AI.** |

A destructive storage op is **impossible** without ALL of:

1. **An authenticated owner/admin.** Every mutating route is behind
   `requireRole("owner", "admin")` (mirrors `routes/switch.ts`). The AI has no
   owner session.
2. **A valid confirmation token.** The route first *evaluates* the op (Tier 3 →
   202 + token bound to `{service, resourceId}`), then a separate
   `POST /api/storage/command/confirm` *executes* it only on a matching,
   unexpired, single-use token. A token for `pool_destroy` on pool `md0` cannot
   confirm a `pool_destroy` on `md1`, nor a `pool_format`.
3. **A passing host-script pre-flight.** Even with owner + token, the actual
   `mdadm` / `mkfs` runs in a host script (`scripts/host/droplet-storage-pool.sh`)
   that **refuses** if any target disk is mounted, holds a filesystem with data,
   or is (or backs) the OS disk — and requires a typed double-confirm naming the
   exact disks and the data being erased. The script never runs blind.

### D5 — The AI is blocked entirely from destructive storage (defense beyond Tier 3)

The destructive operations are **not registered in `packages/tools-core`** at
all — exactly as `factory_reset` and `reboot` are simply absent from the tool
registry. There is no MCP tool, no `WRITE_TOOLS` entry, no handler. The AI
cannot name an operation that does not exist in the registry. The **read-only**
pool list MAY be exposed as a tools-core tool (`requiresWrite: false`,
`requiresConfirmation: false`), because reading array health is safe and useful
("is my storage healthy?"). The create/destroy path is owner-dashboard-only.

### D6 — Execution lives in a repo-tracked host script installed by `setup.sh` (rule 20)

`mdadm` and `mkfs` need root and the host's real block devices; they cannot be
shelled from inside a container, and a hand-placed `/usr/local/sbin` script is
forbidden (rule 20). So:

- The script `scripts/host/droplet-storage-pool.sh` is **repo-tracked**.
- `setup.sh` installs it (via `scripts/install-device-bridge.sh`, alongside the
  existing `droplet-shutdown-screen.sh` host script) to
  `/usr/local/sbin/droplet-storage-pool.sh`, so `factory-reset` can remove it
  cleanly and no box ever carries an out-of-tree copy.
- The device-bridge invokes it for destructive ops via an **auth-gated POST**
  (`X-Droplet-Auth`, same token + constant-time compare as `/drives/:uuid/eject`).
- The script's hard pre-flight (D4.3) is the last line of defense and is unit
  tested for each refusal (mounted / has-data / OS-disk / missing double-confirm).

#### D6.1 — The bridge cannot run the script itself: spool + root apply unit

The original D6 wiring had the bridge `exec` the script directly — but the
bridge runs as `User=droplet` inside `ProtectSystem=strict` +
`NoNewPrivileges`, where every privileged step fails (`EPERM` opening the
`root:disk 0660` block devices, `EROFS` under `/mnt`) and, worse, the `blkid`
"has data" probe **silently degrades**: an unprivileged `blkid -p` cannot open
the device, prints nothing, and the guard passes. Verified on the shipping
single-box. So no pool op could ever succeed from the sandbox, and the
pre-flight is only trustworthy under root.

The fix follows the WARP-808 hostapd split (StateDirectory write + a
narrowly-scoped polkit grant), adapted because `mdadm` is a direct binary with
no unit of its own to polkit-restart:

1. The bridge writes `{request_id, operation, params}` atomically to
   `/var/lib/droplet-bridge/pool-spool/request.json` — inside its own 0700
   `StateDirectory`, so only the bridge (or root) can place a request.
2. It then runs `systemctl start droplet-storage-pool-apply.service` — a
   D-Bus ask to PID 1, authorized for the `droplet` user by
   `services/oled-display/50-droplet-device-bridge.rules` (that one unit,
   `start` verb only). `NoNewPrivileges` stays on; there is no sudo anywhere.
3. The apply unit (root, `Type=oneshot`, never enabled) runs
   `scripts/host/droplet-storage-pool-apply.sh`, which consumes the one
   spooled request, runs `droplet-storage-pool.sh` — whose D4.3 pre-flight now
   probes with root and therefore actually bites — and writes
   `pool-spool/result.json` (`{request_id, rc, stdout, stderr}`) back for the
   bridge to read, verify against its `request_id`, and delete.

A blocking `systemctl start` of a oneshot returns when `ExecStart` exits, so
the bridge reads the result synchronously; concurrent POSTs are refused by a
non-blocking in-process lock (and systemd serializes the unit besides). A
refused pre-flight is **not** a unit failure — the refusal travels in
`result.json` so a wrong confirm phrase never leaves a failed unit behind.

### D7 — Read path

`GET /api/storage/pools` (orchestrator, read-only, no role gate — reading health
is safe) → device-bridge `GET /pools` (read-only: parses `/proc/mdstat` +
`mdadm --detail --scan`, never mutates) → joined with the `StoragePool` /
`PoolMember` Prisma rows for owner-chosen names/notes, exactly as
`GET /api/storage/drives` joins the `Drive` table. Returns `{ pools: [], count: 0 }`
honestly when md reports no arrays.

## Consequences

**Positive**

- The dashboard shows the *truth*: real arrays with real usable capacity, real
  degraded/rebuild state, or an honest "no pool" — never a fabricated sum.
- The owner's optionality guarantee is structural and tested: there is no code
  path that creates a pool without an explicit owner action + token + passing
  host pre-flight, and none at all for the AI.
- One safety model across smart-home / network / storage — same token shape,
  same `requireRole`, same audit log, lower cognitive load for reviewers.

**Negative / costs**

- `mdadm` software RAID has a CPU/throughput cost vs. hardware RAID under heavy
  parity workloads. Accepted per O-006 for the SMB target; revisit if customer
  demand justifies a hardware-RAID brick variant.
- A second host script to keep in lock-step with `setup.sh` / `factory-reset`
  (mitigated by installing it through the existing `install-device-bridge.sh`).
- The confirm-token + host-pre-flight double gate adds friction to a legitimate
  owner create/destroy. That friction is the point for a data-destroying op.

## Non-goals

- **No auto-tiering, auto-rebuild-on-replace, or auto-pool-creation.** Every
  destructive transition is owner-initiated.
- **No hardware-RAID controller integration** (O-006 chose software RAID).
- **No ZFS/btrfs pooling.** md only, for cross-shape uniformity.
- **No per-host hardcoded device list or default RAID level** (rule 12) — the
  owner picks the level and the member disks every time.

## Status audit — 2026-07-27

Flipped `Proposed` → `Accepted`. Evidence on `main`:
`apps/orchestrator/src/routes/storage.ts` serves the storage surface, with
`src/__tests__/storage-pools.routes.test.ts` and `src/__tests__/storage.test.ts`
covering it.
