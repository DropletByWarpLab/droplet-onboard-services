# Handoff — Windows remote access: ship vpnd in the installer, finish the WARP-1388 away-mode connect flow

> Part of the WARP-1382 remote-access epic (ADR-031 own WG overlay; ADR-037 key custody;
> ADR-040 blind-relay fallback). Written 2026-08-16 against droplet-windows `main` with the
> week's hardening PRs assumed merged (windows #32 tolerant candidate parsing is already in
> the tree as `CandidateKind::Unknown`). Every file:line below was read, not guessed.
> Repos: `DropletByWarpLab/droplet-windows` (all code cited unless noted) and this repo
> (droplet-onboard-services, "the box") for the server half.

## The one-sentence status

The Windows away-mode connect flow — enroll, owner approval, profile fetch, tunnel bring-up
through a real WireGuard data plane — is **built and wired end-to-end in the repo**, and
**no customer has ever run it**, because the released installer does not contain
`droplet-vpnd.exe` or `wintun.dll`. Fix the installer first; it is a one-line workflow
change plus a verification step. Everything else in this document is ordered after it.

---

## Part A — the installer that ships without vpnd

### Mechanism (verified)

All vpnd packaging lives in a **release-only overlay config**,
`src-tauri/tauri.bundle.conf.json` (droplet-windows):

- `build.beforeBuildCommand` → `powershell … -File src-tauri/scripts/stage-vpnd.ps1`
  (tauri.bundle.conf.json:4), which builds `droplet-vpnd.exe` with
  `cargo build --release` (stage-vpnd.ps1:41) and fetches `wintun.dll` 0.14.1 from
  wintun.net with a pinned SHA-256
  (`07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51`,
  stage-vpnd.ps1:52-54) into `src-tauri/binaries/`.
- `bundle.resources` maps both files into the install dir (tauri.bundle.conf.json:7-10) —
  they land in `%ProgramFiles%\Droplet`.
- `bundle.windows.nsis.installerHooks` → `installer/hooks.nsh`
  (tauri.bundle.conf.json:11-15), whose `NSIS_HOOK_POSTINSTALL` runs
  `"$INSTDIR\droplet-vpnd.exe" --install` + `net start DropletVpnd` (hooks.nsh:14-26)
  and whose `NSIS_HOOK_PREUNINSTALL` runs `--uninstall` (hooks.nsh:28-35).

The base `tauri.conf.json` **deliberately references none of this** (so plain
`cargo check`/CI never trips over un-staged paths — stage-vpnd.ps1:17-20). The overlay
only applies via `cargo tauri build --config …/tauri.bundle.conf.json`
(README.md:56-76).

`.github/workflows/release.yml` runs `tauri-apps/tauri-action` (pinned v1.0.0,
release.yml:114-148) with `tagName`, `releaseName`, `releaseDraft: true`,
`uploadUpdaterJson: true`, `updaterJsonPreferNsis: true`, `tauriScript: tauri` — and
**no `args:` input**. So the overlay never applies in the release pipeline: no
stage-vpnd, no resources, no hooks. The release.yml header even says so —
"Deliberately NOT here: droplet-vpnd / wintun bundling — staged work (WARP-355 /
WARP-359)" (release.yml:24-25). That deliberate deferral is now stale: the service, the
data plane, and the shell flow all exist. The workflow was never updated.

### The fix (diff-level)

In `droplet-windows/.github/workflows/release.yml`, in the
`Build, sign and upload draft release` step's `with:` block (release.yml:123-148), add:

```yaml
          # Apply the release overlay: stage droplet-vpnd.exe + wintun.dll
          # (src-tauri/scripts/stage-vpnd.ps1) and wire the NSIS service hooks.
          # Without this line the installer ships with NO tunnel service.
          args: --config src-tauri/tauri.bundle.conf.json
```

tauri-action appends `args` to its `tauri build` invocation; it runs from the repo root
(`projectPath` defaults to `.`), so the config path is repo-root-relative. The overlay's
`beforeBuildCommand` path (`src-tauri/scripts/stage-vpnd.ps1`) is likewise
repo-root-relative and already correct for that working directory.

