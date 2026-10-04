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
drive** shows the two addresses, the username, and the password with copy
buttons (owner/admin only), plus each user's own drive login when the owner
has turned personal drives on (see "Per-user drive (WebDAV)" below).

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
  dashboard hides the shared-folder section from family/guest sessions.
  Per-user SMB accounts mapped to Nextcloud identities are the natural
  follow-up if per-user permissions over SMB are ever needed.
- **LAN reach, not LAN binding.** The Samba container runs with host
  networking and the compose block sets no `interfaces` or
  `bind interfaces only`, so smbd listens on every host interface, including
  an uplink where the host has one. Keeping port 445 off the uplink relies on
  the network layout and the host firewall, not on this configuration.
  Binding smbd to the LAN interface needs a name that is correct on every
  supported shape (a stock single-box has no `br-lan`); it is tracked in
  WARP-3576 and not done yet. The share is not reachable over the
  remote-access overlay unless the peer routes the LAN subnet, the same
  posture as every other LAN service.
- **No rotation yet.** Removing or demoting a member does not change
  `SMB_PASSWORD`, and SMB writes are not attributed to a person (all map to
  uid 33). The SMB protocol floor and signing/encryption are the image
  defaults. Rotation, per-person logins and those settings are tracked in
  WARP-3576.
- **Fails closed.** An empty `SMB_PASSWORD` (a `.env` predating the feature,
  before `migrate_env` runs) leaves the account created with an empty
  password, which smbd's `null passwords = no` default refuses — no
  passwordless share, and no `${VAR:?}` interpolation failure that would
  brick an OTA recreate.
- **Uid discipline.** The SMB account maps to uid 33 (`www-data`) and the
  share forces all writes to it, matching what Nextcloud writes as — neither
  surface can strand files the other can't modify.

## Per-user drive (WebDAV)

The SMB share above is one device-wide login for the shared folder. Owners,
admins and family members (not guests, not `service`) can also map **their
own** drive: Nextcloud's WebDAV endpoint, authenticated as that user.
Nextcloud's own ACLs apply — a user sees only their My Files, Household and
the department folders whose Nextcloud group they are in — but the drive
talks to Nextcloud directly, so the controls only the orchestrator enforces
do **not** apply (see "What the drive does not enforce" below).

**Owner setting, off by default.** Personal drives only work once the owner
turns on **Settings -> Personal drives**. The setting is the explicit boolean
`Workspace.personalDriveEnabled` (default `false`, singleton row `id = 1`).
Only the owner may change it (`PUT /api/settings/workspace/personal-drive`,
body `{ "enabled": boolean }`; admins get `403 owner_required`); any signed-in
user can read it as `personalDriveEnabled` in `GET /api/settings/workspace`,
which is how the dialog knows to show "Personal drives aren't turned on for
this Droplet" instead of the create button. Every change is an Activity row.
While it is off, the POST below answers `403 {"error":"personal_drive_disabled"}`
and mints nothing. Turning it off also **revokes every personal drive login**:
the PUT marks each active `DeviceClient` with `kind = personal_drive` revoked
(the Nextcloud app password is deleted best-effort; the row is marked revoked
either way, so `<n>` counts rows marked revoked, not passwords Nextcloud
confirmed deleted), leaves native-app pairings (`kind = app_pairing`) alone, and
answers `{ "personalDriveEnabled": false, "revokedDriveLogins": <n> }`. The
flag change and the revoke outcome are two Activity rows (the outcome row lists
each revoked login, or records "failed after N revoked" if the sweep throws,
which is a 500). If the switch-off lands while a login is being minted, the
POST notices once its row exists, revokes it and answers 403
`personal_drive_disabled` without returning a password. Logins created
**before** the `kind` column existed (migration
`20260930100000_device_client_kind`) cannot be told apart from pairings and are
not bulk-revoked; each person can find theirs in their own devices list (Paired
devices) as "Finder on …" / "File Explorer on …" and remove them there. The
setting's copy tells the owner that drive access
skips the download audit and the per-file upload limit.

**Flow.** Files page -> Connect as a network drive -> "Your drive" -> pick Mac
or Windows -> "Create my drive login". The orchestrator mints a per-device
Nextcloud **app password** for the caller (same mechanism as device pairing),
stores it encrypted in `DeviceClient` (`deviceType: desktop`,
`kind: personal_drive`, name "Finder on My Mac" / "File Explorer on My PC"),
and returns it once. The user
pastes the address and login into Finder (Go -> Connect to Server, tick
"Remember this password in my keychain") or Explorer (This PC -> Map network
drive, tick "Reconnect at sign-in" and "Connect using different credentials").

