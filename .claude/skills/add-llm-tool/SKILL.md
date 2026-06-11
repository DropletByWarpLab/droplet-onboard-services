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

The MCP server picks the tool up automatically. The orchestrator's
`WRITE_TOOLS` set in `apps/orchestrator/src/routes/llm.ts` is derived
from `requiresWrite`, so RBAC tracks per-tool intent without manual
sync.