Then extend the `verify draft release assets` step (release.yml:157-177) so the gap can
never silently reopen. Today it greps asset names for `latest.json` / `.msi` /
`-setup.exe` / `.sig` (release.yml:171) — asset names cannot prove the payload. Add a
check that downloads the draft's `-setup.exe` asset (`gh api` with
`Accept: application/octet-stream`, or `gh release download <tag>` — note the release is
a DRAFT, so resolve the asset id via the release LIST the way the existing step does at
release.yml:162-163) and lists the NSIS payload:

```bash
7z l Droplet_*-setup.exe | grep -E 'droplet-vpnd\.exe|wintun\.dll' || {
  echo "::error::installer does not contain droplet-vpnd.exe + wintun.dll — do NOT publish"
  exit 1
}
```

`7z` is on the `windows-latest` runner image and lists NSIS installers natively.

### Things the implementer must know before merging

1. **Runner egress**: stage-vpnd.ps1 downloads from `https://www.wintun.net` at build time
   (stage-vpnd.ps1:69). GitHub-hosted runners have open egress, so this works — but the
   SHA-256 pin is the trust boundary, and a wintun version bump must change version AND
   hash together (stage-vpnd.ps1:51-52). A pre-staged `src-tauri/binaries/wintun.dll` is
   honored without download (stage-vpnd.ps1:59-63) for air-gapped hosts.
2. **The .msi stays service-less**: `hooks.nsh` is NSIS-only. `bundle.targets` builds both
   `msi` and `nsis` (tauri.conf.json:45); with the overlay applied, the MSI will CARRY
   both files but never run `--install`, so an MSI install leaves the service unregistered
   (README.md:74-76 documents this). This is acceptable to ship because
   `updaterJsonPreferNsis: true` (release.yml:145) already points the updater at the NSIS
   package and the download page should link the setup.exe — but the WiX
   `ServiceInstall` fragment is a tracked follow-up in the WARP-1388 story, not silently
   dropped.
3. **Build time**: the step now also compiles droplet-vpnd in release. The job's
   `timeout-minutes: 60` (release.yml:52) was sized for the shell build alone at ~19m cold
   (release.yml:49-51); vpnd is a much smaller crate, but watch the first tagged run.
4. **Installer size context**: the installer is ~217 MB of which ~96% is Microsoft's
   embedded WebView2 offline runtime (`webviewInstallMode: offlineInstaller`,
   tauri.conf.json:53-55 — deliberate, air-gapped-first). Adding vpnd + wintun adds
   single-digit MB. Do not "fix" the size while here.

### Verification recipe (installer)

Local, before the PR: from the droplet-windows repo root on a Windows box,
`cd src-tauri && cargo tauri build --config tauri.bundle.conf.json`, then
`7z l target/release/bundle/nsis/Droplet_*-setup.exe` — expect `droplet-vpnd.exe` and
`wintun.dll` in the listing. Install it in a Windows Sandbox / throwaway VM and confirm:
`sc query DropletVpnd` shows RUNNING, `%ProgramFiles%\Droplet\wintun.dll` exists,
`%ProgramData%\Droplet\ipc.token` exists (written by the service), and the app's
remote-access card no longer reports "Remote access isn't set up on this computer"
(that copy is `VpndError::Unavailable`/`NoToken`, vpnd_client.rs:148-150).

In CI: push a `vX.Y.Z` tag on main (version must match `tauri.conf.json` — the gate at
release.yml:87-95 enforces it), and confirm the extended verify step passes. The draft
release gate (a human publishes; release.yml:133-137) is unchanged.

---

## Part B — the WARP-1388 away-mode connect flow

### What exists (verified map, droplet-windows)

**Shell identity + enroll (user-mode, Tauri crate `src-tauri/`):**

- `overlay_identity.rs` — the ECDSA-P256 signing identity under user-scope DPAPI at
  `%LOCALAPPDATA%\ai.warp-lab.droplet\overlay-identity.json` (:42-45, :119-123). The SPKI
  PEM is derived once, pinned to LF, handed out by reference — the box fingerprints
  `sha256(sign_public_key_pem)` over the UN-TRIMMED bytes, so byte-stability is a wire
  contract (banner :21-29, pin test :229-242). Corrupt/foreign stores recover by minting a
  new identity (a new device the owner re-approves), never by wedging (:72-84).
