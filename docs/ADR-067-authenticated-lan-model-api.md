# ADR-067: Coding tools on the LAN may use the box's model through an authenticated, allowlisted endpoint, and this is consistent with "never exposed"

- **Status:** Proposed, 2026-10-02 ([WARP-3452](https://warp-lab.atlassian.net/browse/WARP-3452)). The product decisions below are Romain's, 2026-10-02, recorded on the ticket.
- **Builds on:** `shared_brain/FOUNDATION.md` (the core principle; sibling repo), [`ADR-036`](ADR-036-inference-runtime-abstraction.md) §6 (the runtime binds loopback and the compose network only), [`ADR-004`](ADR-004-rbac-per-route-guards.md) (roles), WARP-456 (the signed activity log), WARP-2767 (`CalendarFeedToken`, the hashed-credential pattern copied here), WARP-3306 (inference scheduler preemption).
- **Number:** 064 is claimed by the voice-authority draft (WARP-3328), 065 is on `stage`, 066 is claimed by #2572 (WARP-3423). This takes 067. A claimed number reserves nothing, so re-check before merge.

## Context

Employees want their coding tools (GitHub Copilot's Custom Endpoint, the official Ollama VS Code extension, Continue, Cline, OpenCode, Zed and others) to use the company's own box instead of a cloud model, so code and prompts stay in the office.

The obvious way, publishing the runtime's port on the LAN, is ruled out:

- Neither runtime checks credentials. Ollama's local API does not require authentication, and Docker Model Runner (DMR, the default since WARP-1870) ignores the `Authorization` header.
- Their model-management endpoints are where the published vulnerabilities live: CVE-2024-37032 (`/api/pull`), CVE-2025-63389 (no auth on model management), CVE-2026-7482 (`/api/blobs` + `/api/create` + `/api/push`). On DMR, `POST /models/create` makes the box fetch an artifact of the caller's choosing, which ADR-036 calls a hard stop if reachable.
- ADR-036 §6 binds the runtime to loopback and the compose network only. The single-box compose publishes Ollama on `127.0.0.1:11434` and DMR on `127.0.0.1:12434`. That keeps the runtime off the box's host ports, but today the compose network itself is not sealed: on the single-box shape the OpenWrt container routes the guest Wi-Fi zone (and the staff Wi-Fi in routed-AP mode) onto it, so those clients can reach the unauthenticated runtime at its container address ([WARP-3454](https://warp-lab.atlassian.net/browse/WARP-3454), High, open). That is a defect in the network shape, not part of this design.

The Foundation says the local AI "can *see* the network and *manage* the network, but is never *exposed* to it", and that "everything crossing the boundary is screened in both directions … default-deny and audited". It does not say whether "exposed" means the WAN or also the trusted LAN. Serving model tokens to authenticated colleagues on the LAN needs that question decided in writing.

## Decision

### 1. "Never exposed" forbids reachability, not service

We read the principle as: nothing on the network can reach the AI's runtime, its data or its management surface on its own terms. A service that the box offers to its own authenticated users, through a gate the box controls, is not exposure. The dashboard, chat and file access already work this way: the LAN reaches nginx, never a container.

An endpoint for coding tools is consistent with the Foundation when all five of the following hold. Each one is a requirement, not a description, and the `/llm/` endpoint meets all five.

| Foundation property | How `/llm/` meets it |
|---|---|
| **Inbound only from authenticated company users** | Every request carries `Authorization: Bearer dlk_…`, a per-person token. Owner, admin and members may create one; external guests never. Tokens are stored only as sha256, expire 364 days after creation or renewal, and are revoked automatically when the person is deactivated or becomes a guest. ai-gateway checks each request against the orchestrator (`POST /api/llm-access/_introspect`), with no cache, so a revoke takes effect on the next request. No token in the URL. |
| **Screened by an allowlist** | ai-gateway forwards only a fixed list of inference paths (OpenAI chat/completions/models, Ollama version/tags/show/chat/generate, Anthropic messages, and Responses on Ollama boxes). Everything else, including `/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs/*`, DMR `/models/*` and `_configure`, gets a 404 without contacting the runtime. Allowlist, never blocklist. Only the box's active chat model is served, and a request for any other model gets a 404 without triggering a pull or a load. |
| **Default-deny** | A box-wide switch, "Coding tools can use the local model", ships OFF on every box (fresh setup and OTA). Only owner/admin can turn it on. While it is off, introspection refuses every token. A token is required on every request. |
| **Audited** | An ActivityRow on the signed chain for every switch change, every token created, renewed or revoked (with who), every automatic revoke, and refused uses of a revoked or expired token (at most one row per token per hour). Usage is counted per token per day (requests, prompt and completion tokens, errors), never as an ActivityRow per request. No prompt or completion content is stored or logged anywhere. |
| **No WAN, relay or guest network** | Reached through the box's existing HTTPS gateway on the LAN and over WireGuard remote access, the same paths as the dashboard. Refused on the cloudflared relay path and from the guest network. No new egress. |

### 2. The runtime itself stays where ADR-036 put it

Nothing in this ADR changes a bind. The runtime stays on loopback and the compose network, and ai-gateway is the only component meant to talk to it, as it is today for the box's own chat. `/llm/` is a new router in ai-gateway behind a new nginx `location`, not a new listener.

The five properties in §1 describe `/llm/`, and `/llm/` is token-gated on every path, guest Wi-Fi included. They do not describe the raw runtime: until WARP-3454 lands, guest Wi-Fi (and the staff Wi-Fi in routed-AP mode) can route to its compose address directly, management surface included. Closing that path is WARP-3454's job; this ADR neither opens nor closes it.

### 3. The box's own work comes first

External requests run at AUTOMATION priority in ai-gateway's inference scheduler, set server-side and never taken from the client, so the box's own chat preempts them. Each token may have one request in flight and a per-token request rate (`LLM_ACCESS_RPM`, default 60 per minute); over either limit, or when the scheduler queue is full, the answer is 429 with `Retry-After`.

### 4. Where the pieces live

- **Orchestrator:** the `ModelAccessToken` and `ModelAccessTokenUsage` tables, the switch (`ai.llm_access.enabled` WorkspaceSetting, seeded `false`), the routes under `/api/llm-access` (`routes/llm-access.ts`, `services/model-access-token.service.ts`), and the automatic revoke in the shared lifecycle post-effects (`runDisablePostEffects`, `runRoleChangePostEffects` in `role-mutation-guard.service.ts`). The two internal routes admit only the `_service:ai-gateway` principal, pinned by id.
- **ai-gateway and nginx:** the `/llm/` router, the path allowlist and runtime mapping, the per-token limits, the relay refusal.
- **Dashboard:** Settings → Coding tools.

## Alternatives considered

- **Publish the runtime port on the LAN.** Refused for the reasons in Context: no authentication, a management surface with a record of remote-code-execution bugs, and a direct contradiction of ADR-036 §6.
- **nginx `auth_request` to the orchestrator, then forward with the service token.** It works, but it puts the identity in a header nginx sets and ai-gateway trusts. Having ai-gateway introspect the token itself keeps one place that both authenticates the request and applies the per-token limits, and keeps the box-wide service token off this path entirely.
- **Reuse `/ai/` with the box-wide `SERVICE_TOKEN_AI_GATEWAY`.** One shared secret for every laptop: no per-person revocation, no audit of who, and the token would unlock BYOK key and session routes that coding tools have no business reaching.

## Consequences

- The Foundation's "never exposed" is now defined for the LAN: reachability is forbidden, authenticated, allowlisted, default-off, audited service is allowed. A future proposal that serves the LAN without all five properties in §1 does not meet it.
- WARP-2780 (the droplet-local-LLM two-box compose publishing Ollama on `0.0.0.0:11434`) has a replacement: once `/llm/` reaches the inference host through ai-gateway, that publish can be removed.
- `docs/THREAT_MODEL.md` T5.4 and T2.8 are corrected in the same change: the runtime's host ports are loopback-only, but its compose address is reachable from guest Wi-Fi (and the staff Wi-Fi in routed-AP mode) until WARP-3454 lands.
- Copilot code completions never use a bring-your-own model, so this serves chat and agent mode only. The Settings page says so.
- Widening to "all installed models" would let a coding tool evict the box's own chat model on a single GPU. That stays a later, separate decision.

## References

- WARP-3452 (this work), WARP-3454 (guest Wi-Fi routes to compose container addresses), WARP-2780, WARP-3414 (certificate fingerprint for self-signed boxes), WARP-3377 (the unaudited module switches this does not repeat).
- `shared_brain/FOUNDATION.md` § "The core principle".
- `docs/ADR-036-inference-runtime-abstraction.md` §6.