**Auth model.** The app password is scoped to the one user, shown once, and
revocable individually (`DELETE /api/devices/clients/:id`, i.e. the devices
list) without touching the user's real password. Minting needs the caller's
Nextcloud session token, which SSO and passkey logins never receive: those
callers get `409 {"error":"nc_credential_unavailable"}` and the UI asks them
to sign in with their password once. Rate limit: 10 logins per user per hour.

**Endpoint** (also for the droplet-windows desktop app and a future macOS app,
which call it to map the drive automatically):

```
POST /api/storage/network-drive/personal      (session auth; owner|admin|family)
{ "platform": "macos" | "windows", "computerName"?: string /* 1-60 chars */ }

200 {
  "deviceId":    "<DeviceClient id>",
  "username":    "<Nextcloud uid>",
  "appPassword": "<plaintext, returned once>",
  "webdavUrl":   "https://<host>/nextcloud/remote.php/dav/files/<uid>/",
  "macosUrl":    "https://<host>/nextcloud/remote.php/dav/files/<uid>/",
  "windowsPath": "\\\\<host>@SSL\\nextcloud\\remote.php\\dav\\files\\<uid>"
}
400 invalid body | 403 role not permitted (guest, service)
403 personal_drive_disabled (owner setting is off, or was switched off mid-request)
409 nc_credential_unavailable
429 rate limited | 502 Nextcloud refused to mint
```

`<host>` comes from the trusted-origin resolver (never a raw request header).
A non-443 port is emitted as `<host>@SSL@<port>` in `windowsPath`.

**What the drive does not enforce.** Everything below is enforced by the
orchestrator's Files API (`routes/files.ts`) and not by Nextcloud, so a
Finder/Explorer mount bypasses it. These two remain documented gaps
(WARP-3318 tracks them and the credential surface itself; the owner accepts
both, in plain words, when turning the setting on):

- **Download audit.** The Files API records a "File downloaded" Activity
  row; files opened or copied out over WebDAV leave none.
- **Per-file upload size cap.** `UserUsagePolicy.maxUploadSizeMb`
  (WARP-1271) is checked only on Files API uploads. The *storage quota* is
  different: the usage-policy reconciler pushes it into Nextcloud, so it
  still applies to WebDAV writes.

**Sharing is closed at the gateway.** An app password is full-scope and would
also work against Nextcloud's OCS sharing API, letting any user mint shares
and public links without the department manager check or the WARP-3053 rule
that only owners/admins publish Workspace files. The gateway therefore
answers 403 for `/nextcloud/ocs/v1.php/apps/files_sharing` and
`/nextcloud/ocs/v2.php/apps/files_sharing` (any suffix, any method) before
proxying (`docker/nginx/nginx.conf`, pinned by
`tests/nginx-nextcloud-assets.test.sh` Phase 7; `docs/THREAT_MODEL.md` §3a).
That covers every app password, including the ones device pairing mints. The
web app's own sharing is unaffected: the orchestrator reaches Nextcloud over
the compose network (`NEXTCLOUD_URL`), not through the gateway. Contributor and
manager are the same Nextcloud group (`dept-<slug>`), so the department
manager check and the WARP-3053 share rule are orchestrator policy; with
sharing closed here, a mounted drive can no longer sidestep either.

Because the gateway blocks Nextcloud's sharing API, Nextcloud's own web UI share
dialog and the Nextcloud desktop and mobile clients cannot create shares through
the box's gateway; the Droplet dashboard is the sharing surface. The same
denial covers the other OCS routes that mint a credential-free link (editor
direct-editing links, direct-download links; audit in `docs/SECURITY.md`).

**Known limits.**

- Windows' WebClient service caps file transfers at **50 MB by default**
  (`FileSizeLimitInBytes`) and requires a certificate Windows trusts
  (`scripts/trust-droplet-cert.sh` / the per-device public FQDN cert);
  otherwise the mapping fails with "network path not found" or a cert error.
- Finder over WebDAV is noticeably slower than SMB on very large folders.
- The app password is per computer; a new machine needs its own login.

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
- **Windows 11: `Windows cannot access \\DROPLET`, no password prompt** —
  the box must have `map to guest = Never` (`SAMBA_CONF_MAP_TO_GUEST` on the
  `samba` service, shipped since WARP-3516). Without it Samba answers
  Windows' first try (the PC's own account) with a guest session, which
  Windows 11 24H2+ refuses, so it never prompts. With it, Windows asks for
  the user `droplet` and the password from **Files → Connect drive**; tick
  **Remember my credentials**. Never enable insecure guest logons on the PC
  to get around it.
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
