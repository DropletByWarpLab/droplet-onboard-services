# Spec — MCP Server (Single Source of Truth for LLM Tools)

**Date:** 2026-04-26
**Status:** Draft for review
**Parent:** `CLAUDE.md` (LLM tooling section), GTM M3.6 (community marketplace), GTM §5 prompt-injection hardening
**Supersedes:** the duplicated tool-calling implementations in `apps/orchestrator/src/services/llm-tools.ts` and `services/ai-gateway/tools/`

---

## 1. Context

The repo has two parallel tool-calling implementations that have drifted apart:

- **`apps/orchestrator/src/services/llm-tools.ts`** (1347 lines, 36 tools, TypeScript) — implements tool handlers directly against Prisma + orchestrator services. **Dead code in production:** `runAgent()` is only called by `POST /api/llm/agent`, which nothing calls (verified — no dashboard, ai-gateway, or test reference).
- **`services/ai-gateway/tools/`** (`definitions.py` 522 lines, `executor.py` 467 lines, 31 handlers, Python) — implements every handler as an HTTP call back to the orchestrator's REST API. **This is the live tool path:** the dashboard calls `POST /api/llm/chat` → orchestrator forwards to ai-gateway → ai-gateway runs its own ReAct loop using `executor.py`.

Outcome: tool definitions, names, and behavior diverge between the two registries, the live path makes a loopback HTTP call back to the orchestrator for every tool, and there is no canonical surface for external clients (inference-engine, Claude Desktop) to discover tools.

This spec consolidates everything onto a single Model Context Protocol (MCP) server, with three consumers, one source of truth, and the dead code removed.

## 2. Goals

- One canonical tool registry. Every tool has exactly one definition and one handler in the codebase.
- Three consumers via MCP: the orchestrator's in-process agent (stdio), the `inference-engine` repo (HTTP), and external MCP-aware clients like Claude Desktop (HTTP).
- The orchestrator owns the live agent loop. The ai-gateway shrinks to its actual job: provider routing (LiteLLM), session storage, BYOK key management, and gRPC.
- Per-tool RBAC carried forward from today's `WRITE_TOOLS` set, applied uniformly across all consumers.
- Tier 2 confirmation flow (WARP-41) preserved unchanged: destructive tools return `{status: "confirmation_required", …}` and the dashboard remains the trust anchor for approval.
- Existing dashboard `/api/llm/chat` UX preserved (streaming, tool-call rendering, model selection).

## 3. Non-goals

- **Replacing the inference-engine's internal tool sandbox.** The inference-engine's OpenClaw guardrails are independent. This spec only makes the inference-engine an MCP *client*.
- **MCP elicitation primitives.** The 202+passthrough confirmation flow stays; we don't adopt MCP `elicitation/create` in v1.
- **Streaming tool results.** Tool calls are atomic per turn. Only assistant content streams.
- **Per-user tool customization / "agent builders".** Out of scope; today's all-users-see-all-tools (modulo role) model is preserved.
- **Native Ollama MCP support.** Ollama doesn't speak MCP. The orchestrator agent loop is the translator between OpenAI tool-calling and MCP `tools/call`.
- **Tool versioning / deprecation policy.** v1 ships one version of each tool; deprecation is a follow-up.

## 4. Scope and ticket decomposition

Five tickets, all on Sprint cadence. Each shippable independently through the agent harness.

```
WARP-100  Foundation (packages/tools-core skeleton + mcp-server skeleton + stdio + 5-tool slice)
   |
WARP-101  Orchestrator agent rewire (live chat path through MCP, SSE streaming)
   |
WARP-102  Bulk port (45 handlers into tools-core, names reconciled, llm-tools.ts deleted)
   |
WARP-103  HTTP transport + JWT auth + per-tool RBAC (inference-engine + Claude Desktop usable)
   |
WARP-104  ai-gateway slim + cleanup (delete tools/, strip router.py, doc + compose updates)
```

