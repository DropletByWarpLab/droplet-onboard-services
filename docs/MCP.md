# Model Context Protocol (MCP)

PR #7 wires the orchestrator into the [Model Context Protocol](https://modelcontextprotocol.io)
ecosystem so:

1. **External MCP clients** (Claude Desktop, Continue, custom agents) can
   connect to the Droplet and use every tool in `TOOL_REGISTRY` —
   network control, file management, smart-home, calendar, cameras, etc.
2. **External MCP servers** can be plugged in via env config; their tools
   are auto-discovered at orchestrator startup and surfaced to the local
   LLM agent loop alongside the built-in tools.

The existing `TOOL_REGISTRY` keeps working unchanged. MCP is additive.

## Architecture

```
┌────────────────────┐                    ┌──────────────────────┐
│  Claude Desktop /  │                    │  Local LLM agent     │
│  any MCP client    │                    │  (/api/llm/agent)    │
└─────────┬──────────┘                    └──────────┬───────────┘
          │ MCP/JSON-RPC                             │
          │ POST /api/mcp/jsonrpc                    │
          ▼                                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                    apps/orchestrator                              │
│                                                                   │
│   ┌────────────────┐         ┌─────────────────────────────┐    │
│   │ mcp-server.ts  │◄───────►│ TOOL_REGISTRY (llm-tools.ts)│    │
│   │ (initialize,   │         │  • built-in tools           │    │
│   │  tools/list,   │         │  • remote tools (prefixed)  │    │
│   │  tools/call)   │         └──────────────▲──────────────┘    │
│   └────────────────┘                        │                    │
│                            registers       │                    │
│   ┌────────────────┐         tools at     ┌─┴────────────────┐   │
│   │ mcp-registry.ts│────── boot ─────────►│ mcp-client.ts    │   │
│   └────────────────┘                       │ (calls remote     │
│                                            │  servers)         │   │
│                                            └─────────┬─────────┘   │
└──────────────────────────────────────────────────────┼─────────────┘
                                                       │ MCP/JSON-RPC
                                                       ▼
                                            ┌─────────────────────┐
                                            │ External MCP server │
                                            │ (web search, GitHub,│
                                            │  vendor-specific)   │
                                            └─────────────────────┘
```

## HTTP surface

| Method | Path | Description |
|---|---|---|
| GET | `/api/mcp/health` | Readiness — protocol version + tool count |
| POST | `/api/mcp/jsonrpc` | JSON-RPC 2.0. Methods: `initialize`, `tools/list`, `tools/call`, `ping` |

Both endpoints sit behind the standard auth middleware (cookie session or
Bearer token). The role gate from `routes/llm.ts` is mirrored — non-owner /
admin callers cannot see or invoke write tools, regardless of which
transport they use.

## Adding an external MCP server

Set in `.env`:

```bash
# Single server
MCP_SERVERS=search=https://search-mcp.example.com/jsonrpc

# Multiple, comma-separated
MCP_SERVERS=search=https://search.example/jsonrpc,gh=https://github-mcp.example/jsonrpc

# With Bearer token (URL fragment)
MCP_SERVERS=premium=https://api.example/mcp/jsonrpc#token=sk_live_abc123
```

Restart the orchestrator. On startup it:

1. Parses `MCP_SERVERS`.
2. Connects to each server, sends `initialize`, then `tools/list`.
3. Registers every discovered tool into `TOOL_REGISTRY` with the prefix
   `<server-name>__<tool-name>`.
4. The local LLM agent loop sees the new tools alongside built-ins.

Failures don't block boot — a server that's down logs a warning, its
tools simply aren't available.

### Naming rules

- Server names: `[a-zA-Z0-9_-]{1,32}`. Used as a tool-name prefix, so it
  has to be a safe identifier.
- Tool names: prefixed automatically. The LLM sees `search__web` rather
  than `web` to make provenance clear.
- Tool descriptions are auto-prefixed `[remote: <server>] ...` so the
  model knows where the tool lives when explaining itself.

## Connecting Claude Desktop to the Droplet

In Claude Desktop's MCP config:

```json
{
  "mcpServers": {
    "droplet": {
      "type": "http",
      "url": "https://your-droplet.local/api/mcp/jsonrpc",
      "headers": {
        "Authorization": "Bearer <your-droplet-bearer-token>"
      }
    }
  }
}
```

Claude Desktop will run `initialize` + `tools/list`, see every tool the
authenticated user is allowed to invoke, and surface them in the UI.

## What's NOT in v1 (deferred)

- **SSE / streaming transport** — the spec defines an SSE variant for
  long-lived connections. We ship HTTP request/response only because
  every MCP client we care about supports it; SSE is a follow-up if a
  long-running tool needs progress updates.
- **Resources** — server-pushed file/data URIs. Would need a parallel
  surface from the file-indexer.
- **Prompts** — named prompt templates. Useful but orthogonal to tool
  calling.
- **Sampling** — server requesting completions FROM the client model.
  Advanced, rarely used.
- **stdio transport** — typical for local-process MCP servers. Our use
  case is an HTTP server-of-servers, so stdio doesn't fit.

## Security notes

- Pre-existing role gate (WRITE_TOOLS in `routes/llm.ts`) is duplicated
  in `routes/mcp.ts` to avoid a circular dep. The two MUST stay in sync;
  there's a future cleanup to extract a shared module.
- External MCP servers run TOOLS WITH THE LOCAL USER'S IDENTITY when the
  LLM invokes them. Treat external server URLs like any other supply-
  chain dependency — only configure servers you trust.
- Server URLs in `MCP_SERVERS` are validated to require `http(s)://` and
  reject `javascript:` / `file:` / `ftp:` schemes.
- Bearer tokens in URL fragments stay on the server side; they're stripped
  before logging and never echoed in tool responses.
