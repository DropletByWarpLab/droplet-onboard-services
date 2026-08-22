# Network drive — the Droplet folder in Windows Explorer / macOS Finder

The Droplet exposes a shared **"Droplet"** folder as a native SMB network
drive, so it appears directly in both desktop file systems with nothing to
install:

- **Windows** — the box shows up under Explorer's **Network** (WS-Discovery),
  and the share is reachable at `\\droplet-ai.lan\Droplet` (router DNS) or
  `\\droplet-ai.local\Droplet` (mDNS, Windows 10+).
- **macOS** — the box appears in Finder's **Network** browser/sidebar (mDNS),
  and `smb://droplet-ai.local/Droplet` (Finder → Go → Connect to Server…, ⌘K)
  connects directly.

Files written from the desktop appear in the web dashboard's Files UI (and
vice versa) — both surfaces are views of the same tree.

The dashboard renders all of this for the customer: **Files → Connect
drive** (owner/admin only) shows the two addresses, the username, and the
password with copy buttons.

## How it fits together

```
Windows Explorer ── WS-Discovery ──▶ wsdd2 ─┐
macOS Finder ────── mDNS (_smb._tcp) ───────┤   samba container (host net, :445)
                    (HOST avahi,            │   account `droplet` (uid 33)
                     scripts/lib/local-dns.sh)  force user → uid 33 writes
                                            │
                                            ▼
                                   droplet-share volume
                                            ▲
                                            │  files_external LOCAL mount
                                            │  "/Droplet", filesystem_check_changes=1
                                   Nextcloud (web Files UI, WebDAV, dashboard)
```

Four pieces, all provisioned by `./scripts/setup.sh`:

1. **`samba` compose service** (`docker/docker-compose.yml`, `linux`
   profile, `network_mode: host`) — `ghcr.io/servercontainers/samba`
   (pinned tag + digest) exporting the `droplet-share` named volume as the
   share `[Droplet]`. The bundled **wsdd2** answers Windows WS-Discovery
   probes; the image's own avahi and NetBIOS (`nmbd`) are disabled.
2. **Host Avahi advertisement** (`scripts/lib/local-dns.sh`) — the existing
   `/etc/avahi/services/droplet.service` file now also announces
   `_smb._tcp:445` (Finder discovery) and a `_device-info._tcp` model record
   (Finder icon).
3. **Nextcloud registration** (`docker/nextcloud-init.sh`) — the same volume
   is mounted into the Nextcloud container at `/droplet-share` and registered
   idempotently as the files_external **local** mount `/Droplet` with
   `filesystem_check_changes=1`, so out-of-band SMB writes are picked up on
   access without a manual `occ files:scan`. It is deliberately **not** a
   groupfolder: groupfolder trees live inside `oc_filecache`-tracked storage
   where out-of-band writes desync the cache; external local mounts tolerate
   them by design.
4. **Credential** (`scripts/lib/secrets.sh`) — a per-device `SMB_PASSWORD`
   (alphanumeric, 20 chars) for the **fixed `droplet` account**, generated
   into `.env` on fresh installs and backfilled by `migrate_env` on upgrades.

## Auth & security model (v1)

- **One device-wide credential.** The `droplet` SMB account opens the shared
  Droplet folder — and only it. Personal spaces, department libraries, and
  the rest of Nextcloud are *not* exposed over SMB. Because the credential is
  device-wide (no per-user permissions on the wire), the orchestrator's
  `GET /api/storage/network-drive` is `requireRole("owner", "admin")` and the
  dashboard hides the "Connect drive" button from family/guest sessions.
  Per-user SMB accounts mapped to Nextcloud identities are the natural
  follow-up if per-user permissions over SMB are ever needed.
- **LAN-only.** smbd binds the host on the Vault's LAN; nothing crosses the
  WAN boundary (the share is not reachable over the remote-access overlay
  unless the peer routes the LAN subnet, which is the same posture as every
  other LAN service).
- **Fails closed.** An empty `SMB_PASSWORD` (a `.env` predating the feature,
  before `migrate_env` runs) leaves the account created with an empty
  password, which smbd's `null passwords = no` default refuses — no
  passwordless share, and no `${VAR:?}` interpolation failure that would
  brick an OTA recreate.
- **Uid discipline.** The SMB account maps to uid 33 (`www-data`) and the
  share forces all writes to it, matching what Nextcloud writes as — neither
  surface can strand files the other can't modify.

## Enablement matrix

| Knob | Written by | Effect |
|---|---|---|
| `linux` in `COMPOSE_PROFILES` | `setup.sh` (Linux hosts) | Actually starts the `samba` container (host networking is Linux-only) |
| `SMB_ENABLED` | `setup.sh` (`1` Linux / `0` macOS) | EXPLICIT switch the orchestrator surface reports; never derived from `SMB_PASSWORD` |
| `SMB_PASSWORD` | `setup.sh` / `migrate_env` | The `droplet` account credential |

## Troubleshooting

- **Box not visible in Explorer's Network** — wsdd2 needs the host network
  and `NET_ADMIN` (both set in compose). Direct path always works:
  `\\droplet-ai.lan\Droplet`. Check `docker logs droplet-samba`.
- **Box not visible in Finder** — the host avahi service file is written by
  `scripts/lib/local-dns.sh`; re-run `./scripts/setup.sh` after hostname
  changes. Direct path: ⌘K → `smb://droplet-ai.local/Droplet`.
- **Logon refused** — `.env` has no `SMB_PASSWORD` (pre-feature install):
  re-run `./scripts/setup.sh`, then recreate the container
  (`docker compose … up -d --force-recreate samba` — `docker restart` does
  NOT re-read `.env`).
- **SMB write not visible in the web UI** — the `/Droplet` external mount
  re-stats on access (`filesystem_check_changes=1`); a hard refresh of the
  Files page re-lists. If the mount is missing entirely, the next Nextcloud
  container start reconciles it (`nextcloud-init.sh` is a boot-time
  reconcile hook).
- **Files created over SMB aren't searchable/brain-indexed** — known v1
  limitation: `file-indexer` watches the Nextcloud data volume, and the
  external-storage tree lives outside it. Indexing the share is a follow-up.

## Port/footprint summary

| Surface | Port | Container |
|---|---|---|
| SMB | 445/tcp (host) | `droplet-samba` (smbd) |
| WS-Discovery | 3702/udp + 5357/tcp (host) | `droplet-samba` (wsdd2) |
| mDNS | 5353/udp | host `avahi-daemon` (pre-existing) |

NetBIOS (137/138/139) is disabled — wsdd2 covers every supported Windows
version.