| Ticket | Summary | Depends on | Size |
|---|---|---|---|
| **WARP-100** | `packages/tools-core/` workspace + 5-tool vertical slice + `services/mcp-server/` stdio transport | — | M |
| **WARP-101** | Orchestrator agent → MCP stdio client; `/api/llm/chat` runs orchestrator loop; SSE streaming events | WARP-100 | L |
| **WARP-102** | Port all 45 handlers; reconcile names; move tests; delete `llm-tools.ts` | WARP-101 | L |
| **WARP-103** | Streamable-HTTP transport + JWT + per-tool RBAC; mcp-server in `docker-compose.yml` | WARP-102 | M |
| **WARP-104** | Delete ai-gateway tool surface; trim `router.py` / `schemas.py`; remove `/api/llm/agent`; doc updates | WARP-103 | M |

Ticket numbers (WARP-100..104) are placeholders until project lead assigns final IDs.

## 5. Architecture

### 5.1 End-state layout

```
packages/tools-core/                          NEW workspace package
  package.json                                @droplet/tools-core
  src/
    types.ts                                  ToolContext, Tool, ToolHandler, ToolResult, ToolError
    schemas/                                  one .ts module per tool, exporting JSON-Schema literal
    handlers/
      network/
        list-network-devices.ts
        get-network-status.ts
        ...
      files/        smart-home/   cameras/    switch/
      calendar/     reminders/    notifications/  clips/  system/
    registry.ts                               name → {schema, handler, requiresWrite, requiresConfirmation} map
    confirmation.ts                           shared 202-passthrough helper
    index.ts                                  public exports
  __tests__/                                  unit tests per handler

services/mcp-server/                          NEW Node service
  package.json                                @droplet/mcp-server
  Dockerfile
  src/
    server.ts                                 @modelcontextprotocol/sdk Server instance
    transports/
      stdio.ts                                Server.connect(StdioServerTransport)
      http.ts                                 Server.connect(StreamableHTTPServerTransport) on PORT
    auth/
      jwt.ts                                  verifies Bearer JWTs against JWT_SECRET; extracts role
    rbac.ts                                   filters tools/list and tools/call by role + WRITE_TOOLS
    context.ts                                builds ToolContext (Prisma client, http clients, userId, role, ncToken)
    index.ts                                  entrypoint — picks transport from argv/env

apps/orchestrator/
  src/services/llm-agent.service.ts           REFACTORED — spawns mcp-server stdio child; holds MCP client
  src/services/mcp-client.service.ts          NEW — wraps @modelcontextprotocol/sdk Client; tools/list cache
  src/routes/llm.ts                           /api/llm/chat drives orchestrator agent loop with SSE events
                                              /api/llm/tools proxies MCP tools/list
                                              /api/llm/agent REMOVED
  src/services/llm-tools.ts                   DELETED
  src/__tests__/llm-tools-files.test.ts       MOVED to packages/tools-core/__tests__/handlers/files/

services/ai-gateway/
  tools/                                      DELETED (definitions.py, executor.py, __init__.py)
  tests/test_tools.py                         DELETED
  router.py                                   trimmed: tool-loop code gone
  schemas.py                                  trimmed: ToolDefinition, ToolFunction, ToolCall removed
  main.py                                     unchanged
                                              KEPT: chat passthrough, sessions, BYOK keys, gRPC, scheduler

docker/docker-compose.yml                     adds mcp-server service (internal-only by default)
```

### 5.2 Process model

The MCP server can run two ways simultaneously:

- **As a child process of the orchestrator** (stdio transport). The orchestrator's `llm-agent.service.ts` spawns `node services/mcp-server/dist/index.js --transport=stdio` and communicates over stdin/stdout. One child per orchestrator process.
- **As a long-running container** (HTTP transport). `services/mcp-server` becomes a Compose service (`mcp-server`) listening on an internal port. JWT-protected. Reachable from off-host clients only when explicitly exposed.

