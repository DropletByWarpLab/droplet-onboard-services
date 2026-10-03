# ADR-069: One work engine — Projects at paid-tool parity, a Service Desk on the same rows, integrations through the egress gate

- **Status:** Accepted (2026-10-03)
- **Authors:** Stefan Cruceru (CEO)
- **Epic:** [WARP-3517](https://warp-lab.atlassian.net/browse/WARP-3517) (Work Suite)
- **Builds on:** [ADR-026](ADR-026-native-pm-supersedes-plane.md) (native PM; its §"How to apply" step 5 — cycles, modules, custom fields, attachments, activity feed — is unfinished and is absorbed here), [ADR-044](ADR-044-business-ecosystem-customer-spine.md) (the `Business` nav group and the Customer spine — `Contact` is *the* person row), [ADR-032](ADR-032-access-roles-custom-rbac.md) (feature / tool / connector grants), [ADR-012](ADR-012-phone-home-egress-control.md) (off-LAN egress is a closed, owner-switched vocabulary), [ADR-041](ADR-041-cloud-connector-class.md) / [ADR-042](ADR-042-customer-supplied-credentials.md) (connectors and the credentials they hold), [ADR-067](ADR-067-authenticated-lan-model-api.md) (hashed, revocable LAN API tokens), [ADR-014](ADR-014-llm-client-dispatched-actions.md) (confirm-to-apply writes).
- **Design authority for the Projects surface:** [`docs/projects-surface-design-brief.md`](projects-surface-design-brief.md). Slice-level specs: [`docs/superpowers/specs/2026-10-03-work-suite-design.md`](superpowers/specs/2026-10-03-work-suite-design.md).

## Context

A business that buys a Droplet still pays per seat for two kinds of SaaS that hold its most operational data: a work tracker (Jira, Linear, Asana, ClickUp, Monday) and a help desk (Zendesk, Freshdesk, Help Scout, Jira Service Management). Both hold exactly the data the box exists to keep on the LAN — customer conversations, internal plans, who owes whom what. ADR-026 replaced the embedded Plane stack with a native module so Projects could be one-login, Droplet-branded and LLM-native. It shipped the core (projects, states, labels, work items, assignees, comments, relations, departments) and stopped there.

Read at `origin/stage` on 2026-10-03:

1. **The schema is ahead of the product.** `PmCycle`, `PmModule`, `PmCustomProperty`, `PmWorkItemPropertyValue` and `PmAttachment` have existed since the ADR-026 foundation migration. No route reads or writes them and no screen shows them. `PmWorkItem.startDate` is accepted by the API and shown read-only in the drawer; no screen lets anyone set it.
2. **The open bugs are trust bugs, not polish.** The board silently stops at 100 items (WARP-3371). Members see `User 1a2b` instead of a teammate's name, and a due date entered west of UTC lands a day early (WARP-3372). Any member can delete a whole project with every work item and nothing records it (WARP-3370). Module gates still miss routes (WARP-1625). The primary button fails WCAG AA (WARP-3181). Work items cannot carry a file (WARP-1505).
3. **There is no ticketing at all.** Live Jira and the brain agree: no service-desk, support-inbox or requester concept exists. The pieces a desk is built from all exist separately and do not meet — `Contact` / `CrmCompany` (who is asking), `EmailAccount` / `EmailThread` / `EmailMessage` (the channel they ask through), `PmWorkItem` (the unit of work), `NotificationLog` (who hears about it), `Department` (who owns it).
4. **Nothing leaves the box for a work event.** There are no webhooks, no chat-app notifications, no calendar feed of due dates, no API token a script can use, no import from the tracker a customer is leaving, and no link from a work item to the code change that closes it.

The comparison that matters to an owner is a feature matrix against what they cancel. Where Projects and a desk stand today, and where this ADR takes them:

| Capability | Jira / Linear / Asana | Zendesk / Freshdesk | Droplet today | After this ADR |
|---|---|---|---|---|
| Board, list | ✓ | — | ✓ (capped at 100) | ✓ uncapped |
| Table, calendar, timeline (Gantt), my work | ✓ | — | — | ✓ |
| Saved views, structured filters, bulk edit, command palette | ✓ | ✓ | — | ✓ |
| Cycles / sprints, milestones (modules), burndown | ✓ | — | schema only | ✓ |
| Custom fields, types, estimates | ✓ | ✓ | schema only | ✓ |
| Comments: edit, delete, @mention, reactions; watchers | ✓ | ✓ | create only | ✓ |
| Attachments | ✓ | ✓ | — | ✓ |
| Activity history | ✓ | ✓ | rows written, not shown | ✓ |
| Templates, recurring work, automation rules | ✓ | ✓ | — | ✓ |
| Time tracking, timesheets | ✓ (add-on) | ✓ | — | ✓ |
| Insights: throughput, cycle time, CFD, workload | ✓ | ✓ | — | ✓ |
| Import (Jira/Asana/Trello/Linear CSV), CSV export | ✓ | ✓ | — | ✓ |
| Tickets with requester, public reply vs internal note | — | ✓ | — | ✓ |
| Email-to-ticket, threaded replies, auto-acknowledge | (JSM) | ✓ | — | ✓ |
| SLA policies, business hours, breach escalation | (JSM) | ✓ | — | ✓ |
| Macros / canned responses, assignment rules | (JSM) | ✓ | — | ✓ |
| Support reports (FRT, resolution, SLA %, CSAT) | (JSM) | ✓ | — | ✓ |
| Webhooks, Slack / Teams / Discord / Google Chat | ✓ | ✓ | — | ✓, egress-gated |
| ICS feed, personal API tokens, OpenAPI | ✓ | ✓ | — | ✓ |
| GitHub / GitLab development panel | ✓ | — | — | ✓, egress-gated |
| An assistant that can read and (with confirmation) act on all of it | partial, cloud | partial, cloud | `business_*` over projects + CRM | ✓ incl. tickets, on the LAN |

## Decision

### 1. One work engine, two surfaces

**A ticket is a `PmWorkItem` in a project whose `kind` is `SERVICE_DESK`.** A one-to-one `PmTicket` row carries the columns only a desk needs (requester, channel, SLA clocks, satisfaction). Everything a work item already has — state, priority, assignees, labels, department, relations, attachments, activity, comments, custom fields, saved views, automation — a ticket has for free, and escalating a ticket to engineering is an existing `PmWorkItemRelation` across projects. This is the Jira Service Management shape, not the Zendesk one, and it is chosen for the same reason: a desk that cannot link to the work that resolves it is a second silo.

- `PmProject.kind` is an explicit enum (`PROJECT | SERVICE_DESK`), default `PROJECT`. Never inferred from the presence of a `PmTicket` row.
- `/projects` and `/api/pm/*` read `kind = PROJECT` only. A service-desk work item fetched through a PM route is a 404, so the `pm` feature grant never becomes a back door into customer conversations.
- `/support` and `/api/support/*` read `kind = SERVICE_DESK` only, behind a new `support` module and feature grant.
- **No `requires` edge between `support` and `projects`.** ADR-044's bar: the child must have no reachable surface without the parent. `/support` is its own surface; a dental front desk runs Support with Projects off. Linking a ticket to engineering work needs both grants and degrades to "linked item (no access)" otherwise.

### 2. The requester is a `Contact` — or a `User`

A ticket's requester is either an external `Contact` (ADR-044: the one person row) or an internal `User` (staff raising an IT or facilities request). `PmTicket.requesterKind` is an explicit enum (`CONTACT | USER`) with exactly one of the two foreign keys set, enforced by a CHECK constraint. `PmTicket.companyId` is set when the contact has exactly one company at intake and otherwise left for a human — never guessed. Email intake creates a `Contact` for an unknown sender with an explicit origin value, through the same address-book service the CRM uses; it never writes a second person-shaped table.

### 3. Conversation: public replies and internal notes are one comment stream

`PmComment.visibility` (`INTERNAL | PUBLIC`, default `INTERNAL` — every existing comment stays internal) and `PmComment.authorKind` (`USER | CONTACT | SYSTEM | AUTOMATION`) are explicit columns. Only a `PUBLIC` comment on a ticket is delivered to the requester, through the ticket's channel. Project work items never have public comments.

### 4. Channels reuse what the box already has

`PmTicket.channel` (`EMAIL | INTERNAL | WEB_FORM | CHAT | API | PHONE`) records where a ticket came from.

- **Email is the external channel.** A service desk binds one existing `EmailAccount`; the email sync the box already runs is the intake, and the account's own send path delivers public replies with `In-Reply-To` / `References` threading and a `[KEY-123]` subject token. No new mail server, no MX change, no inbound port.
- **No public web form or customer portal is exposed off-LAN by this ADR.** The Foundation is an air-gapped mentality and ADR-009 already allows inbound only over WireGuard: the box dials out, it is not dialled into. Staff file tickets from the dashboard (`INTERNAL`), customers email, and the assistant files on someone's behalf (`CHAT`, confirm-to-apply). An internet-facing portal is a separate decision with its own threat model.

### 5. Ticket status is the project's states, with an explicit SLA clock

A service desk seeds its own states — New, Open, Pending (on customer), On hold (on third party), Solved, Closed — mapped onto the existing `PmStateGroup`. `PmState.slaClock` (`RUNNING | PAUSED | STOPPED`) says what each state does to SLA time. It is a column, not a rule derived from the group name, so a desk can rename "Pending" without breaking its SLAs.

### 6. SLAs are computed, stored and ticked

`PmSlaPolicy` (targets per priority for first response, next response and resolution) runs against a `PmBusinessCalendar` (timezone, weekly windows, holidays). Due times and an explicit `PmTicket.slaStatus` (`NONE | ON_TRACK | AT_RISK | BREACHED | MET | PAUSED`) are materialised on the ticket by pure functions — business-hours arithmetic is the one place in this ADR where DST bugs live, so it is a library with exhaustive tests, not inline date math. A `cron-runtime` interval re-evaluates open tickets each minute and emits notifications and escalation actions on transitions. No `while (true)`.

### 7. `PmActivity` is the outbox

Every PM mutation already writes `PmActivity` inside its own transaction (`writeActivity` in `pm.service.ts`), and the assignee notification sweep already tails it. That makes it a transactional outbox, and every new consumer reads it instead of adding emit calls throughout the service: webhooks (WS-16), automation (WS-9), live board updates (WS-19). Each consumer walks rows in `(createdAt, id)` order from its own cursor, stored in the existing `SystemFlag` key/value table under `pm-outbox:<consumer>`. It runs on a `cron-runtime` interval with an advisory lock, gets an in-process nudge after commit, and is idempotent. No consumer can miss an event that committed, and none sees one that rolled back.

### 8. One filter language

A typed, zod-validated filter DSL (`field / op / value` trees) is the single way to describe a set of work items. The API compiles it to a Prisma `where`; saved views persist it; automation conditions are written in it; the assistant's list tools accept it. Four consumers, one grammar, one compiler, one test suite.

### 9. Integrations leave the box only through the egress gate

- **Off-LAN delivery** — webhooks, Slack / Teams / Discord / Google Chat, GitHub / GitLab API polling — is gated by one new `OffLanChannelKey` value, `work_integrations`, owner-switched and default **off**. Extending the closed vocabulary is the schema change ADR-012 requires.
- **LAN destinations** (a local n8n, Home Assistant, a NAS) do not need the switch but always pass an SSRF guard that refuses loopback, link-local, the compose network and the box's own addresses, resolves once and pins the IP for the request.
- **Webhooks are signed** with HMAC-SHA256 (FIPS-approved) over `timestamp.body`, retried with exponential backoff from a delivery table, and auto-disabled after sustained failure. Secrets are encrypted at rest with the existing credential helper.
- **GitHub / GitLab are polled, not pushed to.** A box is not internet-reachable by design, so the connector dials out on an interval with conditional requests and matches work-item keys in branch names, PR titles and commit messages. Credentials are customer-supplied (ADR-042).
- **Calendar** is a read-only ICS feed of due dates behind the existing `CalendarFeedToken` mechanism — no second token scheme.
- **Scripts and other tools** use personal access tokens: hashed at rest, shown once, scoped (`pm:read`, `pm:write`, `support:read`, `support:write`), revocable, last-used tracked — the ADR-067 shape. An OpenAPI 3.1 document describes `/api/pm/*` and `/api/support/*`.

### 10. Automation is typed, bounded and audited

`PmAutomationRule` = trigger (enum) + conditions (§8 DSL) + actions (typed list). Rules run after the triggering transaction commits, never inside it; a chain stops at depth 3 and a rule never re-triggers itself. Every automated change writes `PmActivity` with `actorKind = AUTOMATION` and the rule id, so "who did this" always has an answer. Recurring work and templates are the same machinery's scheduled and manual entry points.

### 11. The assistant gets the whole surface through the existing verbs

No noun-shaped tools come back. WARP-2583 collapsed ten `pm_*` / `crm_*` tools into the verb-shaped `business_find` / `business_timeline` / `business_create` / `business_update` / `business_link` over one business graph, because a 20B local model chooses badly between many schemas and every description costs serialized budget. Tickets join that graph: `ticket` becomes an `entity` value where it makes sense (one enum member, measured before and after), a customer-visible reply is a `business_create` of a reply-kind note on a `ticket` parent, and every write stays behind the generic WARP-2305 confirmation interceptor. Drafting a reply is a read; sending it is a confirmed write. The assistant never emails a customer on its own.

## Rejected

- **A separate `SupportTicket` model family (the Zendesk shape).** Re-implements states, assignees, labels, comments, attachments, activity, views and automation a second time, and makes "this ticket is waiting on that bug" a cross-table join nobody maintains.
- **Treating tickets as ordinary work items with a `ticket` label.** No requester, no channel, no SLA clock — a label cannot carry a foreign key to a `Contact`, and a desk that cannot answer "who asked" is a to-do list.
- **A public portal / web form in this ADR.** Inbound exposure is the opposite of the Foundation's default. Email covers every customer on day one.
- **Receiving GitHub webhooks.** Needs an internet-reachable box; polling the API outbound needs nothing new.
- **Embedding a third-party desk (Zammad, osTicket, FreeScout).** Every argument ADR-026 made against Plane: a second login, a foreign design language, a footprint, an upstream.
- **A per-integration egress channel key.** Five keys an owner must understand for one decision — "may work data leave this box". One switch; each integration still needs explicit configuration.

## Consequences

**Positive.** A box can replace a work tracker and a help desk with one surface pair, one login, one backup, and an assistant that can see both. Every slice ships independently with the box bootable, and the schema ADR-026 laid down finally earns its keep.

**Negative.** This is the largest single feature program on the board: twenty-one slices touching the Prisma schema, the orchestrator, the dashboard, the `business_*` tools and the mobile read contract. Several slices touch the same PM files and will need rebases as they land. The SLA engine introduces time-zone arithmetic the codebase has not needed before.

**Neutral.** The `support` module adds a `ModuleId` value — a Prisma enum migration plus its mirrored sites, which ADR-044 deliberately avoided for `/business` and which `/support` genuinely needs: it is a whole surface with its own API prefix and tool domain. The mobile PM contract only gains fields.

## Slices

One PR per slice, each against `stage`, each with its own WARP story. Specs and acceptance criteria per slice: [`2026-10-03-work-suite-design.md`](superpowers/specs/2026-10-03-work-suite-design.md).

| # | Slice | Ticket |
|---|---|---|
| WS-0 | This ADR + the slice spec | WARP-3518 |
| WS-1 | Projects reliability: uncapped board/list, names + date-only dates, project archive/restore with owner-only delete and audit, complete module gates, AA contrast | WARP-3371 · WARP-3372 · WARP-3370 · WARP-1625 · WARP-3181 |
| WS-2 | Collaboration: comment edit/delete/@mention/reactions, watchers, activity timeline | WARP-3519 |
| WS-3 | Attachments on work items and comments | WARP-1505 |
| WS-4 | Editing everywhere: inline editors for every work-item property, relations, item archive, project settings (states, labels, fields), custom fields, types, estimates | WARP-3520 |
| WS-5 | Cycles (sprints) and modules (milestones), backlog planning, burndown | WARP-3521 |
| WS-6 | Filter DSL, query API, saved views, deep links | WARP-3522 |
| WS-6b | Table layout, grouping, bulk edit, command palette, shortcuts | WARP-3537 |
| WS-7 | Calendar, timeline (Gantt) and My Work | WARP-3523 |
| WS-8 | Insights: throughput, cycle time, CFD, workload, `unassigned` summary | WARP-3524 |
| WS-9 | Templates, recurring work, automation rules | WARP-3525 |
| WS-10 | Time tracking: worklogs, timers, timesheets | WARP-3526 |
| WS-11 | Import (Jira/Asana/Trello/Linear/generic CSV) and export | WARP-3527 |
| WS-12 | Service desk core: `support` module, `PmTicket`, `/support` queues and ticket workspace | WARP-3528 |
| WS-13 | Email channel: intake, threaded public replies, auto-acknowledge, loop protection | WARP-3529 |
| WS-14 | SLAs, business calendars, escalation, macros, assignment rules | WARP-3530 |
| WS-15 | Support insights, CSAT, assistant tools for tickets | WARP-3531 |
| WS-16 | Webhooks and chat-app notifications behind `work_integrations` | WARP-3532 |
| WS-17 | ICS feed, personal API tokens, OpenAPI | WARP-3533 |
| WS-18 | GitHub / GitLab development panel | WARP-3535 |
| WS-19 | Live updates: boards, lists and drawers refresh when someone else changes work | WARP-3536 |
