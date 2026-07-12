# LLM agent and tool registry

The orchestrator runs a **tool-aware agent loop** the local LLM uses to read
and control the system. This is the execution layer behind "scan for cameras
and add the new one," "block the iPad on the guest VLAN," and similar
conversational workflows.

> **Updated for WARP-100..104.** Tool dispatch lives in
> [`services/mcp-server/`](../services/mcp-server/) with handlers in
> [`packages/tools-core/`](../packages/tools-core/). The orchestrator drives
> the loop over MCP (stdio child process). External MCP clients
> (inference-engine, Claude Desktop, …) reach the same server over
> streamable HTTP with JWT auth and per-tool RBAC. The AI Gateway is a
> pure provider router and does NOT dispatch tools.

## Architecture

```
dashboard / curl
       │
       ▼ POST /api/llm/chat  { model, messages, max_iter?, allowed_tools?, stream? }
┌───────────────────────────────────────────────────────────────────┐
│ apps/orchestrator/src/routes/llm.ts                               │
│   narrowAllowedToolsForRole(role)  → filter writes for non-admin  │
│   runAgent(deps, req)                                             │
│     ┌─── loop up to max_iter (default 5, hard cap 10) ───────────┐│
│     │                                                             ││
│     │  ai-gateway /ai/chat       (provider router only)           ││
│     │      ↓                                                      ││
│     │  Ollama qwen2.5:3b-instruct (or any tool-calling model)     ││
│     │      ↓                                                      ││
│     │  tool_calls[]                                               ││
│     │      ↓                                                      ││
│     │  mcpClient.callTool()  ──── stdio ────▶ services/mcp-server ││
│     │                                          ↓                  ││
│     │                                  packages/tools-core handlers
│     │                                  (Prisma + service modules) ││
│     │      ↓                                                      ││
│     │  tool-role messages appended to history                     ││
│     │      ↓                                                      ││
│     └── re-prompt until model emits final text ──────────────────┘│
│                              │                                    │
│                              ▼                                    │
│   Streaming SSE: content_delta / tool_call / tool_result / done   │
│   Non-streaming: { message, trace[], iterations, stop_reason }    │
└───────────────────────────────────────────────────────────────────┘
```

Key decisions:

- **The orchestrator owns the agent loop.** ai-gateway forwards `tools[]`
  to the model and returns the raw response untouched. Spec §8 / §9.
- **The MCP server owns tool dispatch.** Handlers are pure functions of
  `(args, ToolContext)` and live in `packages/tools-core/`. The same
  registry serves the in-process orchestrator child and external MCP
  clients (HTTP transport with JWT + per-tool RBAC).

## Endpoints

### `GET /api/llm/tools`

Proxies `mcpClient.listTools()` so the wire shape matches the MCP
`tools/list` JSON-RPC response. Useful for the dashboard's "capabilities"
pane and for debugging schemas.

```json
{ "tools": [ { "name": "list_cameras", "description": "...", "parameters": {…} }, … ] }
```

### `POST /api/llm/chat`

Drives the orchestrator agent loop with the authenticated user's context.
When `stream=true`, the response is SSE with the event types defined
in `apps/orchestrator/src/types/sse-events.ts`
(`content_delta`, `tool_call`, `tool_result`, `done`, plus WARP-458's
`reasoning_step` when `captureReasoning=true` and WARP-903's
`model_loading` — emitted first, at most once, when the selected model
is installed in Ollama but needs a cold load). Non-streaming returns
the legacy `AgentResult` shape.

Request:
```json
{
  "model": "qwen2.5:3b-instruct",
  "messages": [
    { "role": "user", "content": "How many cameras are online?" }
  ],
  "stream": false,                      // optional, default false
  "max_iter": 5,                        // optional, default 5, max 10
  "temperature": 0.7,                   // optional
  "allowed_tools": ["list_cameras"]     // optional — narrow the surface
}
```

