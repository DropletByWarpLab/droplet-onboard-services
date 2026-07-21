---
name: add-llm-tool
description: |
  Procedure for adding a new LLM-callable tool to the canonical
  @droplet/tools-core registry. Use when adding, registering, or wiring
  a new agent tool, or when wondering where tool handlers live and how
  RBAC/write-intent tracking picks them up.
---

# Adding a new LLM tool

1. Add a handler under `packages/tools-core/src/handlers/<domain>/`.
2. Register it in `packages/tools-core/src/registry.ts`, setting
   `requiresWrite` and `requiresConfirmation`.
3. Add a unit test.
4. Add a `TOOL_ROUTES` entry (`packages/tools-core/src/tool-routes.ts`):
   if the tool makes an HTTP call, declare its client + every hop and make
   sure the backing route admits the mcp principal
   (`requireRoleOrMcpService`) — a pure-prisma/compute/`ctx.matter` tool is
   `client: "none"` with no hops. The completeness gate
   (`__tests__/tool-routes.test.ts`) fails otherwise, so a tool can't ship
   dead.

The MCP server picks the tool up automatically. The orchestrator's
`WRITE_TOOLS` set in `apps/orchestrator/src/routes/llm.ts` is derived
from `requiresWrite`, so RBAC tracks per-tool intent without manual
sync.
