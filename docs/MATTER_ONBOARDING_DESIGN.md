# Matter QR-Code Onboarding + LLM/Voice Control — Design Doc

> **Status:** Spec ready. Awaiting "go" from Stefan to start Day 1.
> Decisions confirmed 2026-05-15.

## What this does (end-state)

1. **Customer scans a Matter device's QR code** with their phone
   (dashboard `/devices/add-matter`), the wizard, or via the voice
   assistant ("Hey Jarvis, add a device") which hands off to the
   phone. The Droplet commissions the device into its Matter fabric.
2. **The device shows up on `/devices`** with the appropriate
   control widget (toggle / brightness / thermostat / etc.).
3. **The LLM (chat or voice) can control it.** "Turn off the office
   lamp" → tool call → device toggles. Tier-2 commands ask for
   confirmation; locks via voice are refused (no speaker auth).
4. **Audit log** records every command for the operator (visible in
   the ops-console once the proxy lands in fleet phase 2).

## What already exists (the part I was surprised by)

This is mostly a wiring job, not a from-scratch build. Inventory of
pre-existing infrastructure as of 2026-05-15:

| Component | Where | Status |
|---|---|---|
| matter.js controller embedded in orchestrator | `apps/orchestrator/src/services/matter.service.ts` (622 lines) | Working. `QrPairingCodeCodec` + `ManualPairingCodeCodec` both imported. |
| REST API for Matter | `apps/orchestrator/src/routes/matter.ts` (359 lines) | 9 endpoints incl. `POST /matter/commission` |
| Three-tier safety model | `services/safety-tier.service.ts` | Tier 1 auto / Tier 2 confirm / Tier 3 audit |
| 11 device-category mapping | matter.service.ts:33–65 | lights, switches, climate, sensors, locks, covers, fans, media, vacuums, cameras, binary sensors |
| Dashboard `/devices` page | `apps/web-dashboard/src/app/devices/page.tsx` | Grouped device cards, control widgets, SSE-driven live state |
| 8 smart-home UI components | `apps/web-dashboard/src/components/smart-home/` | BrightnessSlider, ClimateControl, ToggleSwitch, etc. |
| `useSmartHome` hook | `apps/web-dashboard/src/lib/hooks/useSmartHome.ts` | Exposes `commission(pairingCode)` |
| 6 LLM tools defined | `packages/tools-core/src/handlers/smart-home/` | commission, control, discover, get, list, history |
| MCP server tool-call dispatch | `services/mcp-server/src/server.ts` | RBAC-filtered, ready to dispatch |

## The 4 actual gaps

### Gap 1: MCP-server's Matter dep is stubbed

> **✅ RESOLVED (2026-06-01).** The stub is gone. `services/mcp-server/src/index.ts` now wires `matter: createMatterController(createHttpClient("orchestrator"))`, proxying to the orchestrator over HTTP with service-token auth — exactly the decision recorded below. The 7 smart-home tools in `packages/tools-core` (list/get/control/discover/commission/history/run_scene) are reachable by the agent loop today, and `matter.controller.test.ts` covers the proxy contract (21 tests). The snippet and line numbers below are historical.

`services/mcp-server/src/index.ts:159-166` (historical):

```typescript
matter: {
  listDevices: async () => ({}),
  getDevice: async () => ({}),
  sendCommand: async () => ({}),
  discover: async () => ({}),
  commission: async () => ({}),
  getAuditLog: async () => ({}),
},
```

Comment: *"WARP-102: stub until the decision lands on whether MCP
hosts its own controller or proxies to orchestrator."*

**Decision:** Proxy to orchestrator via HTTP. Don't dual-host the
controller — matter.js's fabric state is in the orchestrator's
`/data/matter-storage` volume; two controllers reading the same
storage is fragile. HTTP proxy keeps the orchestrator as the single
source of truth.

**This is the biggest unlock.** Once wired, the LLM can already
control devices today via the existing 6 tools.

### Gap 2: No QR scanner UI

The existing `/devices/pair` page pairs **mobile companion apps**
(iOS/Android Droplet clients), not Matter devices.
`DiscoveryBanner.tsx` literally says *"Commission them via chat or
pairing code."*

Need camera-based scanning with manual fallback below the viewport.

### Gap 3: Voice doesn't pass tools to the LLM

`services/voice-orchestrator/voice/llm.py` makes a plain text-completion
call to ai-gateway. No `tools` parameter, no tool-iteration loop. So
voice today returns text *about* turning on the light, not a tool call
that does it.

Llama 3.1 8B (the current model) supports tool calling natively — just
needs the wiring.

### Gap 4: Setup wizard has no "add device" step

WARP-174 wizard ends at AI/voice setup. Missing a "scan your first
Matter device" affordance during first-run.

## Decided 2026-05-15

**Tier-2 voice handling:**
- Tier 1 (lights, switches, plugs) — auto-execute via voice. No confirmation needed.
- Tier 2 non-lock (thermostat extremes, covers / blinds) — verbal confirmation, 10-second window. "Should I close the bedroom blinds? Say yes to confirm."
- Tier 2 **locks** — **refused via voice entirely.** "That requires the dashboard." No speaker authentication; we will not accept "yes" from anyone in earshot to unlock the front door.
- Tier 3 (audit-only) commands log automatically; no change in flow.

**QR scanning entry points** (all three implemented):
1. Dedicated `/devices/add-matter` page (primary discoverability).
2. New step in the setup wizard ("Add your first smart device").
3. Voice-triggered "Hey Jarvis, add a device" → speaks back a phone-handoff URL ("Open droplet.local/devices/add-matter on your phone to scan it"). Phase-2 enhancement: push notification to paired companion app.

