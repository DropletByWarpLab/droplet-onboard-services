# Trigger→action automation engine + create_automation/list_automations tools — design (WARP-1448)

**Status:** Draft for review
**Tickets:** WARP-1448 (this design); parent analysis WARP-1423 (MCP tool gap analysis)
**Tools covered:** `create_automation` (Tier-2 write), `list_automations` (Tier-1 read)

## 1. Context and goals

The appliance already has both halves of an automation engine — it has
never connected them. Time-based trigger→action exists twice
(`SceneSchedule` + RRULE ticker; `ToolSchedule`/`ToolSpec` runner,
WARP-462/463), and two live event sources fan out inside the
orchestrator with **zero subscribers that act**: Frigate camera
detections and Matter device state changes. This design adds the
missing piece — an `AutomationRule` table + one evaluation service that
turns "when the driveway camera sees a person after 22:00" into "run
Goodnight" — plus the two LLM tools so it is authorable from chat.

Non-goals (v1): condition chaining (AND/OR trees), multi-trigger rules,
LLM-in-the-loop rule bodies ("ask the model whether to fire"), generic
MQTT-topic triggers, cross-rule cycle detection (§7), and a
`time_window` **trigger type** — pure-time rules already have a
sanctioned home (§3, "reuse, don't duplicate").

## 2. As-built anchors (what this design extends)

| Layer | Existing machinery | How this design uses it |
|---|---|---|
| Time-trigger precedent | `SceneSchedule` (schema.prisma:2792) fired by `tickSceneSchedules` (scene-schedule-ticker.service.ts:71), mounted via `cronRuntime.scheduleInterval` + pg advisory lock `droplet:scene-schedule-ticker` (index.ts:496–515); clone of `ToolSchedule` (schema.prisma:2708, WARP-462/463) | Pure-time rules stay there; `AutomationRule` copies its explicit-state posture (enabled column, defensive disable + audit) |
| Camera events | `camera.service.ts:85` subscribes `frigate/events`; `handleMqttMessage:117` parses camera/label/score at :145–167, dedupes via `processCameraEvent` (accept_new gate), broadcasts a `detection` SSE event; in-process fan-out via `subscribeCameraEvents:308` | Engine subscribes `subscribeCameraEvents` — inherits the dedupe gate (no re-fire on Frigate `update` spam). One plumbing change: carry `zones` (from `after.entered_zones`) on the detection event |
| Device state events | matter-controller sidecar SSE `GET /events` (services/matter-controller/src/server.ts:277–321) emits `state_changed {nodeId, path, value}` (controller.ts:301–305); orchestrator bridge re-emits locally (matter.service.ts:545), exposed via `subscribeStateChanges` (matter.service.ts:423–428) | Engine's second subscription — no new SSE consumer, no new MQTT client (`mqtt.service.ts subscribeToTopic:91` stays unused here) |
| Action paths | `executeScene` (scene-runner.service.ts:82) — the ONE scene walker shared by the run route and the ticker; `sendMatterCommand` (matter.service.ts:380) — audits every command | Rules fire through these exact paths; `ExecuteSceneOpts.triggeredBy` union (scene-runner.service.ts:63) gains `"automation"` |
| RBAC | `requireRoleOrMcpService` (middleware/auth.ts:738) — admits the pinned `_service:mcp` principal; scenes routes already mix it in (routes/scenes.ts:181,251) | All `/api/automations` routes use it from day one — no WARP-1453-style retrofit |
| Tool confirmation | Handler-enforced two-phase confirm: first call returns `confirmation_required`, re-issue with `confirmed: true` (handlers/memory/forget.ts:103–110); ops-folding precedent `set_device_schedule` `operation: set|clear|list` (handlers/network/set-device-schedule.ts:73) | `create_automation` copies both idioms (§6) |
| Audit | `recordActivity` (activity.singleton.ts:53), kind `smart_home` (activity.service.ts:47), structured `refs` | Every rule CRUD + every firing (incl. suppressed) is a row (§4) |
| Active-window vocabulary | 7-bit day mask Sun=1…Sat=64 + minutes-since-midnight, wrap-past-midnight valid (lib/schedule-window.ts:21); IANA `timezone` column precedent (KAN-6, SceneSchedule) | Optional active-window columns reuse the same encoding — no second window dialect |

