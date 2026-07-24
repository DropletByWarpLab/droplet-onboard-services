# Business identity + full-surface tool guidance — design

**Date:** 2026-07-23
**Repo:** droplet-onboard-services
**Branch:** WARP/business-identity-prompt (off origin/main @ 3f46d6aa)

## Problem

Two gaps in the base system prompt every `/api/llm/chat` caller receives:

1. **Identity is household-voiced.** `apps/orchestrator/data/droplet-identity.md`
   frames Droplet as a "warm, capable housemate" for a *household*. The product
   direction is business-first: the identity must present Droplet as the AI
   assistant for this business, functionally described, without ownership or
   anti-cloud marketing framing.
2. **Tool guidance covers 3 of ~68 advertised tools.** Default chat scope
   (registry minus `EXCLUDED_FROM_CHAT_TOOLS`, WARP-1424) advertises ~68 tools,
   but `buildBaseSystemPrompt` steers only `search_content`, `memory_recall`,
   and `memory_extract_fact`. Everything else — email, calendar, smart devices,
   cameras, network/system health, and notably `calculate` — rides on schema
   descriptions alone. Small local models (gpt-oss:20b class) under-call tools
   without prompt-level steering, and do arithmetic mentally instead of calling
   `calculate`.

## Decisions (settled with Romain, 2026-07-23)

- **Business-only identity rewrite.** Every box gets the business voice; the
  household framing is removed (not made box-type-aware, not neutralized).
- **Category-level guidance** — ~9 lines, one per tool family, not per-tool.
- **Strong-but-scoped calculate mandate** — "never do arithmetic yourself",
  scoped to actual computation; excludes trivial counting and solving-for-x
  (the evaluator rejects unknown identifiers at parse time).
- **Guidance lives in a new pure composer service**, mirroring
  `persona.service.ts` / `business-profile.service.ts` / `identity-prompt.ts`.

## 1. Identity rewrite — `apps/orchestrator/data/droplet-identity.md`

Full replacement text (locked):

```markdown
# Droplet — identity & what this box does

You are Droplet, the AI assistant for this business, running locally
on its appliance. Think of yourself as a sharp, reliable colleague
who handles the busywork, not a corporate chatbot.

## What the box does

- Runs you — a local AI the team can chat with from the dashboard, by
  voice ("hey droplet"), or from connected apps.
- Keeps and searches the business's files, documents, emails, and
  notes.
- Manages email, calendar, contacts, and reminders for the team.
- Does everyday computation on request: arithmetic, unit and currency
  conversion, dates and times, translation.
- Watches the premises' cameras with on-device detection.
- Runs the network: Wi-Fi, routing, device blocking, and remote
  access over VPN.
- Connects to smart devices over Matter (lights, plugs, thermostats,
  and more).
- Remembers durable facts about the business when asked, and recalls
  them later.

## How you speak

- Professional, plain, and direct — like a capable colleague, not a
  press release. Contractions are fine; filler and jargon are not.
- Be honest about limits: if a tool fails or you don't know, say so
  plainly, once, without over-apologizing.
- Privacy first: never suggest a cloud service for something the box
  already does on-site.
```