Both modes share the **same** entrypoint binary and the **same** `packages/tools-core` registry. The transport is selected by `--transport=stdio|http` (default: stdio).

### 5.3 Three-consumer flow

```
                         services/mcp-server/        (one binary, two transports)
                         ───────────────────────
                         tools/list  →  registry from packages/tools-core
                         tools/call  →  handler(args, context)
                                          context = { prisma, httpClients, userId, role, ncToken }

  Consumer                              Transport               Auth                 Notes
  ────────────────────────────────────  ─────────────────────  ──────────────────   ──────────────────────────────
  (1) Orchestrator agent loop           stdio (child process)   none — in-proc      Started by llm-agent.service.ts
      apps/orchestrator/.../llm.ts ───►                                              Translates OpenAI ↔ MCP

  (2) inference-engine (other repo)     streamable HTTP         JWT (Bearer)         Uses orchestrator-issued JWT
                                ───────►                                             obtained via /api/auth/login

  (3) Claude Desktop / dev tools        streamable HTTP         JWT (Bearer)         Same JWT flow as (2)
                                ───────►                                             Per-tool RBAC by role claim
```

### 5.4 ToolContext shape

The handler signature, defined in `packages/tools-core/src/types.ts`:

```ts
export interface ToolContext {
  prisma: PrismaClient;
  http: {
    routing: HttpClient;       // services/routing
    cameras: HttpClient;       // services/camera-discovery
    switchSvc: HttpClient;     // services/switch
    fileIndexer: HttpClient;   // services/file-indexer
    nextcloud: HttpClient;     // for file ops
  };
  matter: MatterController;    // shared singleton; in-process today via apps/orchestrator/src/services/matter.service.ts —
                               // the MCP server hosts an instance per process or talks to the orchestrator via HTTP
                               // (decided at WARP-102 implementation time based on Matter library reentrancy)
  userId?: string;             // from JWT sub claim, or undefined for unauthed stdio
  role?: 'owner' | 'admin' | 'family' | 'guest';
  ncToken?: string;            // Nextcloud session token, for file/share ops
  signal: AbortSignal;         // request cancellation
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;          // JSON-Schema (draft-07)
  requiresWrite: boolean;       // gates RBAC; corresponds to today's WRITE_TOOLS
  requiresConfirmation: boolean;// returns {status: "confirmation_required"} on first call; dashboard handles approval
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string }; status: 'error' | 'confirmation_required' };
```

### 5.5 Registry

`packages/tools-core/src/registry.ts` exports a `Map<string, Tool>` populated at module load time by importing every handler. The MCP server reads this registry once per process.

```ts
export const TOOLS: ReadonlyMap<string, Tool> = new Map([
  [listNetworkDevices.name, listNetworkDevices],
  [getNetworkStatus.name, getNetworkStatus],
  // ...44 more
]);
```

## 6. Tool inventory and naming

### 6.1 Tool inventory by domain

The union of the two existing registries, post name-reconciliation, organized by domain. Approximately 50–60 tools depending on how a handful of near-duplicates resolve at port time. WARP-102 publishes the authoritative inventory at `packages/tools-core/INVENTORY.md`; the names below are the planned set.

| Domain | Names |
|---|---|
| Network | list_network_devices, get_network_status, list_dhcp_leases, get_wifi_settings, scan_wifi_networks, set_wifi_ssid, set_wifi_channel, get_firewall_rules, block_network_device, unblock_network_device, add_port_forward, get_router_system_info |
| Files | list_files, read_file, search_files, search_content, list_recent_files, write_file, delete_file, create_directory, rename_file, move_file, copy_file |
| Smart home (Matter) | list_smart_home_devices, get_smart_home_device, control_device, discover_matter_devices, commission_device, get_command_history |
| Cameras | list_cameras, list_discovered_cameras, list_camera_events, scan_for_cameras, accept_discovered_camera, get_camera_snapshot, list_clips, export_clip, get_camera_live_url, share_clip |
| Switch | get_switch_ports, get_switch_vlans, set_port_vlan, get_switch_poe, set_port_poe, detect_wan_port, setup_camera_ports |
| Calendar / reminders / notifications | create_event, list_events, update_event, delete_event, create_reminder, list_reminders, complete_reminder, send_notification, list_notifications |
| Sync | list_sync_targets, trigger_sync |
| System | get_system_health, list_drives |

