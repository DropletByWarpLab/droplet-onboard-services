# ADR-043: The outbound MCP client — dialing a server whose tools we did not write

- **Status:** Accepted (2026-08-27)
- **Epic:** [WARP-320](https://warp-lab.atlassian.net/browse/WARP-320) (LLM Agent, MCP & Chat) · this ADR is [WARP-2286](https://warp-lab.atlassian.net/browse/WARP-2286)
- **Amends:** nothing. It **narrows** [`docs/ADR-041-cloud-connector-class.md`](ADR-041-cloud-connector-class.md) by carving the outbound MCP session out of the cloud-connector class rather than letting it inherit rules written for a different shape of thing.
- **Builds on:** ADR-041 §1 (dial-out only) and §3 (every destination registered, screened, audited) — both inherited unchanged. [`docs/ADR-009-canonical-system-architecture.md`](ADR-009-canonical-system-architecture.md) (no public inbound), [`docs/ADR-012-phone-home-egress-control.md`](ADR-012-phone-home-egress-control.md), WARP-269 / WARP-268 (the default-deny egress registry and its runtime audit), WARP-467 (the off-LAN channel vocabulary).
- **First consumers:** the Atlassian remote MCP server and the Slack remote MCP server, both under [WARP-2300](https://warp-lab.atlassian.net/browse/WARP-2300). Slack's provisioning model is decided by [WARP-2373](https://warp-lab.atlassian.net/browse/WARP-2373), not here.

## Context

Droplet is an MCP **server**. That half shipped under [WARP-153](https://warp-lab.atlassian.net/browse/WARP-153): `services/mcp-server` exposes the tool registry to an external client, and an owner can point Claude Desktop or any other MCP host at the box.

It also contains exactly one MCP *client*, and that client is a loopback. `apps/orchestrator/src/services/mcp-client.service.ts:12-13` imports `Client` and `StdioClientTransport` — nothing else — and its own docstring describes what it is: *"Owns one long-lived `Client` connected to a child `mcp-server` process over stdin/stdout."* It is a child-process supervisor. Those two lines are the only `@modelcontextprotocol/sdk/client` imports in product code on `stage`; every other occurrence is a test file. Nothing in this tree has ever opened a session to a server it does not own.

Connecting out to a third-party MCP server — Atlassian's, Slack's, anyone's — makes Droplet an MCP client in the real sense. The question this ADR settles is not *whether* that is allowed; the tools an SMB actually wants live behind exactly these servers. It is **on what terms**, and specifically whether ADR-041's cloud-connector rules already cover it.

They do not, and the reason is worth stating precisely rather than asserted.

ADR-041 governs reading a customer's SaaS system of record over the vendor's own REST API. Three properties make that tractable, and an outbound MCP session has none of them:

1. **A session, not a request.** A cloud connector makes a bounded request and gets a bounded response; a module-level call budget can price it, and a failed call is a failed call. An MCP session is held open, initiated by us, and survives across agent turns. There is no natural unit to meter and no natural point at which "the call finished".
2. **Arbitrary, server-authored tools.** We write every cloud-connector handler and we pin every schema — `read-queries.ts`, `export-drop/profiles.ts`. A remote MCP server delivers its tool surface over the wire. We did not write those handlers, we have not reviewed their semantics, and the surface can change between two `listTools()` calls with no version signal and no vendor contract to point at.
3. **No trustworthy self-description.** This is the one that matters. MCP tool `annotations` — `readOnlyHint`, `destructiveHint` — are advisory by spec and adversarially untrustworthy in practice. They are a claim made by the party whose behaviour they purport to describe.

The tension here is the same one ADR-041 named and refused to smooth over, one turn sharper. ADR-041 admitted that a connector pulling a mailbox down is data crossing the boundary, and bought back safety with the fact that we author both ends of the exchange. Here we author one end. The product contract — *reads run automatically, writes ask for a thumbs-up, destructive actions are blocked* — was written on the assumption that "a tool" is a thing somebody on this team wrote a handler for. A wire-discovered tool breaks that assumption, and §3 below says so in the plainest terms available rather than letting the contract be quietly weakened by a feature that appears to honour it.

## Decision

**The outbound MCP client is a distinct architecture class, separate from ADR-041's cloud connectors.** It is permitted on seven binding conditions.

### 1. Dial-out only, and every host registered before first use

Inherited from ADR-041 §1 and §3 **unchanged**, restated here so no reader has to infer it.

Droplet **only ever dials out** to a remote MCP server. It opens no port, registers no webhook, and adds no inbound path. **No remote MCP server may initiate a connection to the box**, under any transport, for any reason. Streamable HTTP and SSE are both client-initiated and therefore both fit; nothing about this feature requires the box to become reachable, and any design that did would be rejected on ADR-009 grounds before it reached this ADR.

Every remote MCP host is registered in `docs/security/allowed-egress.yaml` before first use, **by domain and never by IP** (ADR-041 §3, which cites Salesforce's own warning that endpoint addresses change). `policy.default: deny` holds. Security review on any PR touching that file — assign Romain — is a standing requirement, not one this ADR relaxes.

ADR-041's three-distinct-failure-states rule carries over unchanged. `services/erp-connector/src/quickbooks/online-connector.ts:58-70` states it for the QuickBooks track: quota-exhausted, reauthorize-required and connector-blocked are different conditions with different remedies, and *"None of the three may ever render as an empty result."* An MCP session adds a fourth — the server is reachable but its tool catalog changed — and it is subject to the same rule. A tool that vanished between two `listTools()` calls must not surface as "there is nothing to do".

### 2. Tool classification is a local, operator-owned policy table — never the wire

**The only authority on whether a remote MCP tool is a read, a write, or blocked is a local classification table this repo owns and an operator maintains.**

The wire's `annotations` — `readOnlyHint`, `destructiveHint` — **MUST NOT be read**, and the reason is not squeamishness. They are advisory by the MCP specification, and they are supplied by the same party that implements the tool. A remote server can declare `deleteIssue` with `readOnlyHint: true`. Under any design that consumes annotations, that declaration is the thing that routes `deleteIssue` onto the automatic-execution path — the server would be choosing its own privilege level, by asserting it.

Nothing in this tree reads those fields today. This condition therefore preserves the status quo rather than reversing a shipped behaviour, and that is the cheapest moment to write it down: the rule costs nothing now and would cost a refactor later.

The default on import is the strict one. **A newly discovered remote tool enters the table as `requiresWrite: true, requiresConfirmation: true`**, regardless of its name, its description, or anything it claims about itself. It is demoted to read-only by **explicit human review** of what the tool actually does — an operator action recorded as such, never a heuristic over the tool name and never a bulk import. A tool absent from the table is not callable.

WARP-2321 builds the table, the deny tier and the per-server allowlisting. This ADR gives it the ruling to build against; it does not specify the implementation.

### 3. Two clauses of the product contract have no runtime implementation a wire-discovered tool could hit

This is the condition that most needs saying out loud, because a reader who knows the product contract will reasonably assume the machinery behind it exists. For a tool that arrives at runtime, it does not — in either half.

**"Writes ask for a thumbs-up" is enforced by nothing generically.** The tree states this about itself, at `packages/tools-core/src/handlers/memory/forget.ts:6-9`:

> *Tier 2 (write + requires confirmation), enforced BY THE HANDLER: neither the MCP server nor the agent loop enforces the `requiresConfirmation` flag generically, so the first call returns `confirmation_required` (no write) with the fact echoed in the message.*

All **37** tools carrying `requiresConfirmation: true` in `packages/tools-core/src/handlers/` hand-roll that two-phase contract inside their own handler body. `requiresConfirmation` is a declaration the handler then honours; it is not a gate anything upstream applies. **A wire-discovered tool has no handler of ours, so there is nothing to hand-roll the contract, and the flag on its table entry would be inert.**

**"Destructive actions are blocked" means absent from `registry.ts`.** It is a compile-time property of a hand-maintained list, policed by `packages/tools-core/__tests__/storage-pool-tools.test.ts:25-53`, which asserts that named destructive storage operations are *not registered* and that no registered pool tool is a write op. That test is a good test. It is also structurally incapable of saying anything about a tool that never appears in `registry.ts` because it arrived over a socket after the build.

Neither gap is created by this ADR — both predate it, and both are load-bearing for the local registry today only because every tool in it was written by someone here. What this feature does is remove the property that made them survivable.

Therefore, **binding**: no remote MCP tool may be invoked in a write or destructive capacity until a **generic interceptor** enforces `requiresConfirmation` outside the handler ([WARP-2305](https://warp-lab.atlassian.net/browse/WARP-2305), under [WARP-2214](https://warp-lab.atlassian.net/browse/WARP-2214)) and a **runtime deny tier** exists that can refuse a tool by policy rather than by absence from a compiled list ([WARP-2321](https://warp-lab.atlassian.net/browse/WARP-2321)). Read-only invocation of tools an operator has explicitly demoted to read status under §2 may ship before those land. Writes may not.

### 4. The owner kill switch is a new `OffLanChannelKey` value and a migration

`OffLanChannelKey` at `apps/orchestrator/prisma/schema.prisma:3319-3329` is a closed enum, and the docstring immediately above it (`:3316-3318`) says why: *"closed set of off-LAN egress channels. Extending the vocabulary is a schema change so the dashboard and the egress metering pipeline (WARP-468 / E2) can't drift apart silently."*

So the owner's switch over outbound MCP is a schema change, not a config flag. This ADR fixes the value as **`remote_mcp`**, added by an `ALTER TYPE … ADD VALUE` migration following the `ambient_data` precedent at `apps/orchestrator/prisma/migrations/20260720000000_warp_1436_offlan_ambient_data/migration.sql` — append-only, wrapped in the `pg_enum` catalog guard that makes it idempotent.

The channel ships **off**. It joins `OFF_LAN_CHANNEL_DEFAULTS` (`apps/orchestrator/src/services/workspace-settings.service.ts:166`) as `{ key: "remote_mcp", enabled: false, requiresAdmin: true }` — the same posture as `web_fetch` and `ambient_data`, and consistent with ADR-041 §2's rule that this class of thing cannot self-enable. The owner-facing surface is the existing off-LAN settings control, `PATCH /api/settings/off-lan/:key` at `apps/orchestrator/src/routes/settings.ts:308-309`, reading and writing the `OffLanAllowlistChannel` row. Adding the value to the enum without adding it to `OFF_LAN_CHANNEL_DEFAULTS` and to the `OFF_LAN_CHANNEL_KEYS` literal in `apps/orchestrator/src/routes/off-lan-network.ts` is exactly the silent drift the closed enum exists to prevent; all three move together.

**What "off" means is specified here, because leaving it unstated produces two implementations.** Flipping the channel off **tears down live sessions** — it does not merely decline to re-establish them. A kill switch that lets an already-open session keep running is not a kill switch, and a persistent transport makes the difference material in a way it never was for the request-shaped `ambient_data` channel. Sessions are closed, in-flight `callTool` requests are abandoned, and the refusal is audited.

The gate fails **closed**, per `off-lan-gate.service.ts`: a missing row, a disabled row, or a DB error all refuse. That service's own docstring records why — its pre-merge shim *"defaulted OPEN, which is exactly the wrong way for a sovereignty gate to fail."* The channel's state is an explicit stored boolean, never inferred from a `NULL` or an absent row.

### 5. The socket lives in a `web-fetch`-shaped component, not in the orchestrator process

**The orchestrator process MUST NOT open a session to a remote MCP server.** A violating implementation would add a remote transport import next to `apps/orchestrator/src/services/mcp-client.service.ts:12-13`; that is the file to look at, and a reviewer who sees `StreamableHTTPClientTransport` or `SSEClientTransport` land in orchestrator product code should treat it as a breach of this ADR.

The shape to follow is `services/web-fetch`, fronted by `apps/orchestrator/src/routes/web.ts:1-26,75-99`. That route's docstring states the posture in order, on every request: **gate → cache → upstream**, with an audit row for each outcome. The gate is fail-closed. The audit is a signed activity row (`kind: "network"`, `sub: "web_egress"`) with `refs.outcome` drawn from a fixed set. `web-fetch` describes itself as *"The ONLY component allowed outbound HTTP"* for its tools. That sentence is the property worth buying.

**This differs from ADR-041's ruling, deliberately, and the difference is the point.** ADR-041 put cloud connectors in-process, and its reasoning was sound *for cloud connectors*: the sidecar exists to isolate a **native driver**, Graph and Salesforce need none, and a container bought no isolation for the cost of a service to build, ship, health-check and debug. That argument turns on isolation buying nothing. Here it buys something ADR-041 never had to price: **the tool surface is untrusted**. A remote MCP server sends us tool definitions, tool results, and error text, all of which flow toward a model that acts on them. The orchestrator is the process with the most reach inside the box — the database, the tool registry, every internal service. Putting an untrusted counterparty's socket in that process is a different proposition from putting a schema we pinned there. One component being the only thing that touches the internet is what makes the egress story auditable at all, and this is the case where it earns its keep.

Two things this condition must not be read as claiming:

- **`services/web-fetch` as it exists today cannot host this.** It is a Python FastAPI service, *"purely request-driven: no schedulers, no caches"*, with *"keyless fixed providers only — every destination is a hardcoded constant in `providers.py`"*. Every one of those properties is wrong for a configurable, session-holding, credential-bearing MCP transport. The ruling is that the session lives in a **dedicated internet-facing component behind the orchestrator's gate → audit route**, following `web-fetch`'s shape. Whether WARP-2300 extends `web-fetch` or stands up a sibling with the same contract is an implementation choice, constrained only by the rule that the orchestrator does not hold the socket. A sibling is the likelier answer, given the SDK is TypeScript.
- **The cache step does not apply to `callTool`.** `routes/web.ts` caches because its providers are idempotent public reads keyed by location or currency. A remote tool invocation is neither idempotent nor safely keyable, and a cached `callTool` result is a correctness bug waiting to be filed. `listTools()` output **may** be cached — that is the same reasoning `mcp-client.service.ts` already applies to the local registry — with an explicit invalidation path, because a stale catalog that silently drops a tool is the §1 fourth-failure-state. The gate and the audit steps apply in full; the cache step applies only to catalog listing.

### 6. A configurable server URL registers as `kind: dynamic` — the sanctioned pattern, not a new exemption

Where the remote MCP server URL is supplied by configuration rather than hardcoded, it registers in `docs/security/allowed-egress.yaml` as **`kind: dynamic` with its `config_key`**. This is the pattern `docs/SECURITY.md:174-184` already sanctions — *"runtime-configured destinations (user mail servers, fleet HQ URL) as `kind: dynamic` with their config key"* — the same treatment ADR-041 gave Salesforce's per-customer My Domain. It is not a loophole being opened for this feature, and a reviewer meeting one of these entries should read it as a registration, not as a waiver.

`data_class` is drawn from the three legal values (`none | operational-telemetry | user-content-on-request`); `user-content-on-request` is the honest one for a session carrying an owner's Jira or Slack content. `ambient-customer-content` is banned by name at `docs/SECURITY.md:176-178` and no MCP entry may use it.

**And `kind: dynamic` documents the destination without constraining it.** That is the sentence to keep. `docs/SECURITY.md:183-185` is explicit that *"the static scan cannot see hostnames assembled at runtime"* — `scripts/check-egress-allowlist.py` scans tracked source for host literals, and a URL built from a config value at runtime is invisible to it. A green `egress-gate` proves only that no unregistered *literal* appears in the tree.

So the **code-side exact-host guard is mandatory**, as defence in depth rather than as belt-and-braces. The shape already exists and is to be reused, not reinvented: `services/erp-connector/src/quickbooks/online-connector.ts:145-147,181-192` — a `QBO_ALLOWED_API_HOSTS` exact-host `Set`, an `assertSafeBaseUrl` that rejects userinfo in the URL, an unregistered hostname, and any port other than 443, and a distinct `UnsafeBaseUrlError` so the refusal is legible. Registration and the guard are two controls with different failure modes; neither substitutes for the other, and the registry entry's `code_refs` must point at the guard that enforces it.

### 7. Access provisioning: two models, and this ADR classifies rather than decides

Every integration has to answer *who requests what* from the vendor. For remote MCP servers there are exactly two answers, and the distinction is architectural input to this ADR rather than a decision it makes.

- **Customer-created credential.** The customer's own admin creates a credential in their own tenant, owns it, and rotates it. Nothing is registered by Warp Lab; no shared identity exists; a revocation affects one customer. **Atlassian is this model** — a customer-created API token, with the customer's org admin separately enabling Rovo MCP on their site. Both actions are the customer's, and the box holds only what that customer issued.
- **Vendor app registered by the operator.** The vendor requires a registered application with a fixed app identity before any MCP session is possible. Someone must publish and own that app; each customer's workspace admin then approves it. The identity is shared across every box that uses it, which makes revocation a fleet-wide event rather than a single-customer one.

**Slack falls in the second model.** This ADR states that classification and stops there. **Whether Warp Lab publishes that app is decided by [WARP-2373](https://warp-lab.atlassian.net/browse/WARP-2373)**, which owns the decision, its consequences and the ownership and rotation runbook. This ADR takes no position on it, and any reader looking for the verdict should follow that link rather than infer one from this paragraph.

That boundary is deliberate and was drawn on WARP-2286 before drafting. Two ADRs independently asserting who provisions a vendor is precisely how ADR-041 ended up double-claimed — [WARP-2114](https://warp-lab.atlassian.net/browse/WARP-2114) Done against [WARP-2105](https://warp-lab.atlassian.net/browse/WARP-2105) To Do, still unresolved. One document owns each ruling.

Whichever model applies, ADR-041 §5 carries over: the credential is a key to the customer's account, encrypted at rest, never written to `docker/.env` or any tracked file, never logged (rule 19 — `apps/orchestrator/src/lib/log-redaction.ts` is the machinery), purged on disconnect and on factory reset. Connection state is an **explicit enum**, never inferred from a missing token.

## Consequences

**What gets better.** The agent reaches the tools an SMB's work actually lives in — issue trackers, team chat — without Warp Lab writing and maintaining a connector per vendor per API change. The remote server is the vendor's maintenance burden, not ours. Getting the transport, the classification table and the session lifecycle right once makes every subsequent MCP server a configuration exercise. And the discipline this ADR imposes on an untrusted tool surface is the discipline the local registry will want anyway the first time a tool is contributed rather than authored.

**What gets harder, stated plainly.**

- **The context window is already over-subscribed, so a remote catalog degrades the agent before it extends it.** This is not a projection. `apps/orchestrator/src/services/chat-tool-scope.ts:1-31` records that the full registry *"serializes to ~85K chars (~21K tokens) of `tools[]` schemas — it no longer fits the shipping single-box context window (`OLLAMA_CONTEXT_LENGTH=16384`, the WARP-854 fix) at all, let alone alongside the fixed system blocks"*. That is the state **before** anything remote arrives; the local `allTools` array on `stage` holds 137 entries and the default chat scope already ships as the registry *minus* an exclusion set. Importing an MCP server's catalog on top of that pushes every turn into `degradeToFit` and past it. **Per-turn tool selection ([WARP-2348](https://warp-lab.atlassian.net/browse/WARP-2348), with [WARP-1423](https://warp-lab.atlassian.net/browse/WARP-1423) as the gap analysis) gates any remote catalog landing in default chat.** A remote server whose tools are advertised unconditionally makes the assistant worse at everything else it does, which is a strictly worse outcome than not shipping it.
- **A persistent session is byte-blind to the runtime egress auditor until it closes.** WARP-268's collector parses `conntrack -E -e NEW,DESTROY` (`services/egress-audit/conntrack_parse.py:1-15`); byte counters ride the DESTROY event. A session held open across many agent turns therefore reports its volume once, at teardown, and a session open for days reports nothing for days. What *is* known at flow start is the destination — the NEW event carries it, so the flow is classified and attributed immediately even though it is not yet metered. Say this out loud in any operator-facing byte chart rather than letting a long-lived session read as an idle one.
- **The tool surface can change under us with no signal.** No version pin exists to hold, because MCP has no versioned tool contract to pin. A tool an operator reviewed and demoted to read-only in the §2 table can have its behaviour changed by the remote party without its name changing. The classification table records a decision about a tool at a moment; it cannot record a guarantee. Periodic re-review is a real operational cost, and WARP-2321 should treat drift detection on the catalog as in-scope rather than as a nicety.
- **A new internet-facing component is a service to build, ship, health-check and debug** — precisely the cost ADR-041 declined to pay. Paid here knowingly, for the isolation §5 describes.

**What is explicitly not permitted under this ADR.**

- Reading `readOnlyHint`, `destructiveHint`, or any other server-supplied annotation as an input to a privilege decision.
- Invoking a remote tool in a write or destructive capacity before WARP-2305's interceptor and WARP-2321's deny tier exist.
- Invoking any remote tool absent from the local classification table.
- Opening a remote MCP session from the orchestrator process.
- Any inbound listener, webhook, or callback URL for this feature.
- Dialing a host absent from `docs/security/allowed-egress.yaml`, or registering one by IP.
- Relying on `egress-gate` alone for a runtime-assembled URL, in place of the code-side exact-host guard.
- Enabling the `remote_mcp` channel by default, or from anywhere other than the owner's off-LAN settings surface.
- Caching `callTool` results.
- Writing a remote server's credential to a tracked file, a log, or an export.
- Ruling here on whether Warp Lab publishes a Slack app — that is WARP-2373's.

## Follow-ups

- **Transport, session lifecycle and the tool multiplexer** — [WARP-2300](https://warp-lab.atlassian.net/browse/WARP-2300). Widens the agent loop's MCP dependency from the one stdio child to an interface, then builds the remote transport, the credential lifecycle and the encrypted token store.
- **Which MCP SDK the client is built on** — [WARP-2423](https://warp-lab.atlassian.net/browse/WARP-2423), recorded in [`docs/mcp-client-sdk-version.md`](mcp-client-sdk-version.md). `^1.30.0`, the pin already on `stage`; there is no v2 to weigh against it. That doc also names the three triggers that would re-open the question, so nobody re-derives it from a version-drift alert.
- **The generic `requiresConfirmation` interceptor** — [WARP-2305](https://warp-lab.atlassian.net/browse/WARP-2305), under [WARP-2214](https://warp-lab.atlassian.net/browse/WARP-2214). Blocking for any remote write, per §3.
- **The classification table, the runtime deny tier and per-server allowlisting** — [WARP-2321](https://warp-lab.atlassian.net/browse/WARP-2321). Blocking for any remote write, per §3.
- **Per-turn tool selection under the 16K budget** — [WARP-2348](https://warp-lab.atlassian.net/browse/WARP-2348). Gates any remote catalog reaching default chat, per Consequences.
- **The Slack app-ownership decision** — [WARP-2373](https://warp-lab.atlassian.net/browse/WARP-2373). When it lands, §7 cites it as settled instead of pending.
- **Register each server's hosts on its own ticket**, with the `kind: dynamic` entry and the exact-host guard landing together, per §6. Security review on each — assign Romain.
- **Credential storage at rest.** ADR-041's warning applies unchanged: `schema.prisma` asserts a `secretRef` secret store and `ErpEntityCache` PHI encryption that do not exist ([WARP-2028](https://warp-lab.atlassian.net/browse/WARP-2028)). An MCP credential store must not become either model's first writer. Build the encryption or use a store that already has it; do not inherit an unkept promise.
