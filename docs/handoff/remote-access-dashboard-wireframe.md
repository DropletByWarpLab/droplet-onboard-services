# Remote Access dashboard — wireframe + UX completion spec

Handoff packet for WARP-1382 (remote-access epic). Written 2026-08-16 against the
post-merge state of onboard #1609/#1610/#1611, fleet-hq #15/#17, windows #32, and
onboard #1615 (HQ URL flip). Every claim below was verified by reading the cited
code; where a citation says "#1610 diff" the line numbers on `main` will have
drifted — anchor on the route path and the error code, not the number.

Persona: the ADR-002 home/office user. Owner control through the UI is the
product thesis — anything this page cannot express, the owner cannot do.

## Read these first

| File | What it gives you |
|---|---|
| `apps/web-dashboard/src/app/remote-access/page.tsx` (1141 lines) | The whole page: header, guidance cards, status card, pending queue, peer list, Add/Link dialogs, revoke confirm |
| `apps/web-dashboard/src/lib/vpn-peer-liveness.ts` | The five-state liveness copy contract (WARP-1763). Do not restate it — reuse it |
| `apps/web-dashboard/src/lib/overlay-enroll.ts:47-85` | `overlayApproveErrorCopy` — the approve-failure copy map this spec extends |
| `apps/web-dashboard/src/lib/friendly-errors.ts:433-455` | `CODES.vpn` — the deny/revoke translator this spec extends |
| `apps/web-dashboard/src/lib/api.ts:6159-6345` | The fetch wrappers; note which body fields each one drops |
| `apps/orchestrator/src/routes/vpn.ts:1489-1561` | `GET /api/vpn/status` — today's response shape |
| `apps/orchestrator/src/routes/vpn.ts:1589-1641` | `GET /api/vpn/peers` — `liveStateAvailable` + per-peer `provisioned`/`lastHandshakeAt` |
| onboard PR #1610 diff (`fix/warp-2061-enroll-lifecycle`) | The 409/502 contract the queue must render (verbatim bodies below) |
| `apps/orchestrator/src/services/overlay-placement.service.ts` | `WanPlacement`, `EndpointCandidate` ladder (relay reserved at priority 20, never emitted), `needsRelay`, `observePlacement` |
| `apps/orchestrator/src/lib/remote-access.ts:86-105` | `computeOffLanReachable` — STATIC-conf reachability only; knows nothing about the overlay agent |
| `apps/orchestrator/src/config.ts:533-548` | `OVERLAY_CONNECT_ENABLED` (default true since WARP-1767), `OVERLAY_CONNECT_POLL_SECONDS` (default 15) |
| `docs/ADR-040-blind-relay-fallback-for-punch-failures.md` | The relay fallback the header must leave room for |

## The honesty problem this page has today

Two different transports live on one page and the copy narrates only one of them:

1. **Static conf ("Add device")** — a WireGuard `.conf` minted in HOME mode
   (page.tsx:527, WARP-1391). Its off-LAN reachability is `offLanReachable`
   from `/vpn/status`, computed by `computeOffLanReachable()`
   (remote-access.ts:86-105) from the STATIC endpoint env only. On a shipping
   box (FQDN set, no override, mode ≠ relay) this is `false`.
2. **Overlay linked device ("Link a device")** — QR-enrolled, brokered by HQ,
   punched direct (ADR-031). The box-side agent is ON by default since
   WARP-1767/#1608 (config.ts:533-545). A linked phone with the Droplet app
   CAN reach the box from a coffee shop today when the punch succeeds.

The page header sub (page.tsx:187-191) and `RemoteAddressCard` (328-390) gate
the whole story on `offLanReachable`, so a box whose linked devices already
work from anywhere still says "Away-from-office access arrives with the secure
relay — coming soon." That is now false for flow 2 and true for flow 1. The
revised page must narrate them separately.