## Build plan — 4-6 focused days

### Day 1 — Wire the MCP-server Matter stub (Gap 1)

- Replace the `matter: { ... no-op ... }` block in
  `services/mcp-server/src/index.ts:159` with an HTTP client that
  calls `http://orchestrator:3000/matter/*`.
- Use the existing `httpFactory` (already in `ContextDeps`) — same
  auth shim as other tools that proxy back.
- Pass-through the `confirmation_required` shape (`control-device.ts:51-61`
  already handles it).
- Unit tests: stub the orchestrator with msw / nock, verify each of
  the 6 tool handlers calls the right URL.
- Integration test (manual): chat says *"Turn on the office lamp"*
  → tool call → device toggles → audit-log entry visible.

**Effort:** ~1 day.

### Day 2-3 — QR scanner UI (Gap 2)

- Add `@zxing/browser` to `apps/web-dashboard` deps (~70 kB, MIT,
  works on iOS Safari + Android Chrome).
- New route `/devices/add-matter/page.tsx`:
  - Top: camera viewport with viewfinder overlay
  - Below: "Or enter the 11- or 21-digit pairing code:" text input
  - Permissions: `navigator.mediaDevices.getUserMedia` with
    graceful fallback to manual entry when denied.
- On QR decoded OR manual submit: POST to existing
  `/matter/commission` with `{ pairing_code: <string> }`.
- Live commissioning progress (matter.service.ts already emits
  state events) — subscribe via the existing SSE channel.
- Success: redirect to `/devices?highlight=<nodeId>`.
- Add wizard step "Add your first device" (Day 2 or 3) in
  `apps/web-dashboard/src/app/setup/page.tsx` — reuse the same
  scanner component as a wizard sub-step. Skippable.
- Sidebar entry: "Smart Devices" → `/devices` already exists,
  no change needed.

**Effort:** ~1.5 days.

### Day 3-4 — Voice → tool wiring (Gap 3)

- Extend `services/voice-orchestrator/voice/llm.py`:
  - At startup: fetch tool list from mcp-server (gRPC or stdio).
    Cache for the process lifetime; reload on pipeline restart.
  - On each LLM call: pass `tools=[...filtered to smart-home subset]`
    in the Ollama `/api/chat` payload.
  - Iteration loop:
    1. Send prompt + tools to ai-gateway.
    2. Response has `message.tool_calls`? Invoke each via
       mcp-server (HTTP `tools/call`). Append tool results to the
       message stream.
    3. Re-call LLM with the extended history.
    4. Repeat until response has no `tool_calls` (plain text reply).
    5. Hand text to TTS.
- Tool-loop safety: max 5 iterations, then bail with "I tried but
  couldn't complete that — check the dashboard."
- Confirmation handling:
  - Tool returns `confirmation_required` shape → voice asks "Should
    I do X? Say yes to confirm." Then waits 10 s for the next STT
    response. "Yes" / "okay" / "do it" → call the confirm endpoint.
    Anything else / timeout → cancel and say "Got it, cancelled."
  - Tool category is `lock` → voice refuses outright. "Locks need
    the dashboard for safety. I can do other things."
- New file `voice/tools.py` for the iteration loop + confirmation
  flow. Tests stub the mcp-server transport.

**Effort:** ~1.5 days.

### Day 5 — Polish + safety hardening

- Setup wizard step QA — first-run feels good?
- Audit-log surface in dashboard: filter by device-id, search by
  command, export CSV (operators love CSV).
- Voice error responses with personality: "I don't have a kitchen
  light commissioned yet. Want me to add one? Grab your phone."
- README in `services/voice-orchestrator/` documenting the tool-
  loop flow + confirmation discipline.

**Effort:** ~0.5-1 day.

## Hardware / network assumptions

- **Wi-Fi commissioning only for v1.** Newer Matter devices support
  Wi-Fi as the commissioning transport (no BLE needed). Older
  Matter devices need BLE — orchestrator container would need
  `network_mode: host` + BlueZ socket access. Defer BLE-only
  support to phase 2 unless a pilot customer has BLE-only devices
  in inventory (worth asking).
- **IPv6 multicast on the POC LAN.** Matter's operational discovery
  uses mDNS over IPv6 link-local. OpenWrt's default config routes
  this fine; verify on the POC by trying to discover a known
  Matter device after Day 1.
- **Matter fabric is per-Droplet.** Customer's Matter devices are
  bonded to their Droplet, not to Warp Lab HQ. Decommissioning
  needs a "factory reset" flow if a customer churns — already
  exists via `DELETE /matter/devices/:nodeId` route, just needs
  a UI button.

## Out of scope for v1

- BLE-only Matter devices (Wi-Fi-only for v1; BLE in phase 2)
- Thread border router (needs USB Thread radio)
- Multi-fabric Matter (sharing a device with Google Home / Apple
  Home / Alexa simultaneously — Matter supports this but it's
  involved to expose)
- Scenes, automations, rules ("when the front door unlocks, turn
  on the entry light") — Matter's `Scenes` cluster + a small
  rules engine; defer until ≥1 customer asks
- Voice speaker authentication (the reason locks are refused via
  voice). Possible later via lightweight voice-ID model — defer
  until business case clear

## Decision log

* **2026-05-15:** Tier-2 voice handling chosen — verbal confirm for
  everything except locks; locks refused via voice (no speaker auth).
* **2026-05-15:** Three QR entry points approved — dedicated page +
  wizard step + voice-triggered phone-handoff.
* **2026-05-15:** WARP-102 decision — MCP-server proxies to
  orchestrator over HTTP, does NOT host its own Matter controller
  (orchestrator stays the single fabric-state owner).
