# ADR-015: Voice device control via spoken confirmation

- **Status:** Proposed — draft (awaiting sign-off; **design only, no code until Accepted**)
- **Date:** 2026-06-01
- **Authors:** Stefan Cruceru (CEO) — draft (via Claude Code)
- **Related tickets:** [WARP-625](https://warp-lab.atlassian.net/browse/WARP-625) (this ADR — review, sign-off & implementation), [WARP-154](https://warp-lab.atlassian.net/browse/WARP-154) (voice assistant), [WARP-627](https://warp-lab.atlassian.net/browse/WARP-627) (the 4 voice-control tools), [WARP-626](https://warp-lab.atlassian.net/browse/WARP-626) (voice streaming)
- **Related ADRs:** ADR-004 (RBAC per-route guards — role taxonomy + "service principals are read-only"), ADR-014 (LLM client-dispatched actions — the target-axis + Tier-1/2/3 reuse this ADR mirrors), ADR-009 (canonical system architecture)
- **Related docs:** [`docs/llm-safety-tiers.md`](llm-safety-tiers.md) (Tier 1/2/3), `apps/orchestrator/src/services/safety-tier.service.ts`, [`docs/MATTER_ONBOARDING_DESIGN.md`](MATTER_ONBOARDING_DESIGN.md) (the 2026-05-15 voice-tier decision this ADR formalizes), `apps/orchestrator/src/routes/matter.ts` (the two-phase `/confirm` token), `services/voice-io/` (the voice loop)

## Context

The voice assistant (`services/voice-io`) captures mic audio, detects the wake word ("hey droplet"), transcribes locally, and POSTs the transcript to the orchestrator agent loop at `/api/llm/chat` — the same MCP-backed loop the dashboard chat uses. So voice already *reaches* the full tool surface server-side.

But voice authenticates as the **`service`** role, and `narrowAllowedToolsForRole()` (`apps/orchestrator/src/routes/llm.ts`) strips **all** write tools (`WRITE_TOOLS`, derived from each tool's `requiresWrite`) for any non-owner/admin role — per **ADR-004 §3, "service principals are read-only."** The route comment is explicit: voice's service principal may *drive* the loop, but tool-level RBAC keeps it from issuing destructive operations.

Net today: **by voice you can query anything (devices, cameras, files, network) but cannot control anything** — you can't turn on a light, set a thermostat, run a scene, or pair a device by voice. Safe, but it contradicts a decision the team already made.

`docs/MATTER_ONBOARDING_DESIGN.md` (**Decided 2026-05-15**) specifies that voice *should* control devices, tiered:

- **Tier 1** (lights, switches, plugs) — auto-execute via voice, no confirmation.
- **Tier 2 non-lock** (thermostat extremes, covers / blinds) — verbal confirmation, 10-second window.
- **Tier 2 locks** — **refused via voice entirely** ("That requires the dashboard"). No speaker authentication; we will not accept "yes" from anyone in earshot to unlock the front door.

That decision was never implemented because the RBAC carve-out and the spoken-confirm mechanism were never specified. This ADR specifies them.

**Trust surface.** Voice is fundamentally weaker than the dashboard (per-user auth) or the desktop client (ed25519-signed per-action consent, ADR-014): a voice command is authenticated only by "a human is near the box and spoke." Anyone in earshot — a guest, a child, a TV — can issue commands. The design must keep the blast radius of that weak channel small and visible by construction.

## Decision

**Carve a narrow, tier-gated write exception for the voice principal, reusing the existing safety-tier machinery and the Matter two-phase confirmation token — not a parallel system.** This mirrors ADR-014's philosophy (one tier model, one audit chain) for a new *voice* surface.

### 1. A dedicated `voice` role (not elevation of `service`)

Introduce a `voice` role in the ADR-004 taxonomy (sits between `guest` and `family`) that voice-io authenticates as on `/api/llm/chat`, replacing its current `service` usage there. `service` stays read-only (ADR-004 §3 unchanged). `narrowAllowedToolsForRole()` gains a `voice` branch whose allowed set is:

```
{ all read tools } ∪ { write tools that are Tier 1 } ∪ { write tools that are Tier 2 AND not lock-like }
```

Always **excluded** for `voice`: any Tier-2 **lock** tool, any **Tier-3** tool, and `commission_device` (pairing is a privileged setup action — dashboard/app only). The allow-set is **derived from `tools-core` metadata** (`requiresWrite` + safety tier + a `lockLike` flag), never hand-maintained — the same discipline that already keeps `WRITE_TOOLS` in sync.

### 2. Spoken confirmation reuses the two-phase confirmation token

For a Tier-2 non-lock tool the orchestrator already returns `confirmation_required` + a `confirmationToken` (60 s TTL; the Matter command route implements the `confirmation_required` → `POST /api/matter/devices/:nodeId/confirm` two-phase flow). voice-io:

1. Receives `confirmation_required` with a `userVisibleSummary`.
2. Speaks it as a yes/no question ("Should I close the bedroom blinds? Say yes to confirm.") and opens a bounded listen window (~10 s, ≤ the token TTL).
3. On an affirmative ("yes" / "confirm" / "do it") within the window, re-issues the same tool call with the `confirmationToken`. Anything else (silence, "no", a different request) cancels: "Okay, cancelled."

No new token type — voice is just another *surface* for the existing confirmation contract (mirrors ADR-014, where the desktop native modal is another surface for the same `confirmationToken`).

### 3. Locks + Tier-3 are refused at the voice layer, with a spoken redirect

`control_device` already enforces lock/unlock confirmation server-side regardless of caller (substring matching to defeat synonyms). For `voice`, lock-like and Tier-3 tools are excluded from the allowed set entirely (§1), so the model never sees them. If the user asks anyway, the agent answers (text → TTS): "Unlocking the door has to be done from the dashboard." There is **no** spoken-confirm path for locks — ever.

### 4. Every voice-dispatched write is audited

Reuse the canonical `tool_call` `ActivityRow` (WARP-456 / ADR-014) with `refs.surface = "voice"` so voice-initiated actions are filterable. No new activity kind.

## Consequences

### Positive
- Implements the 2026-05-15 decision: "hey droplet, turn on the kitchen light" works, while pairing, locks, and Tier-3 stay off the voice channel.
- One tier model + one confirmation token + one audit chain (consistent with ADR-014); no parallel consent system to keep aligned.
- The weak voice channel's blast radius is bounded **by construction** (allow-set derived from tier metadata), not by prompt-engineering the model.

### Negative
- A new `voice` role is another row in the RBAC matrix to reason about and test.
- Spoken confirmation has no speaker identity — a determined bystander can confirm a Tier-2 non-lock action within the ~10 s window. Accepted: scoped to non-lock, non-destructive Tier-2; locks + Tier-3 excluded.
- Feels best with the 4 voice-control tools (WARP-627) and streaming (WARP-626), though it is independent of both.

## Alternatives considered
- **Elevate `service` to allow writes (rejected).** Broadest blast radius; breaks ADR-004 §3 for *every* service principal, not just voice.
- **Keep voice read-only (rejected — contradicts the 2026-05-15 decision).** Safe, but the product intent is voice control of Tier-1 devices.
- **A parallel voice-consent system (rejected).** Reuse the safety-tier + `confirmationToken` machinery instead (same reasoning as ADR-014).
- **Speaker-ID / voiceprint auth for locks (deferred).** The only safe way to allow locks via voice; out of scope — locks stay dashboard-only until/unless a deep-assist-grade enrollment exists (cf. ADR-014's clipboard/screenshot deferral).

## How to apply
- Add the `voice` role to the ADR-004 taxonomy + `narrowAllowedToolsForRole()`; point voice-io's principal at it (its own `SERVICE_TOKEN_VOICE`-backed identity already exists).
- Tag `tools-core` tools with their safety tier + a `lockLike` flag; derive the `voice` allow-set from that metadata (no hand-maintained list).
- voice-io implements the spoken-confirm window against the existing `confirmation_required` response; cap the window at ≤ token TTL.
- All voice writes audit through `activity.service.ts` with `refs.surface = "voice"`.
- **No code until this ADR is Accepted** (sign-off gate). Tracked in WARP-625.

## Open questions (non-blocking)
- Rate-limit Tier-1 voice writes per-room to blunt accidental repeats? (Lean yes — reuse the Tier-1 rate limiter.)
- A global "voice control off" switch in settings for households that want query-only voice? (Likely yes; cheap.)
- Multi-speaker households + a future voiceprint option — revisit if/when locks-via-voice is ever requested.
