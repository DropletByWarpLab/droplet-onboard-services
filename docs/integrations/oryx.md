# Oryx — provider reference (cloud connector, draft)

> **Status: DRAFT — architecture proposal, pre-vendor-engagement.** Oryx
> (oryxdental.com) is a fully cloud dental practice-management system. Unlike
> Eaglesoft ([`eaglesoft.md`](eaglesoft.md)) there is **no LAN database to
> read** — the practice's system of record lives in Oryx's cloud, so this
> provider is a **cloud connector** under
> [ADR-041](../ADR-041-cloud-connector-class.md), not an ERP/LAN track.
>
> Facts below are web-verified 2026-08-23. The build is **gated on vendor
> engagement** (§3) because Oryx publishes no developer documentation.

---

## 1. Connector class and shape

| Question | Answer |
|---|---|
| Class | **Cloud connector** (ADR-041) — outbound HTTPS only, owner-enabled per account, polling sync, synced data persisted on the box. |
| Where the code lives | **In-process in the orchestrator** (ADR-041: the sidecar exists to isolate a native driver; an HTTPS API needs none). Same landing as the M365 connector (WARP-2115). |
| Egress | Oryx API hostname(s) registered in [`allowed-egress.yaml`](../security/allowed-egress.yaml), `data_class: user-content-on-request`, domain not IP. Exact hostnames come out of vendor engagement (§3). |
| Data | **PHI.** Patient/schedule/recall data synced onto the box is protected health information — encrypted at rest (WARP-2028 is a hard prerequisite, per ADR-041 §4), RBAC'd to PHI-viewing roles, purged on disconnect and factory reset. |
| Writes | **Out of scope for v1.** Read-only sync. Any future write goes through the standard outbox → human-confirm pipeline ([`README.md`](README.md) §5) and its own ticket. |

What is reused verbatim from the framework: `IntegrationConnection` (+
explicit-enum status; `provider` is free text so `"oryx"` needs no
migration), the `/integrations` dashboard hub, the audit trail, tools-core
named tools (the assistant never composes API calls), and — once WARP-2115
lands — the encrypted token store and poll/sync engine patterns.

---

## 2. What we know about the Oryx API (verified 2026-08-23)

- **No public developer portal or API documentation exists.** Integration
  is done through Oryx's in-house partner program ("all partners are
  completely integrated within Oryx").
- **API access is an Enterprise-plan feature** (the DSO / multi-location
  tier). The standard **Pro tier (~$650/mo per practice) does not list API
  access**; Enterprise pricing is custom-quoted only.
- **No per-query / metered API pricing is published.** As far as public
  information shows, API usage is bundled into the plan — the marginal cost
  per query is $0, and the real cost lever is the plan tier plus whatever
  the partner agreement says. (Contrast: M365 Graph API costs nothing extra
  on any Business plan — see WARP-2113.)
- Auth model, rate limits, entity coverage, delta/incremental query support,
  and sandbox availability are all **unknown** — nothing is public.

**Consequence:** unlike Eaglesoft (where the database is one switch-port
away and needs no vendor blessing), an Oryx integration **cannot be built
without Oryx's cooperation**. Vendor engagement is Phase 0, and its outcome
shapes everything in §4.

---

## 3. Phase 0 — vendor engagement (the gate)

Questions the partner/sales conversation must answer before build:

1. API surface: REST? entity coverage (patients, appointments, providers,
   recall, production/AR)? incremental "changed since" queries (polling is
   our only sync mechanism — ADR-041 §1)?
2. Auth: OAuth per-practice-user (preferred — delegated access mirrors
   ADR-041 §5) or practice-level API key? Token/key custody terms.
3. Rate limits and any metered cost per call.
4. Commercial terms: does the *practice* need the Enterprise plan, or does a
   partner agreement grant API access on lower tiers? One-time or recurring
   partner fees?
5. **BAA** — who signs what. PHI leaves Oryx's cloud for the customer's box;
   the practice is the covered entity, but Warp needs its exposure reviewed
   (same posture as WARP-1100 for Eaglesoft).
6. Sandbox/demo tenant for development, so no real PHI is touched pre-BAA.

---

## 4. Build plan and effort estimate (assumes a workable REST API)

Estimates are dev-effort for one engineer, on top of the merged integrations
framework and the WARP-2115 auth/token foundation. Unknown-API risk is real:
treat the total as ±50% until Phase 0 answers land.

| Phase | Work | Estimate |
|---|---|---|
| 1. Scaffold | Provider metadata (`connectors.ts` + visual), `IntegrationConnection` wiring for `"oryx"`, egress registry entry, connect/disconnect lifecycle with explicit enum states | 2–3 days |
| 2. Auth | Oryx auth per §3.2, credentials in the encrypted store (never `.env`/logs), `needs_reconnect` as a first-class state | 3–5 days |
| 3. Sync | Poll-based incremental sync (cron-runtime, no `while True`) for v1 entities: patients, appointments, providers, recall due, production summary; persisted encrypted at rest (WARP-2028) | 5–8 days |
| 4. Surface | tools-core read tools + RBAC (PHI-viewing roles) + PHI-free audit scopes + dashboard `/integrations/oryx` detail | 4–6 days |
| | **Total** | **~14–22 days (≈3–4.5 weeks)** |

Out of scope for v1: writes of any kind, embedding/RAG over synced PHI
(needs its own privacy review), multi-location DSO aggregation.

---

## 5. Cost summary (the "what does this cost" answer)

| Cost | What we know |
|---|---|
| Per query | **Nothing published; believed $0 marginal** — API access is plan-bundled, not metered. Confirm in Phase 0. |
| Plan gate | API access = **Enterprise tier, custom quote**. Baseline reference: Pro is ~$650/mo per practice without API access. |
| Partner fees | Unknown — Oryx runs an in-house partner program; terms unpublished. |
| Dev effort | ~3–4.5 engineer-weeks (§4), after Phase 0 unblocks. |
| Legal | BAA + counsel review before any real PHI (§3.5). |

---

## 6. References

- Connector class + terms: [ADR-041](../ADR-041-cloud-connector-class.md)
- Framework: [`README.md`](README.md) · [`ADD-A-PROVIDER.md`](ADD-A-PROVIDER.md)
- Sibling dental provider (LAN class): [`eaglesoft.md`](eaglesoft.md)
- Tickets: **WARP-2144** (Phase 0 — vendor engagement + cost, blocks the
  build) · **WARP-2145** (implementation, v1 read-only)
- Epic (cloud connectors): WARP-2113 · auth foundation: WARP-2115 ·
  encryption-at-rest gate: WARP-2028
- Vendor: oryxdental.com — pricing and partner pages (no developer docs as
  of 2026-08-23)
