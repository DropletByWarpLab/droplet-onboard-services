# ADR-011: LLM client-dispatched actions (desktop tool-host)

- **Status:** Accepted
- **Date:** 2026-05-29 (accepted 2026-05-30)
- **Authors:** Stefan Cruceru (CEO) — draft
- **Sign-off:** Romain Jouffret (CPO) — review, tier + consent decisions (WARP-351)
- **Related tickets:** [WARP-350](https://warp-lab.atlassian.net/browse/WARP-350) (Epic), [WARP-351](https://warp-lab.atlassian.net/browse/WARP-351) (this ADR — review & sign-off), WARP-352…WARP-359 (phases), [WARP-549](https://warp-lab.atlassian.net/browse/WARP-549) (deep-assist ADR) + [WARP-550](https://warp-lab.atlassian.net/browse/WARP-550) (deep-assist enrollment — clipboard/screenshot follow-ups)
- **Related ADRs:** ADR-004 (RBAC per-route guards — role taxonomy), ADR-008 (native mobile design system + API contract — same wire protocol), ADR-009 (canonical system architecture)
- **Related docs:** [`docs/llm-safety-tiers.md`](llm-safety-tiers.md) (Tier 1/2/3 model this ADR extends), `apps/orchestrator/src/services/safety-tier.service.ts`

> **Numbering note.** This ADR was tracked in Jira as "ADR-003" (the number it carried when WARP-350/351 were filed against the 2026-05 `shared_brain` snapshot). In this repo `docs/ADR-003-rag-techniques-adoption.md` (RAG techniques) landed on `main` first, so — exactly as ADR-004 did before it — the document is renumbered to the next free slot, **ADR-011**, and named for what it does (`llm-client-dispatched-actions`) rather than its old number. The Jira epic/story titles still say "ADR-003"; treat that as a stale alias for this file. The originally-referenced `ADR-003-llm-client-dispatched-actions.md` and `desktop-tool-host-rpc.md` were never committed to `shared_brain`; this ADR supersedes those dead links.

## Context

Droplet ships a unified LLM agent (orchestrator agent loop + MCP tool dispatch) that today acts only on the appliance itself — files, cameras, network, smart-home, email. Users increasingly want the assistant to act on the **device in front of them**: "open the brief you just summarized in Preview," "paste this into the doc I have focused," "drop that file in my Downloads." That requires a trusted agent running on the user's own Mac/Windows machine that the Droplet LLM can dispatch tool calls to.

This is a materially larger trust surface than on-appliance tools: the appliance is sovereign and operator-owned, but a desktop runs the user's whole working life. The design must make "the AI cannot touch my machine unless I say so, per action" the **default and visible** posture — consistent with Droplet's "sovereign by default" principle.

The existing safety-tier system (`docs/llm-safety-tiers.md`) already classifies appliance actions into Tier 1 (auto, rate-limited), Tier 2 (confirmation token, 60 s TTL), and Tier 3 (blocked for AI). Client dispatch reuses that machinery rather than inventing a parallel one.

This ADR is **Phase 0** of WARP-350 and **blocks all downstream code** (WARP-352+). It exists to lock four decisions before any implementation lands.

## Decision

**Adopt a default-deny, per-action-consent desktop tool-host.** A native desktop client (Tauri: Rust core owns WebSocket, ed25519 signing, and tool execution; webview reuses the dashboard build) pairs with one Droplet, advertises a capability list, and receives LLM-dispatched tool calls over the orchestrator's WS bridge.

### Core mechanism — the *target axis*

The safety-tier service is generalized with a **target dimension** rather than a new tier system:

```
target: 'self' | { kind: 'client', deviceId: string }
```

- `confirmationToken` binding is extended to `{ service, action, resourceId, targetDeviceId }`.
- For `target = client`, the Tier-2 confirmation surface is the **target device's native modal**, not the dashboard `/command/confirm` round-trip. The client signs its consent (ed25519 over `{requestId}|{outcome}|{deviceId}|{timestamp}`); the orchestrator verifies the signature and checks a 5-minute `(deviceId, requestId)` replay cache before executing.
- The per-conversation tool catalog is synthesized as `{ self-target tools } ∪ { for each connected, opted-in client: its consented tools }`, with names disambiguated by target (e.g. `open_file__stefans_macbook`). Catalog membership requires `DeviceClient.last_seen_ws_at` within 90 s **and** non-empty `tool_consent`.
- Every dispatched call writes a signed `ActivityRow` (canonical audit chain per WARP-456) carrying `target_device_id` and `request_id`; the legacy `CommandAuditLog` view is dual-written for the existing `/api/network/audit` path.

### Sign-off decisions (WARP-351)

**① V1 tool catalog — APPROVED as below.** Only these tools ship in V1. Anything not listed is out of scope for V1 and requires a follow-up ADR or ticket.

| Tool | Tier | Target | Notes |
|------|------|--------|-------|
| `notify` | 1 | client | Native toast (NSUserNotification / WinRT). |
| `open_url` | 1 | client | `http`/`https` only. |
| `reveal_in_finder` / `reveal_in_explorer` | 1 | client | Reveals, does not open. |
| `get_focused_app` | 1 | client | Returns frontmost app identity only. |
| `list_recent_files` | 1 | client | Metadata only; no contents. |
| `open_file` | 2 | client | Confirm modal shows full path + size + last-modified. |
| `paste_text` | 2 | client | Confirm modal shows target app + text preview. |
| `download_to_path` | 2 | client | Confirm modal shows filename + size + destination. |
| `show_overlay` | 2 | client | On-screen overlay; confirm shows overlay text. |

**② `get_clipboard` and `screenshot` — DEFERRED. Tier-3 (blocked for AI) in V1.** These two are *excluded from V1* and reclassified from the draft's Tier-2 to **Tier 3** until a separate **"deep assist" ADR** defines stronger, explicit enrollment (hardware-token / Yubikey-grade opt-in, distinct from ordinary pairing). Rationale: clipboard and screen capture are ambient-surveillance-shaped — they can exfiltrate content the user never deliberately handed to the assistant — and do not meet the per-action-intent bar that the rest of the V1 catalog clears. WARP-357 is re-scoped to "blocked in V1; design the deep-assist enrollment" and no longer blocks V1 GA. The deep-assist work is tracked as **WARP-549** (ADR / decision) → **WARP-550** (enrollment gate) → WARP-357 (clipboard/screenshot implementation).

**③ Default state — DEFAULT-OFF, opt-in per tool.** After pairing, *every* client tool is `block` in `DeviceClient.tool_consent`. Nothing on the desktop is reachable by the LLM until the user explicitly enables each tool (`allow always` or `confirm each time`) from the menu-bar **AI permissions** settings. Pairing grants presence + identity, never capability. This is the sovereign-by-default posture; the smoother "default-on after pairing" alternative was rejected.

**④ Native consent-modal copy — APPROVED (strings below).** Per-call Tier-2 modal, device-named, data-named, deny-defaulted.

Generic template (Tier-2, `confirm each time`):

> **Title:** `Droplet AI wants to {action} on {deviceName}`
> **Body:** `{userVisibleSummary}`
> **Detail block:** tool name + parameter preview (path / size / target app / destination / overlay text)
> **Buttons:** `Allow once` (secondary)  ·  `Don't allow` (primary, default-focused, also bound to Esc)
> **Footer:** `Expires in {n}s · Manage in the Droplet menu bar → AI permissions`

Per-tool wording:

| Tool | Title | Preview shows |
|------|-------|---------------|
| `open_file` | "Droplet AI wants to open a file on {deviceName}" | full path · size · last modified |
| `paste_text` | "Droplet AI wants to paste text into {focusedApp} on {deviceName}" | first 200 chars |
| `download_to_path` | "Droplet AI wants to save a file to {deviceName}" | filename · size · destination folder |
| `show_overlay` | "Droplet AI wants to show an on-screen message on {deviceName}" | overlay text |

Not-yet-enabled tool (default-off path) — surfaced to the user in chat, not a modal:

> "`{tool}` isn't enabled for **{deviceName}**. Turn it on in the Droplet menu bar → **AI permissions**."

Per-tool settings selector copy: `Allow always` · `Confirm each time` · `Block` (default).

Design intent for the copy: name the **device**, name the **data/target**, make **Don't allow** the default action, never pre-check "always," and keep the parameter preview literal so the user sees exactly what would happen before consenting.

## Consequences

### Positive

- Reuses the existing Tier 1/2/3 machinery (one mental model, one audit chain) instead of a parallel consent system.
- Default-deny + per-tool opt-in + per-call native confirm makes "the AI can't touch my machine unless I say so" the visible default — a strong privacy story for the SMB wedge.
- ed25519-signed, replay-protected responses + signed `ActivityRow` give a tamper-evident record of every desktop action, attributable to a `target_device_id`.
- Deferring clipboard/screenshot keeps the riskiest capabilities out of the first release while leaving a clean, explicit path (the deep-assist ADR) rather than a vague "maybe later."

### Negative

- Default-off adds onboarding friction: a freshly paired desktop does nothing until the user enables tools. Mitigation: a one-screen "turn on what you want" step in the pairing flow (still explicit, still per-tool).
- Per-call confirmation on Tier-2 tools is slower than batch consent; acceptable given the trust surface.
- Two surfaces now describe consent (dashboard for `self`, native modal for `client`) — more UI to keep consistent. The shared `confirmationToken` contract is the single source of truth that keeps them aligned.
- Tauri/native build + signing + notarization is real platform work (Phase 4 + Phase 7) with cert-procurement lead time.

## Alternatives considered

- **Default-on after pairing (rejected — decision ③).** Lower friction, but pairing would silently grant capability; contradicts sovereign-by-default.
- **Clipboard/screenshot as Tier-2 in V1 (rejected — decision ②).** Capable but ambient-surveillance-shaped; deferred to a dedicated deep-assist ADR with stronger enrollment.
- **A new, separate consent/tier system for clients (rejected).** Rejected in favor of the *target axis* extension so there is one tier model and one audit chain.
- **Dashboard-only confirmation for client actions (rejected).** Forces a context switch away from the device being acted on; native modal on the target device is both safer (it's where the action lands) and clearer.

## How to apply

- Tier classification for new client tools follows `docs/llm-safety-tiers.md`. Client tools are `requiresWrite`/`requiresConfirmation` per the same registry conventions as on-appliance tools.
- New client tools beyond the V1 catalog require an ADR amendment (catalog is a closed whitelist for V1).
- `get_clipboard` / `screenshot` (and any keystroke / screen-recording / arbitrary-exec capability) are **blocked** until the deep-assist ADR (**WARP-549**) is Accepted.
- All client dispatch audit-logs through `activity.service.ts::record({ kind: "client", … , refs: { targetDeviceId, requestId } })`.

## Open questions (non-blocking — tracked as follow-ups)

- Offline-target fallback: when a dispatch target is offline, fall back to dashboard confirm using the same `confirmationToken`? Drafted as an optional Phase 7 item (WARP-358); decide when first needed.
- Deep-assist enrollment shape (hardware token vs. OS-level biometric + re-auth) — owned by the deep-assist ADR (**WARP-549**) and its enrollment story (**WARP-550**).
- Cross-device confirmation when a user has 2+ paired desktops connected simultaneously — covered by name disambiguation today; revisit if it confuses users.