- `vpn.rs` — the two-phase enroll (WARP-1478) plus the phase-3 bridge:
  - `enroll_by_token` (:866) — parses the `droplet://overlay-enroll?server=…&token=…`
    deep link (in-app capture ONLY; lib.rs drops overlay-enroll links arriving via OS
    protocol activation, lib.rs:174), provisions identity FIRST (fail-closed,
    `OverlayDeviceIdentity::provision` :570-579 — vpnd's WG public key over the pipe, then
    the signing key), then `POST {server}/api/vpn/overlay/devices/by-token` with
    `{token, wg_public_key, sign_public_key_pem, label}` and NO Authorization header
    (:822-849). 202 → `Pending{pending_id}`; 409/410/401/400/429 → typed errors (:835-848).
  - `overlay_enroll_status` (:897) — `GET …/by-token/{pending_id}/status` with
    `X-Overlay-PoP` = standard-base64 DER ECDSA-P256 over
    `droplet-overlay-enroll-status:v1:<pending_id>` (:715-723). All five box states
    mapped; `denied`/`expired` are outcomes, not errors (:781-806).
  - `overlay_connect` (:946) — the phase-3 bridge: signs the SEPARATE profile PoP
    (`droplet-overlay-enroll-profile:v1:<pending_id>`, :746-748, so a status signature
    can't be replayed for the profile), `GET …/by-token/{pending_id}/profile`,
    deserializes STRAIGHT into `vpnd_client::TunnelProfile` (:981-984), and hands it
    verbatim to the service. 409 → "not approved yet"; 503 → re-approve copy (:967-978).
- `vpnd_client.rs` — the shell↔service IPC: named pipe `\\.\pipe\droplet-vpnd` (:41),
  length-prefixed frames capped at 64 KiB (:44), token from
  `%ProgramData%\Droplet\ipc.token` (:178-184), `PROTOCOL_VERSION = 1` checked on connect
  (:221-231). Mirrored (not shared) protocol types with wire-string pin tests (:317-406).
  Commands: `vpn_service_status` (snapshot, never throws for "unavailable" — :546-597),
  `vpn_device_key`, `vpn_connect`, `vpn_disconnect` (:605-627). Fresh connection per call
  because the service is `nMaxInstances = 1` (:490-495).
- All commands registered in lib.rs:390-424.

**Service data plane (SYSTEM, crate `droplet-vpnd/`):**

- `control.rs::ServiceControl::connect` (:113-179) — validates via
  `tunnel::build_config`, tears down any previous tunnel, raises the wintun adapter,
  starts the noise loop, then walks the candidate ladder: 5 s handshake window per rung
  (`HANDSHAKE_WINDOW`, :37), IP-literals only (`socket_addr` refuses to resolve names,
  :228-231), and on exhaustion TEARS THE ADAPTER DOWN and returns `NoUsableEndpoint`
  (:173-178) — never a dead interface routing into a hole. Status reports `Up` only on a
  handshake fresher than 180 s (`FRESH_HANDSHAKE`, :41, :207-211).
- `ladder.rs` — re-sorts locally by priority (never trusts the box's sort, :24-28),
  filters unusable candidates on construction (:54-75), `is_lan_only()` for the
  "works at home, silently fails away" household (:116-122), `reset()` for network
  changes (:107-110).
- `dispatch.rs` — version gate BEFORE any request including `Version` itself (:86-96);
  auth is per-connection at the pipe door, not per-request (:10-15).
- `protocol.rs` — the ADR-037 custody boundary as tests: field-name allowlist +
  no-stale-entries + value scan (:194-399). `CandidateKind` now includes `Relay`
  ("box-side emission not yet implemented", :58-59 — matches ADR-040: the box's ladder
  defines relay at priority 20 but never emits it) and `#[serde(other)] Unknown`
  (:60-72, WARP-2063 / windows PR #32): unknown kinds parse and are dialled in ladder
  order, so new transports appear server-side without stranding deployed clients.

**UI (dist/index.html, no build step):** the "Link this computer" surface (:383-411)
drives `enroll_by_token` → 3 s × 100 status polls → `overlay_connect` → one
`vpn_service_status` read (:586-644). Every failure is rendered as plain text.

**Box half (this repo):** stage/status/profile routes under
`/api/vpn/overlay/devices/by-token`, candidate ladder from
`resolveOverlayEndpointCandidates` (WARP-1758), profile at
`GET /api/vpn/overlay/devices/by-token/:pending_id/profile` (WARP-1757).
`OVERLAY_CONNECT_ENABLED` defaults **true** since WARP-1767/#1608 (verified:
`.env.example:972`, `scripts/lib/secrets.sh:764`, pinned by
`apps/orchestrator/src/__tests__/overlay-connect-deployment.test.ts`).

### The WARP-1770 full-tunnel refusal invariants — must not regress

A Droplet profile routes the HOME LAN, never the customer's whole internet connection.
Enforced semantically in `droplet-vpnd/src/tunnel.rs`, and every future change to profile
handling keeps ALL of these:

1. **Every spelling of the default route is refused** — any allowed-IP parsing to
   prefix 0 (`0.0.0.0/0`, `::/0`, `::0/0`, expanded v6) → `ProfileError::FullTunnel`
   (tunnel.rs:168-170; test `refuses_every_spelling_of_a_full_tunnel` :467).
2. **Partitioned coverage is refused** — `0.0.0.0/1` + `128.0.0.0/1` (the wg-quick /
   Mullvad / Proton idiom) and any union covering an entire family →
   `FullTunnelUnion` via an explicit sort-and-merge over the integer address space
   (:177-181, `covers_the_whole_family` :264-297). Covering all of v6 alone still counts
   (test :570). Half the space is legal (test :521).
3. **A /0 interface address is a full tunnel wearing an address's clothes** — refused
   (:148-150; test :607).
4. **`*.droplet-us.com` is NEVER a WireGuard endpoint** — it is the public-NXDOMAIN TLS
   name (`NEVER_AN_ENDPOint_SUFFIX`, :129); candidates are IP literals only, and the dial
   path performs no DNS (control.rs:228-231, test `never_resolves_a_candidate_hostname`
   :310). This is the WARP-1391 bug class.
5. **One bad candidate never kills the profile; a profile of ONLY bad candidates fails
   loudly** (skip-with-log, :192-226 — WARP-2063).
6. **No IPC message can carry a private key** — protocol.rs allowlist tests + the
   shell-side mirror test `a_connect_request_carries_the_profile_verbatim_and_no_key`
   (vpnd_client.rs:333-358). ADR-037.

CI compiles AND runs all of these (`cargo test --locked` in both jobs, ci.yml:74-75 and
:129-130).

### What remains (the actual WARP-1388 gap list)

Ordered; 1 blocks customer exposure of everything else.

1. **Ship the installer** (Part A). Until then every runtime path correctly reports
   `Unsupported` via the `provision()` fail-closed gate (vpn.rs:868-871).
2. **Persist the enrollment.** Verified absent: dist/index.html stores neither `server`
   nor `pending_id` — after app restart there is no "Connect" affordance; the user's only
   path is a fresh QR + re-approval. Store `(server, pending_id)` in the tauri-plugin-store
   `droplet.json` (plaintext is fine: both values are useless without the DPAPI-held
   signing key), add a Connect button for the stored enrollment, and treat a 401/409 on
   profile fetch as "re-enroll needed" (covers HQ-revoke from onboard #1610).
3. **Disconnect surface.** `vpn_disconnect` is registered (lib.rs:396) but nothing in
   dist/index.html invokes it. Add Disconnect next to the status line.
4. **Live status surface.** One `vpn_service_status` snapshot after connect
   (dist/index.html:632-636) is not a surface. Poll while the remote-access card is
   visible; render `state`, `active_candidate_kind`, `last_handshake_secs`, bytes —
   the snapshot already carries all of it (vpnd_client.rs:520-539).
5. **Network-change redial in the service.** `Ladder::reset/succeeded/active/exhausted/`
   `is_lan_only` are built and tested but UNUSED by control.rs, which walks a local ladder
   once inside `connect` (:151-171). A laptop that sleeps, roams Wi-Fi→hotspot, or comes
   home keeps a wedged session until the user manually reconnects. Add a supervisor:
   on `NotifyNetworkConnectivityHint`/route change or handshake staleness, `reset()` and
   re-walk. Also surface `is_lan_only()` as a distinct status so the UI can say "this
   Droplet is only reachable from home" instead of timing out away.
6. **MSI `ServiceInstall` parity** (WiX fragment) or stop publishing the .msi for
   customer use — pick one, don't leave the silent third state.
7. **Stale copy/comment in `overlay_connect`**: the 503 branch's rationale
   (vpn.rs:959-966) still says the box's connect tick "sits behind
   OVERLAY_CONNECT_ENABLED (default false, set in no deployment artifact)". Post-#1608
   the default is true in every deployment artifact. Re-word the 503 copy honestly (the
   box now self-heals; "try again shortly" is truthful) and fix the comment.
8. **Relay rung readiness**: nothing to do client-side — unknown kinds are dialled
   blind (protocol.rs:60-72) and a blind relay needs no client pre-work (ADR-040). Do NOT
   add relay-specific client logic without reading ADR-040 first.

### Tests: exist vs needed

**Exist and run in CI (hermetic):** the full suites of both crates — protocol allowlist +
wire-shape pins, dispatch version-gate ordering, ladder policy, every full-tunnel
refusal, control-layer failure shapes (missing driver → `AdapterUnavailable`,
control.rs:289-307), enroll link parsing, PoP message/header formats, PEM byte-stability,
identity-before-socket ordering pins (vpn.rs:862-864, :891-892).

**Exist but manual (`#[ignore]` / live):**
`vpnd_client::round_trips_against_a_running_service` (vpnd_client.rs:465-506 — needs
`droplet-vpnd --console` + its printed token copied to `%ProgramData%\Droplet\ipc.token`;
the installed service would correctly refuse an unsigned test binary),
`droplet-vpnd/tests/adapter_live.rs` (needs wintun + elevation),
`tests/noise_handshake.rs`.

**Needed:**
- CI proof the installer contains vpnd (Part A's 7z step — this is the regression test
  for the entire packet).
- An install-smoke doc/checklist (service registered + started, token present, uninstall
  removes the service) — manual until a Windows-VM harness exists; do not fake it with
  mocks (see "green tests that cannot fail" in the handbook).
- Reconnect-supervisor unit tests once item 5 lands (the ladder trait split exists
  precisely so this is testable without an adapter).
- A persistence round-trip test for item 2 (enrollment survives restart; revoked
  enrollment surfaces re-enroll, not an error loop).

### On-bench verification recipe (test box)

Prereqs: the test box (warp-lab.droplet-us.com, office LAN behind the RB5009 — its WAN is
private, so off-site reachability is limited by design; see the fabric notes) on current
main with `OVERLAY_CONNECT_ENABLED` unset-or-true; a Windows laptop with the
overlay-built installer (Part A local build is fine). Order matters:

1. **Install** the NSIS setup.exe. Verify `sc query DropletVpnd` → RUNNING and
   `%ProgramData%\Droplet\ipc.token` exists.
2. **On-LAN enroll**: put the laptop on the office LAN. In the app, open the Droplet's
   dashboard → Remote Access, copy the `droplet://overlay-enroll?…` link into the
   "Link this computer" field. Expect "Now approve this computer…", approve on the
   dashboard, expect "Connected to your Droplet." Then verify honestly, not by copy:
   `vpn_service_status` (tray/devtools) shows `state: "up"`,
   `active_candidate_kind: "lan"`, `last_handshake_secs` < 180, and bytes moving while
   you load the dashboard over the tunnel address.
3. **Owner-side check**: the box's peer list shows the laptop with a live handshake
   (post-#1609 the idle sweep spares it; post-#1610 counts reflect live peers).
4. **Away-mode**: move the laptop to a phone hotspot. Reconnect. Watch the service log
   walk the ladder (`vpnd: trying … candidate`, control.rs:157-170). Behind the RB5009's
   double-NAT a `srflx` punch may legitimately fail — `NoUsableEndpoint` with the
   "this network can't reach your Droplet" copy is the HONEST result there (control.rs:173-178)
   and is exactly the case ADR-040's relay rung will close; a bench pass does NOT require
   away-mode success until relay emission lands. Record which rung (if any) connected.
5. **Revoke path**: owner deletes the device on the dashboard (HQ-revoke, #1610).
   Verify the tunnel drops or the next connect fails with re-enroll guidance — this is
   the item-2 UX you are testing.
6. **Uninstall**: verify the service is gone (`sc query DropletVpnd` → not found) and
   `%ProgramFiles%\Droplet` is removed.

### Order of work

1. Installer Bug (release.yml `args:` + asset-proof step) — shippable alone, unblocks all
   customer exposure.
2. Make the vpnd CI job a required check (separate Task; the job name string
   `cargo check + clippy (droplet-vpnd)` at ci.yml:47-48 IS the branch-protection
   contract — add it, never rename it).
3. WARP-1388 decomposition story items 2-7, roughly in that order; 5 (redial) is the
   largest and the only one touching the service.
