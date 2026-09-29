# ADR-061: Native Linux client — Rust, GTK 4 and libadwaita, no web view

- **Status:** Proposed (2026-09-25)
- **Sibling of:** ADR-062 (native per-platform desktop clients: the native WinUI 3 Windows client and the macOS row; open PR #2444, WARP-3211). Not ADR-060, which is the Windows Hello relying party. The clients deliberately share no code (ADR-008 §1). The Windows client is tracked as WARP-3197 and described in `droplet-windows` (`DESIGN.md`, `docs/ARCHITECTURE.md` on `feat/native-windows-client`).
- **Ticket:** WARP-3203.
- **Supersedes for desktop Linux:** ADR-009's client row "reuse the dashboard in a shell". ADR-009 never listed Linux; this ADR adds the row.
- **Builds on:** ADR-008 (native clients implement the contract themselves), ADR-023 and ADR-058 (trust: public certificate, else the pairing's pinned key, never TOFU), ADR-037 (tunnel key custody), ADR-045 (the operator stages installers; the box never fetches).
- **Repo:** [`DropletByWarpLab/droplet-linux`](https://github.com/DropletByWarpLab/droplet-linux), first PR [droplet-linux#1](https://github.com/DropletByWarpLab/droplet-linux/pull/1). CI builds, tests and screenshots the real app against a stand-in box on Ubuntu 24.04.

## Context

When this ADR was written no Linux client existed, and `data/app-downloads/EXPECTED` still says so (`linux absent - no Linux client exists`). The first client has since landed: [droplet-linux#1](https://github.com/DropletByWarpLab/droplet-linux/pull/1) merged 2026-09-26. No installer has been built or staged yet. The staging pipeline already accepts `.deb`, `.rpm` and `.AppImage` for a `linux` platform (`scripts/app-downloads/stage.mjs`), and the device-clients platform list already names `linux`.

Stefan asked for a fully native Linux app, explicitly not a web view, on 2026-09-25. The same day, the Windows client moved from Tauri + WebView2 to native WinUI 3 (WARP-3197, decided in ADR-062). ADR-009's reason for the web-view shell was "don't reimplement every page". That is now outweighed by what a wrapped dashboard can't do well: pinned trust inside the web view, native notifications, keyring custody, the system VPN, and a UI that belongs on the desktop it runs on.

## Decision

1. **Stack: Rust, GTK 4, libadwaita.** These are platform widgets and the GNOME HIG, and they run on KDE too. Rust is the language the Tauri Windows shell's trust (`trust.rs`) and LAN discovery (`lan_discovery.rs`) were proven in, so those rules are ported with their fixtures rather than re-derived. The floor is **GTK 4.14 / libadwaita 1.5 (Ubuntu 24.04 LTS)**.
2. **No web view, anywhere.** A surface is native, or it isn't in the sidebar. "Open the full dashboard" opens the system browser for everything not yet native. There is no "coming soon" page.
3. **No shared library with other clients** (ADR-008 §1). The contract is the orchestrator's `stage` routes. `droplet-kit` and the iOS app are the behavioural reference. If duplication hurts, the sanctioned next step is OpenAPI codegen, not a shared crate.
4. **Trust is ADR-058 §2.0 exactly.** It uses rustls with the bundled Mozilla roots, never the OS store. When the public chain fails, the pairing link's `spki=` pin is accepted for hosts the leaf's SAN names, inside its validity window. There is no TOFU. A key mismatch is a loud "this isn't the Droplet from your link". The pin is per pairing, not per host, because it is the box's identity. Discovery (mDNS `_droplet._tcp` and `_https._tcp`, the friendly names, certificate-SAN discovery of `<name>.droplet-us.com`) changes where the app looks, never what it trusts.
5. **Links.** `droplet://` is registered as `x-scheme-handler/droplet`. A pair link may choose the box only on a fresh client (WARP-3035). `overlay-enroll` links are never actioned from the desktop (WARP-1477).
6. **Secrets.** Session tokens go to the desktop keyring (Secret Service). With no keyring they are memory-only and the app says so. They are never written to a file. The pairing record (address, pin, box name) is not secret and lives in `~/.config/droplet/pairing.json` (0600), written only by pairing and "Forget this Droplet".
7. **Remote access goes through NetworkManager's WireGuard.** The tunnel comes up only when the LAN probe fails (the mobile clients' D1 rule). **ADR-037 row for Linux:** NetworkManager owns the tunnel. The app generates the WireGuard keypair, hands the private key straight to NetworkManager over D-Bus (stored root-only in its system connection), zeroizes its copy and never persists it. This is Android's "same trust domain" case, not Windows' split privilege: the desktop user who runs the app is the user polkit already lets read and modify that connection, so there is no privilege boundary for the key to cross. Enrollment binds to the paired box only (ADR-037, rogue-QR binding).
8. **Distribution:** a `.deb` built in CI (`cargo deb`) and staged by the operator (ADR-045). `data/app-downloads/EXPECTED` moves `linux` from `absent` to `blocked` (with its ticket) until the first signed build exists, then to `installer`. Flatpak and `.rpm` come later and don't change this ADR.

## Consequences

- Linux ships Home, Ask AI, Files, Cameras, Network, Devices, Notifications, Remote Access and Settings natively in 0.1. The rest opens in the browser until built (`droplet-linux/docs/PARITY.md`).
- Passkey sign-in (libfido2, the `webauthn` routes, RP = the box's name, never an IP) and native SSO (loopback PKCE on `/api/sso/oidc/native/*`) follow the sign-in extensions proposed in ADR-063 (WARP-3226, open PR #2446). Those routes are not on `stage` yet, and this ADR does not assume they exist. The same routes are meant to serve every desktop.
- ADR-056's "desktop as an MCP host" and ADR-014's desktop tool-host consent tiers apply to this client too. Neither is in 0.1. Both need WARP-1955-style signing and update custody decided for Linux before anything runs tools on a customer's PC.
- **Open, not decided here:** the app id. Linux uses `ai.warplab.Droplet`, matching Android's `ai.warplab.droplet` namespace. ADR-045 already flags the iOS/Android bundle-id split, and this adds a data point, not a decision.
