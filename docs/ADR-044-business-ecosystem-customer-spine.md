# ADR-044: One business, three systems — the Customer spine

- **Status:** Accepted (2026-08-30)
- **Epic:** [WARP-2557](https://warp-lab.atlassian.net/browse/WARP-2557) · slice 1 is [WARP-2558](https://warp-lab.atlassian.net/browse/WARP-2558)
- **Amends:** nothing. It **supersedes one field decision** made under [WARP-2117](https://warp-lab.atlassian.net/browse/WARP-2117) — the `requires: "projects"` edge on the `crm` module — and states why that edge was correct when written and is wrong now.
- **Builds on:** [`docs/ADR-026-native-pm-supersedes-plane.md`](ADR-026-native-pm-supersedes-plane.md) (the PM surface), [`docs/ADR-032-access-roles-custom-rbac.md`](ADR-032-access-roles-custom-rbac.md) (§3 per-person module effectiveness, §5.4 the connectors axis), [`docs/ADR-041-cloud-connector-class.md`](ADR-041-cloud-connector-class.md) (provenance on synced rows), WARP-1585 (the `requires` edge and its bar), WARP-884 (explicit `isArchived` over an inferred null).

## Context

Three systems on this box describe the same business, and none of them can see the others.

| System | Route | Nav group | Who owns "the customer" |
|---|---|---|---|
| PM (Projects) | `/projects` | Workspace | **nobody — there is no customer field at all** |
| CRM | `/projects`, as sub-tabs | Workspace, borrowed | `CrmCompany` |
| ERP | `/integrations/eaglesoft` | Operations → Integrations | the upstream's own database |

Read at `origin/stage` after the WARP-2117 / WARP-2545 / WARP-2546 stack landed, four facts define the problem:

1. **The CRM had no home of its own.** `module-registry.ts` gave it `navHrefs: []` and `requires: "projects"`. The comment was honest about why — naming `/projects` there would have hidden the PM surface whenever CRM was off — but the consequence was that the CRM's only door was another module's page.

2. **A tab renamed itself.** `app/projects/page.tsx` computed `shellLabel = crmEnabled ? "CRM" : "Projects"` while `nav-config.ts` said `label: "Projects"`. On a CRM-on box the sidebar and the page header disagreed, and that shipped.

3. **Projects was a sibling of itself.** `CrmTabs.TABS = [customers, deals, projects]`, so `/projects` was simultaneously the container and one of the three things in the container. The page then negated six render branches against `onCrmTab`.

4. **ERP ↔ CRM linkage is zero.** `grep -i "contact|crm"` across `services/erp.service.ts` and `services/erp-sync/*` returns only `perPage` substring hits. `ErpEntityCache` is `{connectionId, entity, sourceKey, payload Json}` — an opaque blob with no path to a party. `CrmDeal.projectId → PmProject` exists in the schema, commented *"a won deal becomes the job that delivers it"*, and no UI walks it.

The socket for a join was already cut and left unused: `Contact`, `CrmCompany` and `CrmDeal` each carry `externalSystem` + `externalId` with `@@unique([externalSystem, externalId])`, documented as *"the cross-connector reconcile key"*. The ERP is the one upstream that never writes it.

## Decision

**`Customer` is the spine — not `CRM`, not `Projects`.** A customer is one record with a lifecycle: lead → deal → delivered job → ongoing operational relationship. The three systems stop being three tabs and become three *contributions to one record*. The vertical's own word — patient, client, guest — is a per-connector **label**, never a second entity.

Two moves, independently shippable.

### 1. A `Business` nav group — Customers · Projects · Practice · Planning

A group between Workspace and Operations. Integrations stays in Operations as what it actually is: plumbing. What moves out of it is the **data** surface, never the **connection** surface — connecting a connector *is* infrastructure, and the hub, the credentials page and the connect wizard belong where they are.

Four rules the group holds:

- **A tab never renames itself.** Each entry's `label` is a constant per route. A module turning on may *add* an entry; it may never rebrand one.
- **Every entry survives its neighbours being off.** `visibleItems()` already filters per item and the Sidebar already drops empty groups, so the group renders whatever is left and needs no new mechanism.
- **The CRM's `requires: "projects"` edge is dropped.** WARP-1585 set the bar for that field: *the child has no reachable surface of its own without the parent.* That was true only while the CRM borrowed another module's page. With `/customers` it is false, and the edge forbade the shape most dental boxes actually want — Customers with no PM at all.
- **`MOBILE_PRIMARY_HREFS` stays at four.** Business routes through the More drawer; WARP-290 measured the four-tab cap at 360px and this ADR does not reopen it.

### 2. `PartyLink` — correspondence, not provenance

One additive join table so an ERP record and a CRM party can be *the same customer* without copying the ERP record in. The ERP stays the system of record; the link row is a pointer — a provider key and an opaque id — and detail is fetched live through the existing connector under the existing PHI gate.

**Why not reuse `Contact.externalSystem` / `externalId`.** That pair is `@@unique` on `Contact`, so it can express *provenance* — "this contact came from HubSpot" — and cannot express *correspondence*: this person is a HubSpot contact **and** patient #4471 in Eaglesoft **and** customer `cus_9f2` in Stripe. A customer is routinely all three. Overloading the pair would force a choice of which connector "owns" a customer, which is the wrong question.

`linkedBy` is an explicit `PartyLinkOrigin` enum (`MANUAL | MATCHED | IMPORTED`), never derived from a null — the same rule that made `origin` and `isArchived` real columns under WARP-884. `isArchived` + `archivedAt` follow the shape every other party row already uses.

### 3. PHI: a link is created only by an explicit act

Eaglesoft patients are PHI, gated today in exactly one place — `canViewPhi` plus `DATA_STATUSES` on the ERP surface. The address book has no such gate and `/customers` is reachable by `family`.

**Therefore ERP patients are never projected into `Contact`.** Three reasons, in order of severity:

1. **PHI spill.** A synced patient row in the address book is PHI in a surface with no PHI gate, reachable by `family`, and — through the `contacts` tool domain — readable by the local model.
2. **Volume.** A practice has 10k–40k patients. The address book is not that.
3. **Sync burden.** A one-way projection needs a reconciler, a drift story and an archive story for patients the practice deletes. `ErpDriftRecord` exists for the *schema*, not for parties.

A `PartyLink` row is written only when a human links a customer or accepts a high-confidence match. The customer record's practice block fetches live and renders **nothing** when `!canViewPhi`, identically to `eaglesoft/page.tsx` today. Two enforcement points, both mirroring shipped patterns:

- `GET /api/customers/:id` returns the practice block **only** for a principal that passes the existing ERP access check. The client cannot pre-judge it — `/reports` already documents this posture: the connector grant on top of the role is server-side only, and denial is a 403.
- The `crm` tool domain gets the party spine; it does **not** get the practice block. A tool returning PHI belongs to the ERP domain and its grant, not to the CRM's.

## Rejected

- **One `Business` tab with five sub-tabs.** Recreates the container-is-its-own-child problem one level down, and puts a second tab mechanism inside a page that already has `ViewSwitcher`.
- **A `Customer` model.** `Contact` is already declared *the* contact entity (WARP-2117). A `Customer` beside `Contact` and `CrmCompany` would be the third person-shaped row on one box.
- **Projecting ERP patients into `Contact`.** §3.
- **Reusing `Contact.externalSystem`/`externalId` for the ERP link.** §2.
- **Folding Planning into `/reports`.** Different tense, different audience, different gate. Reports answers *how did it go* and is admin-tier and infrastructure-shaped; Planning answers *what is coming* and is the operator's morning.
- **Moving Integrations out of Operations.** Only the data surface moves.
- **Renaming `/projects`.** The route is live, deep-linked, and named by PM tools. The group moved; the route did not.

## Consequences

**A box may now run the CRM with PM switched off.** That is the point, and it is also the sharpest new state to hold: `GET /api/capabilities` answers `crm: true, projects: false`, and every surface that reads both flags must tolerate it. The capabilities route deliberately does not re-derive any edge of its own — whatever edges exist live in `satisfiedModuleIds`, and a second copy is free to drift from the one the module gate enforces.

**Two mirrors of the dependency had to move together.** The orchestrator's `module-registry.ts` is the authority, and `apps/web-dashboard/src/lib/access.ts` carries a value-identical copy for the access builder's copy strings. Leaving the edge on the dashboard side would have been the worse of the two failures: it would tell a builder to switch on a module the surface does not need, while the server granted the CRM regardless. The `crmNeedsProjects` string is deleted rather than kept — a false dependency sentence is worse than a missing one.

**The nav's `requiresModule` union grows by one id per routed module.** `crm` earns its place there only now that it owns a route; `contacts` still does not, and stays `navHrefs: []` until WARP-2038 builds its surface.

**`PartyLink` is additive and reversible.** No existing column changes meaning, no data moves, and a box that never links anything is unaffected. The migration adds a table and two nullable columns.

**What this ADR does not settle.** Whether `family` sees `/customers` on a dental box — the front desk needs the party list but not the pipeline, which suggests per-section role gating inside the record. And whether `/practice` takes a fixed label or a per-connector `partyNoun`; per-connector is right long-term and is a descriptor field, decided before the ERP surface moves.

## Follow-ups

- WARP-2558 — slice 1: the `Business` group, `/customers`, the dropped edge.
- Slice 2 — promote the ERP data surface to `/practice`; Integrations keeps the hub and credentials.
- Slice 3 — `/business` Planning tiles, each degrading on its own, role-gated rather than module-gated (the `/reports` precedent).
- Slice 4 — `PartyLink`, `PmProject.companyId`, `CrmActivity.partyLinkId`.
- Slices 5–7 — the customer record page, its PHI-gated practice block, and `partyNoun` on the connector descriptor.
- [WARP-2549](https://warp-lab.atlassian.net/browse/WARP-2549) — the connector→CRM landing seam. `PartyLink` is the table its matches land in; the two must be designed against each other, not in sequence.
