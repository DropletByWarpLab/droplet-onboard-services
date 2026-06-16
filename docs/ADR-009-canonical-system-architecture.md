# ADR-009: Canonical System Architecture

**Status:** Accepted
**Date:** 2026-05-18
**Source:** Stefan whiteboard photo, 2026-05-18 (kept in
`docs/img/2026-05-18-architecture-whiteboard.jpg` when posted to the
repo; referenced here by description only).
**Deciders:** Stefan Cruceru
**Supersedes (in part):** earlier mobile + dashboard ADRs only where
they conflict — they remain authoritative on persona, brand, and API
contracts.

## Context

ADRs 001-004 covered specific surfaces (prototype-readiness, network
page, dashboard brand + dual workspace, native mobile design + API
contract). What's been missing is a single architecture diagram that
shows how every service + every client fits together and how the
boundaries are drawn. Stefan whiteboarded the canonical architecture
on 2026-05-18; this ADR captures it in writing so future agents (and
future Stefan) can re-read the same source of truth instead of
re-deriving it from code.

The HARD RULE in `feedback_align_with_shared_brain.md` requires that
all Droplet work align with what's in shared_brain. This ADR is the
canonical reference for the system shape; any code or compose change
that touches more than one box on the diagram below must cite this
ADR.

## Decision

Pin the system shape that follows. New work must fit inside it.

### Diagram (whiteboard, ASCII'd)

```
┌──────────────────────── DROPLET APPLIANCE ────────────────────────┐    ┌─── CLIENTS ───┐
│                                                                    │    │                │
│   ┌─────────┐                       ┌────────┐                     │    │  ┌──────────┐  │
│   │ NxtCld  │◄──── JWT OAuth ─────► │  Orch  │ ◄────► ┌────────┐  │    │  │ Web Dash │  │
│   └─────────┘                       │        │        │  Apis  │ ─┼────┼──┤          │  │
│                                     │        │        │        │  │    │  └──────────┘  │
│   ┌─────────┐                       │        │ ◄────► │        │  │    │                │
│   │ Apps    │ ◄──────────────────►  │        │        │        │  │    │  ┌──────────┐  │
│   │ Board   │                       │        │        └────────┘  │    │  │ iOS App  │  │
│   └─────────┘                       │        │           ▲   ▲    │    │  └──────────┘  │
│                                     │        │           │   │    │    │                │
│   ┌─ AI stack ────┐                 │        │           │   │    │    │  ┌──────────┐  │
│   │ ┌──────────┐  │   ┌─────────┐   │        │           │  OAuth │    │  │ Android  │  │
│   │ │Ollama mgr│ ◄┼─► │ Ai Orch │◄──┤        │           │   │    │    │  └──────────┘  │
│   │ └──────────┘  │   └─────────┘   │        │       ┌───┴┐  │    │    │                │
│   │ ┌──────────┐  │                 │        │       │VPN │  │    │    │  ┌──────────┐  │
│   │ │  Ollama  │  │                 │        │       │(WG)│  │    │    │  │ macOS    │  │
│   │ └──────────┘  │                 │        │       └────┘  │    │    │  │ (Catalyst│  │
│   │ ┌──────────┐  │                 │        │           ▲   │    │    │  │  on iOS) │  │
│   │ │   LLM    │  │                 │        │           │   │    │    │  └──────────┘  │
│   │ └──────────┘  │                 │        │           │   │    │    │                │
│   └───────────────┘                 │        │           │   │    │    │  ┌──────────┐  │
│                                     │        │           │   │    │    │  │ Win .exe │  │
│   ┌─────────┐                       │        │           │   │    │    │  │ (Tauri)  │  │
│   │ MCP     │ ◄──────────────────►  │        │           │   │    │    │  └──────────┘  │
│   └─────────┘                       │        │           │   │    │    │                │
│                                     └────────┘           │   │    │    │  Off-LAN ─►    │
│   ┌──────────┐  ┌──────────┐                             │   │    │    │  through VPN   │
│   │ OpenWrt  │  │ Voice    │  ┌────────────────┐         │   │    │    │  ───────────   │
│   │ server   │  │ Rec serv │  │ Status Screen  │         │   │    │    │  On-LAN ─►     │
│   └─────┬────┘  └─────┬────┘  │ Service        │         │   │    │    │  direct        │
│         │             │       └────────────────┘         │   │    │    │                │
│         └─────────────┴───────────────────────────────────┘   │    │    │                │
│                                                               │   │    │                │
└───────────────────────────────────────────────────────────────┘   │    └────────────────┘
                                                                    │
                                                          ◄─────────┘
                                                          OAuth + JWT
```

