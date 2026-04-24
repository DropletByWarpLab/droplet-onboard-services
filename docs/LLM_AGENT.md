# LLM agent and tool registry

The orchestrator exposes a **tool-aware agent endpoint** the local LLM uses to
read and control the system. This is the execution layer behind "scan for
cameras and add the new one," "block the iPad on the guest VLAN," and similar
conversational workflows.

## Architecture

```
dashboard / curl
       │
       ▼ POST /api/llm/agent  { model, messages, max_iter?, allowed_tools? }
┌──────────────────────────────────────────────────────────────┐
│ apps/orchestrator/src/routes/llm.ts                          │
│   resolveNcToken(req) → ToolContext.ncToken                  │
│   runAgent()                                                  │
│     ┌───────── loop up to max_iter (default 5, hard cap 10) ─┐
│     │                                                         │
│     │  ai-gateway /ai/chat   (execute_tools: false)           │
│     │     ↓                                                   │
│     │  Ollama  qwen2.5:3b-instruct  (tool-calling model)      │
│     │     ↓                                                   │
│     │  tool_calls[] ── dispatchTool() → TOOL_REGISTRY         │
│     │                  ↓                                      │
│     │     direct service-layer call (no HTTP round-trip)      │
│     │        openwrt.client   nextcloud.client                │
│     │        frigate.client   prisma (SQL)                    │
│     │     ↓                                                   │
│     │  tool-role messages appended to history                 │
│     │     ↓                                                   │
│     └── re-prompt until model emits final text ───────────────┘
│                           │
│                           ▼
│   { message, trace[], iterations, stop_reason }              │
└──────────────────────────────────────────────────────────────┘
```

Key decision: the orchestrator owns tool dispatch, not ai-gateway. ai-gateway
has its own in-process ReAct loop that HTTP-calls the orchestrator's REST
endpoints, but that loop can't attach the caller's Nextcloud session cookie,
so file-scoped tools come back `401`. The orchestrator has direct access to
service modules, the Prisma client, and the session token — so it does the
loop, and opts out of ai-gateway's loop with `execute_tools: false`.

## Endpoints

### `GET /api/llm/tools`

Returns the current tool registry with JSON-Schema parameters. Useful for
the dashboard's "capabilities" pane and for debugging schemas.

```json
{ "tools": [ { "name": "list_cameras", "description": "...", "parameters": {…} }, … ] }
```

### `POST /api/llm/agent`

Runs the agent loop with the authenticated user's context.

Request:
```json
{
  "model": "qwen2.5:3b-instruct",
  "messages": [
    { "role": "user", "content": "How many cameras are online?" }
  ],
  "max_iter": 5,                       // optional, default 5, max 10
  "temperature": 0.7,                  // optional
  "allowed_tools": ["list_cameras"]    // optional — narrow the surface
}
```

Response:
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

## Tool registry

Defined in `apps/orchestrator/src/services/llm-tools.ts`. 15 tools today;
every entry wraps a service-layer function (no HTTP round-trip). Adding a
tool is one file.

| Category   | Tool                          | What it does |
|------------|-------------------------------|--------------|
| Network    | `list_network_devices`        | DB-backed inventory: MAC, IP, hostname, vendor, last-seen, blocked state |
| Network    | `list_dhcp_leases`            | Live DHCP table from the OpenWrt router |
| Network    | `get_wifi_info`               | SSID, channel, encryption, associated clients |
| Network    | `block_device`                | Add MAC-filter rule on the router + mark `isBlocked` in DB |
| Network    | `unblock_device`              | Inverse |
| Files      | `list_files`                  | List a Nextcloud folder (auth: caller's NC session) |
| Files      | `search_files`                | Filename substring search across the caller's drive |
| Files      | `list_recent_files`           | 30 most-recently-modified files |
| Cameras    | `list_cameras`                | Configured cameras from Frigate |
| Cameras    | `list_discovered_cameras`     | ONVIF/RTSP-discovered cameras pending acceptance |
| Cameras    | `list_recent_camera_events`   | Frigate events (motion/person/…) |
| Cameras    | `scan_for_cameras`            | Trigger camera-discovery scan on the cameras VLAN |
| Cameras    | `accept_discovered_camera`    | Flip `enabled=true` on a discovered camera in Frigate |
| System     | `get_system_health`           | Rolled-up `/orchestrator/health` aggregate |
| System     | `list_drives`                 | Mounted data drives via the host device-bridge |

### Tool context

Every handler receives a `ToolContext`:

```ts
interface ToolContext {
  prisma:  PrismaClient;
  userId?: string;   // caller's username (from auth cookie)
  ncToken?: string;  // caller's Nextcloud session token
}
```

File tools require `ncToken`; they return `{ error: "auth_required" }` when
it's missing. Network / camera / system tools run without it.

### Adding a tool

1. Open `apps/orchestrator/src/services/llm-tools.ts` and add a `Tool` entry
   to the right section.
2. Write `parameters` as a JSON-Schema object — this is forwarded to the
   model unchanged (OpenAI function-calling shape).
3. Implement `handler(args, ctx)` returning JSON-serialisable data. Keep
   responses compact — every tool result burns context on the next turn.
4. Append the entry to the `TOOL_REGISTRY` array at the bottom.
5. Ship. No model retrain, no separate deployment; ai-gateway picks up the
   new tool on the next `/ai/chat` call.

### What's intentionally NOT in the registry

Destructive operations (delete camera, remove user, reset device, drop
database table). Add these with explicit audit-log and a
`confirmation_required: true` gate; do not extend the registry blindly.

## How ai-gateway's `execute_tools` flag works

`services/ai-gateway/schemas.py` adds an `execute_tools: bool = True` field
on `ChatRequest`. When true (default, preserves existing behaviour), the
gateway runs its own ReAct loop. When false, it forwards `tools[]` to the
model, returns the raw response (tool_calls included), and lets the caller
dispatch.

The orchestrator's agent endpoint sets `execute_tools: false`. Plain
`/api/llm/chat` (the dashboard's streaming chat path) doesn't touch this
field and gets the default behaviour, so existing dashboard chat continues
to work unchanged.

## Testing

Hit it directly from the Jetson (session cookie required for any non-
`/health` orchestrator route):

```bash
cd /home/droplet/Documents/droplet-pi-platform
PW=$(grep '^NEXTCLOUD_ADMIN_PASSWORD=' .env | cut -d= -f2-)

curl -sk -c /tmp/cj.txt -X POST https://127.0.0.1/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" -o /dev/null

curl -sk -b /tmp/cj.txt https://127.0.0.1/api/llm/tools | jq '.tools[].name'

curl -sk -b /tmp/cj.txt -X POST https://127.0.0.1/api/llm/agent \
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
  Orin Nano's 7 GB RAM budget with Frigate + orchestrator + Nextcloud
  running. Tool-calling quality is decent; occasional schema issues on
  nested objects.
- **`qwen2.5:7b-instruct`** (4.7 GB) — better tool-calling reliability but
  OOMs on this hardware once the rest of the stack is up.
- **`llama3.2:3b`** (2.0 GB) — alternative; weaker on tool schemas
  (emits stray fields) but faster on short replies.

Switch models by changing the `model` field in the request — no service
restart needed. The ai-gateway picks up new `ollama pull`s on the next
`/ai/models` refresh.