Also: the "Active devices" stat (page.tsx:127 + 250) counts active peer ROWS.
A row exists from mint/approval — it never proves presence (the WARP-1763
lesson, restated at vpn-peer-liveness.ts:1-26). The stat label must never say
"connected"; a connected count exists (`countConnectedNow`,
vpn-peer-liveness.ts:85-91) and must only render when `liveStateAvailable`.

## Revised page — wireframe (desktop)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⊕ Remote Access                                   [Link a device] [Add device]
│ Reach your Droplet from anywhere. Devices with the Droplet app connect   │
│ through your fleet directory; other phones and laptops use a WireGuard   │
│ profile on your office network.                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌─ STATUS HEADER (new — one card, always rendered) ───────────────────┐  │
│ │ ● Remote access is on                                    [badge ok] │  │
│ │ Your Droplet is behind your office router — linked devices connect  │  │
│ │ to it directly after a quick meet-up through the fleet directory.   │  │
│ │ ┌───────────────┬───────────────┬────────────────┬───────────────┐  │  │
│ │ │ REMOTE ACCESS │ FLEET DIRECTORY│ CONNECTION PATH│ WEB ADDRESS   │  │  │
│ │ │ On            │ Connected      │ Direct         │ spath….com    │  │  │
│ │ └───────────────┴───────────────┴────────────────┴───────────────┘  │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ [ error banner — only on fetch failure, existing pattern p.194-204 ]     │
│ [ "Web address not ready" / "Local address not ready" guidance cards —   │
│   existing, unchanged, never stacked (p.206-243) ]                       │
│ ┌─ Devices waiting to link (owner/admin only, existing p.897-1037) ───┐  │
│ │ 📱 Alice's phone   ⌗ a1b2c3d4 · 2 min ago                           │  │
│ │    Check this code matches the one shown in the Droplet app…        │  │
│ │                                            [ Deny ] [ ✓ Approve ]  │  │
│ │ 📱 Bob's tablet    ⌗ e5f6a7b8 · just now                            │  │
│ │    This device is being approved. Once it appears in the device     │  │
│ │    list below you can revoke it there.        [ Deny ] [ Approving…]│  │
│ │      (both buttons disabled + aria-describedby → the caption above) │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Devices (existing peer list p.261-289, liveness badges unchanged) ─┐  │
│ │ 📱 Alice's phone   10.6.0.2 · linked by stefan                      │  │
│ │    [Connected]  linked 3 days ago                            [🗑]   │  │
│ │ 💻 Office laptop   10.6.0.3 · stefan                                │  │
│ │    [Last connected 2 days ago]                               [🗑]   │  │
│ └─────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Your box's web address (existing p.328-390, copy revised per-flow) ┐  │
│ └─────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

Layout deltas from today, in order: (1) the status header card is NEW and sits
above everything, replacing the `status?.configured` Stat card (p.246-253) —
that card's "Endpoint"/"Server key" stats are operator trivia, not owner
facts; fold "VPN subnet" away and move the device counts into the list header.
(2) The approving-row caption + disabled reason is NEW. (3) All other blocks
are today's blocks.

## Status header — behavior spec

### Inputs (one API delta — see "API deltas" below)

`GET /api/vpn/status` grows an `overlay` block:

```jsonc
"overlay": {
  "agentEnabled": true,        // config.OVERLAY_CONNECT_ENABLED && HQ_ISSUANCE_URL !== "" — mirror the index.ts supervision gate
  "hqReachable": true,         // boolean | null — last connect-tick outcome; null = no tick observed yet
  "placement": "behind_nat",   // WanPlacement: edge_public | behind_nat | cgnat | unknown (overlay-placement.service.ts:23-37)
  "relayRequired": false,      // needsRelay(candidates) (overlay-placement.service.ts:374-376)
  "relayAvailable": false      // literal false until ADR-040 ships allocations; the header keys "coming soon" vs "via relay" on it
}
```