(The whiteboard is two-tone: most boxes black, **VPN is red** to
signal it's the mandatory transport for off-LAN clients, and the
**JWT OAuth + OAuth labels are red** to signal the auth boundaries.)

### Boxes — what each one is

#### Droplet appliance (left half)

| Box | Identity | Status |
|---|---|---|
| **Orch** | `apps/orchestrator/` — Express + Prisma. Coordinator for every internal service. The "brain" of the appliance. | exists |
| **Apis** | **Logical name for `Orch`'s `/api/*` HTTP surface** — not a separate service. Per Stefan 2026-05-18: do NOT introduce a gateway in front of the orchestrator. The whiteboard box exists to mark the boundary between client-facing routes (mounted under `/api/*`) and internal coordination logic (modules + service-clients inside `Orch`). | exists (as part of Orch) |
| **NxtCld** | `nextcloud:29-apache` container. File storage + per-device app-password authority. Connects to Orch via `JWT OAuth` flow — orchestrator uses Nextcloud's OCS API to mint per-device app passwords, Orch then issues short-lived JWTs against them. | exists |
| **Apps Board** | The **ops-console** at `127.0.0.1:8089` (see memory `project_ops_console.md`, `feat/ops-console` branch). FastAPI + vanilla JS, bearer-token gated, mounts `/var/run/docker.sock`. Admin UI for "what's running on this Droplet". The whiteboard box `Apps Bd` IS this. | exists on `feat/ops-console` |
| **Mcp** | `services/mcp-server/` — Model Context Protocol server. Bidirectional channel with Orch so the LLM can call tools (read files, query cameras, etc.). | exists |
| **Ai Orch** | `services/ai-gateway/` — the gateway between Orch and the Ollama stack. Bidirectional with Orch. | exists |
| **Ollama mgr** | `ollama-manager` sidecar — loads / unloads models, monitors VRAM, hot-swaps. | exists (per memory) |
| **Ollama** | The Ollama server (`ollama/ollama:rocm` on the photo-studio POC for AMD GPU). | exists |
| **LLM** | The currently-loaded model weights (e.g. `llama3.1:8b-instruct-q8_0`). Not a service — represents the loaded model file. | n/a |
| **OpenWrt server** | `services/routing/` Python service that talks to the OpenWrt container via ubus/UCI. | exists |
| **Voice Rec serv** | `services/voice-io/` + `wyoming-faster-whisper` + `wyoming-piper`. Hears wake word, transcribes, synthesizes speech back. | exists |
| **Status Screen Service** | OLED display service (`services/oled-display/` per docker-compose.yml). Drives the front-panel screen showing IP / paired-device count / system status. | exists |

#### Clients (right half)

| Client | Repo / Path | Tech | Status |
|---|---|---|---|
| **Web Dashboard** | `apps/web-dashboard/` | Next.js 14 + Tailwind + lucide-react | exists; under rehaul (Phase 1-3) |
| **iOS App** | `stefan-cruceru/droplet-ios` | SwiftUI + URLSession + Keychain | scaffold shipped |
| **Android App** | `stefan-cruceru/droplet-android` | Kotlin + Compose + Ktor + EncryptedSharedPrefs | scaffold shipped |
| **macOS App** | **shares droplet-ios via Mac Catalyst** — Stefan 2026-05-18. NOT a separate repo. Add a Mac (Designed for iPad) target to the existing Xcode project; iOS UI ships on macOS with ~no per-platform code. | to do (Phase 5b) |
| **Win .exe** | `stefan-cruceru/droplet-windows` | **Tauri** (Rust shell + WebView2) wrapping the dashboard's React build. Small .exe (~5-10 MB), native menu bar + system tray + notifications + deep links. | to do (Phase 6) |

#### VPN

The red **VPN** box represents the mandatory transport for off-LAN
clients. Implementation: **WireGuard**, per Phase 0.5 of ADR-002 and
WARP-175 (M2.6 WireGuard remote access, Done).

Two access paths for clients:
- **On-LAN** (black arrows): client hits `https://droplet.local` or
  `https://192.168.x.y` directly. No VPN.
- **Off-LAN** (red arrows): client hits the same DNS name through
  WireGuard. The phone / laptop opens its WG tunnel, then the same
  `https://droplet.local` URL resolves through the tunnel to the
  Droplet's LAN IP. **No public TLS endpoint** on the orchestrator —
  the only inbound is via WG.

Native apps self-pair as WG peers on first launch (Phase 5 in
droplet-ios/droplet-android). The web dashboard relies on the OS-level
WG client; we don't ship a per-browser tunnel.

### Authentication

Two auth boundaries (both red on the whiteboard):