WARP-102 must verify each tool's underlying orchestrator endpoint or service path actually exists and is not itself a stub — `list_sync_targets` and `trigger_sync` in particular call `/api/sync/*` paths that may need verification or removal during the port.

### 6.2 Name reconciliation table

When the two registries had different names for the same operation, the canonical winner is below. Choices favor verb-noun consistency and the more explicit name.

| Orchestrator (`llm-tools.ts`) | ai-gateway (`definitions.py`) | Canonical | Reason |
|---|---|---|---|
| `list_network_devices` | `list_devices` / `get_connected_devices` | `list_network_devices` | most explicit; matches scope |
| `block_device` | `block_network_device` | `block_network_device` | matches `unblock_network_device` |
| `unblock_device` | `unblock_network_device` | `unblock_network_device` | symmetric |
| `list_cameras` | `get_cameras` | `list_cameras` | verb-noun |
| `list_recent_camera_events` | `get_camera_events` | `list_camera_events` | drop "recent" — limit param controls it |

All other names are kept as-is (no collision).

### 6.3 RBAC table

The MCP server filters `tools/list` by role. `tools/call` rechecks at dispatch time.

| Role | Read tools | Write tools | Notes |
|---|---|---|---|
| `guest` | yes | no | sees only read tools |
| `family` | yes | no | same as guest in v1 |
| `admin` | yes | yes | sees all tools |
| `owner` | yes | yes | same as admin in v1 |
| no role (stdio, in-proc) | yes | yes | fully trusted; the orchestrator process is the principal |

The set of "write tools" is the `requiresWrite: true` flag on each tool. Initial set: every `set_*`, `block_*`, `unblock_*`, `add_*`, `delete_*`, `write_*`, `move_*`, `copy_*`, `rename_*`, `create_*`, `setup_*`, `control_device`, `commission_device`, `accept_discovered_camera`, `export_clip`, `share_clip`, `trigger_sync`, `complete_reminder`, `update_event`, `delete_event`, `send_notification`. Authoritative list ships with WARP-102.

## 7. MCP protocol surface

The mcp-server implements these standard MCP methods:

| Method | Behavior |
|---|---|
| `initialize` | standard handshake; advertises `tools` capability only (no `resources`, no `prompts`, no `sampling` in v1) |
| `tools/list` | returns the registry filtered by the caller's role |
| `tools/call` | RBAC check → handler dispatch → returns `ToolResult` as MCP content blocks |
| `ping` | health check; standard MCP |
| `notifications/cancelled` | abort in-flight tool calls via `AbortSignal` |

### 7.1 `tools/call` result encoding

`ToolResult.ok = true` → MCP content block: `{type: "text", text: JSON.stringify(data)}`.

`ToolResult.ok = false`, `status = "confirmation_required"` → MCP content block: `{type: "text", text: JSON.stringify({status: "confirmation_required", message, ...})}` plus `isError: false`. The model sees a normal tool result that explicitly says "user must confirm in the dashboard."