## 3. Data model — `AutomationRule`

One table, explicit columns per the no-guessing rule — no JSON blob
conditions, no state derived from NULLs.

```prisma
enum AutomationTriggerType { camera_event  device_state }   // deliberately NO time_window (below)
enum AutomationActionType  { scene  device_command }
enum AutomationComparator  { eq  ne  lt  lte  gt  gte }

model AutomationRule {
  id               String                @id @default(uuid())
  name             String
  enabled          Boolean               @default(true)
  triggerType      AutomationTriggerType
  // camera_event condition (required when triggerType=camera_event)
  cameraName       String?               // Frigate camera name
  cameraLabel      String?               // e.g. "person"
  cameraZone       String?               // null = any zone
  // device_state condition (required when triggerType=device_state)
  deviceNodeId     String?
  deviceAttribute  String?               // sidecar `path`, e.g. "onOff.onOff"
  comparator       AutomationComparator?
  threshold        Json?                 // boolean | number | string, compared per comparator
  // optional active window (any trigger type) — "…after 22:00"
  activeDaysMask   Int?                  // 7-bit Sun=1…Sat=64 (lib/schedule-window.ts DAY_BIT)
  activeStartMin   Int?                  // minutes since local midnight; end<=start wraps midnight
  activeEndMin     Int?
  timezone         String                @default("UTC")   // KAN-6 precedent — window wall-clock zone
  // action — sceneId XOR inline command, discriminated by actionType
  actionType       AutomationActionType
  sceneId          String?
  scene            Scene?                @relation(fields: [sceneId], references: [id], onDelete: SetNull)
  actionNodeId     String?
  actionCommand    String?
  actionArgs       Json?
  // firing state + audit
  cooldownSeconds  Int                   @default(300)
  lastFiredAt      DateTime?             // last successful claim (§4) — provenance + cooldown CAS anchor
  createdBy        String?
  createdAt        DateTime              @default(now())
  updatedAt        DateTime              @updatedAt

  @@index([enabled, triggerType])        // the evaluator's only hot query
  @@index([sceneId])
}
```