1. **Client → Apis** = `OAuth` — meaning OAuth-flavored JWT, NOT full
   RFC 6749 OAuth 2.0. The actual flow:
   - Pair: dashboard issues a 6-digit code → client POSTs
     `/api/devices/pair/claim` → orchestrator returns
     `{ accessToken, refreshToken, deviceId, displayName }`.
   - Request: client sends `Authorization: Bearer <accessToken>` on
     every call.
   - Refresh: 401 → `/api/auth/refresh` → new access token; failure →
     bounce to PairScreen.
   - This is the existing model. ADR-008 §3 documents the mobile side;
     `apps/web-dashboard/src/lib/auth.tsx::authFetch` is the web side.
2. **NxtCld → Orch** = `JWT OAuth` — orchestrator mints per-device
   Nextcloud app passwords, encrypts them, then issues JWTs to clients
   that wrap that app password. Pairing flow per Romain's plan
   `2026-04-11-droplet-file-sync-onedrive-upgrade.md` Phase 3.

No external OIDC provider, no Auth0, no SaaS. All issuance is local
to the Droplet — that's the wedge.

## Consequences

### Easier

- **No new "Apis gateway" service** to build. Orchestrator stays the
  HTTP frontend for `/api/*`. The whiteboard's `Apis` box is a logical
  marker, not a build target. The existing nginx `gateway` service
  (port 443) remains the TLS terminator + static dashboard server in
  prod; routing-wise it forwards `/api/*` to orchestrator unchanged.
- **macOS app ships fast** via Mac Catalyst on droplet-ios. One Xcode
  project, two targets. Most of the iOS SwiftUI code renders on macOS
  with no changes.
- **Windows .exe reuses the dashboard** — Tauri wraps the existing
  Next.js build, so we don't reimplement every page. The native shell
  adds: system tray, native notifications, deep links, auto-update.
- **Ops-console is `Apps Board`** — no need to invent a new admin UI;
  promote `feat/ops-console` to the canonical "Apps Board" surface.

### Harder

- **VPN is mandatory for off-LAN** — no public TLS-only path means
  customers cannot demo the dashboard from a coffee shop without
  enabling WG first. The setup wizard's remote-access step must spell
  this out and offer one-tap WG enable.
- **5 client platforms now in scope** — Web + iOS + Android + macOS +
  Win. Design tokens and copy live in `apps/web-dashboard` (canonical
  CSS) + ADR-008 (SwiftUI + Compose mirror) + this ADR's macOS +
  Windows notes. Token drift is a real risk; a future ADR-006 may
  introduce token codegen.
- **Apps Board on the architecture** elevates ops-console from a
  power-user tool to a customer-facing admin surface. Needs design
  pass to fit the violet brand + dual workspace.

## Action items

| # | Item | Owner | Phase |
|---|---|---|---|
| 1 | Add Mac Catalyst target to `stefan-cruceru/droplet-ios` (`project.yml` → Mac target; flip `SUPPORTS_MACCATALYST` to YES) | Mac-with-Xcode dev | Phase 5b |
| 2 | Create `stefan-cruceru/droplet-windows` Tauri repo (Rust shell + reuse dashboard build) | next session | Phase 6 |
| 3 | Document ops-console = Apps Board mapping in `feat/ops-console` README | when 2c lands | Phase 2c follow-up |
| 4 | Wizard's remote-access step must say "VPN required for remote access" explicitly | wizard work (Phase 4) | Phase 4 |
| 5 | Continue dashboard rehaul Phase 2c (Devices / Calendar / Knowledge / Remote-access / Events / Context) | now | Phase 2c |

## Future-agent notice

**Do not introduce a new "Apis gateway" service** without superseding
this ADR. Stefan explicitly chose to keep `Apis` as a logical name for
the orchestrator's `/api/*` surface. If you find yourself sketching a
separate Express/nginx gateway in front of the orchestrator, stop and
re-read this ADR — there's a good reason it isn't there.

**Do not start a separate macOS-native SwiftUI repo.** macOS ships
via Mac Catalyst on the iOS repo (Stefan 2026-05-18). If Catalyst
proves too limiting, supersede this ADR before forking.

**Do not pick an Electron/WPF/WinUI 3 stack for Windows.** Tauri is
locked. If you're considering it for bundle-size or maturity reasons,
that conversation belongs in an ADR-006 superseding this one — don't
silently switch stacks.

**Do not add a public TLS endpoint to the orchestrator.** Off-LAN
access goes through WireGuard, full stop. If a customer demands
"works from anywhere without VPN" we either ship a cloud relay
(separate ADR) or say no — we don't open `https://droplet.com/...` to
the public Internet on the device.
