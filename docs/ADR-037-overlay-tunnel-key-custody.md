# ADR-037: Overlay tunnel key custody — where a client's WireGuard private key is born and lives

- **Status:** Accepted (2026-08-05)
- **Epic:** [WARP-1382](https://warp-lab.atlassian.net/browse/WARP-1382) · this doc: [WARP-1596](https://warp-lab.atlassian.net/browse/WARP-1596)
- **Builds on:** ADR-031 (own WireGuard overlay), ADR-023 (per-device public-CA TLS, split-horizon), [WARP-1757](https://warp-lab.atlassian.net/browse/WARP-1757) (profile issuance), WARP-894 (DPAPI secure store on Windows)
- **Forces a decision on:** [WARP-1591](https://warp-lab.atlassian.net/browse/WARP-1591) (iOS discards its enrolled key), [WARP-359](https://warp-lab.atlassian.net/browse/WARP-359) / [WARP-1388](https://warp-lab.atlassian.net/browse/WARP-1388) (Windows tunnel client)
- **Amended by:** [Amendment 1](#amendment-1-the-native-windows-client-warp-3245) (2026-09-27, [WARP-3245](https://warp-lab.atlassian.net/browse/WARP-3245)) for the native Windows client of [ADR-062](ADR-062-native-desktop-clients.md): the client is named, the pipe is machine-wide, the token file is write-only, the client-process gate is specified, and the vpnd pipe protocol is `PROTOCOL.md` v1. The custody rule itself is unchanged. [ADR-061](ADR-061-native-linux-client.md) Decision 7 records one Linux exception to it (Proposed).

## Context

The overlay's QR enrollment flow has each client generate its **own** WireGuard
keypair and submit only the public half. The box never sees a client private
key — that is the invariant that makes the tunnel genuinely end-to-end, and it
is why [WARP-1757](https://warp-lab.atlassian.net/browse/WARP-1757) issues a
*profile* rather than a rendered `.conf`: rendering a conf server-side would
imply a private key we must never hold.

That invariant is settled. What was never decided is the other end: **on the
client, where is that private key born, and what is allowed to read it?** Three
platforms answered differently, and two of the three answers are wrong:

- **Android** generates in-app and hands the key to `GoBackend`, which runs
  in-process. Coherent.
- **iOS** generates the keypair at enrollment and *discards the private half*
  (`OverlayEnrollStore.swift:101`), on the reasonable-sounding principle that
  enrollment is not connection. But the box persists the submitted public key
  and, on approval, mints a real overlay device against a cap of 20. So every
  iOS enrollment permanently consumes one of 20 slots with a peer whose private
  key does not exist anywhere in the world. A household that enrolled twenty
  times is wedged until someone prunes by hand
  ([WARP-1591](https://warp-lab.atlassian.net/browse/WARP-1591)).
- **Windows** hard-gates key generation entirely (`OverlayDeviceIdentity::provision()`
  returns `Err(Gated)`). The recorded reason — "there is no non-plaintext sink
  for the WG / ECDSA private keys" — is factually wrong; `secure_store.rs` has
  been the DPAPI sink since WARP-894. The gate is still the right call, but for
  a different and sharper reason, and that reason is the whole subject of this
  ADR.

The sharp constraint on Windows: a tunnel needs a privileged component (a TUN
adapter and route table writes are not user-mode operations), and **DPAPI
user-scope ciphertext is not readable by a SYSTEM-level service.** Storing it
machine-scope instead, or in any file the user-mode app can write, walks
straight into the standing hard rule that *no droplet-writable file may feed a
privileged unit* — that pattern is a local privilege-escalation vector. So on
Windows the naive shape ("app generates key, app stores it, service reads it")
is not merely inelegant; it is the thing we have already banned.

## Decision

**The WireGuard private key is born inside whatever component owns the tunnel,
and never leaves it. The user-mode app never sees the private half.**

Concretely, per platform:

| Platform | Tunnel owner | Key born in | Storage | App's access |
|---|---|---|---|---|
| **Windows** | `droplet-vpnd`, a Windows service | the service | service-scope secret, written and read only by the service account | public key only, over IPC |
| **iOS** | `NEPacketTunnelProvider` extension | the extension | Keychain, `WhenUnlockedThisDeviceOnly`, shared via App Group with the extension as sole writer | public key only |
| **Android** | `GoBackend`, in-process | the app process | Keystore-backed credential store | holds both — same trust domain |

Android is listed for completeness: there is no privilege boundary to cross, so
"born in the tunnel owner" and "born in the app" are the same place. The rule is
not "hide the key from the app" for its own sake; it is "never move a private
key across a privilege boundary."

> **Linux is a recorded exception, not a row in this table**
> ([ADR-061](ADR-061-native-linux-client.md) Decision 7, Proposed):
> NetworkManager owns the tunnel, and the app generates the keypair and hands
> the private half to NetworkManager once, over D-Bus, into a connection bound
> to the enrolling user. The app does see the private half for that moment, so
> the headline rule above is not met. ADR-061 records why that is acceptable
> and under which conditions.

### Consequences for enrollment

This forces the resolution of [WARP-1591](https://warp-lab.atlassian.net/browse/WARP-1591),
and it picks **option 2** from that ticket: **do not register a WireGuard public
key until the component that owns the tunnel exists and has generated one.**

Enrollment stages *identity* — the ECDSA-P256 sign key that proves possession of
the pending enrollment. The WG public key is submitted when the tunnel owner has
minted it. This preserves the "enrollment ≠ connection" principle iOS was
reaching for, while removing the failure it actually caused: no enrollment can
ever burn a capped overlay slot with a peer nobody can connect as.

Option 1 (persist the key at enrollment) is rejected: it puts a long-lived
tunnel private key on the device before any tunnel exists to use it, and on
Windows it cannot be done at all without crossing the privilege boundary this
ADR exists to forbid.

### The Windows shape, specifically

Split-privilege, as WARP-359 always described, and as Tailscale and WireGuard's
own Windows client both do it:

- **`droplet-vpnd`** — a Windows service. Contains the userspace WireGuard
  implementation (`boringtun`) and the TUN adapter (`wintun`). Owns the tunnel,
  the private key, and the route table writes. Installed by the MSI with a
  one-time admin prompt; after that, connect and disconnect are silent.
  *Amended (Amendment 1, row 5): asked at install and at each update.*
- **The Tauri shell** — user-mode UI. Talks to the service over a named pipe,
  loopback-only, token-authenticated. It can ask for `connect`, `disconnect`,
  `status`; it receives the public key to submit during enrollment. It cannot
  read the private key because the private key is never marshalled across the
  pipe.
- The pipe's ACL must admit only the installing user, and the token must not
  live in a file the service reads — the same LPE rule applies to the IPC
  credential as to the tunnel key.

> **Amended ([Amendment 1](#amendment-1-the-native-windows-client-warp-3245), rows 1-5):**
> the user-mode half is `Droplet.exe`, the native C# client of ADR-062, not
> the Tauri shell. The pipe admits every interactive user, because the tunnel
> is a machine resource. The token is a first reject in a file the service
> writes and never reads. The access control is a gate on the connecting
> process. A per-machine WiX MSI installs both halves.

macOS, when it lands, is the same shape with a `launchd` LaunchDaemon and
`utun`.

### Rogue-QR binding (the other half of WARP-1596)

Independently of custody: `parse_overlay_enroll_link` accepts **any** https
host, and `enroll_by_token` never consults the paired base URL — unlike
`get_home_peer_config`, which does. Once real keys are minted, scanning a
hostile QR would enroll the desktop into an attacker's overlay and disclose the
WG public key, the ECDSA identity SPKI, and `COMPUTERNAME` to an
attacker-controlled host, with no consent step anywhere in the Rust layer. The
Android review found the same missing allowlist independently.

**Therefore:** a client MUST bind `link.server` to the box it is already paired
with, or — when there is no pairing yet — show an explicit consent step naming
the destination host, plus a suffix check against the known Droplet domain.
This is a class fix across all three clients, not three separate nits.

> **Amended ([Amendment 1](#amendment-1-the-native-windows-client-warp-3245), row 6):**
> the rule stands. On Windows the native C# client implements it
> (WARP-2079). The Tauri code quoted above never did, and it is deleted with
> the shell rather than ported.

## Consequences

**Positive**

- The private key never crosses a privilege boundary on any platform, so the
  droplet-writable-file-feeds-privileged-unit LPE pattern cannot appear here.
- No enrollment can burn a capped overlay slot with an unusable peer; the
  20-device cap starts meaning what it says.
- "Enrollment ≠ connection" survives, and is now enforced by the shape of the
  flow rather than by a comment.
- The desktop key custody question that blocked WARP-359 has an answer, so the
  provisioning code can be written.

**Negative / owned**

- Enrollment becomes two-phase on the clients that defer their WG key: identity
  first, WG public key when the tunnel owner exists. That is a wire change on
  `POST /vpn/overlay/devices/by-token` (WG key becomes optional) plus a new
  authenticated call to attach it. It has to land coordinated across box, iOS
  and Windows.
  *Superseded ([Amendment 1](#amendment-1-the-native-windows-client-warp-3245), row 7):
  the wire change was never built, and neither Windows nor iOS needs it.*
- Windows gains a service to install, sign, upgrade and uninstall — real surface
  area, and the MSI now needs an admin prompt it did not need before.
  *Amended (Amendment 1, row 5): asked at install and at each update.*
- Existing iOS enrollments that already burned slots need a one-time prune.
  There are no customer boxes in this state; the lab box may need it.

**Not decided here**

- The IPC wire format and the service's upgrade/rollback story — WARP-359.
  *Wire format decided since: `droplet-vpnd/PROTOCOL.md` v1
  ([Amendment 1](#amendment-1-the-native-windows-client-warp-3245), row 8).*
- Whether the desktop app becomes the *primary* laptop path (a positioning
  question flagged on WARP-359, for Romain).
- Relay fallback for boxes with no dial-able candidate —
  [WARP-1390](https://warp-lab.atlassian.net/browse/WARP-1390).

## Amendment 1: the native Windows client (WARP-3245)

- **Status:** Accepted, 2026-09-30, by Stefan Cruceru, who merged it ahead
  of Romain's sign-off. R15 below stays provisional until Romain confirms it.
- **Date:** 2026-09-27 · **Ticket:** [WARP-3245](https://warp-lab.atlassian.net/browse/WARP-3245) · epic [WARP-3223](https://warp-lab.atlassian.net/browse/WARP-3223)
- **Why:** [ADR-062](ADR-062-native-desktop-clients.md)
  ([#2444](https://github.com/DropletByWarpLab/droplet-onboard-services/pull/2444))
  replaces the Tauri shell with a native C# / WinUI 3 client and keeps
  `droplet-vpnd` (its row 7). It leaves the pipe's client identity and the
  shared-PC policy to this amendment. The shipped vpnd (0.2.2) also differs
  from the Windows shape above in the places below.
- **Rests on:** Stefan's decision S8 on WARP-3223 (policy A, row 2) and
  Romain's R15 (vpnd hardening before the first signed MSI). R15 is the
  roadmap's recommended default and stays provisional until he confirms it in
  review.
- **Unchanged:** the custody rule. The WireGuard private key is born in
  `droplet-vpnd`, stays in the service-only directory
  `%ProgramData%\Droplet\vpnd`, and no pipe message carries it.
- **Gate G6:** the vpnd hardening PRs,
  [WARP-3248](https://warp-lab.atlassian.net/browse/WARP-3248) (VPND-2) and
  [WARP-1935](https://warp-lab.atlassian.net/browse/WARP-1935) (VPND-3), do
  not merge before this amendment is Accepted. They and spike S9 land before
  the release pipeline builds the first signed MSI. No signed MSI ships
  vpnd 0.2.2's gate.
- **References:** line references (`:89`-`:145`) are to this file as of `stage` at `129016f27`, before this amendment and any later note.
  Orchestrator references are to `stage` at `129016f27`. `droplet-windows`
  references are to `main` at `e1428db39` (vpnd 0.2.2); files under
  `droplet-vpnd/src/` are cited by file name. "The roadmap" is the plan of
  record on WARP-3223 (2026-09-25); this amendment is its §5.3, and its
  VPND-*, WIN-* and REL-* IDs name the PRs that carry each change.

**1. The user-mode half is the native C# client** (`:91`). It is
`Droplet.exe`, the ADR-062 client, installed in `%ProgramFiles%\Droplet` next
to `droplet-vpnd.exe`. vpnd identifies its client by the connecting process's
image, which constrains the packaging:

- It is an unpackaged apphost exe in that directory. `dotnet Droplet.dll` is
  refused because the image is `dotnet.exe`. An MSIX install is refused too,
  because its image lives under `WindowsApps`. A framework-dependent Windows
  App SDK (the fallback if the toast spike, WARP-3242, needs it) does not
  change the image, so it passes.
- Every process that opens the pipe has to pass the gate (row 4). A tray
  helper or background exe would need its own allow-list entry, added by
  editing this ADR.
- The client opens the pipe without .NET's `PipeOptions.CurrentUserOnly`,
  which fails against a SYSTEM server (`PROTOCOL.md` §7).

**2. The pipe is machine-wide, and the tunnel is a machine resource**
(`:96-97`, policy A). An ACL that admits only the installing user does not
fit. The descriptor is fixed when the service starts, the installing account
is often an administrator rather than the person using the PC, and whoever
signs in to Windows changes, on an office PC often. The shipped descriptor
becomes the rule: `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)S:(ML;;NW;;;LW)`
(`droplet-vpnd/src/winsec.rs:49`). SYSTEM and Administrators get full access,
every interactive user gets read and write, low-integrity processes cannot
write, and remote clients are refused (`pipe.rs:165-166`). The ACL is not the
access control; the process gate in row 4 is. What that means, accepted and
documented:

- A PC has one WireGuard key, so the box sees one overlay peer per PC, owned
  by the account that linked it. Another account linking the same PC gets
  `409 wg_key_conflict` (`apps/orchestrator/src/routes/vpn.ts:704-717`), and
  the client shows its own copy for it.
- Any Windows user's Droplet app on the PC sees the tunnel's state and can
  connect or disconnect it. A client that disconnects on Quit ends the tunnel
  for everyone on the PC.
- Policy B is not adopted now. Under it, vpnd would record the Windows session
  that connected (`GetNamedPipeClientSessionId`), and Quit would disconnect
  only a tunnel that session started. It can come later as an additive v1
  change (`PROTOCOL.md` §10) if shared PCs need it.
- vpnd's comment that other accounts are "already blocked by the ACL"
  (`client_identity.rs:11`) is wrong under this rule. It is corrected when
  VPND-2 edits that file.

**3. The token is minted at each start and written, never read**
(`:97-98`). vpnd 0.2.2 reads and rewrites `%ProgramData%\Droplet\ipc.token` as
SYSTEM at every start (`service.rs:241-266`). Its comment calls that
directory admin-write-only (`service.rs:224-225`), but the key store says it is
user-writable (`keystore.rs:159-160`; `winsec.rs:133-134`). That is the
planted-file shape this ADR bans. From VPND-3 on, the service mints a fresh
token at every start and only writes it. It checks the path's owner and that
the path is not a link, deletes any existing file, and creates the file new
(`CREATE_NEW`, not following reparse points, so a file planted between the
delete and the create fails the create rather than being written to, and a
failed create stops the service from starting) with a
protected descriptor: SYSTEM and Administrators get full control,
interactive users get read. Under policy A that is every interactive user on the
machine, not only the installing user. It never reads the file. A client therefore reads
the file for each connection and does not cache it. The token stays a cheap
first reject in v1; dropping it is reserved for protocol v2 (`PROTOCOL.md`
§10).

**4. The gate is the client process** (`:92-93`). The token is not the
authentication, because every process running as the signed-in user can read
it. The service checks the connecting process before it reads a byte
(`PROTOCOL.md` §1). Today that check is only "Authenticode-valid, any trusted
signer" (`adapter.rs:107-160`) plus "under `%ProgramFiles%\Droplet`,
subdirectories included" (`client_identity.rs:135-162`). That is not enough
for a .NET client. A self-contained publish can place Microsoft-signed exes
such as `createdump.exe` in that folder, and any process running as the user
can start the signed `Droplet.exe` with injection environment variables. The
gate required before the first signed MSI:

| Control | What it stops | Lands in |
|---|---|---|
| Authenticode (`WinVerifyTrust`), with every signature RFC 3161-timestamped | Unsigned or altered images. Artifact Signing certificates live about 3 days, so an untimestamped signature stops verifying | vpnd today; timestamps in the release pipeline (REL-2) |
| Install directory: the image sits directly in `%ProgramFiles%\Droplet`, not in a subdirectory | Binaries outside the folder root, subfolders included | VPND-2 |
| Publisher-subject pin, baked in at build time. A subject, not a thumbprint, because the certificates rotate every few days. The release pipeline asserts the production subject on tags | Any other trusted publisher's binary | VPND-2 |
| Exact image allow-list: `Droplet.exe` | `createdump.exe` and any other signed helper the publish adds | VPND-2 |
| `StartupHookSupport=false` in the app's runtime config, and a self-contained .NET runtime | `DOTNET_STARTUP_HOOKS` running a user's assembly inside the signed process; `DOTNET_ROOT` redirecting the host | The client (ADR-062 row 1) |
| `O:SY` in the pipe descriptor. Before it sends the token, the client requires the server to be in session 0 and, once `O:SY` lands, to be owned by SYSTEM (`PROTOCOL.md` §7) | A user process that squats the pipe name while the service is stopped and hands back its own WireGuard key | VPND-3; the client's check in WIN-16 |
| SCM failure actions (restart on failure) | A crashed service leaving the name free for a squatter. None are configured today, although `service.rs:186-187` assumes they are | VPND-3 |

Residual risk, recorded: the CLR profiler variables (`CORECLR_ENABLE_PROFILING`,
`CORECLR_PROFILER_PATH`) can still load a native DLL into the signed process,
and no runtime-config switch that blocks them was found. vpnd already concedes
that class ("an attacker who can inject code into the signed process wins",
`client_identity.rs:23-24`), and a same-user process could already inject into
the signed Rust shell. .NET makes it easier; it does not open it. Spike S9
checks the installed build: a startup hook runs nothing; `createdump.exe`, an
exe in a subdirectory and a wrong subject are refused; the apphost passes. If
S9 fails, a small signed Native AOT helper owns the pipe instead, with its own
threat model and an edit to this ADR (R15 prefers `StartupHookSupport=false` to
AOT for the app itself).

**5. A per-machine WiX MSI installs both halves** (`:89-90`). The Tauri
shell's release pipeline built NSIS installers only, and it never shipped a
release. The native
client's installer is a per-machine WiX MSI (REL-1), fixed to
`%ProgramFiles%\Droplet`. It carries `Droplet.exe`, `droplet-vpnd.exe` and
`wintun.dll` in the folder root. It registers `DropletVpnd` with
`ServiceInstall` (LocalSystem, automatic start, quoted path) and stops the
service before it replaces files. NSIS is the fallback only if the WiX spike
(S4) fails. The admin prompt is no longer one-time: v1 asks at install and at
each update (ADR-062 row 8). Connect and disconnect stay silent.

**6. The rogue-QR binding is implemented in the C# client** (`:103-116`,
unchanged). It is part of the client's overlay enrollment work
(WIN-24, [WARP-2079](https://warp-lab.atlassian.net/browse/WARP-2079)):

- Sign-in enrollment (`POST /api/vpn/overlay/devices`, WARP-1882) is the
  primary path. It carries the Bearer over the pinned channel, so it only ever
  reaches the paired box.
- A `droplet://overlay-enroll` link must name the paired box's FQDN as its
  `server`. With no pairing, the client shows a consent step naming the
  destination host and requires a `*.droplet-us.com` host, as Android's
  allow-list does.
- As in the Tauri shell, the client does not take these links from OS
  activation.

**7. The optional WireGuard key is superseded** (`:133-137`). The planned wire
change (an optional key on `POST /vpn/overlay/devices/by-token`, plus a call to
attach the key later) was never built.
[WARP-2076](https://warp-lab.atlassian.net/browse/WARP-2076) closed as Won't
Do, and `stage` still requires the key (`routes/vpn.ts:459-465`).

- Windows never needs it. The MSI installs vpnd before any enrollment, and
  vpnd creates the key on the first `get_public_key` (`PROTOCOL.md` §4), so
  the client has the public key before it stages anything.
- iOS keeps its key from enrollment (Romain, 2026-09-23, on WARP-1591).
  Recording that custody model in this ADR is
  [WARP-3006](https://warp-lab.atlassian.net/browse/WARP-3006)'s erratum, not
  this amendment's.

**8. The IPC wire format is decided** (`:145`). It is
`droplet-vpnd/PROTOCOL.md`, protocol v1, frozen
([droplet-windows#50](https://github.com/DropletByWarpLab/droplet-windows/pull/50),
[WARP-3247](https://warp-lab.atlassian.net/browse/WARP-3247)):

- Frames with a u32-LE length prefix over `\\.\pipe\droplet-vpnd`: the token
  as frame 1, then JSON requests and responses, one per frame.
- Five ops, and no private key in any message.
- Golden fixtures in `droplet-vpnd/tests/fixtures/ipc-v1/`, which the Rust and
  C# tests both read.

Changes within v1 are additive: a new op, field or value, or hardening that
keeps the bytes (rows 3 and 4). Anything else needs v2. Upgrades are the MSI
(row 5) and box-served updates (ADR-062 row 8, through ADR-045). A rollback
story is still not decided.