Non-streaming response:
```json
{
  "message":     { "role": "assistant", "content": "There are 0 cameras configured." },
  "trace":       [ { "tool_call_id": "...", "tool": "list_cameras", "args": {}, "result": [] } ],
  "iterations":  2,
  "stop_reason": "model_done"
}
```

`stop_reason` is one of:
- `model_done` — model emitted a final text answer
- `iteration_limit` — hit `max_iter` without a final answer
- `error` — ai-gateway call failed

RBAC: write tools (anything with `requiresWrite: true` in
`packages/tools-core/`) require an `owner` or `admin` session.
Unprivileged callers get the read-only subset of `tools/list` and any
spoofed `tool_calls` for write tools in replayed history return 403.

## Tool registry

The canonical registry lives in
[`packages/tools-core/src/registry.ts`](../packages/tools-core/src/registry.ts).
See [`packages/tools-core/INVENTORY.md`](../packages/tools-core/INVENTORY.md)
for the authoritative list of tools, domains, and the `requiresWrite` /
`requiresConfirmation` flags. Every handler wraps a service-layer function
(no HTTP round-trip when invoked from the orchestrator's stdio child).

### Tool context

Every handler receives a `ToolContext`:

```ts
interface ToolContext {
  prisma: PrismaClient;
  userId?: string;   // caller's username (from auth cookie)
  ncToken?: string;  // caller's Nextcloud session token
  // …plus injected service handles per spec §5.4.
}
```

File tools require `ncToken`; they return an `auth_required` error when
it's missing. Network / camera / system tools run without it.

### Adding a tool

1. Add a handler under
   `packages/tools-core/src/handlers/<domain>/<name>.ts`, exporting a
   `Tool` with `name`, `description`, JSON-Schema `inputSchema`,
   `requiresWrite`, `requiresConfirmation`, and the `handler(args, ctx)`
   function.
2. Register it in `packages/tools-core/src/registry.ts`.
3. Add a unit test under
   `packages/tools-core/src/__tests__/handlers/<domain>/`.
4. The MCP server picks it up automatically; the orchestrator's
   `WRITE_TOOLS` set is derived from `requiresWrite` so RBAC is
   automatic.

### What's intentionally NOT in the registry

Destructive operations beyond the per-tool `requiresConfirmation` gate
(factory reset, drop database table, raw SQL). Add these only with an
explicit audit-log entry; do not extend the registry blindly.

## Testing

Hit it directly (session cookie required for any non-`/health`
orchestrator route):

```bash
PW=$(grep '^NEXTCLOUD_ADMIN_PASSWORD=' .env | cut -d= -f2-)

curl -sk -c /tmp/cj.txt -X POST https://127.0.0.1/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" -o /dev/null

curl -sk -b /tmp/cj.txt https://127.0.0.1/api/llm/tools | jq '.tools[].name'

curl -sk -b /tmp/cj.txt -X POST https://127.0.0.1/api/llm/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:3b-instruct","messages":[{"role":"user","content":"How many cameras are online?"}]}' \
  | jq '{stop: .stop_reason, trace: [.trace[] | {tool, result}], final: .message.content}'
```

Expected output shape:
```json
{
  "stop": "model_done",
  "trace": [{ "tool": "list_cameras", "result": [] }],
  "final": "There are 0 cameras currently configured in Frigate."
}
```

## Model recommendations

- **`qwen2.5:3b-instruct`** (2.0 GB, Q4_K_M, current default) — fits the
  inference host's 7 GB RAM budget with Frigate + orchestrator + Nextcloud
  running. Tool-calling quality is decent; occasional schema issues on
  nested objects.
- **`qwen2.5:7b-instruct`** (4.7 GB) — better tool-calling reliability but
  OOMs on this hardware once the rest of the stack is up.
- **`llama3.2:3b`** (2.0 GB) — alternative; weaker on tool schemas
  (emits stray fields) but faster on short replies.

Switch models by changing the `model` field in the request — no service
restart needed. The ai-gateway picks up new `ollama pull`s on the next
`/ai/models` refresh.
