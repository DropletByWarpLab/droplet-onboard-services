# ADR-041: Cloud connectors — reading a customer's SaaS system of record without breaking the air-gapped mentality

- **Status:** Accepted (2026-08-19)
- **Epic:** [WARP-2113](https://warp-lab.atlassian.net/browse/WARP-2113) · this ADR is [WARP-2114](https://warp-lab.atlassian.net/browse/WARP-2114)
- **Amends:** [`docs/integrations/README.md`](integrations/README.md) §1 and §2, which define an integration as LAN-only ("No cloud, no vendor SaaS relay, no data egress"). That sentence was written when every provider was a database on the practice's own network. It stays true for those providers; it is no longer true of the whole framework.
- **Answers:** [`docs/integrations/ADD-A-PROVIDER.md`](integrations/ADD-A-PROVIDER.md) §0, which routes a "radically different category (non-database, API-based)" provider to an ADR before any code.
- **Builds on:** `shared_brain/FOUNDATION.md` (the air-gapped-mentality thesis), ADR-009 (no public inbound), ADR-012 (phone-home egress control), WARP-269 / WARP-268 (the default-deny egress registry and its runtime audit).
- **First consumers:** Microsoft 365 / Graph ([WARP-2115](https://warp-lab.atlassian.net/browse/WARP-2115), [WARP-2118](https://warp-lab.atlassian.net/browse/WARP-2118)) and Salesforce ([WARP-2116](https://warp-lab.atlassian.net/browse/WARP-2116)).
- **Amended by:** [ADR-042](ADR-042-customer-supplied-credentials.md), which adds a **third** consent model to §5 — a credential the customer mints in their own vendor account and pastes into the box — and settles which vendors require Warp Lab to register an app. §5's delegated-per-user default is narrowed, not replaced.

## Context

The integrations framework (`services/erp-connector`, epic WARP-1093) was built around one shape of customer system: a database sitting on the same LAN as the box. Eaglesoft over SQL Anywhere, an ODBC ERP, a file export dropped on a share. All three tracks share one property that the docs then generalised into a promise — **nothing leaves the premises**, because there was nowhere for it to go.

The customers we are now selling to keep their business records somewhere else. Their mail, calendar, contacts and documents are in Microsoft 365; their pipeline, if they have one, is in Salesforce. A Droplet that cannot see any of it is a Droplet that cannot answer "what did we agree with this customer last month" — which is most of what a small business wants to ask. Research on 2026-08-19 (WARP-2113) established that both are reachable over official, well-documented APIs, that the box's lack of inbound reachability is not an obstacle for either, and that the client libraries are permissively licensed.

So the framework needs a fourth track. The question this ADR settles is not *whether* to read a cloud system — the product needs it — but **on what terms**, such that the answer is still recognisably Droplet and not a box that quietly became a SaaS client.

The tension is real and worth stating rather than smoothing over. FOUNDATION.md's thesis is *security and an air-gapped mentality first, without needing to be literally air-gapped*. A connector that opens an outbound TLS session to Microsoft and pulls a mailbox down is, unambiguously, data crossing the boundary. Pretending otherwise would be the kind of untruthful doc the team has caught before.

## Decision

**Cloud connectors are a distinct, explicitly-bounded fourth connector class.** They are permitted, on five conditions that are architectural, not aspirational.

### 1. The direction of reachability never changes

A cloud connector **only ever dials out**. It opens no port, registers no webhook, and adds no inbound path of any kind. The box remains unreachable from the internet exactly as ADR-009 requires.

This is not a compromise we negotiated — it is what the APIs force, and we should treat it as a fit rather than a limitation. Microsoft Graph change-notification subscriptions require a publicly reachable HTTPS endpoint; we will never have one, so we poll. Microsoft's own answer for this shape is **delta query**, which exists precisely so a client can ask "what changed since this token" instead of being told. Salesforce's Pub/Sub API is gRPC over HTTP/2 and **pull-based** — the client opens the stream and requests events — so it works from behind the box's NAT with nothing forwarded.

The consequence, recorded here so nobody re-opens it later: **polling is the sync mechanism for every cloud connector, by design.** Latency is bounded by poll interval, not by push. The budgets make this a non-issue at small-business scale — Outlook permits 10,000 requests per 10 minutes per mailbox, so a one-minute poll across ten mail folders consumes about 1% of the allowance.

### 2. Owner consent is the enabling event, and it is per-connection

A cloud connector ships **off**. It carries no default credentials and cannot self-enable. The owner connects it deliberately in the dashboard, per account, and that act *is* the consent record — matching how the cloud-LLM provider path already works, and consistent with the standing principle that owner control runs through the UI rather than through a support engineer over SSH.

Disconnecting must be equally real: it revokes and **purges the stored tokens**, not merely flips a flag. The UI must state plainly, at connect time, what will be read and that it will be copied onto the box — a capability statement, not a policy promise (the framing `docs/integrations/README.md` §10 already uses).

### 3. Every destination is registered, screened and audited — no exceptions

Cloud connectors carry **user content** across the boundary. That is precisely what `docs/security/allowed-egress.yaml` exists to govern: default-deny, one entry per destination, `data_class` declared honestly, security review required on any PR touching the file, and runtime audit under WARP-268.

There is precedent and it is the right precedent: `cloudflare-tunnel-edge` and the cloud-LLM provider path are both already registered as `user-content-on-request` — user-initiated, owner-enabled flows carrying real content. A cloud connector is the same category of thing, and gets the same treatment rather than a new exemption.

Registered by **domain, never by IP** (Salesforce explicitly warns its endpoint addresses change). This ADR registers `graph.microsoft.com` and `login.microsoftonline.com`; each subsequent provider registers its own hosts on its own ticket.

One thing surfaced while registering those, worth knowing before building the connector: **the box already talks to Entra.** `login.microsoftonline.com` is registered under `sso-oidc-idps` (WARP-243) because Droplet already supports Entra ID as an admin-configurable **SSO identity provider** (`docs/ONBOARDING_SSO_OIDC.md`, `apps/orchestrator/src/config.ts`). That is a different call path with a different consent model — signing *into the box* versus authorizing the box to *read an account* — and the two must not be conflated in code or in the UI. The host is therefore registered twice, deliberately and cross-referenced in both entries, so neither is deleted on the assumption the other covers it.

It does, however, mean a customer may already be signing into Droplet with the same Microsoft identity they are about to connect as a data source. WARP-2115 should decide whether the connect flow recognises that and offers a smoother path, rather than presenting two unrelated Microsoft sign-ins.

### 4. Cloud connectors persist; ERP connectors do not — and that difference is the product

The ERP tracks are **read-through**: `erp.service.ts` builds, connects and closes a connector per read, and nothing is stored. That was right for a system of record sitting one switch-port away, where the freshest copy is always the vendor's.

Cloud sync is the opposite by design. **The local copy is the point** — it is what survives the vendor's outage, what the customer still owns after an account lockout, what RAG indexes and the local model can reason over without a round trip. This is the same thesis as [WARP-1234](https://warp-lab.atlassian.net/browse/WARP-1234) ("own a copy of everything the cloud has on you"), and the M365 connector delivers that ticket as a side effect of delivering itself.

Two constraints follow, and both are binding:

- **Synced content is encrypted at rest.** Note the trap here: `schema.prisma` already declares `ErpEntityCache` with a docstring promising that `payload` PHI "is encrypted at rest by the application layer" — and that encryption **is not implemented** (WARP-2028). A cloud connector must not become that model's first writer. Either build the encryption or use a store that already has it; do not inherit an unkept promise.
- **Deletion is a real operation.** Disconnecting an account must offer to purge what was synced from it, and a factory reset must remove it — consistent with how a wipe already rotates identity and invalidates pairings.

### 5. Tokens are credentials to the customer's whole account, and are treated as such

> **Amended by [ADR-042](ADR-042-customer-supplied-credentials.md) (2026-08-27).** This section names two consent models; there are three. Every SaaS vendor in [WARP-2214](https://warp-lab.atlassian.net/browse/WARP-2214) — Stripe, HubSpot, Mailchimp, Shopify, Xero — supports a credential the **customer mints in their own vendor account and pastes into the box**, which is neither delegated-per-user nor an application-wide secret we distribute. ADR-042 authorises that third model, states what the owner pastes per vendor, rules the boundary rejection of full-privilege keys, and settles who registers the vendor app. The delegated-per-user default below still stands wherever the vendor offers no customer-creatable credential.

An OAuth refresh token for Microsoft 365 is, functionally, a long-lived key to the customer's mailbox and files. It is encrypted at rest, never written to `docker/.env` or any tracked file, never logged, purged on disconnect, and purged on factory reset.

Two related choices that this ADR fixes for the first consumer and recommends as the default posture for all of them:

- **Delegated per-user authorization, not application-wide.** Microsoft application permissions grant "read mail in *all* mailboxes in the tenant", and narrowing them requires per-tenant Exchange RBAC PowerShell that Droplet cannot run from the box. Delegated authorization means **the box can never read what the signed-in user cannot** — the access model mirrors the customer's own, which is the honest default for an appliance that claims minimum-necessary access.
- **Connection state is an explicit enum, never inferred from a missing token.** At minimum `disconnected`, `pending_consent`, `connected`, `needs_reconnect`, `error`. This is the repo's standing no-guessing-from-absence rule, and it matters more here than usual: a refresh token silently dies when a tenant admin resets the user's password or revokes the grant, and the failure mode we must avoid is a connector that looks connected and quietly syncs nothing.

### Where the code lives: in-process in the orchestrator

**Cloud connectors are implemented in the orchestrator, not in the `erp-connector` sidecar.**

The sidecar exists for exactly one reason, stated in `docs/integrations/README.md` §2: to isolate a **native driver** so the orchestrator stays language-agnostic. That reason does not apply here. Graph and Salesforce are plain HTTPS and gRPC with mature, permissively-licensed TypeScript clients (`@azure/msal-node`, `@microsoft/microsoft-graph-client`, `jsforce` — all MIT). The framework already contains the precedent: the `eaglesoft-api` REST track **runs in-process for this exact reason**, while only the SQL track needs the sidecar.

Adding a container for a connector that needs no native dependency would buy no isolation and cost a service to build, ship, health-check and debug. `ADD-A-PROVIDER.md` §7 separately warns that introducing a new workspace package is a silent CI-redder across six build paths.

What is reused rather than reinvented: the `IntegrationConnection` record and its lifecycle, the `/integrations` dashboard hub, the provider-selection seam, the audit trail, and the rule that the assistant reaches an integration **only** through named tools in `packages/tools-core` — never by emitting queries. `IntegrationConnection.provider` is free text, so new provider keys need no migration.

## Consequences

**What gets better.** The framework can serve customers whose records live in SaaS, which is most of them. WARP-1234's local-backup pitch becomes implementable. The local model gains the customer's actual working context — mail, calendar, documents — which is what makes an on-premise assistant worth having. And the sync-engine work (delta tokens, backoff, resync recovery) is written once and reused by every subsequent provider: Google Workspace, QuickBooks and Dynamics 365 are all the same shape.

**What gets harder, stated plainly.**

- **The LAN-only guarantee is no longer framework-wide.** It remains absolutely true of every ERP track and must keep being stated there. But "Droplet never talks to the cloud" was never quite true (OTA, telemetry, cloud-LLM opt-in) and is now visibly not true. The honest formulation, which the docs and UI should both use: *nothing leaves the box unless the owner turns on a specific connection, and everything that does is registered, screened and audited.*
- **The box now holds a copy of the customer's mailbox.** That raises the stakes on encryption at rest, on RBAC over the synced data, and on backup/restore. Treat the encryption gap (WARP-2028) as a hard prerequisite, not a follow-up.
- **Tokens are a new class of high-value secret on the box**, with a new revocation path we do not control. Expect `needs_reconnect` to be a routine state, and design the UI for it rather than treating it as an error.
- **Vendor dependency is real.** Both vendors have shipped breaking platform changes recently — Exchange Web Services is being retired (phased disablement from 2026-10-01, fully off 2027-04-01), basic-auth SMTP dies at the end of 2026, and Salesforce blocked uninstalled OAuth clients in September 2025. A connector is a maintained relationship, not a shipped artefact. Pin API versions in config and review them annually.

**What is explicitly not permitted under this ADR.** A cloud connector may not open an inbound path, may not relay traffic for a third party, may not enable itself, may not write to a destination absent from the egress registry, and may not send box-local content **to** the cloud beyond what the owner's chosen action requires (a drafted reply the owner sends is fine; opportunistic upload is not).

## Follow-ups

- Build the at-rest encryption the synced-content store requires — **WARP-2028**; blocking for any persisted cloud sync.
- Register each further provider's hosts on its own ticket: Salesforce (WARP-2116) needs `login.salesforce.com`, the customer's `*.my.salesforce.com` My Domain as a `kind: dynamic` entry, and `api.pubsub.salesforce.com` if the live feed ships.
- Revisit if a future provider genuinely needs a native driver — that provider, not this class, would justify a sidecar.