`ToolResult.ok = false`, `status = "error"` → MCP content block with `isError: true`, body is `{code, message, details?}`. The optional `details` field carries structured payload from the underlying service (e.g. the routing service's 202 confirmation body) without forcing handlers to stringify it into `message`.

### 7.2 Auth

Streamable-HTTP transport requires `Authorization: Bearer <jwt>`. JWT is verified against `JWT_SECRET` (same secret as the orchestrator). The `role` and `sub` claims populate the `ToolContext`.

stdio transport bypasses auth — the orchestrator process is the trusted principal. The orchestrator sets a sentinel env var (`MCP_TRUSTED=1`) in the spawn so the server knows to skip JWT verification on this transport.

For inference-engine, the orchestrator gains a `/api/auth/service-tokens` endpoint **in a follow-up ticket** (not WARP-103 — out of scope; v1 uses an admin-issued long-lived JWT obtained manually via `/api/auth/login`).

## 8. Orchestrator agent rewire (WARP-101)

### 8.1 New flow

```
Dashboard ──POST /api/llm/chat──► apps/orchestrator/src/routes/llm.ts
                                       │
                                       ▼
                                  agent loop in llm-agent.service.ts:
                                       1. tools = await mcpClient.listTools()  (cached for the process)
                                       2. translate tools → OpenAI format
                                       3. POST ai-gateway /chat with messages + tools[]
                                       4. response.choices[0].message:
                                            - if content (no tool_calls): emit content_delta SSE events; done
                                            - else: for each tool_call:
                                                emit tool_call SSE event
                                                result = await mcpClient.callTool(name, args)
                                                emit tool_result SSE event
                                                append role:"tool" message to history
                                              loop back to step 3
                                       5. emit done SSE event
```

### 8.2 SSE event shape

Server-Sent Events emitted from `/api/llm/chat` when `stream=true`:

```
event: content_delta
data: {"text": "I can help with that."}

event: tool_call
data: {"id": "call_123", "name": "list_network_devices", "args": {}}

event: tool_result
data: {"id": "call_123", "ok": true, "data": {...}}

event: tool_result
data: {"id": "call_456", "ok": false, "status": "confirmation_required", "message": "Open the dashboard to approve"}

event: done
data: {"iterations": 2, "stop_reason": "model_done"}
```

Non-streaming requests get the final assistant message + a flat `trace[]` array, matching today's `runAgent()` `AgentResult` shape — preserves consumers that don't want SSE.

### 8.3 Iteration cap

`DEFAULT_MAX_ITER = 5`, `max_iter` capped at `10` (matches today's `runAgent`).

### 8.4 ai-gateway interaction

The orchestrator agent only calls the ai-gateway's chat completion endpoint (current path lives in `services/ai-gateway/main.py`; preserve whatever URL the orchestrator's existing `ai-gateway.client.ts` already uses). It sends the OpenAI-style tool list and expects an OpenAI-style response. ai-gateway no longer runs its own ReAct loop, no longer dispatches tools — it's a model proxy.

## 9. ai-gateway slimming (WARP-104)

### 9.1 What's deleted

- `services/ai-gateway/tools/__init__.py`
- `services/ai-gateway/tools/definitions.py`
- `services/ai-gateway/tools/executor.py`
- `services/ai-gateway/tests/test_tools.py`
- The `execute_tools` parameter and tool-loop branch in `services/ai-gateway/router.py`
- The `ToolDefinition`, `ToolFunction`, and `ToolCall` Pydantic models in `services/ai-gateway/schemas.py` if no longer referenced (they may be needed for OpenAI-passthrough request validation — confirmed at WARP-104 implementation time)

### 9.2 What's kept

- Provider routing (LiteLLM proxying to Ollama, Anthropic, OpenAI)
- Session storage
- BYOK key management (`services/ai-gateway/auth/`)
- gRPC server (`services/ai-gateway/grpc_server.py`)
- Scheduler (`services/ai-gateway/scheduler.py`)
- Pydantic chat request/response shapes (still need to validate OpenAI tool format coming from the orchestrator)

### 9.3 What changes in `router.py`

The chat route used to:
1. Receive a chat request from the orchestrator with `tools[]`.
2. Route to a provider, get a response.
3. If the response had `tool_calls[]` and `execute_tools=true`, dispatch each via `executor.py`, append results, loop.
4. Return the final response.

After WARP-104, the chat route only:
1. Receives a chat request from the orchestrator with `tools[]`.
2. Routes to a provider, gets a response.
3. Returns the response (with `tool_calls[]` if the model emitted any — orchestrator handles them).

`execute_tools` is removed; the orchestrator always handles tools.

## 10. Cleanup audit

Files removed or moved:

| Path | Action | Ticket |
|---|---|---|
| `apps/orchestrator/src/services/llm-tools.ts` | DELETE (handlers moved to tools-core) | WARP-102 |
| `apps/orchestrator/src/__tests__/llm-tools-files.test.ts` | MOVE to `packages/tools-core/__tests__/handlers/files/` | WARP-102 |
| `apps/orchestrator/src/services/llm-agent.service.ts` | REFACTOR (becomes MCP client wrapper) | WARP-101 |
| `apps/orchestrator/src/routes/llm.ts` (`/api/llm/agent` route) | DELETE | WARP-104 |
| `apps/orchestrator/src/routes/llm.ts` (`/api/llm/chat` route) | REFACTOR (drives orchestrator agent now) | WARP-101 |
| `apps/orchestrator/src/routes/llm.ts` (`/api/llm/tools` route) | REFACTOR (proxies MCP `tools/list`) | WARP-104 |
| `services/ai-gateway/tools/definitions.py` | DELETE | WARP-104 |
| `services/ai-gateway/tools/executor.py` | DELETE | WARP-104 |
| `services/ai-gateway/tools/__init__.py` | DELETE | WARP-104 |
| `services/ai-gateway/tests/test_tools.py` | DELETE | WARP-104 |
| `services/ai-gateway/router.py` | TRIM (remove tool-loop branch) | WARP-104 |
| `services/ai-gateway/schemas.py` | TRIM (remove ToolDefinition/Function/Call if unused) | WARP-104 |
| `apps/web-dashboard/src/lib/hooks/useChat.ts` | SWITCH chat hook from `sendSessionChat()` (→ `/api/llm/sessions/:id/chat`, ai-gateway) to `sendChat()` (→ `/api/llm/chat`, orchestrator agent). Required so the MCP-backed agent loop is reachable from the dashboard UI; the WARP-101 rewire was deliberately back-end-only. May require trimming session UX (history, multi-session) since `/api/llm/chat` is stateless — re-evaluate at WARP-104 implementation time and either preserve session features via a thin orchestrator-side persistence layer or document the UX delta. | WARP-104 |
| `docker/docker-compose.yml` | ADD mcp-server service + ENV wiring | WARP-103 |
| `CLAUDE.md` | UPDATE tooling section | WARP-104 |
| `README.md` | UPDATE architecture diagram | WARP-104 |
| `services/ai-gateway/README.md` | UPDATE (no longer the tool dispatch surface) | WARP-104 |

## 11. Testing strategy

### 11.1 Per-package

| Package | Test framework | New tests |
|---|---|---|
| `packages/tools-core` | vitest | one suite per handler — same coverage as today's `llm-tools-files.test.ts`, extended to all 45 handlers via WARP-102 |
| `services/mcp-server` | vitest | server.ts handshake; rbac.ts filter; auth/jwt.ts verification; transports/stdio.ts roundtrip; transports/http.ts roundtrip |
| `apps/orchestrator` | vitest + supertest | `llm-agent.service.ts` driving the loop; `mcp-client.service.ts` reconnect/cache; `/api/llm/chat` SSE streaming |
| `services/ai-gateway` | pytest | adjusted `test_router.py` reflecting tool-loop removal |

### 11.2 Integration

A new integration test at `tests/mcp.integration.test.ts` boots the full Compose stack and verifies:

1. Dashboard chat invokes `list_network_devices` — confirms in-process stdio path.
2. External MCP client (synthesized in the test) connects to mcp-server over HTTP with a valid JWT, lists tools, calls `list_network_devices`, gets the same data — confirms HTTP path.
3. Same external client with a `family` JWT cannot see or call `block_network_device` — confirms RBAC.
4. `block_network_device` with valid call returns `{status: "confirmation_required"}` — confirms 202-passthrough.

### 11.3 Regression

All vitest, pytest, and supertest suites must remain green at every ticket boundary. No suite is allowed to regress.

## 12. Acceptance criteria — per ticket

### WARP-100 (Foundation)

- [ ] `packages/tools-core/` workspace package created and listed in root `package.json` workspaces.
- [ ] `types.ts` defines `ToolContext`, `Tool`, `ToolHandler`, `ToolResult`, `ToolError`.
- [ ] Five handlers implemented in `packages/tools-core/handlers/`: `list_network_devices`, `get_network_status`, `list_smart_home_devices`, `block_network_device`, `list_files`. Each has a JSON-Schema and a unit test.
- [ ] `services/mcp-server/` workspace package created with `@modelcontextprotocol/sdk` dependency.
- [ ] `services/mcp-server/src/index.ts` selects transport from `--transport=stdio|http` (default stdio).
- [ ] stdio transport works: a test spawns the server as a child process, calls `tools/list` and `tools/call list_network_devices`, gets results.
- [ ] `npm run build` and `npm test` green for both new packages.
- [ ] No production code (orchestrator, ai-gateway, dashboard) is wired to the new server yet.

### WARP-101 (Orchestrator agent rewire)

- [ ] `apps/orchestrator/src/services/mcp-client.service.ts` exists; wraps `@modelcontextprotocol/sdk` `Client`; spawns the mcp-server as a child process; caches `tools/list` for the process lifetime.
- [ ] `llm-agent.service.ts` refactored to use `mcp-client.service.ts` instead of the (now-deleted) `dispatchTool` from `llm-tools.ts`. The dead-code in-process loop becomes the live one.
- [ ] `/api/llm/chat` route now drives the orchestrator agent loop (was: forward to ai-gateway). When `stream=true`, emits the four SSE event types defined in §8.2.
- [ ] `/api/llm/chat` non-streaming response shape matches the legacy ai-gateway response (assistant message + trace) — verified by an integration test.
- [ ] Dashboard chat works for the 5 vertical-slice tools end-to-end. Manual check: ask "what's connected to my network?" — model calls `list_network_devices`, results render.
- [ ] `ai-gateway.client.ts` no longer sends `execute_tools=true`.
- [ ] All existing dashboard chat tests pass.

### WARP-102 (Bulk port)

- [ ] All 45 handlers ported to `packages/tools-core/handlers/`. Domain folders (`network/`, `files/`, etc.) match §6.1.
- [ ] Name reconciliation table (§6.2) applied — `block_device` → `block_network_device`, `list_cameras`, `list_camera_events`, `unblock_network_device`.
- [ ] `requiresWrite` flag set per the RBAC table (§6.3).
- [ ] `requiresConfirmation` flag set on every tool that today returns 202.
- [ ] Each handler has at least one unit test. Existing tests from `llm-tools-files.test.ts` move into `packages/tools-core/__tests__/handlers/files/`.
- [ ] `apps/orchestrator/src/services/llm-tools.ts` is deleted.
- [ ] `apps/orchestrator/src/__tests__/llm-tools-files.test.ts` is moved (not duplicated).
- [ ] `tsc --noEmit` clean across all touched packages.
- [ ] Authoritative tool inventory committed at `packages/tools-core/INVENTORY.md`.

### WARP-103 (HTTP transport + JWT + RBAC)

- [ ] `services/mcp-server/src/transports/http.ts` implements streamable-HTTP transport on a configurable port (`MCP_PORT`, default `9090`).
- [ ] `services/mcp-server/src/auth/jwt.ts` verifies Bearer JWTs against `JWT_SECRET`. Reject missing/invalid/expired with MCP `Unauthorized` error.
- [ ] `services/mcp-server/src/rbac.ts` filters `tools/list` by role using `requiresWrite` per §6.3. Re-checks on `tools/call`.
- [ ] `MCP_TRUSTED=1` env on stdio transport bypasses JWT (in-process orchestrator agent).
- [ ] `docker/docker-compose.yml` adds `mcp-server` service with `JWT_SECRET` env wiring; internal network only by default. Health check.
- [ ] Integration test: external MCP client with admin JWT can list/call all tools; with family JWT, sees and calls only read tools; without JWT, gets `Unauthorized`.
- [ ] `tests/mcp.integration.test.ts` covers the four scenarios in §11.2.

### WARP-104 (ai-gateway slim + cleanup)

- [ ] `services/ai-gateway/tools/` directory deleted.
- [ ] `services/ai-gateway/tests/test_tools.py` deleted.
- [ ] Tool-loop branch removed from `services/ai-gateway/router.py`. `execute_tools` parameter removed.
- [ ] `ToolDefinition`, `ToolFunction`, `ToolCall` Pydantic models removed from `schemas.py` if unused, kept if still required for OpenAI passthrough validation (decide at implementation time, document in PR).
- [ ] `/api/llm/agent` route deleted from `apps/orchestrator/src/routes/llm.ts`. Agent request schema deleted.
- [ ] `/api/llm/tools` route refactored to proxy `mcp-client.service.ts` `listTools()`.
- [ ] `CLAUDE.md` LLM tooling section updated. `README.md` architecture diagram updated. `services/ai-gateway/README.md` updated to reflect "no longer the tool dispatch surface".
- [ ] `apps/web-dashboard/src/lib/hooks/useChat.ts` switched from `sendSessionChat()` to `sendChat()` so the dashboard UI reaches the MCP-backed agent loop. UX delta from losing session-based chat history is either restored via orchestrator-side persistence OR documented in the PR body with sign-off from the project lead.
- [ ] `services/ai-gateway/tests/` pytest suite passes after edits.
- [ ] No references to deleted code remain (verified by `grep -r "executor\.py\|tools\.executor\|TOOL_HANDLERS\|llm-tools" apps services` returning zero hits).

## 13. Open questions for the project lead

1. **Ticket numbering.** WARP-100..104 are placeholders; project lead assigns final IDs at sprint planning.
2. **Service-account token endpoint** (deferred from WARP-103). Is `/api/auth/service-tokens` needed in v1 for inference-engine, or is a manually-issued long-lived JWT acceptable?
3. **mcp-server host port exposure.** Default is internal-only (no host port). If inference-engine runs off-box during development, a host port is needed — set in the same compose change as WARP-103 if so.
4. **Deprecation banner in dashboard chat.** Should there be a one-time toast announcing "Tool calls now go through MCP" when the cut lands? (Probably no — UX is unchanged.)

## 14. Execution model

This work follows the agent harness defined in [`docs/superpowers/agent-harness.md`](../agent-harness.md). Per-ticket gates: Dev → QA → UI/UX (only on WARP-101 and WARP-104) → Manager → PR → CI → Code Reviewer → human merge.

UI/UX gate runs on:
- **WARP-101** — verify SSE tool-call rendering, streaming smoothness, no regression in existing chat UX.
- **WARP-104** — verify dashboard "capabilities" pane (if present, fed by `/api/llm/tools`) still works after the proxy switch.

Other tickets are non-dashboard and skip the UI/UX gate per playbook §1.

WARP-100 also produces a dry-run trace at `docs/superpowers/harness-runs/WARP-100-dry-run.md` if the harness or role prompts have changed since Phase 1; otherwise the dry-run can be skipped per `agent-harness.md` §6.