Implementation notes for the orchestrator side:
- `placement`/`relayRequired` come from `observePlacement` (overlay-placement.
  service.ts:414-440) with the same probes `resolveOverlayEndpointCandidates`
  already wires (vpn.ts:189-211). It re-observes per call (bridge uplink-ip +
  STUN); the page fetches status once per mount (page.tsx:110-112 — no poll),
  so the cost lands once per visit. Do NOT add a dashboard poll for it.
- `hqReachable` is the only new plumbing: a module-level last-tick-outcome
  cell the connect agent writes each tick (ticks run every
  `OVERLAY_CONNECT_POLL_SECONDS` = 15s, config.ts:548). Follow the WARP-1763
  rule verbatim: **absent observation is not a negative one** — `null` until
  the first tick, and the UI renders `null` as "Checking…", never as down.
- Family users get this block too (it leaks no address; `endpointHost` stays
  admin-gated exactly as today, vpn.ts:1497+1531).

### State matrix + copy (verbatim, product voice)

Precedence top to bottom; first match wins. Badge = the shell `.badge` tones
the peer rows already use (`ok`/`warn`/`muted`).

| # | Condition | Badge + title | Body copy (verbatim) |
|---|---|---|---|
| 1 | status fetch 503 `ROUTING_UNAVAILABLE` | existing error banner (p.194-204) | Server's own sentence: "The box's network service isn't responding right now. Try again in a minute." (vpn.ts:1553-1557) |
| 2 | `!overlay` (older orchestrator) | render NO header — fall back to today's page wholesale | Never guess against a box that predates the field. |
| 3 | `!overlay.agentEnabled` | muted · "Local only" | "Remote access is switched off on this Droplet. Devices connect only on your office network. Turning it on needs a settings change on the box." |
| 4 | `overlay.hqReachable === false` | warn · "Fleet directory not responding" | "This Droplet can't reach its fleet directory right now. Devices on your office network keep working; linking new devices and away-from-office connections will wait until it reconnects. This usually clears on its own." |
| 5 | `overlay.relayRequired \|\| placement === "cgnat"`, `!relayAvailable` | warn · "Limited on this network" | "Your internet provider's setup blocks direct connections from outside. Everything works on your office network; away-from-office access for this connection arrives with the secure relay — coming soon." |
| 6 | same, `relayAvailable` (post-ADR-040) | ok · "Remote access is on" | "Direct connections aren't possible on this network, so your devices connect through a secure relay. Everything stays encrypted end to end — the relay can't read your traffic." (This is ADR-040's blind-relay privacy claim; keep the sentence, it is the load-bearing trust promise.) |
| 7 | `placement === "unknown"` or `hqReachable === null` | muted · "Checking your connection…" | "Your Droplet is working out how it reaches the internet. This settles on its own — check back in a minute." |
| 8 | `placement === "edge_public"` | ok · "Remote access is on" | "Your Droplet has its own public address — linked devices connect to it directly from anywhere." |
| 9 | `placement === "behind_nat"` (the common shipping case) | ok · "Remote access is on" | "Your Droplet sits behind your office router — linked devices connect to it directly after a quick meet-up through the fleet directory." |

Four-up fact row under the copy (Stat primitive, p.392-403):
- **Remote access**: `On` / `Local only` / `Limited` — mirrors the badge.
- **Fleet directory**: `Connected` / `Not responding` / `Checking…`.
- **Connection path**: `Direct` (edge_public) / `Direct via router` (behind_nat) / `Needs relay` / `Checking…`.
- **Web address**: `publicFqdn` or `Setting up…` (reuses RemoteAddressCard's null copy, p.383-385).

### The per-flow copy split (replaces the offLanReachable-only story)

- ShellPage `sub` (p.187-191): stop keying the whole sentence on
  `offLanReachable`. New copy: "Reach your Droplet from anywhere. Devices with
  the Droplet app connect through your fleet directory; other phones and
  laptops use a WireGuard profile on your office network." When header state
  is 3/5 (local-only or relay-needed) drop "from anywhere" and say "on your
  office network".
- AddDeviceDialog ready-step copy (p.663-694): unchanged — it correctly
  narrates the STATIC conf and gates on `offLanReachable`. Do not let the
  overlay story leak into it: a static conf still cannot punch.
- RemoteAddressCard (p.328-390): keep, but its "Away from the office" stat
  reads from the header state, not from `offLanReachable` alone:
  `Linked devices connect directly` (states 8/9) / `Turn on Connect in the app`
  (offLanReachable, today's line 362) / `Coming soon — secure relay` (state 5).

## Device list — states + liveness (mostly already built)

The list and its five-state copy are DONE and correct (WARP-1763):
`peerConnectionCopy` (vpn-peer-liveness.ts:109-139) renders, verbatim:

| State | Copy | Tone |
|---|---|---|
| interface unreadable (`liveStateAvailable:false`) | "Connection status unavailable" | muted |
| `provisioned === false` | "Setup didn't finish — approve it again" | warn |
| `lastHandshakeAt === null` | "Linked · not connected yet" | muted |
| `lastHandshakeAt` absent (older routing build) | "Linked" | muted |
| handshake ≤ 3 min (`HANDSHAKE_FRESH_MS`) | "Connected" | ok |
| handshake older | "Last connected {relative}" | muted |

Rules the revision must not break:
- **Never claim connected from a row's existence.** The only presence evidence
  is a fresh `lastHandshakeAt` (vpn-peer-liveness.ts:14-26). `null` vs absent
  vs recent are three different facts — collapsing them "renders a routing
  sidecar restart as a household of dead phones".
- Revoked rows render tombstoned with `· revoked` and NO connection badge
  (page.tsx:416, 422-424, 447) — a revoked row must never carry liveness copy.
- List-header counts: "N devices" (row count) and, ONLY when
  `liveStateAvailable`, "· M connected now" via `countConnectedNow`
  (vpn-peer-liveness.ts:85-91 — its docstring mandates withholding the number
  when nothing was observed; honor it).

## Pending queue — per-state affordances

Today (verified): rows filter to `pending | approving` (p.965-967); 10s poll
(`OVERLAY_POLL_MS`, p.895); `disabled = busy || approving` feeds BOTH buttons
(p.1052-1053, 1114-1136) — so Deny is already disabled on rows the client
knows are approving. Two real gaps:

1. **No disabled reason.** The page already has the pattern: `Add device` uses
   `aria-describedby={disabledReasonId}` pointing at the guidance card
   (p.141-145, 173). Approving rows get the same: swap the row caption
   (p.1094-1097 "Check this code matches…") for an explanation with an `id`,
   and point both disabled buttons' `aria-describedby` at it. Copy:
   **"This device is being approved. Once it appears in the device list below
   you can revoke it there."**
2. **The 10s staleness race.** Another owner session (or the same owner on the
   phone) can approve/deny a row between polls; the local row still says
   `pending`, Deny is enabled, and the click draws #1610's
   `409 {error:"not_pending", state, message}`. Today that toasts
   `FALLBACK.vpn` ("We couldn't update remote access right now. Try again in a
   moment." — friendly-errors.ts:105-106): retry advice for a permanent 409.
   Handling below. On ANY 409 from approve or deny, `reload()` the queue —
   the row's truth changed; show it.

Per-state affordance table:

| Row state | Approve | Deny | Caption |
|---|---|---|---|
| `pending` | enabled | enabled | "Check this code matches the one shown in the Droplet app on that device." (existing p.1094-1097) |
| `pending` + `conflict` | enabled (red-context row, existing p.1056-1110) | enabled | existing conflict warning ("A different device tried to use this code…") — unchanged, it is the highest-stakes copy on the page |
| `approving` | disabled, label "Approving…" (existing p.1135) | disabled | NEW disabled-reason caption above, wired to both buttons |
| `approved`/`denied`/`expired` | row not rendered (filter p.965-967) — history, not a decision | | |

## Error rendering — the #1610 contract, verbatim

What the server answers (post-#1610; anchor on route + code, not line):

| Route | Answer | Body (verbatim) |
|---|---|---|
| `POST …/pending-enrollments/:id/deny` on approved row | 409 | `{"error":"not_pending","state":"approved","message":"This device is already approved. To cut off its access, revoke it from the device list — denying the old request would only change a label while the device stays connected."}` |
| same, on approving row | 409 | `{"error":"not_pending","state":"approving","message":"This device is being approved right now. Wait for the approval to finish, then revoke it from the device list if it shouldn't have access."}` |
| same, on denied row | 200 | `{"state":"denied"}` — idempotent, NOT an error; toast the normal "Denied" line |
| `POST …/:id/approve`, HQ vouch answers state ≠ active | 409 | `{"error":"enrollment_rejected_by_hq","message":"The fleet directory has this device marked as revoked (this happens after a factory reset or an earlier revoke), so it can't be re-linked with its old key. Remove the Droplet from the device's app and link it again from scratch — that gives it a fresh key."}` Row is now `denied` — it leaves the queue on reload. |
| same, finalize lost a state race | 409 | `{"error":"state_changed_during_approval","message":"This device's request changed while the approval was running — the approval was rolled back. Check the request list and try again."}` |
| `DELETE /api/vpn/peers/:id`, overlay peer, HQ unreachable | 502 | `{"code":"HQ_REVOKE_FAILED","error":"Couldn't reach the fleet directory to revoke this device. Nothing was changed — try again in a moment.","id":…}` — HQ revoke runs BEFORE the router delete precisely so "nothing was changed" is true |

What the client must render (the repo rule — WARP-294, friendly-errors.ts:9-15
— is **never surface `err.message` verbatim**; every string below is a fixed,
curated duplicate of the server's own copy, same precedent as
`CODES.device["502"]`, friendly-errors.ts:468-475):

1. `overlayApproveErrorCopy` KNOWN map (overlay-enroll.ts:48-57) gains:
   - `enrollment_rejected_by_hq` → the server's sentence above, verbatim as a
     fixed string.
   - `state_changed_during_approval` → the server's sentence above, verbatim.
2. Deny path: `denyOverlayEnrollment` (api.ts:6328-6345) additionally attaches
   `body.state` as `e.state`. `handleDeny` (page.tsx:947-961) special-cases
   `err.code === "not_pending"` BEFORE `translateError`, rendering the
   approved-state or approving-state sentence above by `e.state` (fallback
   when state is missing: "This request has already moved on and can't be
   denied. If the device shouldn't have access, revoke it from the device
   list."), then reloads the queue.
3. `CODES.vpn` (friendly-errors.ts:433-455) gains
   `HQ_REVOKE_FAILED: "The fleet directory couldn't be reached, so this device
   was not revoked — it still has access. Try again in a moment."` — sits
   beside `REVOKE_STAGED` (line 453), which is its mirror image (that one:
   change started but didn't take; this one: nothing started).
4. Cap copy note: #1610 changed the cap to count LIVE overlay peers
   (`prisma.vpnPeer.count({kind:"overlay", status:"active"})`), so the existing
   `overlay_device_cap_reached` line — "Remove one before linking another" —
   is now literally actionable. No copy change; do not "fix" it.

## Empty states

- Peer list empty: existing (p.264-269) — "No devices yet / Tap 'Add device'
  to set up your first phone or laptop." Unchanged.
- Pending queue empty: existing (p.1015-1020) — "No devices waiting. Tap
  'Link a device' to add one." (loading: "Checking for devices…"). Unchanged.
- Status header: never empty. Loading renders the muted "Checking your
  connection…" state (matrix row 7); an absent `overlay` block renders no
  header at all (matrix row 2).

## Mobile notes

- The shell's mobile contract is enforced by
  `src/__tests__/shell/mobile-layout-contract.test.ts` (asserts `.pt-chip`
  `min-width: 0` + `flex-shrink: 1`, and `.pt-host`/`.pt-sep` hidden in the
  mobile media block — droplet-shell.css:494-517). The status header must not
  reintroduce the same class of bug: no nowrap flex-shrink-0 text wider than
  ~340px.
- The four-up fact row stacks 2×2 below the mobile breakpoint (the `grid c4`
  primitive the old status card already uses; verify with the contract test's
  375px assumptions).
- Pending-row action pair (p.1113-1137) is `flex-shrink-0`; the label column
  already has `min-w-0` + `break-all` (p.1071-1074). Keep both — a
  255-char hostile device label is the tested case (the label is untrusted,
  p.890-893).
- Toasts are the error surface on mobile; every string above fits three lines
  at 375px — none exceeds ~200 chars except `enrollment_rejected_by_hq`,
  which is the one the owner must actually read; acceptable.

## API deltas

Exactly one, and only for the status header:

- **Extend `GET /api/vpn/status`** (vpn.ts:1489-1561) with the `overlay` block
  specced above. Placement/relay come from `observePlacement` (already wired
  with the right probes at vpn.ts:189-211); `agentEnabled` mirrors the
  index.ts supervision gate on `OVERLAY_CONNECT_ENABLED` + `HQ_ISSUANCE_URL`;
  `hqReachable` needs a small in-memory last-tick-outcome cell written by the
  connect agent. `relayAvailable` is hardcoded `false` until ADR-040 ships.

Everything else in this spec — pending-queue affordances, all 409/502
rendering, liveness copy, empty states — is buildable against today's routes
plus #1610 with ZERO server changes.

## Build order + verification

Order: (1) the error-rendering task (WARP ticket B) — no API dependency, fixes
actively-wrong copy shipping today; (2) the status-header story (ticket A) —
needs the `/vpn/status` delta; land orchestrator + page in one PR so the
`overlay`-absent fallback is exercised by the older-orchestrator test, not by
customers.

Verification recipe:

1. **Server contract** (proves #1610's shapes before building against them):
   `cd apps/orchestrator && npx vitest run src/__tests__/vpn-overlay-qr-enroll.test.ts src/services/overlay-connect.service.test.ts`
   — the WARP-2061 cases assert every body in the table above.
2. **Client copy units**: add cases to a colocated test beside
   `overlay-enroll.ts` for the two new KNOWN codes, and to the friendly-errors
   tests for `vpn.HQ_REVOKE_FAILED`; assert the not_pending page branch
   reloads the queue. `cd apps/web-dashboard && npx vitest run`.
3. **Mobile contract**: `npx vitest run src/__tests__/shell/mobile-layout-contract.test.ts`.
4. **Live box** (test box, office LAN — see the box-ssh memory for access):
   open `/remote-access` as owner; mint a Link QR; scan from the Android app;
   while the row is approving, confirm both buttons disable with the caption;
   from a SECOND browser session deny the same row post-approve and confirm
   the not_pending toast names revoke-not-deny and the queue reloads. Block
   the box's HQ route (or point `HQ_ISSUANCE_URL` at a dead host and restart
   the orchestrator container — remember `restart` does not re-read `.env`)
   and revoke a linked device: expect the HQ_REVOKE_FAILED toast and the row
   still active. Restore, revoke again, expect success and HQ-first ordering
   in the orchestrator log.
5. **Header honesty**: with the agent on and HQ reachable, the header must NOT
   say "coming soon" for linked devices while a punched phone is demonstrably
   connected from cellular; with `OVERLAY_CONNECT_ENABLED=false` it must say
   Local only. `curl -s http://<box>/api/vpn/status | jq .overlay` shows the
   block; a family-user session must also receive it (only `endpointHost` is
   admin-gated).