Constraints honored: no ownership framing ("the business that owns this
appliance" — removed), no cloud-comparison marketing ("you are not a cloud
service" — removed), capability bullets stripped of marketing clauses ("all
stored on the box", "recordings never leave the building" — removed). The
privacy-first bullet stays: it is a behavioral rule, reviewed and kept.

`FALLBACK_IDENTITY` in `identity-prompt.ts` is reframed to match:
`"You are Droplet, the AI assistant for this business, running locally on its appliance."`
(~1.6k chars total; cap is 4000 — `IDENTITY_MAX_CHARS` unchanged.)

## 2. Tool-guidance composer — `apps/orchestrator/src/services/tool-guidance.service.ts`

New pure module. Signature:

```ts
composeToolGuidance(allowed: string[] | undefined): string
// "" when no line survives; otherwise "Tool guidance:\n- …"
```

`allowed === undefined` means privileged caller → every tool passes (same
`can()` contract as today's `buildBaseSystemPrompt`).

**WARP-642 invariant (the core rule):** a rendered line names ONLY tools that
pass `can()`. Each category declares its tool names with per-name text
fragments; compose-time filters to the passing subset; a category whose
anchor set is empty is dropped entirely. A stripped tool's name must never
appear in output — instructing a stripped tool sends small models into the
hallucinated-tool guard and, after 3 guard-only iterations, a failed turn.

Categories and lines (final wording tuned at implementation; intent locked):

| # | Category | Tools gating/named | Line intent |
|---|---|---|---|
| 1 | Content search | `search_content`, `read_file`, `summarize_file` | Business files/documents/notes/emails questions → `search_content`, ground in returned passages, cite `path` values; "use tool names exactly as advertised — never invent one" retained. |
| 2 | Email | `email_search`, `email_read`, `email_summarize_thread`, `email_draft_reply`, `email_send` | Search/read before answering mail questions; prefer drafting for review before sending. "Send" is mentioned only when `email_send` passes. |
| 3 | Calendar & time mgmt | `search_calendar_events`, `list_events`, `create_event`, `list_reminders`, `search_contacts`, `set_timer` | Check the calendar/reminders via tools — never guess schedules from memory. |
| 4 | Computation | `calculate`, `unit_convert`, `currency_convert`, `date_math`, `get_current_datetime` | See locked wording below. |
| 5 | Smart devices | `list_smart_home_devices`, `control_device`, `run_scene` | Act on devices only via tools; confirm ambiguous device references before acting. |
| 6 | Cameras | `list_cameras`, `search_camera_events`, `get_camera_snapshot` | Ground camera/premises answers in tool results. |
| 7 | Network & system | `network_summary`, `get_network_status`, `get_system_health`, `get_drive_health` | Report status from live tool output, never from memory. |
| 8 | Memory | `memory_recall`, `memory_extract_fact`, `memory_forget` | Today's two lines reworded business + forget: honor deletion requests via `memory_forget`. |
| 9 | Business context | `business_profile_get` | Questions about the business itself → check the business context block; call `business_profile_get` for detail. |

Locked calculate wording (category 4 lead):

> Never do arithmetic in your head. For any computation — totals,
> percentages, margins, conversions — call `calculate` and report its
> `formatted` result. It evaluates plain numeric expressions only: reduce
> the problem to numbers first, and don't use it for simple counting or
> solving for unknowns.

…followed by the passing subset of: `unit_convert`/`currency_convert` for
units and money, `date_math`/`get_current_datetime` for dates and times.

`buildBaseSystemPrompt` (routes/llm.ts) shrinks to composition only:
identity → persona block → business block → `composeToolGuidance(allowed)`.
The memory-facts block remains appended by the route as today.

Size: ~1.3k chars all-lines-on. Guidance remains part of the never-dropped
identity fold in the WARP-1118 estimator.

## 3. Coherence sweep

- `buildMemoryFactsBlock` header: "facts previously saved for this
  household" → "for this business".
- Memory guidance line: "the user's preferences" phrasing reviewed for
  business voice ("how the team likes things done").
- Grep the chat path for remaining `household`/`home` strings; fix those in
  prompt-visible text only (comments/docs untouched unless trivially wrong).
- Voice-io greeting path (`tool_choice: "none"`) skips the base prompt by
  design — no change. Voice persona files are out of scope.

## 4. Budget

Never-dropped block grows ~1.9k → ~2.9k chars (~+250 tokens) against the
16,384-token window (`OLLAMA_CONTEXT_LENGTH`, WARP-854). WARP-1118 canary
(`base-prompt-budget.test.ts` / `context-budget.service.test.ts` pins)
re-pinned; if a hard ceiling is crossed, the bump is deliberate and
documented in the canary comment.

**Amendment (implementation, settled with Romain 2026-07-23):** counting
guidance as a capped block (2200 chars) pushed the worst-case window-fit
assertion 33 tokens over `16384 − OUTPUT_RESERVE`. Fixed by scoping four
config-heavy/power-user tools out of DEFAULT chat in `chat-tool-scope.ts`
— `create_scene` (the largest schema in chat scope, ~1.9K chars),
`remove_device`, `restore_file_version`, `list_file_versions` — reclaiming
~1,000 tokens (headroom now ~975, better than pre-change). Dashboard and
external MCP clients still see these tools; explicit `allowed_tools`
overrides as always. `BASE_PROMPT_MAX_CHARS` 10000 → 12200.

## 5. Testing

- **New** `tool-guidance.service.test.ts`: per-category gating on/off; the
  stripped-tool-never-named invariant (property-style: for random allowed
  subsets, no output token matches a stripped tool name); calculate line
  wording; `""` when everything is stripped; undefined-allowed = full set.
- **Updated** `llm-chat.base-prompt.test.ts`: business identity leads
  ("You are Droplet" + "for this business"); guidance follows identity;
  existing gating tests repointed at the composer's output.
- **Updated** `identity-prompt` tests: new fallback string, new file content.
- **Updated** budget canary pins.
- E2E smoke unchanged (prompt content is not asserted there).

## Out of scope

- Voice-io persona (`services/voice-io/voice/persona.py`) — separate surface.
- Box-type-aware identity variants (explicitly rejected in favor of
  business-only).
- Algebra/symbolic solving — would be a new tool, not prompt work.
- droplet-local-LLM repo — no agent prompt lives there (stateless by design).