Decisions:
- **No `time_window` trigger type — reuse, don't duplicate.** A pure
  "at 07:00 run Morning" rule IS a `SceneSchedule`; building a second
  RRULE-less clock path would recreate the ticker the schema comment at
  schema.prisma:2779 explicitly forbids duplicating ("one sanctioned
  scheduler, no hand-rolled timers"). `create_automation` routes a
  pure-time request to `POST /scenes/:id/schedules` (routes/scenes.ts:507)
  and says so in its response. `time_window` here is only the optional
  *gate* on an event trigger (activeDaysMask/StartMin/EndMin).
- **Per-type condition validation lives in the route layer** (zod
  discriminated union), not DB CHECKs — same posture as SceneAction's
  opaque `args`. The evaluator treats a malformed row (e.g.
  `actionType=scene` with `sceneId` NULL after a scene deletion,
  `onDelete: SetNull`) exactly like the ticker treats a missing scene
  (scene-schedule-ticker.service.ts:92–111): disable + audit, never loop.
- **`enabled` is the explicit state column**; `lastFiredAt` is
  provenance + the cooldown CAS anchor, never a status signal.

## 4. Rule evaluation service — `automation-engine.service.ts`

One orchestrator service, initialized in `index.ts` after
`initCameraService` (index.ts:327) and matter init; shutdown via the
returned unsubscribers (both sources hand back teardown functions).
No polling, no `while True` — it is purely event-driven off the two
in-process emitters:

- `subscribeCameraEvents(cb)` (camera.service.ts:308) — reacts only to
  `type: "detection"` events, which the accept_new gate already
  dedupes per Frigate tracked object. Prerequisite plumbing: extend the
  detection broadcast (camera.service.ts:175–198) to include
  `zones: after.entered_zones ?? []`.
- `subscribeStateChanges(cb)` (matter.service.ts:423) — `{nodeId, path,
  value}` per attribute change.

Per event, the callback does `void evaluate(event).catch(log)` — never
awaited in the emitter, so a wedged evaluation cannot back-pressure the
camera SSE fan-out or the matter bridge. `evaluate()`:

1. **Match** — `findMany({ where: { enabled: true, triggerType } })`,
   then in-memory condition compare (camera/label/zone equality;
   nodeId + attribute path + comparator vs threshold). Home-scale rule
   counts make a per-event query fine; an invalidate-on-write cache is
   a later optimization, not v1.
2. **Active window** — if `activeStartMin` is set, compute the rule's
   local wall-clock (rule.timezone) and test day-mask + window with the
   wrap-past-midnight semantics of lib/schedule-window.ts:34–42. Outside
   → not a match (no audit row; matching means condition AND window).
3. **Cooldown claim — atomic compare-and-set.** The storm brake and the
   race brake are the same single UPDATE:
   ```ts
   const claimed = await prisma.automationRule.updateMany({
     where: { id: rule.id, enabled: true,
              OR: [{ lastFiredAt: null },
                   { lastFiredAt: { lte: new Date(now - rule.cooldownSeconds * 1000) } }] },
     data: { lastFiredAt: new Date(now) },
   });
   ```
   `claimed.count === 0` ⇒ suppressed: another concurrent event (or
   instance) won, or the cooldown window is open. Exactly one winner per
   window, no read-then-write gap, works unchanged multi-instance.
4. **Execute** — `actionType=scene`: load scene + ordered actions, run
   `executeScene(prisma, matter, scene, { triggeredBy: "automation",
   activityActor: { type: "ai", id: null } })` (partial-failure tolerant,
   already writes its own `smart_home` row). `actionType=device_command`:
   `sendMatterCommand(actionNodeId, actionCommand, actionArgs, …)`
   (matter.service.ts:380 — audits per command).
5. **Audit every matched firing** — one `recordActivity` row per matched
   rule per event, `kind: "smart_home"`, `sub: "automation"`, `refs:
   { ruleId, trigger: {type, camera?, label?, zone?, nodeId?, path?,
   value?}, outcome: "fired" | "suppressed_cooldown" | "failed",
   error? }`. Suppressions are `severity: "info"`; failures `"warn"`.
   Non-matching events write nothing (a busy hallway is not an audit
   event).

**Failure isolation:** each rule's steps 2–5 run inside their own
try/catch; a throw audits `outcome: "failed"` and continues to the next
matched rule — one bad rule (deleted scene, dead device, malformed
threshold) can never wedge the subscriber or starve sibling rules. A
rule whose row is structurally unusable (scene action with NULL sceneId)
is disabled + audited, mirroring the ticker's defensive path.

## 5. Routes + dashboard surface

`apps/orchestrator/src/routes/automations.ts` — all guarded with
`requireRoleOrMcpService` from day one (the WARP-1453 lesson: retrofit
hurts):

- `GET    /api/automations` — `("owner","admin","family")`; list incl. `enabled`, `lastFiredAt`
- `POST   /api/automations` — `("owner","admin")`; zod discriminated-union validation; self-trigger guard (§7); pure-time requests → 400 pointing at scene schedules
- `PATCH  /api/automations/:id` — `("owner","admin")`; field edits + `enabled` toggle (explicit column)
- `DELETE /api/automations/:id` — `("owner","admin")`
- Every write → `recordActivity` (`kind: "smart_home"`, `refs: {ruleId, actor, …}`), same shape as schedule CRUD at routes/scenes.ts:568–583.

Dashboard: one page (Devices area, `apps/web-dashboard/src/app/devices/`
— an "Automations" tab beside scenes). Left: rule list rendered as
plain-language sentences ("When **driveway** sees a **person**, 22:00–06:00
→ run **Goodnight** · cooldown 5 min · last fired 2h ago") with enable
toggles. Right/drawer: editor with trigger-type picker driving the
per-type condition fields, action picker (scene dropdown XOR device+command),
optional window, cooldown. Sketch only — ships in the tools ticket's phase.

## 6. LLM tools

**`create_automation`** — Tier-2 (`requiresWrite` + `requiresConfirmation`),
confirmation enforced BY THE HANDLER exactly per forget.ts:103–110. Ops
folded per the `set_device_schedule` precedent: `operation:
create | enable | disable | delete` (default `create`) — one Tier-2
surface, one confirmation contract, no third tool. Unlike
`set_device_schedule`, **list is NOT folded in**: reads must stay
visible to roles for whom the write tool is narrowed out
(routes/llm.ts:293 `narrowAllowedToolsForRole`), so listing is its own
Tier-1 tool. The confirmation echo renders the rule in plain language,
never as JSON: *"When the driveway camera sees a person between 22:00
and 06:00, run 'Goodnight' (at most once every 5 minutes). Approve to
create this automation."* Delete/disable echo the same rendered sentence
of the existing rule.

**`list_automations`** — Tier-1 read, no confirmation. Returns id, name,
`enabled`, `lastFiredAt`, cooldown, and the same plain-language rendering
(shared renderer with the confirmation echo and the dashboard list, so
the three surfaces cannot drift).

Both land via the `add-llm-tool` skill (handler → registry entry → unit
test; MCP server + RBAC pick them up automatically).

## 7. Phasing + safety

- **Phase 1 — camera_event → scene only.** Smallest credible loop that
  still forces all the new plumbing: model + migration, engine with the
  camera subscription + zones plumbing, cooldown CAS, audit rows, CRUD
  routes. device_state columns ship in the schema but are rejected at
  the route (400 `unsupported_trigger`) until phase 2 — explicit refusal,
  not silent acceptance.
- **Phase 2 — tools + dashboard.** `create_automation` /
  `list_automations` (camera_event→scene scope), dashboard page.
- **Phase 3 — device_state triggers + inline device_command actions**,
  plus the self-trigger guard below.
- **Loop prevention:** a rule's action must not trigger itself. v1
  enforcement is at creation time: reject (route 400 / tool error) any
  rule where `triggerType=device_state` and `actionType=device_command`
  with `actionNodeId === deviceNodeId`; when the action is a scene,
  unroll its `SceneAction` rows at create time and **warn** (non-blocking
  — scenes mutate after rule creation) if any action targets the trigger
  device. Cross-rule cycles (A fires B fires A) are NOT detected in v1;
  the cooldown CAS bounds any flap to one fire per rule per cooldown
  window, and that boundary is documented here rather than papered over.
- Unattended fires bypass per-run confirmation on the same justification
  as SceneSchedule (schema.prisma:2809–2812): *creating the rule IS the
  owner/admin opt-in* (Tier-2 confirm in chat, owner/admin RBAC on the
  route), and every fire is audited.

## 8. Implementation tickets (to be filed on approval)

1. `AutomationRule` model + automation-engine service + `/api/automations`
   CRUD — camera_event→scene, zones on the detection event,
   `triggeredBy: "automation"`, cooldown CAS, audit rows.
2. `create_automation` + `list_automations` tools (shared plain-language
   renderer) + dashboard Automations page.
3. device_state triggers + inline device_command actions + self-trigger
   guard (+ route un-gating of the phase-1 400).

## 9. Open questions for Romain

1. **Family visibility:** scenes let family read schedules
   (routes/scenes.ts:484) — should family also see the automations list
   (`GET /api/automations` + `list_automations`), or is the whole surface
   owner/admin? Proposed: family reads, owner/admin writes (mirrors scenes).
2. **Suppressed-fire audit volume:** one `info` row per
   suppressed-by-cooldown match is the spec here, but a busy driveway can
   emit dozens per cooldown window. Accept the volume, or coalesce to one
   "suppressed N times" row per window?
3. **Scene deletion vs referencing rules:** proposed `onDelete: SetNull`
   + engine auto-disable + audit (matches the ticker's defensive path).
   Alternative: block scene deletion while rules reference it (louder,
   but couples the scenes UI to automations). Which failure mode do you
   want owners to experience?
