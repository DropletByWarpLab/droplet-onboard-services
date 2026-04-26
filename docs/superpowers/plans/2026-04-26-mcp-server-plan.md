# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two drifted tool-calling implementations (`apps/orchestrator/src/services/llm-tools.ts` dead code, `services/ai-gateway/tools/` live code) with a single MCP server that is the canonical source of truth for every LLM tool, consumed by the orchestrator's resurrected agent loop (stdio), the inference-engine repo (HTTP+JWT), and external MCP-aware clients like Claude Desktop (HTTP+JWT).

**Architecture:** New `packages/tools-core/` workspace holds every tool's JSON-Schema and TypeScript handler. New `services/mcp-server/` workspace exposes them over MCP via two transports (stdio for in-process consumers, streamable-HTTP for network consumers). The orchestrator's `llm-agent.service.ts` is refactored from dead code into the live agent loop, spawning the MCP server as a stdio child process. ai-gateway is shrunk to provider routing only; its tool surface is deleted.

**Tech Stack:**
- Backend: Node.js 20, TypeScript, vitest, Express (orchestrator), Prisma 5
- MCP: `@modelcontextprotocol/sdk` (official, TypeScript)
- Transport: stdio (local, in-process trust) and streamable HTTP (network, JWT-auth)
- Auth: existing orchestrator JWT (HS256, `JWT_SECRET`); per-tool RBAC via `requiresWrite` flag and role enum
- Build: Turbo 2.0 monorepo, npm@10.9.2 workspaces

**Spec:** [`docs/superpowers/specs/2026-04-26-mcp-server-design.md`](../specs/2026-04-26-mcp-server-design.md) (authoritative — read it before starting any ticket).

**Ticket → branch → PR:** Five Jira tickets WARP-100..WARP-104. Each ships as its own PR through the agent harness (Dev → QA → UI/UX → Manager → PR → CI → Code Reviewer → human merge). UI/UX gate runs on WARP-101 and WARP-104 only.

**Execution order (enforced by spec §4):**

1. WARP-100 (foundation) — `packages/tools-core` + `services/mcp-server` skeleton + 5-tool slice + stdio
2. WARP-101 (orchestrator agent rewire) — `/api/llm/chat` drives orchestrator agent loop
3. WARP-102 (bulk port) — all 50-ish handlers into tools-core, names reconciled, llm-tools.ts deleted
4. WARP-103 (HTTP transport + JWT + RBAC) — inference-engine + Claude Desktop usable
5. WARP-104 (ai-gateway slim + cleanup) — delete ai-gateway/tools/, trim router.py, doc updates

---

## File Structure

### WARP-100 — Foundation

| Path | Purpose |
|---|---|
| `package.json` (modify) | Add `"packages/*"` to `workspaces` |
| `turbo.json` (modify) | No changes; existing tasks cover new packages |
| `packages/tools-core/package.json` (new) | Workspace package `@droplet/tools-core` |
| `packages/tools-core/tsconfig.json` (new) | Extends repo root TS config |
| `packages/tools-core/src/types.ts` (new) | `ToolContext`, `Tool`, `ToolHandler`, `ToolResult`, `ToolError` |
| `packages/tools-core/src/confirmation.ts` (new) | `requireConfirmation()` helper for 202-passthrough |
| `packages/tools-core/src/registry.ts` (new) | `Map<string, Tool>` populated by importing every handler |
| `packages/tools-core/src/handlers/network/list-network-devices.ts` (new) | First handler — Prisma + cache |
| `packages/tools-core/src/handlers/network/get-network-status.ts` (new) | HTTP → routing service |
| `packages/tools-core/src/handlers/smart-home/list-smart-home-devices.ts` (new) | In-process Matter controller via injected service |
| `packages/tools-core/src/handlers/network/block-network-device.ts` (new) | Destructive — `requiresWrite=true`, `requiresConfirmation=true` |
| `packages/tools-core/src/handlers/files/list-files.ts` (new) | HTTP → Nextcloud/file-indexer |
| `packages/tools-core/src/index.ts` (new) | Re-exports `TOOLS`, types |
| `packages/tools-core/__tests__/handlers/network/list-network-devices.test.ts` (new) | Unit test |
| `packages/tools-core/__tests__/handlers/network/get-network-status.test.ts` (new) | Unit test |
| `packages/tools-core/__tests__/handlers/smart-home/list-smart-home-devices.test.ts` (new) | Unit test |
| `packages/tools-core/__tests__/handlers/network/block-network-device.test.ts` (new) | Unit test |
| `packages/tools-core/__tests__/handlers/files/list-files.test.ts` (new) | Unit test |
| `services/mcp-server/package.json` (new) | Workspace package `@droplet/mcp-server`, depends on `@droplet/tools-core` and `@modelcontextprotocol/sdk` |
| `services/mcp-server/tsconfig.json` (new) | Extends repo root TS config |
| `services/mcp-server/Dockerfile` (new) | Multi-stage Node 20 alpine |
| `services/mcp-server/src/server.ts` (new) | Builds MCP `Server` instance, registers tool capabilities |
| `services/mcp-server/src/context.ts` (new) | Builds `ToolContext` (Prisma client, http clients) for a request |
| `services/mcp-server/src/transports/stdio.ts` (new) | `StdioServerTransport` wiring |
| `services/mcp-server/src/index.ts` (new) | Entrypoint — selects transport via `--transport=stdio\|http` |
| `services/mcp-server/__tests__/stdio-roundtrip.test.ts` (new) | Spawns child, exercises tools/list + tools/call |

### WARP-101 — Orchestrator agent rewire

| Path | Purpose |
|---|---|
| `apps/orchestrator/package.json` (modify) | Add `@droplet/tools-core` and `@droplet/mcp-server` workspace deps; add `@modelcontextprotocol/sdk` |
| `apps/orchestrator/src/services/mcp-client.service.ts` (new) | Wraps MCP SDK `Client`, spawns mcp-server stdio child, caches tools/list |
| `apps/orchestrator/src/services/llm-agent.service.ts` (modify, full rewrite) | Live agent loop — uses MCP client, emits SSE event types |
| `apps/orchestrator/src/services/ai-gateway.client.ts` (modify) | Drop `execute_tools` parameter; orchestrator always handles tools now |
| `apps/orchestrator/src/routes/llm.ts` (modify) | `/api/llm/chat` calls orchestrator agent loop; structured SSE events |
| `apps/orchestrator/src/types/sse-events.ts` (new) | Typed SSE event union (`content_delta`, `tool_call`, `tool_result`, `done`) |
| `apps/orchestrator/src/__tests__/mcp-client.service.test.ts` (new) | Unit test — mocked stdio |
| `apps/orchestrator/src/__tests__/llm-agent.service.test.ts` (new) | Unit test — mocked MCP client + ai-gateway |
| `apps/orchestrator/src/__tests__/llm-chat.integration.test.ts` (new) | supertest integration — SSE event sequence |
| `apps/web-dashboard/src/lib/api.ts` (modify, optional) | If SSE event shape changed, update parser; otherwise no change |

### WARP-102 — Bulk port

| Path | Purpose |
|---|---|
| `packages/tools-core/src/handlers/network/*` (new) | Remaining network handlers (~7 more) |
| `packages/tools-core/src/handlers/files/*` (new) | Remaining file handlers (~10 more) |
| `packages/tools-core/src/handlers/smart-home/*` (new) | Remaining Matter handlers (5 more) |
| `packages/tools-core/src/handlers/cameras/*` (new) | All 10 camera handlers |
| `packages/tools-core/src/handlers/switch/*` (new) | All 7 switch handlers |
| `packages/tools-core/src/handlers/calendar/*` (new) | 4 calendar handlers |
| `packages/tools-core/src/handlers/reminders/*` (new) | 3 reminder handlers |
| `packages/tools-core/src/handlers/notifications/*` (new) | 2 notification handlers |
| `packages/tools-core/src/handlers/sync/*` (new) | 2 sync handlers (verify endpoints exist) |
| `packages/tools-core/src/handlers/system/*` (new) | 2 system handlers |
| `packages/tools-core/src/registry.ts` (modify) | Import + register every new handler |
| `packages/tools-core/INVENTORY.md` (new) | Authoritative tool inventory (final names, descriptions, RBAC flags) |
| `packages/tools-core/__tests__/handlers/**/*.test.ts` (new) | One test per handler |
| `apps/orchestrator/src/services/llm-tools.ts` (delete) | Handlers all moved |
| `apps/orchestrator/src/__tests__/llm-tools-files.test.ts` (move) | → `packages/tools-core/__tests__/handlers/files/legacy.test.ts` |

### WARP-103 — HTTP transport + JWT + RBAC

| Path | Purpose |
|---|---|
| `services/mcp-server/src/auth/jwt.ts` (new) | Verifies Bearer JWT; extracts `sub`, `role` |
| `services/mcp-server/src/rbac.ts` (new) | Filters tools/list and tools/call by role + `requiresWrite` |
| `services/mcp-server/src/transports/http.ts` (new) | `StreamableHTTPServerTransport` on `MCP_PORT` |
| `services/mcp-server/src/index.ts` (modify) | Add `--transport=http` branch |
| `services/mcp-server/__tests__/auth.test.ts` (new) | JWT verification |
| `services/mcp-server/__tests__/rbac.test.ts` (new) | Role filter |
| `services/mcp-server/__tests__/http-roundtrip.test.ts` (new) | HTTP transport e2e |
| `tests/mcp.integration.test.ts` (new) | Compose-stack integration: dashboard chat + external HTTP client + RBAC + confirmation |
| `docker/docker-compose.yml` (modify) | Add `mcp-server` service; wire `JWT_SECRET`, `MCP_PORT` |
| `.env.example` (modify) | Document `MCP_PORT`, `MCP_TRUSTED` |

### WARP-104 — ai-gateway slim + cleanup

| Path | Purpose |
|---|---|
| `services/ai-gateway/tools/__init__.py` (delete) | |
| `services/ai-gateway/tools/definitions.py` (delete) | |
| `services/ai-gateway/tools/executor.py` (delete) | |
| `services/ai-gateway/tools/` directory (delete) | |
| `services/ai-gateway/tests/test_tools.py` (delete) | |
| `services/ai-gateway/router.py` (modify) | Strip tool-loop branch + `execute_tools` parameter |
| `services/ai-gateway/schemas.py` (modify) | Remove `ToolDefinition`/`ToolFunction`/`ToolCall` if unused |
| `services/ai-gateway/main.py` (modify, possibly) | Confirm no tool wiring remains |
| `apps/orchestrator/src/routes/llm.ts` (modify) | Delete `POST /api/llm/agent` route + agentRequestSchema; refactor `GET /api/llm/tools` to proxy `mcp-client.service.ts` |
| `CLAUDE.md` (modify) | Update LLM tooling section: MCP server is canonical, ai-gateway is provider routing |
| `README.md` (modify) | Update architecture diagram |
| `services/ai-gateway/README.md` (modify) | Note "no longer the tool dispatch surface" |

---

## Pre-flight: Workspace setup (lands inside WARP-100)

These tasks happen at the start of WARP-100 and create the empty workspaces.

### Task 0.1: Verify branch + clean tree

- [ ] **Step 1: Confirm branch + clean working tree**

```bash
git status
git rev-parse --abbrev-ref HEAD
```

Expected: branch `WARP-100`, no uncommitted changes.

### Task 0.2: Add `packages/*` to root workspaces

- [ ] **Step 1: Read current root `package.json`**

Open `package.json` and find the `"workspaces"` array.

- [ ] **Step 2: Update workspaces**

Change:
```json
"workspaces": [
  "apps/*",
  "services/*"
],
```

To:
```json
"workspaces": [
  "apps/*",
  "services/*",
  "packages/*"
],
```

- [ ] **Step 3: Run `npm install` to register the empty workspaces glob**

```bash
npm install
```

Expected: no new packages installed yet (no packages exist), `package-lock.json` may rewrite.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add packages/* to npm workspaces (WARP-100)"
```

---

## WARP-100 — Foundation

**Branch:** `WARP-100`
**Spec sections:** §5 (architecture), §5.4 (ToolContext), §5.5 (registry), §6 (inventory — slice only), §11.1 (per-package testing), §12 (AC)

### Task 1.1: Create `packages/tools-core/package.json`

**Files:**
- Create: `packages/tools-core/package.json`

- [ ] **Step 1: Write the package manifest**

```json
{
  "name": "@droplet/tools-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/"
  },
  "dependencies": {
    "@prisma/client": "^5.14.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.12.12",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `packages/tools-core/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

- [ ] **Step 3: Create empty src directory + run `npm install` from repo root**

```bash
mkdir -p packages/tools-core/src
mkdir -p packages/tools-core/__tests__
npm install
```

Expected: `node_modules/@droplet/tools-core` symlink created.

- [ ] **Step 4: Commit**

```bash
git add packages/tools-core/package.json packages/tools-core/tsconfig.json package-lock.json
git commit -m "chore: add @droplet/tools-core workspace skeleton (WARP-100)"
```

### Task 1.2: Define core types

**Files:**
- Create: `packages/tools-core/src/types.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/tools-core/__tests__/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Tool, ToolContext, ToolResult } from "../src/types.js";

describe("types", () => {
  it("ToolResult.ok=true wraps data", () => {
    const r: ToolResult = { ok: true, data: { foo: "bar" } };
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ foo: "bar" });
  });

  it("ToolResult.ok=false carries error and status", () => {
    const r: ToolResult = {
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
      status: "error",
    };
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.status).toBe("error");
    }
  });

  it("Tool has the required shape", () => {
    const t: Tool = {
      name: "noop",
      description: "does nothing",
      inputSchema: { type: "object", properties: {} },
      requiresWrite: false,
      requiresConfirmation: false,
      handler: async () => ({ ok: true, data: null }),
    };
    expect(t.name).toBe("noop");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/tools-core && npx vitest run
```

Expected: FAIL with "Cannot find module '../src/types.js'".

- [ ] **Step 3: Write the types**

Create `packages/tools-core/src/types.ts`:

```ts
import type { PrismaClient } from "@prisma/client";

export type Role = "owner" | "admin" | "family" | "guest";

export interface HttpClient {
  get(path: string, opts?: { params?: Record<string, unknown>; headers?: Record<string, string> }): Promise<Response>;
  post(path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<Response>;
  patch(path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<Response>;
  delete(path: string, opts?: { headers?: Record<string, string> }): Promise<Response>;
}

export interface MatterController {
  listDevices(): Promise<unknown>;
  getDevice(nodeId: string): Promise<unknown>;
  sendCommand(nodeId: string, command: string, data?: unknown): Promise<unknown>;
  discover(): Promise<unknown>;
  commission(pairingCode: string): Promise<unknown>;
  getAuditLog(opts: { entityId?: string; limit?: number }): Promise<unknown>;
}

export interface ToolContext {
  prisma: PrismaClient;
  http: {
    routing: HttpClient;
    cameras: HttpClient;
    switchSvc: HttpClient;
    fileIndexer: HttpClient;
    nextcloud: HttpClient;
  };
  matter: MatterController;
  userId?: string;
  role?: Role;
  ncToken?: string;
  signal: AbortSignal;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: ToolError; status: "error" | "confirmation_required" };

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  handler: ToolHandler;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/tools-core && npx vitest run
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/types.ts packages/tools-core/__tests__/types.test.ts
git commit -m "feat(tools-core): define Tool, ToolContext, ToolResult types (WARP-100)"
```

### Task 1.3: Add the confirmation passthrough helper

**Files:**
- Create: `packages/tools-core/src/confirmation.ts`
- Test: `packages/tools-core/__tests__/confirmation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { confirmationRequired, isConfirmationResponse } from "../src/confirmation.js";

describe("confirmation", () => {
  it("confirmationRequired wraps a reason and produces ToolResult", () => {
    const r = confirmationRequired("blocking a device requires user confirmation");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.code).toBe("CONFIRMATION_REQUIRED");
      expect(r.error.message).toContain("user confirmation");
    }
  });

  it("isConfirmationResponse detects a 202 from the orchestrator", () => {
    const fake = new Response(JSON.stringify({ reason: "needs confirm" }), {
      status: 202,
    });
    expect(isConfirmationResponse(fake)).toBe(true);
    const ok = new Response("{}", { status: 200 });
    expect(isConfirmationResponse(ok)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/confirmation.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/tools-core/src/confirmation.ts`:

```ts
import type { ToolResult } from "./types.js";

export function confirmationRequired(message: string, details?: unknown): ToolResult {
  return {
    ok: false,
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REQUIRED",
      message,
      details,
    },
  };
}

export function isConfirmationResponse(res: Response): boolean {
  return res.status === 202;
}

export async function passThroughConfirmation(res: Response): Promise<ToolResult> {
  const body = await res.json().catch(() => ({}));
  const message =
    typeof body === "object" && body && "reason" in body && typeof body.reason === "string"
      ? body.reason
      : "This action requires user confirmation in the Droplet dashboard.";
  return confirmationRequired(message, body);
}
```

- [ ] **Step 4: Run test (expect pass)**

Same vitest command. Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/confirmation.ts packages/tools-core/__tests__/confirmation.test.ts
git commit -m "feat(tools-core): add 202-passthrough confirmation helpers (WARP-100)"
```

### Task 1.4: Implement `list_network_devices` handler (slice tool 1)

**Files:**
- Create: `packages/tools-core/src/handlers/network/list-network-devices.ts`
- Test: `packages/tools-core/__tests__/handlers/network/list-network-devices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import listNetworkDevices from "../../../src/handlers/network/list-network-devices.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    prisma: {
      networkDevice: {
        findMany: vi.fn().mockResolvedValue([
          { mac: "AA:BB:CC:DD:EE:FF", displayName: "Living Room TV", isBlocked: false },
        ]),
      },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("list_network_devices", () => {
  it("returns ok with the device list", async () => {
    const ctx = ctxWith();
    const r = await listNetworkDevices.handler({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({
        devices: [
          { mac: "AA:BB:CC:DD:EE:FF", displayName: "Living Room TV", isBlocked: false },
        ],
      });
    }
  });

  it("metadata exposes name and write/confirmation flags", () => {
    expect(listNetworkDevices.name).toBe("list_network_devices");
    expect(listNetworkDevices.requiresWrite).toBe(false);
    expect(listNetworkDevices.requiresConfirmation).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/handlers/network/list-network-devices.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `packages/tools-core/src/handlers/network/list-network-devices.ts`:

```ts
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = await ctx.prisma.networkDevice.findMany({
    select: {
      mac: true,
      displayName: true,
      isBlocked: true,
      vendor: true,
      hostname: true,
      lastIp: true,
      firstSeen: true,
      lastSeen: true,
    },
    orderBy: { lastSeen: "desc" },
  });
  return { ok: true, data: { devices } };
}

const tool: Tool = {
  name: "list_network_devices",
  description:
    "List every network device the registry knows about, ordered by most-recently-seen. Returns MAC, display name, blocked flag, vendor, hostname, last IP, first/last seen timestamps.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
```

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/handlers/network/list-network-devices.ts packages/tools-core/__tests__/handlers/network/list-network-devices.test.ts
git commit -m "feat(tools-core): list_network_devices handler (WARP-100)"
```

### Task 1.5: Implement `get_network_status` handler (slice tool 2 — HTTP)

**Files:**
- Create: `packages/tools-core/src/handlers/network/get-network-status.ts`
- Test: `packages/tools-core/__tests__/handlers/network/get-network-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import getNetworkStatus from "../../../src/handlers/network/get-network-status.js";
import type { ToolContext } from "../../../src/types.js";

describe("get_network_status", () => {
  it("calls routing service /status and returns body", async () => {
    const fakeBody = { wan: { up: true, ip: "1.2.3.4" }, lan: { clients: 7 } };
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fakeBody), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const ctx: ToolContext = {
      http: {
        routing: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
        cameras: {} as ToolContext["http"]["cameras"],
        switchSvc: {} as ToolContext["http"]["switchSvc"],
        fileIndexer: {} as ToolContext["http"]["fileIndexer"],
        nextcloud: {} as ToolContext["http"]["nextcloud"],
      },
      prisma: {} as ToolContext["prisma"],
      matter: {} as ToolContext["matter"],
      signal: new AbortController().signal,
    };
    const r = await getNetworkStatus.handler({}, ctx);
    expect(get).toHaveBeenCalledWith("/status", expect.anything());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(fakeBody);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/handlers/network/get-network-status.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `packages/tools-core/src/handlers/network/get-network-status.ts`:

```ts
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const res = await ctx.http.routing.get("/status", { headers: { Accept: "application/json" } });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "ROUTING_UNAVAILABLE",
        message: `routing service returned ${res.status}`,
      },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "get_network_status",
  description:
    "Get current network status: WAN/LAN interface state, WiFi state, connected device count, router system info. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
```

- [ ] **Step 4: Run test (expect pass)**

Same vitest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/handlers/network/get-network-status.ts packages/tools-core/__tests__/handlers/network/get-network-status.test.ts
git commit -m "feat(tools-core): get_network_status handler (WARP-100)"
```

### Task 1.6: Implement `list_smart_home_devices` (slice tool 3 — Matter via injected service)

**Files:**
- Create: `packages/tools-core/src/handlers/smart-home/list-smart-home-devices.ts`
- Test: `packages/tools-core/__tests__/handlers/smart-home/list-smart-home-devices.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import listSmartHomeDevices from "../../../src/handlers/smart-home/list-smart-home-devices.js";
import type { ToolContext } from "../../../src/types.js";

describe("list_smart_home_devices", () => {
  it("delegates to ctx.matter.listDevices()", async () => {
    const fake = { lights: [{ nodeId: "1", name: "Living Room" }], switches: [] };
    const matter = {
      listDevices: vi.fn().mockResolvedValue(fake),
      getDevice: vi.fn(),
      sendCommand: vi.fn(),
      discover: vi.fn(),
      commission: vi.fn(),
      getAuditLog: vi.fn(),
    };
    const ctx: ToolContext = {
      matter,
      prisma: {} as ToolContext["prisma"],
      http: {} as ToolContext["http"],
      signal: new AbortController().signal,
    };
    const r = await listSmartHomeDevices.handler({}, ctx);
    expect(matter.listDevices).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(fake);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/handlers/smart-home/list-smart-home-devices.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = { type: "object", properties: {}, additionalProperties: false } as const;

async function handler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const devices = await ctx.matter.listDevices();
  return { ok: true, data: devices };
}

const tool: Tool = {
  name: "list_smart_home_devices",
  description:
    "List all smart home devices connected via Matter, grouped by category (lights, switches, sensors, climate, media, covers, locks, other). Includes state, connection status, and attributes.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
```

- [ ] **Step 4: Run test (expect pass)**

Same vitest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/handlers/smart-home/list-smart-home-devices.ts packages/tools-core/__tests__/handlers/smart-home/list-smart-home-devices.test.ts
git commit -m "feat(tools-core): list_smart_home_devices handler (WARP-100)"
```

### Task 1.7: Implement `block_network_device` (slice tool 4 — destructive + confirmation)

**Files:**
- Create: `packages/tools-core/src/handlers/network/block-network-device.ts`
- Test: `packages/tools-core/__tests__/handlers/network/block-network-device.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import blockNetworkDevice from "../../../src/handlers/network/block-network-device.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPost(post: ReturnType<typeof vi.fn>): ToolContext {
  return {
    http: {
      routing: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("block_network_device", () => {
  it("metadata flags are set for write+confirmation", () => {
    expect(blockNetworkDevice.requiresWrite).toBe(true);
    expect(blockNetworkDevice.requiresConfirmation).toBe(true);
  });

  it("returns confirmation_required when orchestrator returns 202", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "block requires confirmation" }), { status: 202 }),
    );
    const r = await blockNetworkDevice.handler({ mac: "AA:BB:CC:DD:EE:FF" }, ctxWithPost(post));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("confirmation_required");
      expect(r.error.message).toContain("confirmation");
    }
    expect(post).toHaveBeenCalledWith("/firewall/block", { mac: "AA:BB:CC:DD:EE:FF" });
  });

  it("returns ok when orchestrator returns 200", async () => {
    const post = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "blocked" }), { status: 200 }),
    );
    const r = await blockNetworkDevice.handler({ mac: "AA:BB:CC:DD:EE:FF" }, ctxWithPost(post));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ status: "blocked" });
  });

  it("rejects missing mac", async () => {
    const r = await blockNetworkDevice.handler({}, ctxWithPost(vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/handlers/network/block-network-device.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { isConfirmationResponse, passThroughConfirmation } from "../../confirmation.js";

const inputSchema = {
  type: "object",
  properties: {
    mac: {
      type: "string",
      description: "MAC address of the device to block (format: AA:BB:CC:DD:EE:FF).",
    },
    name: {
      type: "string",
      description: "Optional friendly name for the block rule.",
    },
  },
  required: ["mac"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const mac = typeof args.mac === "string" ? args.mac : null;
  if (!mac) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "mac is required" },
    };
  }
  const body: Record<string, string> = { mac };
  if (typeof args.name === "string") body.name = args.name;

  const res = await ctx.http.routing.post("/firewall/block", body);
  if (isConfirmationResponse(res)) return passThroughConfirmation(res);
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "BLOCK_FAILED", message: `routing returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "block_network_device",
  description:
    "Block a device from accessing the internet by its MAC address. Destructive: requires user confirmation in the Droplet dashboard.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
```

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/handlers/network/block-network-device.ts packages/tools-core/__tests__/handlers/network/block-network-device.test.ts
git commit -m "feat(tools-core): block_network_device handler with 202-passthrough (WARP-100)"
```

### Task 1.8: Implement `list_files` (slice tool 5 — HTTP via nextcloud client)

**Files:**
- Create: `packages/tools-core/src/handlers/files/list-files.ts`
- Test: `packages/tools-core/__tests__/handlers/files/list-files.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import listFiles from "../../../src/handlers/files/list-files.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(get: ReturnType<typeof vi.fn>, ncToken?: string): ToolContext {
  return {
    http: {
      nextcloud: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    ncToken,
    signal: new AbortController().signal,
  };
}

describe("list_files", () => {
  it("defaults path to /, includes ncToken header", async () => {
    const get = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ entries: [{ name: "a.txt" }] }), { status: 200 }),
    );
    const ctx = ctxWith(get, "ncT-abc");
    const r = await listFiles.handler({}, ctx);
    expect(get).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Nextcloud-Token": "ncT-abc" }),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("forwards a non-default path", async () => {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await listFiles.handler({ path: "/photos" }, ctxWith(get));
    expect(get).toHaveBeenCalledWith("/photos", expect.anything());
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/handlers/files/list-files.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory path to list. Defaults to '/'." },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const path = typeof args.path === "string" && args.path.length > 0 ? args.path : "/";
  const headers: Record<string, string> = {};
  if (ctx.ncToken) headers["X-Nextcloud-Token"] = ctx.ncToken;
  const res = await ctx.http.nextcloud.get(path, { headers });
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "LIST_FAILED", message: `nextcloud returned ${res.status}` },
    };
  }
  const data = await res.json();
  return { ok: true, data };
}

const tool: Tool = {
  name: "list_files",
  description:
    "List files and directories at a path on the Droplet device's Nextcloud storage. Defaults to '/'.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
```

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/handlers/files/list-files.ts packages/tools-core/__tests__/handlers/files/list-files.test.ts
git commit -m "feat(tools-core): list_files handler (WARP-100)"
```

### Task 1.9: Wire registry + index

**Files:**
- Create: `packages/tools-core/src/registry.ts`
- Create: `packages/tools-core/src/index.ts`
- Test: `packages/tools-core/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/index.js";

describe("TOOLS registry", () => {
  it("exposes the 5 vertical-slice tools by name", () => {
    expect(Array.from(TOOLS.keys()).sort()).toEqual([
      "block_network_device",
      "get_network_status",
      "list_files",
      "list_network_devices",
      "list_smart_home_devices",
    ]);
  });

  it("flags write+confirmation correctly per tool", () => {
    expect(TOOLS.get("block_network_device")?.requiresWrite).toBe(true);
    expect(TOOLS.get("block_network_device")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("list_files")?.requiresWrite).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd packages/tools-core && npx vitest run __tests__/registry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement registry**

Create `packages/tools-core/src/registry.ts`:

```ts
import type { Tool } from "./types.js";
import listNetworkDevices from "./handlers/network/list-network-devices.js";
import getNetworkStatus from "./handlers/network/get-network-status.js";
import blockNetworkDevice from "./handlers/network/block-network-device.js";
import listSmartHomeDevices from "./handlers/smart-home/list-smart-home-devices.js";
import listFiles from "./handlers/files/list-files.js";

const allTools: Tool[] = [
  listNetworkDevices,
  getNetworkStatus,
  blockNetworkDevice,
  listSmartHomeDevices,
  listFiles,
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(allTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS.get(name);
}
```

Create `packages/tools-core/src/index.ts`:

```ts
export type { Tool, ToolContext, ToolHandler, ToolResult, ToolError, Role, HttpClient, MatterController } from "./types.js";
export { TOOLS, getTool } from "./registry.js";
export { confirmationRequired, isConfirmationResponse, passThroughConfirmation } from "./confirmation.js";
```

- [ ] **Step 4: Run test (expect pass)**

```bash
cd packages/tools-core && npx vitest run
```

Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/registry.ts packages/tools-core/src/index.ts packages/tools-core/__tests__/registry.test.ts
git commit -m "feat(tools-core): registry + public exports for slice (WARP-100)"
```

### Task 1.10: Build tools-core

- [ ] **Step 1: Run TypeScript compile**

```bash
cd packages/tools-core && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Run full test suite + build**

```bash
cd packages/tools-core && npm run build && npm test
```

Expected: clean dist/, all tests pass.

- [ ] **Step 3: Commit `dist/.gitignore` if needed**

If `dist/` showed up in git status, ignore it:

```bash
echo "dist/" > packages/tools-core/.gitignore
git add packages/tools-core/.gitignore
git commit -m "chore(tools-core): ignore dist (WARP-100)"
```

### Task 1.11: Create `services/mcp-server/package.json`

**Files:**
- Create: `services/mcp-server/package.json`
- Create: `services/mcp-server/tsconfig.json`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@droplet/mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "droplet-mcp-server": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/"
  },
  "dependencies": {
    "@droplet/tools-core": "0.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@prisma/client": "^5.14.0",
    "jsonwebtoken": "^9.0.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^20.12.12",
    "tsx": "^4.11.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

- [ ] **Step 3: Install**

```bash
mkdir -p services/mcp-server/src services/mcp-server/__tests__
npm install
```

Expected: `@modelcontextprotocol/sdk` resolves; `@droplet/tools-core` workspace symlink created.

- [ ] **Step 4: Commit**

```bash
git add services/mcp-server/package.json services/mcp-server/tsconfig.json package-lock.json
git commit -m "chore: add @droplet/mcp-server workspace skeleton (WARP-100)"
```

### Task 1.12: Build the `ToolContext` factory

**Files:**
- Create: `services/mcp-server/src/context.ts`
- Test: `services/mcp-server/__tests__/context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildContext, type ContextDeps } from "../src/context.js";

describe("buildContext", () => {
  it("composes a ToolContext with role/user from claims and an AbortSignal", () => {
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: { listDevices: vi.fn() } as never,
      httpFactory: () => ({
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      }),
    };
    const signal = new AbortController().signal;
    const ctx = buildContext(deps, { sub: "u1", role: "admin" }, signal, "ncT");
    expect(ctx.userId).toBe("u1");
    expect(ctx.role).toBe("admin");
    expect(ctx.ncToken).toBe("ncT");
    expect(ctx.signal).toBe(signal);
    expect(ctx.http.routing).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd services/mcp-server && npx vitest run __tests__/context.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `services/mcp-server/src/context.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import type { ToolContext, MatterController, HttpClient, Role } from "@droplet/tools-core";

export interface ContextDeps {
  prisma: PrismaClient;
  matter: MatterController;
  httpFactory: (target:
    | "routing"
    | "cameras"
    | "switchSvc"
    | "fileIndexer"
    | "nextcloud"
  ) => HttpClient;
}

export interface Claims {
  sub?: string;
  role?: Role;
}

export function buildContext(
  deps: ContextDeps,
  claims: Claims | undefined,
  signal: AbortSignal,
  ncToken?: string,
): ToolContext {
  return {
    prisma: deps.prisma,
    matter: deps.matter,
    http: {
      routing: deps.httpFactory("routing"),
      cameras: deps.httpFactory("cameras"),
      switchSvc: deps.httpFactory("switchSvc"),
      fileIndexer: deps.httpFactory("fileIndexer"),
      nextcloud: deps.httpFactory("nextcloud"),
    },
    userId: claims?.sub,
    role: claims?.role,
    ncToken,
    signal,
  };
}
```

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/context.ts services/mcp-server/__tests__/context.test.ts
git commit -m "feat(mcp-server): ToolContext factory (WARP-100)"
```

### Task 1.13: Build the MCP server core (handler registration)

**Files:**
- Create: `services/mcp-server/src/server.ts`
- Test: `services/mcp-server/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";

describe("createServer", () => {
  it("returns an MCP Server with tools capability advertised", () => {
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: {} as never,
      httpFactory: () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
    };
    const server = createServer(deps);
    expect(server).toBeDefined();
    // MCP SDK Server exposes serverInfo + capabilities
    const info = (server as unknown as { serverInfo: { name: string } }).serverInfo;
    expect(info.name).toBe("droplet-mcp-server");
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd services/mcp-server && npx vitest run __tests__/server.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `services/mcp-server/src/server.ts`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, type Tool, type ToolResult } from "@droplet/tools-core";
import { buildContext, type ContextDeps, type Claims } from "./context.js";

const SERVER_INFO = { name: "droplet-mcp-server", version: "0.1.0" };

export function createServer(deps: ContextDeps, claims?: Claims) {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(TOOLS.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool: Tool | undefined = TOOLS.get(req.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `Unknown tool: ${req.params.name}` }) },
        ],
        isError: true,
      };
    }
    const ctx = buildContext(deps, claims, extra.signal);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let result: ToolResult;
    try {
      result = await tool.handler(args, ctx);
    } catch (err) {
      result = {
        ok: false,
        status: "error",
        error: { code: "HANDLER_THREW", message: err instanceof Error ? err.message : String(err) },
      };
    }
    return toolResultToContent(result);
  });

  return server;
}

function toolResultToContent(result: ToolResult): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data) }],
      isError: false,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: result.status,
          error: result.error,
        }),
      },
    ],
    // confirmation_required is NOT a hard error from the model's perspective —
    // it's the expected outcome of calling a destructive tool without prior approval.
    isError: result.status === "error",
  };
}
```

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/server.ts services/mcp-server/__tests__/server.test.ts
git commit -m "feat(mcp-server): core MCP server with tools/list and tools/call (WARP-100)"
```

### Task 1.14: Implement stdio transport

**Files:**
- Create: `services/mcp-server/src/transports/stdio.ts`

- [ ] **Step 1: Implement (no separate failing test — the integration test in 1.15 covers this)**

Create `services/mcp-server/src/transports/stdio.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: Implement entrypoint**

Create `services/mcp-server/src/index.ts`:

```ts
#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import { createServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import type { ContextDeps } from "./context.js";

function parseTransport(argv: string[]): "stdio" | "http" {
  const arg = argv.find((a) => a.startsWith("--transport="));
  const value = arg?.split("=")[1];
  if (value === "http") return "http";
  return "stdio";
}

async function main(): Promise<void> {
  const transport = parseTransport(process.argv.slice(2));

  // Build dependencies. For WARP-100 we only support stdio + a minimal Matter
  // stub; HTTP transport + full deps land in WARP-103.
  const prisma = new PrismaClient();
  const deps: ContextDeps = {
    prisma,
    matter: {
      listDevices: async () => ({}),
      getDevice: async () => ({}),
      sendCommand: async () => ({}),
      discover: async () => ({}),
      commission: async () => ({}),
      getAuditLog: async () => ({}),
    },
    httpFactory: () => ({
      get: () => Promise.reject(new Error("http transport not configured in WARP-100")),
      post: () => Promise.reject(new Error("http transport not configured in WARP-100")),
      patch: () => Promise.reject(new Error("http transport not configured in WARP-100")),
      delete: () => Promise.reject(new Error("http transport not configured in WARP-100")),
    }),
  };
  const server = createServer(deps);

  if (transport === "stdio") {
    await startStdio(server);
  } else {
    console.error("HTTP transport not yet implemented (WARP-103)");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Build**

```bash
cd services/mcp-server && npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add services/mcp-server/src/transports/stdio.ts services/mcp-server/src/index.ts
git commit -m "feat(mcp-server): stdio transport + entrypoint (WARP-100)"
```

### Task 1.15: Stdio roundtrip integration test

**Files:**
- Create: `services/mcp-server/__tests__/stdio-roundtrip.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = resolve(__dirname, "../dist/index.js");

describe("stdio roundtrip", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN, "--transport=stdio"],
    });
    client = new Client(
      { name: "stdio-roundtrip-test", version: "0.0.1" },
      { capabilities: {} },
    );
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it("tools/list returns the 5 vertical-slice tools", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "block_network_device",
      "get_network_status",
      "list_files",
      "list_network_devices",
      "list_smart_home_devices",
    ]);
  });

  it("tools/call list_smart_home_devices returns a content block", async () => {
    const res = await client.callTool({ name: "list_smart_home_devices", arguments: {} });
    expect(res.content[0].type).toBe("text");
  });
});
```

- [ ] **Step 2: Build server before running test**

```bash
cd services/mcp-server && npm run build
```

- [ ] **Step 3: Run test (expect pass)**

```bash
cd services/mcp-server && npx vitest run __tests__/stdio-roundtrip.test.ts
```

Expected: PASS — both tests.

- [ ] **Step 4: Commit**

```bash
git add services/mcp-server/__tests__/stdio-roundtrip.test.ts
git commit -m "test(mcp-server): stdio roundtrip lists and calls slice tools (WARP-100)"
```

### Task 1.16: Build everything + final WARP-100 check

- [ ] **Step 1: Build all new packages**

```bash
cd packages/tools-core && npm run build
cd ../../services/mcp-server && npm run build
```

Expected: clean.

- [ ] **Step 2: Run all new tests**

```bash
cd packages/tools-core && npm test
cd ../../services/mcp-server && npm test
```

Expected: all green.

- [ ] **Step 3: Run repo-wide test suite (regressions)**

```bash
cd ../../ && npm test
```

Expected: existing suites unchanged + new ones passing.

- [ ] **Step 4: Push branch**

```bash
git push -u origin WARP-100
```

WARP-100 done. Hand off to QA via the agent harness.

---

## WARP-101 — Orchestrator agent rewire

**Branch:** `WARP-101` (off `main` after WARP-100 merges)
**Spec sections:** §5 (architecture), §8 (orchestrator agent rewire), §11 (testing), §12 (AC for WARP-101)

### Task 2.1: Add MCP SDK + workspace deps to orchestrator

**Files:**
- Modify: `apps/orchestrator/package.json`

- [ ] **Step 1: Add deps**

Open `apps/orchestrator/package.json` and add to `dependencies`:

```json
"@droplet/tools-core": "0.1.0",
"@droplet/mcp-server": "0.1.0",
"@modelcontextprotocol/sdk": "^1.0.0",
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: workspace symlinks for `@droplet/*`; `@modelcontextprotocol/sdk` installed.

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/package.json package-lock.json
git commit -m "chore(orchestrator): depend on tools-core + mcp-server + MCP SDK (WARP-101)"
```

### Task 2.2: Define SSE event types

**Files:**
- Create: `apps/orchestrator/src/types/sse-events.ts`
- Test: `apps/orchestrator/src/__tests__/sse-events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { encodeSSE, type SSEEvent } from "../types/sse-events.js";

describe("encodeSSE", () => {
  it("encodes content_delta", () => {
    const e: SSEEvent = { type: "content_delta", text: "hello" };
    const out = encodeSSE(e);
    expect(out).toContain("event: content_delta");
    expect(out).toContain('data: {"text":"hello"}');
    expect(out.endsWith("\n\n")).toBe(true);
  });

  it("encodes tool_call with id, name, args", () => {
    const e: SSEEvent = {
      type: "tool_call",
      id: "c1",
      name: "list_files",
      args: { path: "/" },
    };
    const out = encodeSSE(e);
    expect(out).toContain("event: tool_call");
    expect(out).toContain('"name":"list_files"');
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/sse-events.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/orchestrator/src/types/sse-events.ts`:

```ts
export type SSEEvent =
  | { type: "content_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; ok: boolean; data?: unknown; status?: string; message?: string }
  | { type: "done"; iterations: number; stop_reason: "model_done" | "iteration_limit" | "error"; error?: string };

export function encodeSSE(event: SSEEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}
```

- [ ] **Step 4: Run (expect pass)**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/types/sse-events.ts apps/orchestrator/src/__tests__/sse-events.test.ts
git commit -m "feat(orchestrator): typed SSE event encoder (WARP-101)"
```

### Task 2.3: Build the MCP client wrapper

**Files:**
- Create: `apps/orchestrator/src/services/mcp-client.service.ts`
- Test: `apps/orchestrator/src/__tests__/mcp-client.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpClientService } from "../services/mcp-client.service.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = resolve(__dirname, "../../../../services/mcp-server/dist/index.js");

describe("McpClientService", () => {
  let svc: McpClientService;

  beforeAll(async () => {
    svc = new McpClientService({ command: process.execPath, args: [SERVER_BIN, "--transport=stdio"] });
    await svc.start();
  }, 30_000);

  afterAll(async () => {
    await svc.stop();
  });

  it("listTools caches and returns the slice", async () => {
    const a = await svc.listTools();
    const b = await svc.listTools();
    expect(a).toBe(b); // cached reference
    expect(a.map((t) => t.name).sort()).toContain("list_network_devices");
  });

  it("callTool returns parsed JSON content", async () => {
    const r = await svc.callTool("list_smart_home_devices", {});
    expect(r.content).toBeDefined();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/mcp-client.service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `apps/orchestrator/src/services/mcp-client.service.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpClientOptions {
  command: string;
  args?: string[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolCallResult {
  content: { type: string; text?: string }[];
  isError: boolean;
}

export class McpClientService {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsCache: ToolDescriptor[] | null = null;

  constructor(private readonly opts: McpClientOptions) {}

  async start(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args ?? [],
    });
    this.client = new Client(
      { name: "droplet-orchestrator", version: "0.1.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async stop(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.transport = null;
    this.toolsCache = null;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (!this.client) throw new Error("MCP client not started");
    if (this.toolsCache) return this.toolsCache;
    const res = await this.client.listTools();
    this.toolsCache = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as object,
    }));
    return this.toolsCache;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.client) throw new Error("MCP client not started");
    const res = await this.client.callTool({ name, arguments: args });
    return {
      content: res.content as { type: string; text?: string }[],
      isError: Boolean(res.isError),
    };
  }
}
```

- [ ] **Step 4: Build mcp-server first (test dep)**

```bash
cd ../../services/mcp-server && npm run build && cd -
```

- [ ] **Step 5: Run test (expect pass)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/mcp-client.service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/mcp-client.service.ts apps/orchestrator/src/__tests__/mcp-client.service.test.ts
git commit -m "feat(orchestrator): MCP stdio client wrapper with tools cache (WARP-101)"
```

### Task 2.4: Refactor `llm-agent.service.ts` to use MCP client

**Files:**
- Modify: `apps/orchestrator/src/services/llm-agent.service.ts` (full rewrite)
- Test: `apps/orchestrator/src/__tests__/llm-agent.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentDeps } from "../services/llm-agent.service.js";

describe("runAgent", () => {
  it("emits content_delta then done when model returns content immediately", async () => {
    const events: any[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          { name: "list_files", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool: vi.fn(),
      } as never,
      aiGateway: {
        chat: vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "hello" } }],
          }),
        }),
      } as never,
      onEvent: (e) => events.push(e),
    };
    const result = await runAgent(deps, { model: "ollama/qwen3", messages: [{ role: "user", content: "hi" }] });
    expect(result.stop_reason).toBe("model_done");
    expect(events.find((e) => e.type === "content_delta")).toBeDefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();
  });

  it("dispatches tool_calls and feeds results back", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ devices: [] }) }],
        isError: false,
      });
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "list_network_devices", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "no devices" } }],
        }),
      });
    const events: any[] = [];
    const deps: AgentDeps = {
      mcp: {
        listTools: vi.fn().mockResolvedValue([
          { name: "list_network_devices", description: "...", inputSchema: { type: "object", properties: {} } },
        ]),
        callTool,
      } as never,
      aiGateway: { chat } as never,
      onEvent: (e) => events.push(e),
    };
    const result = await runAgent(deps, { model: "ollama/qwen3", messages: [{ role: "user", content: "show devices" }] });
    expect(callTool).toHaveBeenCalledWith("list_network_devices", {});
    expect(result.iterations).toBe(2);
    expect(result.stop_reason).toBe("model_done");
    expect(events.filter((e) => e.type === "tool_call").length).toBe(1);
    expect(events.filter((e) => e.type === "tool_result").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-agent.service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Rewrite `llm-agent.service.ts`**

Replace the file contents with:

```ts
/**
 * LLM agent loop — live, MCP-backed.
 *
 * Drives a ReAct-style loop:
 *   user → ai-gateway w/ tools[] → tool_calls? → MCP tools/call → loop
 *
 * `tools[]` advertised to the model is built once per process from the MCP
 * server's tools/list (cached by McpClientService).
 *
 * Emits structured SSE events to a caller-supplied `onEvent`.
 */

import type { McpClientService } from "./mcp-client.service.js";
import type { ChatMessage, ChatResponse, ToolCall } from "../types/index.js";
import type { SSEEvent } from "../types/sse-events.js";

export interface AgentDeps {
  mcp: McpClientService;
  aiGateway: {
    chat: (req: {
      model: string;
      messages: ChatMessage[];
      stream?: boolean;
      temperature?: number;
      tools?: { type: "function"; function: { name: string; description: string; parameters: object } }[];
      tool_choice?: "auto" | "none";
    }) => Promise<{ ok: boolean; status?: number; json: () => Promise<ChatResponse> }>;
  };
  onEvent?: (e: SSEEvent) => void;
}

export interface AgentRequest {
  model: string;
  messages: ChatMessage[];
  max_iter?: number;
  temperature?: number;
  allowed_tools?: string[];
}

export interface AgentTraceEntry {
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface AgentResult {
  message: ChatMessage;
  trace: AgentTraceEntry[];
  iterations: number;
  stop_reason: "model_done" | "iteration_limit" | "error";
  error?: string;
}

const DEFAULT_MAX_ITER = 5;

export async function runAgent(deps: AgentDeps, req: AgentRequest): Promise<AgentResult> {
  const maxIter = Math.max(1, Math.min(req.max_iter ?? DEFAULT_MAX_ITER, 10));
  const trace: AgentTraceEntry[] = [];
  const messages: ChatMessage[] = [...req.messages];
  const emit = deps.onEvent ?? (() => {});

  const allTools = await deps.mcp.listTools();
  const filtered =
    req.allowed_tools?.length
      ? allTools.filter((t) => req.allowed_tools!.includes(t.name))
      : allTools;
  const tools = filtered.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  for (let iter = 0; iter < maxIter; iter++) {
    const gw = await deps.aiGateway.chat({
      model: req.model,
      messages,
      stream: false,
      temperature: req.temperature,
      tools,
      tool_choice: "auto",
    });
    if (!gw.ok) {
      const error = `ai-gateway ${gw.status ?? "error"}`;
      emit({ type: "done", iterations: iter, stop_reason: "error", error });
      return { message: { role: "assistant", content: "" }, trace, iterations: iter, stop_reason: "error", error };
    }
    const data = await gw.json();
    const choice = data.choices?.[0];
    if (!choice) {
      emit({ type: "done", iterations: iter, stop_reason: "error", error: "no choice" });
      return { message: { role: "assistant", content: "" }, trace, iterations: iter, stop_reason: "error", error: "no choice" };
    }
    const asst = choice.message;

    if (!asst.tool_calls?.length) {
      if (asst.content) emit({ type: "content_delta", text: asst.content });
      emit({ type: "done", iterations: iter + 1, stop_reason: "model_done" });
      return { message: asst, trace, iterations: iter + 1, stop_reason: "model_done" };
    }

    messages.push(asst);
    for (const call of asst.tool_calls) {
      const args = safeParseArgs(call);
      emit({ type: "tool_call", id: call.id, name: call.function.name, args });
      const result = await deps.mcp.callTool(call.function.name, args);
      const text = result.content[0]?.text ?? "{}";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      trace.push({ tool_call_id: call.id, tool: call.function.name, args, result: parsed });
      const evt: Extract<SSEEvent, { type: "tool_result" }> = {
        type: "tool_result",
        id: call.id,
        ok: !result.isError,
      };
      if (parsed && typeof parsed === "object" && "status" in (parsed as object) && (parsed as { status: string }).status === "confirmation_required") {
        evt.status = "confirmation_required";
        evt.message = (parsed as { error?: { message?: string } }).error?.message;
      } else {
        evt.data = parsed;
      }
      emit(evt);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: text.slice(0, 8000),
      });
    }
  }

  emit({ type: "done", iterations: maxIter, stop_reason: "iteration_limit" });
  return { message: { role: "assistant", content: "" }, trace, iterations: maxIter, stop_reason: "iteration_limit" };
}

function safeParseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS — both tests.

- [ ] **Step 5: Run TS check**

```bash
cd apps/orchestrator && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/llm-agent.service.ts apps/orchestrator/src/__tests__/llm-agent.service.test.ts
git commit -m "feat(orchestrator): rewire llm-agent.service to MCP client + SSE events (WARP-101)"
```

### Task 2.5: Drop `execute_tools` from ai-gateway client

**Files:**
- Modify: `apps/orchestrator/src/services/ai-gateway.client.ts`

- [ ] **Step 1: Read current file**

```bash
cd apps/orchestrator && grep -n "execute_tools" src/services/ai-gateway.client.ts
```

- [ ] **Step 2: Remove every reference to `execute_tools` in the chat request body**

Edit `apps/orchestrator/src/services/ai-gateway.client.ts`. Find any line that sets `execute_tools` (e.g. `execute_tools: req.execute_tools ?? true`) inside the `chat()` request body and delete it. Remove `execute_tools` from any TypeScript request type defined locally.

- [ ] **Step 3: Run orchestrator tests**

```bash
cd apps/orchestrator && npm test
```

Expected: green; if any test asserts `execute_tools` was sent, update it to assert the absence.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/services/ai-gateway.client.ts
git commit -m "refactor(orchestrator): drop execute_tools from ai-gateway client; orchestrator owns tool dispatch (WARP-101)"
```

### Task 2.6: Refactor `/api/llm/chat` to drive the orchestrator agent

**Files:**
- Modify: `apps/orchestrator/src/routes/llm.ts`
- Test: `apps/orchestrator/src/__tests__/llm-chat.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/mcp-client.service.js", () => ({
  McpClientService: class {
    async start() {}
    async stop() {}
    async listTools() {
      return [{ name: "list_network_devices", description: "...", inputSchema: { type: "object", properties: {} } }];
    }
    async callTool() {
      return { content: [{ type: "text", text: JSON.stringify({ devices: [] }) }], isError: false };
    }
  },
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  chat: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "no devices" } }],
    }),
  }),
}));

describe("/api/llm/chat", () => {
  it("non-streaming returns final message + trace", async () => {
    const { default: createApp } = await import("../app.js");
    const app: express.Express = createApp();
    const res = await request(app)
      .post("/api/llm/chat")
      .send({ model: "ollama/qwen3", messages: [{ role: "user", content: "show devices" }] });
    expect(res.status).toBe(200);
    expect(res.body.message.role).toBe("assistant");
    expect(res.body.message.content).toBe("no devices");
    expect(Array.isArray(res.body.trace)).toBe(true);
  });

  it("streaming emits content_delta + done events", async () => {
    const { default: createApp } = await import("../app.js");
    const app = createApp();
    const res = await request(app)
      .post("/api/llm/chat")
      .send({ model: "ollama/qwen3", messages: [{ role: "user", content: "hi" }], stream: true })
      .buffer(true)
      .parse((res, cb) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk.toString()));
        res.on("end", () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.text ?? res.body).toMatch(/event: content_delta/);
    expect(res.text ?? res.body).toMatch(/event: done/);
  });
});
```

- [ ] **Step 2: Run (expect fail — route still forwards to ai-gateway)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-chat.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Refactor the chat route**

Edit `apps/orchestrator/src/routes/llm.ts`. Replace the existing `router.post("/llm/chat", ...)` handler with a handler that uses `runAgent`. Imports needed:

```ts
import { runAgent } from "../services/llm-agent.service.js";
import { encodeSSE, type SSEEvent } from "../types/sse-events.js";
import { mcpClient } from "../services/mcp-client.singleton.js";
import * as aiGateway from "../services/ai-gateway.client.js";
```

The new handler body:

```ts
router.post("/llm/chat", async (req, res, next) => {
  try {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const chatReq = parsed.data;

    if (chatReq.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const onEvent = (e: SSEEvent) => res.write(encodeSSE(e));
      try {
        await runAgent(
          { mcp: mcpClient, aiGateway: { chat: aiGateway.chat }, onEvent },
          {
            model: chatReq.model,
            messages: chatReq.messages,
            temperature: chatReq.temperature,
          },
        );
      } finally {
        res.end();
      }
      return;
    }

    const result = await runAgent(
      { mcp: mcpClient, aiGateway: { chat: aiGateway.chat } },
      {
        model: chatReq.model,
        messages: chatReq.messages,
        temperature: chatReq.temperature,
      },
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Add the singleton initializer**

Create `apps/orchestrator/src/services/mcp-client.singleton.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClientService } from "./mcp-client.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_BIN =
  process.env.MCP_SERVER_BIN ??
  path.resolve(__dirname, "../../../../services/mcp-server/dist/index.js");

export const mcpClient = new McpClientService({
  command: process.execPath,
  args: [SERVER_BIN, "--transport=stdio"],
});

let started = false;
export async function ensureMcpStarted(): Promise<void> {
  if (started) return;
  await mcpClient.start();
  started = true;
}
```

- [ ] **Step 5: Hook the singleton into orchestrator startup**

In `apps/orchestrator/src/index.ts` (or wherever Express bootstraps), add early in the boot sequence:

```ts
import { ensureMcpStarted } from "./services/mcp-client.singleton.js";

// ... before listen():
await ensureMcpStarted();
```

And graceful shutdown:

```ts
import { mcpClient } from "./services/mcp-client.singleton.js";

process.on("SIGTERM", async () => {
  await mcpClient.stop();
  process.exit(0);
});
```

- [ ] **Step 6: Run tests (expect pass)**

```bash
cd apps/orchestrator && npm test
```

Expected: green. Existing chat test now exercises the new path.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/services/mcp-client.singleton.ts apps/orchestrator/src/index.ts apps/orchestrator/src/__tests__/llm-chat.integration.test.ts
git commit -m "feat(orchestrator): /api/llm/chat drives orchestrator agent loop with MCP (WARP-101)"
```

### Task 2.7: Manual smoke test against the dashboard

- [ ] **Step 1: Start the dev stack**

```bash
npm run dev:docker
```

Wait for orchestrator + ai-gateway + dashboard to be healthy.

- [ ] **Step 2: Open the dashboard chat page**

Navigate to `http://localhost/chat` (or whatever the dev URL is per `nginx.conf`).

- [ ] **Step 3: Ask "what's connected to my network?"**

Expected: dashboard shows `list_network_devices` tool-call chip + an assistant message with the device list. `journalctl` / docker logs of the orchestrator show `tool_call` and `tool_result` SSE events.

- [ ] **Step 4: Ask "block the AA:BB:CC:DD:EE:FF device"**

Expected: orchestrator emits a `tool_result` with `status: "confirmation_required"`. The model's response tells the user to confirm in the dashboard. No firewall change happens.

- [ ] **Step 5: Document the smoke test in the PR body**

(Manager will pick this up from Dev's self-assessment.)

### Task 2.8: Final WARP-101 check + push

- [ ] **Step 1: Full orchestrator test suite + tsc**

```bash
cd apps/orchestrator && npm test && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 2: Repo-wide test suite**

```bash
cd ../../ && npm test
```

Expected: green.

- [ ] **Step 3: Push branch**

```bash
git push -u origin WARP-101
```

WARP-101 done.

---

## WARP-102 — Bulk port

**Branch:** `WARP-102`
**Spec sections:** §6 (inventory), §6.2 (name reconciliation), §6.3 (RBAC), §10 (cleanup audit), §12 (AC for WARP-102)

This ticket is mechanical: port every handler from `apps/orchestrator/src/services/llm-tools.ts` and `services/ai-gateway/tools/executor.py` into `packages/tools-core/handlers/`, applying the name reconciliation table from spec §6.2 and the RBAC flags from §6.3.

The work is repetitive. Use the established pattern from WARP-100 (tasks 1.4–1.8). Each handler port = TDD cycle: write failing test, implement handler, run test, commit.

### Task 3.1: Authoritative inventory check

**Files:**
- Create: `packages/tools-core/INVENTORY.md`

- [ ] **Step 1: Enumerate every handler in both registries**

```bash
grep -hE '^\s*name:\s*"' apps/orchestrator/src/services/llm-tools.ts | sed -E 's/.*"([^"]+)".*/\1/' | sort -u > /tmp/orchestrator-tools.txt
grep -hE '"[a-z_]+": _' services/ai-gateway/tools/executor.py | sed -E 's/.*"([^"]+)".*/\1/' | sort -u > /tmp/gateway-tools.txt
diff /tmp/orchestrator-tools.txt /tmp/gateway-tools.txt > /tmp/tool-diff.txt
cat /tmp/orchestrator-tools.txt /tmp/gateway-tools.txt | sort -u > /tmp/union.txt
wc -l /tmp/orchestrator-tools.txt /tmp/gateway-tools.txt /tmp/union.txt
```

Note the union count.

- [ ] **Step 2: Apply name reconciliation per spec §6.2**

Manually rename in the union list:
- `block_device` → `block_network_device`
- `unblock_device` → `unblock_network_device`
- `list_devices` → `list_network_devices` (already canonical from WARP-100)
- `get_connected_devices` → `list_network_devices` (collapse duplicate)
- `get_cameras` → `list_cameras`
- `get_camera_events` → `list_camera_events`
- `list_recent_camera_events` → `list_camera_events` (collapse duplicate; `limit` param controls "recent")
- `get_wifi_info` → `get_wifi_settings` (collapse near-duplicates; pick the gateway name)

- [ ] **Step 3: Write `packages/tools-core/INVENTORY.md`**

Format:

```markdown
# Tool Inventory

| Name | Domain | Description | requiresWrite | requiresConfirmation | Source |
|---|---|---|---|---|---|
| list_network_devices | network | List every network device | false | false | both (was: list_devices in gateway) |
| get_network_status | network | WAN/LAN/WiFi status | false | false | gateway |
| ... | ... | ... | ... | ... | ... |
```

Populate every row. Use the spec's RBAC table as the authority for `requiresWrite`. Use today's 202 behavior for `requiresConfirmation`.

- [ ] **Step 4: Commit**

```bash
git add packages/tools-core/INVENTORY.md
git commit -m "docs(tools-core): authoritative tool inventory after dedup (WARP-102)"
```

### Task 3.2 → Task 3.N: Port each remaining handler

For every tool listed in `INVENTORY.md` that isn't already in `packages/tools-core/handlers/` (the 5 from WARP-100 are: `list_network_devices`, `get_network_status`, `list_smart_home_devices`, `block_network_device`, `list_files`), execute the **handler port template** below. Group commits by domain (one commit per ~5 handlers within the same domain).

#### Handler port template (apply per tool)

For tool `<name>` in domain `<domain>`:

- [ ] **Step 1: Locate the existing implementation**

  - In `apps/orchestrator/src/services/llm-tools.ts`, search for `name: "<name>"` and read the handler body and any helpers it calls (e.g. `parseModelDate`, `validateNcPath`, `MAX_PATH_LEN`, `MAX_WRITE_BYTES`).
  - **Or** in `services/ai-gateway/tools/executor.py`, search for `async def _<name>` and read the handler body.

- [ ] **Step 2: Write the failing test at `packages/tools-core/__tests__/handlers/<domain>/<name>.test.ts`**

  Mirror the test shape from WARP-100 task 1.4 (Prisma-backed) or 1.5 (HTTP-backed) or 1.6 (Matter-backed) or 1.7 (destructive + confirmation). Mock `ToolContext` with `vi.fn()` for the surface the handler uses.

- [ ] **Step 3: Run the test (expect FAIL)**

  ```bash
  cd packages/tools-core && npx vitest run __tests__/handlers/<domain>/<name>.test.ts
  ```

- [ ] **Step 4: Implement at `packages/tools-core/src/handlers/<domain>/<name>.ts`**

  - JSON schema per the existing `parameters` block from `llm-tools.ts` or `definitions.py`.
  - Handler body translates the original logic to the new `ToolContext` surface:
    - Prisma access → `ctx.prisma.*` (orchestrator handlers used `ctx.prisma`; copy as-is).
    - `routingFetch` → `ctx.http.routing.*` (orchestrator helper); for ai-gateway-only tools, the original `httpx` call to `/api/network/...` becomes `ctx.http.routing.*` against the routing service base URL.
    - File ops → `ctx.http.nextcloud.*` with `X-Nextcloud-Token` header from `ctx.ncToken`.
    - Camera ops → `ctx.http.cameras.*`.
    - Switch ops → `ctx.http.switchSvc.*`.
    - File-indexer ops (search_content, list_recent_files) → `ctx.http.fileIndexer.*`.
    - Matter ops → `ctx.matter.*`.
  - 202 responses → `passThroughConfirmation(res)` from `confirmation.ts`.
  - `requiresWrite` flag per spec §6.3 / `INVENTORY.md`.
  - `requiresConfirmation` true if the original orchestrator route returned 202 for this op.
  - Name = the canonical name from `INVENTORY.md` (post-reconciliation).

- [ ] **Step 5: Run the test (expect PASS)**

  Same vitest command. Expected: PASS.

- [ ] **Step 6: Commit (batch by domain when feasible)**

  ```bash
  git add packages/tools-core/src/handlers/<domain>/<name>.ts \
          packages/tools-core/__tests__/handlers/<domain>/<name>.test.ts
  git commit -m "feat(tools-core): <name> handler (WARP-102)"
  ```

#### Domain-by-domain checklist

Each line is one handler port. Cross out as completed.

**Network (12 total — 3 already in WARP-100, 9 to port):**

- [ ] `list_dhcp_leases` (orchestrator)
- [ ] `get_wifi_settings` (gateway; name canonicalized; replaces `get_wifi_info`)
- [ ] `scan_wifi_networks` (gateway)
- [ ] `set_wifi_ssid` (gateway, write+confirm)
- [ ] `set_wifi_channel` (gateway, write+confirm)
- [ ] `get_firewall_rules` (gateway)
- [ ] `unblock_network_device` (canonical name; orchestrator was `unblock_device`)
- [ ] `add_port_forward` (gateway, write+confirm)
- [ ] `get_router_system_info` (gateway)

**Files (11 total — 1 already in WARP-100, 10 to port):**

- [ ] `read_file` (gateway)
- [ ] `search_files` (orchestrator)
- [ ] `search_content` (orchestrator)
- [ ] `list_recent_files` (orchestrator)
- [ ] `write_file` (orchestrator, write)
- [ ] `delete_file` (orchestrator, write)
- [ ] `create_directory` (orchestrator, write)
- [ ] `rename_file` (orchestrator, write)
- [ ] `move_file` (orchestrator, write)
- [ ] `copy_file` (orchestrator, write)

**Smart home / Matter (6 total — 1 already in WARP-100, 5 to port):**

- [ ] `get_smart_home_device` (gateway)
- [ ] `control_device` (gateway, write+confirm for locks/extreme settings — flag both true; the underlying matter service decides per-command whether to escalate to confirmation_required)
- [ ] `discover_matter_devices` (gateway)
- [ ] `commission_device` (gateway, write)
- [ ] `get_command_history` (gateway)

**Cameras (10 total):**

- [ ] `list_cameras` (canonical; orchestrator and gateway had `list_cameras` and `get_cameras`)
- [ ] `list_discovered_cameras` (orchestrator)
- [ ] `list_camera_events` (canonical; collapses orchestrator's `list_recent_camera_events` and gateway's `get_camera_events`)
- [ ] `scan_for_cameras` (orchestrator)
- [ ] `accept_discovered_camera` (orchestrator, write)
- [ ] `get_camera_snapshot` (gateway)
- [ ] `list_clips` (orchestrator)
- [ ] `export_clip` (orchestrator, write)
- [ ] `get_camera_live_url` (orchestrator)
- [ ] `share_clip` (orchestrator, write)

**Switch (7 total):**

- [ ] `get_switch_ports` (gateway)
- [ ] `get_switch_vlans` (gateway)
- [ ] `set_port_vlan` (gateway, write+confirm)
- [ ] `get_switch_poe` (gateway)
- [ ] `set_port_poe` (gateway, write+confirm)
- [ ] `detect_wan_port` (gateway, write — auto-detect mutates state)
- [ ] `setup_camera_ports` (gateway, write+confirm)

**Calendar (4 total):**

- [ ] `create_event` (orchestrator, write)
- [ ] `list_events` (orchestrator)
- [ ] `update_event` (orchestrator, write)
- [ ] `delete_event` (orchestrator, write)

**Reminders (3 total):**

- [ ] `create_reminder` (orchestrator, write)
- [ ] `list_reminders` (orchestrator)
- [ ] `complete_reminder` (orchestrator, write)

**Notifications (2 total):**

- [ ] `send_notification` (orchestrator, write)
- [ ] `list_notifications` (orchestrator)

**Sync (2 total — verify endpoints exist before porting):**

- [ ] **Pre-step:** `grep -rn "/api/sync/" apps/orchestrator/src/routes/` — confirm `GET /api/sync/targets` and `POST /api/sync/trigger` are real handlers. If they are stubs or missing, mark this section as "deferred to follow-up ticket" and note it in the PR.
- [ ] `list_sync_targets` (gateway)
- [ ] `trigger_sync` (gateway, write)

**System (2 total — `get_system_health` is also in WARP-100; cover what's left):**

- [ ] `list_drives` (orchestrator)

### Task 3.X: Update registry

**Files:**
- Modify: `packages/tools-core/src/registry.ts`

- [ ] **Step 1: Import every newly-added handler**

Open `packages/tools-core/src/registry.ts`. For each new handler file, add an import at the top and append the imported tool to the `allTools` array. The final `allTools` array contains all ~50 tool defaults imported from their files.

- [ ] **Step 2: Update the registry test**

Edit `packages/tools-core/__tests__/registry.test.ts` to assert the full set of names. Use `INVENTORY.md` as the source of truth.

- [ ] **Step 3: Run all tests**

```bash
cd packages/tools-core && npm test
```

Expected: green across the suite.

- [ ] **Step 4: Build**

```bash
cd packages/tools-core && npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tools-core/src/registry.ts packages/tools-core/__tests__/registry.test.ts
git commit -m "feat(tools-core): register all 50 handlers in TOOLS map (WARP-102)"
```

### Task 3.Y: Move `llm-tools-files.test.ts` and delete `llm-tools.ts`

**Files:**
- Move: `apps/orchestrator/src/__tests__/llm-tools-files.test.ts` → `packages/tools-core/__tests__/handlers/files/legacy.test.ts`
- Delete: `apps/orchestrator/src/services/llm-tools.ts`

- [ ] **Step 1: Move the test**

```bash
mkdir -p packages/tools-core/__tests__/handlers/files
git mv apps/orchestrator/src/__tests__/llm-tools-files.test.ts packages/tools-core/__tests__/handlers/files/legacy.test.ts
```

- [ ] **Step 2: Update imports in the moved test**

The test imports `dispatchTool` from `../services/llm-tools.js`. Rewrite the test to call handlers directly via `getTool(name)?.handler(args, ctx)` from `@droplet/tools-core`. Keep the original assertions; only change the call wrapper.

Example: a line like
```ts
const res = await dispatchTool("list_files", { path: "/" }, ctx);
```
becomes:
```ts
const tool = getTool("list_files");
if (!tool) throw new Error("list_files not registered");
const res = await tool.handler({ path: "/" }, ctx);
```

- [ ] **Step 3: Update the test's `ToolContext` mock to match the new shape**

The legacy test built `ctx` with `{ prisma, userId, ncToken }`. Update to the new shape: add `http: { ... }`, `matter`, and `signal: new AbortController().signal`.

- [ ] **Step 4: Run the moved test**

```bash
cd packages/tools-core && npx vitest run __tests__/handlers/files/legacy.test.ts
```

Expected: green.

- [ ] **Step 5: Delete `llm-tools.ts`**

```bash
git rm apps/orchestrator/src/services/llm-tools.ts
```

- [ ] **Step 6: Update remaining orchestrator references**

`grep -rn "llm-tools" apps/orchestrator/src/` should now show only `routes/llm.ts` (the `/api/llm/tools` route still imports `TOOL_REGISTRY`). Update that route to import from `@droplet/tools-core`:

```ts
import { TOOLS } from "@droplet/tools-core";
// ...
router.get("/llm/tools", (_req, res) => {
  res.json({
    tools: Array.from(TOOLS.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
  });
});
```

(The `/api/llm/agent` route still references `runAgent` — leave it alone for now; it's deleted in WARP-104.)

- [ ] **Step 7: Run orchestrator tests + tsc**

```bash
cd apps/orchestrator && npm test && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(orchestrator): delete llm-tools.ts; tools-core is canonical (WARP-102)"
```

### Task 3.Z: WARP-102 final check + push

- [ ] **Step 1: Repo-wide test suite**

```bash
cd ../../ && npm test
```

Expected: green.

- [ ] **Step 2: Verify no dead references**

```bash
grep -rn "from.*llm-tools\|from.*TOOL_REGISTRY\|toolsForModel\|dispatchTool" apps/ services/ 2>/dev/null | grep -v node_modules | grep -v ".next/"
```

Expected: no hits (or only hits in tests that were already updated).

- [ ] **Step 3: Push**

```bash
git push -u origin WARP-102
```

WARP-102 done.

---

## WARP-103 — HTTP transport + JWT + RBAC

**Branch:** `WARP-103`
**Spec sections:** §5.2 (process model), §7 (MCP protocol surface), §7.2 (auth), §11.2 (integration), §12 (AC for WARP-103)

### Task 4.1: JWT verification module

**Files:**
- Create: `services/mcp-server/src/auth/jwt.ts`
- Test: `services/mcp-server/__tests__/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { verifyJwt, type Claims } from "../src/auth/jwt.js";

const SECRET = "test-secret";

describe("verifyJwt", () => {
  it("returns claims for a valid token", () => {
    const token = jwt.sign({ sub: "u1", role: "admin" }, SECRET, { expiresIn: "5m" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.sub).toBe("u1");
    expect(claims.role).toBe("admin");
  });

  it("throws on invalid signature", () => {
    const token = jwt.sign({ sub: "u1" }, "wrong");
    expect(() => verifyJwt(token, SECRET)).toThrow();
  });

  it("throws on expired token", () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, { expiresIn: "-1s" });
    expect(() => verifyJwt(token, SECRET)).toThrow();
  });

  it("normalizes role to undefined when missing", () => {
    const token = jwt.sign({ sub: "u2" }, SECRET, { expiresIn: "5m" });
    const claims = verifyJwt(token, SECRET);
    expect(claims.role).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd services/mcp-server && npx vitest run __tests__/auth.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import jwt from "jsonwebtoken";
import type { Role } from "@droplet/tools-core";

export interface Claims {
  sub?: string;
  role?: Role;
}

const VALID_ROLES = new Set<Role>(["owner", "admin", "family", "guest"]);

export function verifyJwt(token: string, secret: string): Claims {
  const decoded = jwt.verify(token, secret);
  if (typeof decoded === "string") throw new Error("malformed token");
  const sub = typeof decoded.sub === "string" ? decoded.sub : undefined;
  const roleClaim = (decoded as { role?: unknown }).role;
  const role = typeof roleClaim === "string" && VALID_ROLES.has(roleClaim as Role) ? (roleClaim as Role) : undefined;
  return { sub, role };
}
```

- [ ] **Step 4: Run (expect pass)**

Same command. Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/auth/jwt.ts services/mcp-server/__tests__/auth.test.ts
git commit -m "feat(mcp-server): JWT verification with role extraction (WARP-103)"
```

### Task 4.2: RBAC filter

**Files:**
- Create: `services/mcp-server/src/rbac.ts`
- Test: `services/mcp-server/__tests__/rbac.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { filterToolsForRole, canCallTool } from "../src/rbac.js";
import type { Tool, Role } from "@droplet/tools-core";

function fakeTool(name: string, requiresWrite = false): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    requiresWrite,
    requiresConfirmation: false,
    handler: async () => ({ ok: true, data: null }),
  };
}

describe("filterToolsForRole", () => {
  const all = [fakeTool("read_one"), fakeTool("write_one", true)];

  it("admin sees both", () => {
    expect(filterToolsForRole(all, "admin").map((t) => t.name)).toEqual(["read_one", "write_one"]);
  });

  it("family sees read-only", () => {
    expect(filterToolsForRole(all, "family").map((t) => t.name)).toEqual(["read_one"]);
  });

  it("guest sees read-only", () => {
    expect(filterToolsForRole(all, "guest").map((t) => t.name)).toEqual(["read_one"]);
  });

  it("undefined role (stdio in-process) sees both — fully trusted", () => {
    expect(filterToolsForRole(all, undefined).map((t) => t.name)).toEqual(["read_one", "write_one"]);
  });
});

describe("canCallTool", () => {
  it("denies write to family", () => {
    expect(canCallTool(fakeTool("w", true), "family")).toBe(false);
  });
  it("allows read to guest", () => {
    expect(canCallTool(fakeTool("r"), "guest")).toBe(true);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd services/mcp-server && npx vitest run __tests__/rbac.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { Tool, Role } from "@droplet/tools-core";

const PRIVILEGED: ReadonlySet<Role> = new Set(["owner", "admin"]);

export function filterToolsForRole(tools: Iterable<Tool>, role: Role | undefined): Tool[] {
  if (role === undefined) return [...tools];
  return [...tools].filter((t) => !t.requiresWrite || PRIVILEGED.has(role));
}

export function canCallTool(tool: Tool, role: Role | undefined): boolean {
  if (role === undefined) return true;
  if (!tool.requiresWrite) return true;
  return PRIVILEGED.has(role);
}
```

- [ ] **Step 4: Run (expect pass)**

Expected: PASS.

- [ ] **Step 5: Wire RBAC into the server**

Modify `services/mcp-server/src/server.ts`. In the `ListToolsRequestSchema` handler, replace `Array.from(TOOLS.values())` with `filterToolsForRole(TOOLS.values(), claims?.role)`. In the `CallToolRequestSchema` handler, before dispatching, check `canCallTool(tool, claims?.role)`; if false, return `{ content: [{type:"text", text: JSON.stringify({error:"forbidden_tool_for_role"})}], isError: true }`.

Run unit tests:

```bash
cd services/mcp-server && npm test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add services/mcp-server/src/rbac.ts services/mcp-server/src/server.ts services/mcp-server/__tests__/rbac.test.ts
git commit -m "feat(mcp-server): per-tool RBAC filter on tools/list and tools/call (WARP-103)"
```

### Task 4.3: Streamable-HTTP transport

**Files:**
- Create: `services/mcp-server/src/transports/http.ts`
- Modify: `services/mcp-server/src/index.ts`
- Test: `services/mcp-server/__tests__/http-roundtrip.test.ts`

- [ ] **Step 1: Implement HTTP transport wiring**

Create `services/mcp-server/src/transports/http.ts`:

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { URL } from "node:url";
import { verifyJwt, type Claims } from "../auth/jwt.js";

export interface HttpServerOptions {
  port: number;
  jwtSecret: string;
  buildServer: (claims: Claims | undefined) => Server;
}

export function startHttp(opts: HttpServerOptions): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    if (req.url && new URL(req.url, "http://x").pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing_bearer_token" }));
      return;
    }
    let claims: Claims;
    try {
      claims = verifyJwt(auth.slice("Bearer ".length), opts.jwtSecret);
    } catch (err) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token", message: (err as Error).message }));
      return;
    }

    const server = opts.buildServer(claims);
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  httpServer.listen(opts.port);
  return httpServer;
}
```

- [ ] **Step 2: Update entrypoint to support `--transport=http`**

Modify `services/mcp-server/src/index.ts`. Add an HTTP branch:

```ts
if (transport === "http") {
  const port = Number(process.env.MCP_PORT ?? 9090);
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("JWT_SECRET is required for http transport");
    process.exit(2);
  }
  startHttp({
    port,
    jwtSecret,
    buildServer: (claims) => createServer(deps, claims),
  });
  console.error(`mcp-server listening on :${port} (http, JWT-auth)`);
  return;
}
```

(Adjust deps construction so the server can be re-created per request with different claims.)

- [ ] **Step 3: Write the failing roundtrip test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp } from "../src/transports/http.js";
import { createServer } from "../src/server.js";
import type { ContextDeps } from "../src/context.js";
import type http from "node:http";

const SECRET = "test-secret-http";
const PORT = 39091;

describe("http roundtrip", () => {
  let server: http.Server;

  beforeAll(() => {
    const deps: ContextDeps = {
      prisma: {} as never,
      matter: {
        listDevices: async () => ({ ok: true }),
        getDevice: async () => ({}),
        sendCommand: async () => ({}),
        discover: async () => ({}),
        commission: async () => ({}),
        getAuditLog: async () => ({}),
      } as never,
      httpFactory: () => ({
        get: async () => new Response("{}", { status: 200 }),
        post: async () => new Response("{}", { status: 200 }),
        patch: async () => new Response("{}", { status: 200 }),
        delete: async () => new Response("{}", { status: 200 }),
      }),
    };
    server = startHttp({
      port: PORT,
      jwtSecret: SECRET,
      buildServer: (claims) => createServer(deps, claims),
    });
  });

  afterAll(() => {
    server?.close();
  });

  it("rejects missing token with 401", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(401);
  });

  it("admin sees write tools in tools/list", async () => {
    const token = jwt.sign({ sub: "admin1", role: "admin" }, SECRET, { expiresIn: "5m" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    expect(res.tools.find((t) => t.name === "block_network_device")).toBeDefined();
    await client.close();
  });

  it("family does not see write tools", async () => {
    const token = jwt.sign({ sub: "f1", role: "family" }, SECRET, { expiresIn: "5m" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    expect(res.tools.find((t) => t.name === "block_network_device")).toBeUndefined();
    await client.close();
  });
});
```

- [ ] **Step 4: Run (expect pass)**

```bash
cd services/mcp-server && npm run build && npx vitest run __tests__/http-roundtrip.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/src/transports/http.ts services/mcp-server/src/index.ts services/mcp-server/__tests__/http-roundtrip.test.ts
git commit -m "feat(mcp-server): streamable-HTTP transport + JWT-gated RBAC (WARP-103)"
```

### Task 4.4: Add mcp-server to docker-compose

**Files:**
- Modify: `docker/docker-compose.yml`
- Modify: `.env.example`
- Create: `services/mcp-server/Dockerfile`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/tools-core packages/tools-core
COPY services/mcp-server services/mcp-server
RUN npm install --workspaces --include-workspace-root
RUN npm run -w @droplet/tools-core build
RUN npm run -w @droplet/mcp-server build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/tools-core/dist /app/packages/tools-core/dist
COPY --from=builder /app/packages/tools-core/package.json /app/packages/tools-core/package.json
COPY --from=builder /app/services/mcp-server/dist /app/services/mcp-server/dist
COPY --from=builder /app/services/mcp-server/package.json /app/services/mcp-server/package.json
ENV NODE_ENV=production
EXPOSE 9090
CMD ["node", "/app/services/mcp-server/dist/index.js", "--transport=http"]
```

- [ ] **Step 2: Add Compose service**

In `docker/docker-compose.yml`, add to the `services:` block:

```yaml
  mcp-server:
    build:
      context: ..
      dockerfile: services/mcp-server/Dockerfile
    container_name: droplet-mcp-server
    restart: unless-stopped
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - MCP_PORT=9090
      - DATABASE_URL=${DATABASE_URL}
    networks:
      - droplet
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--spider", "http://localhost:9090/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on:
      db:
        condition: service_healthy
```

(Internal-only by default — no `ports:`. Add a host port if/when inference-engine runs off-box.)

- [ ] **Step 3: Document env vars**

In `.env.example`, append:

```
# MCP server
MCP_PORT=9090            # internal port for streamable-HTTP transport
MCP_TRUSTED=             # set to 1 inside the orchestrator's stdio child to bypass JWT
```

- [ ] **Step 4: Build the image**

```bash
docker compose -f docker/docker-compose.yml build mcp-server
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-server/Dockerfile docker/docker-compose.yml .env.example
git commit -m "chore(infra): mcp-server Compose service + Dockerfile (WARP-103)"
```

### Task 4.5: Compose-stack integration test

**Files:**
- Create: `tests/mcp.integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_BASE = process.env.MCP_BASE_URL ?? "http://localhost:9090/";
const SECRET = process.env.JWT_SECRET ?? "test-secret";

function jwtFor(role: "admin" | "family"): string {
  return jwt.sign({ sub: `u-${role}`, role }, SECRET, { expiresIn: "5m" });
}

async function connect(role: "admin" | "family"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_BASE), {
    requestInit: { headers: { Authorization: `Bearer ${jwtFor(role)}` } },
  });
  const client = new Client({ name: "integ", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("mcp integration (compose stack)", () => {
  let admin: Client;
  let family: Client;

  beforeAll(async () => {
    admin = await connect("admin");
    family = await connect("family");
  }, 30_000);

  afterAll(async () => {
    await admin?.close();
    await family?.close();
  });

  it("admin can list every tool", async () => {
    const res = await admin.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).toContain("block_network_device");
  });

  it("family cannot see write tools", async () => {
    const res = await family.listTools();
    const names = res.tools.map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
  });

  it("family cannot call write tools", async () => {
    await expect(
      family.callTool({ name: "block_network_device", arguments: { mac: "AA:BB:CC:DD:EE:FF" } }),
    ).rejects.toThrow();
  });

  it("block_network_device returns confirmation_required", async () => {
    const res = await admin.callTool({
      name: "block_network_device",
      arguments: { mac: "AA:BB:CC:DD:EE:FF" },
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("confirmation_required");
  });
});
```

- [ ] **Step 2: Add a `tests/package.json` script if needed**

Check `tests/package.json`. If absent, add:

```json
"scripts": {
  "test:mcp": "vitest run mcp.integration.test.ts"
}
```

- [ ] **Step 3: Run against a live stack**

```bash
docker compose -f docker/docker-compose.yml up -d
cd tests && npm run test:mcp
docker compose -f docker/docker-compose.yml down
```

Expected: all four tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp.integration.test.ts tests/package.json
git commit -m "test(mcp): compose-stack integration covering RBAC + confirmation (WARP-103)"
```

### Task 4.6: WARP-103 final check + push

- [ ] **Step 1: Repo-wide tests**

```bash
cd ../../ && npm test
```

Expected: green.

- [ ] **Step 2: Push**

```bash
git push -u origin WARP-103
```

WARP-103 done.

---

## WARP-104 — ai-gateway slim + cleanup

**Branch:** `WARP-104`
**Spec sections:** §9 (ai-gateway slimming), §10 (cleanup audit), §12 (AC for WARP-104)

### Task 5.1: Delete `services/ai-gateway/tools/`

- [ ] **Step 1: Delete the directory**

```bash
git rm -r services/ai-gateway/tools/
git rm services/ai-gateway/tests/test_tools.py
```

- [ ] **Step 2: Find the remaining imports**

```bash
grep -rn "from tools\|from \.tools\|tools\.executor\|tools\.definitions" services/ai-gateway/ 2>/dev/null
```

Identify every file that still imports from `tools/` — likely `router.py`, possibly `main.py` or `schemas.py`.

- [ ] **Step 3: Strip tool-loop branch from `router.py`**

Open `services/ai-gateway/router.py`. Remove:
- Imports of `tools.definitions` and `tools.executor`.
- The branch that checks `chat_request.execute_tools` and runs the ReAct loop.
- The `tools=...` parameter forwarding (the orchestrator now passes the tool list inside the chat request body — ai-gateway just forwards it to the provider).
- Any references to `TOOL_HANDLERS` or `execute_tool`.

What remains: a chat handler that takes the request, picks a provider, sends the request as-is, returns the response. ai-gateway is a passthrough.

- [ ] **Step 4: Strip `ToolDefinition`/`ToolFunction`/`ToolCall` from `schemas.py` if unused**

```bash
grep -rn "ToolDefinition\|ToolFunction\|ToolCall" services/ai-gateway/ 2>/dev/null
```

If the only matches are in `schemas.py` itself, delete those classes. If they're still referenced (e.g. for OpenAI-passthrough validation in the chat request), keep them and document why in the diff.

- [ ] **Step 5: Run pytest**

```bash
cd services/ai-gateway && pytest
```

Expected: green; if any test asserts the removed tool-loop behavior, delete it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(ai-gateway): delete tools/ — orchestrator owns tool dispatch (WARP-104)"
```

### Task 5.2: Delete `/api/llm/agent` route

**Files:**
- Modify: `apps/orchestrator/src/routes/llm.ts`

- [ ] **Step 1: Find and remove the route**

In `apps/orchestrator/src/routes/llm.ts`:
- Delete the `router.post("/llm/agent", ...)` handler.
- Delete `agentRequestSchema` and any imports it requires (`runAgent` is still used by `/llm/chat` via the singleton — keep that import; delete only `agentRequestSchema` and `WRITE_TOOLS` if defined locally).
- Delete `import { TOOL_REGISTRY } from "../services/llm-tools.js"` if any reference remains. (Should already be gone after WARP-102 task 3.Y.)

- [ ] **Step 2: Run orchestrator tests + tsc**

```bash
cd apps/orchestrator && npm test && npx tsc --noEmit
```

Expected: green.

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/src/routes/llm.ts
git commit -m "refactor(orchestrator): delete dead /api/llm/agent route (WARP-104)"
```

### Task 5.3: `/api/llm/tools` proxies MCP tools/list

**Files:**
- Modify: `apps/orchestrator/src/routes/llm.ts`
- Test: `apps/orchestrator/src/__tests__/llm-tools-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import request from "supertest";

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([
      { name: "list_files", description: "list files", inputSchema: { type: "object" } },
    ]),
  },
  ensureMcpStarted: vi.fn(),
}));

describe("/api/llm/tools", () => {
  it("returns tools from MCP listTools", async () => {
    const { default: createApp } = await import("../app.js");
    const app = createApp();
    const res = await request(app).get("/api/llm/tools");
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([
      { name: "list_files", description: "list files", parameters: { type: "object" } },
    ]);
  });
});
```

- [ ] **Step 2: Run (expect fail or stale shape)**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/llm-tools-route.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Refactor route to proxy MCP**

In `apps/orchestrator/src/routes/llm.ts`:

```ts
import { mcpClient } from "../services/mcp-client.singleton.js";
// ...
router.get("/llm/tools", async (_req, res, next) => {
  try {
    const tools = await mcpClient.listTools();
    res.json({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    });
  } catch (err) {
    next(err);
  }
});
```

Remove any remaining import of `TOOLS` from `@droplet/tools-core` in this file (the proxy uses the MCP layer; not the registry directly).

- [ ] **Step 4: Run test (expect pass)**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/routes/llm.ts apps/orchestrator/src/__tests__/llm-tools-route.test.ts
git commit -m "feat(orchestrator): /api/llm/tools proxies MCP tools/list (WARP-104)"
```

### Task 5.4: Update CLAUDE.md, README, ai-gateway README

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `services/ai-gateway/README.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Find the LLM-related section (search for "ai-gateway" or "tool-calling"). Replace any description of "ai-gateway dispatches tools" with:

```
- **LLM tool calling.** All LLM-callable tools live in the `@droplet/tools-core` workspace package
  with a single canonical registry. The orchestrator's `llm-agent.service.ts` runs the agent loop
  and dispatches tool calls via the `@droplet/mcp-server` (MCP, stdio child process). External
  MCP clients (inference-engine, Claude Desktop) reach the same server over streamable HTTP with
  JWT auth and per-tool RBAC. ai-gateway is a thin provider router (LiteLLM); it does NOT
  dispatch tools.
- **Adding a new tool:** add a handler under `packages/tools-core/src/handlers/<domain>/`, register
  it in `packages/tools-core/src/registry.ts`, set `requiresWrite` and `requiresConfirmation`, and
  add a unit test. The MCP server picks it up automatically.
```

- [ ] **Step 2: Update `README.md`**

Find the architecture overview / diagram. Replace any reference to ai-gateway dispatching tools. Add `services/mcp-server/` to the monorepo structure list and `packages/tools-core/` if `packages/*` is mentioned.

- [ ] **Step 3: Update `services/ai-gateway/README.md`**

Add a banner at the top:

```
> As of WARP-104, ai-gateway is purely a provider router (LiteLLM proxying to Ollama, Anthropic,
> OpenAI). Tool dispatch lives in services/mcp-server with handlers in packages/tools-core/.
> If you're looking to add a new LLM-callable tool, see CLAUDE.md.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md services/ai-gateway/README.md
git commit -m "docs: MCP server is the canonical tool surface (WARP-104)"
```

### Task 5.4b: Switch dashboard chat hook to the MCP-backed route

WARP-101 deliberately left the dashboard's chat UI on the legacy ai-gateway session route so the back-end rewire could land hermetically. WARP-104 finishes that cut by switching `apps/web-dashboard/src/lib/hooks/useChat.ts` from `sendSessionChat()` (→ `/api/llm/sessions/:id/chat`) to `sendChat()` (→ `/api/llm/chat`), which is the MCP-backed path.

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/useChat.ts`
- Modify: `apps/web-dashboard/src/lib/api.ts` (if `sendChat` doesn't already exist or doesn't yet return a streaming reader compatible with the new SSE event shape)
- Test: `apps/web-dashboard/src/__tests__/useChat.test.ts` (new or modify)

- [ ] **Step 1: Inspect the current `useChat` hook**

  Read `apps/web-dashboard/src/lib/hooks/useChat.ts`. Identify:
  - Where it calls `sendSessionChat(sessionId, message, ...)`.
  - What state it maintains for "session" (history list, session ID, multi-session UI).
  - Whether the dashboard exposes session switching (e.g. a sidebar of past chats) or only a single rolling thread.

- [ ] **Step 2: Decide UX delta scope**

  `/api/llm/chat` is stateless — the orchestrator does not persist message history. The dashboard has two reasonable paths:

  - **2a. Pure switch:** drop session features. The chat page becomes a single rolling thread held in React state; on refresh, history is gone. Smallest diff.
  - **2b. Preserve sessions via orchestrator:** add lightweight server-side history persistence in the orchestrator (a `ChatSession` Prisma model + `/api/llm/sessions` proxied to it) so the new MCP path keeps the existing UX. Larger diff, may itself want a follow-up ticket.

  Pick **2a** unless the project lead has explicitly said otherwise during WARP-104 planning. Document the choice + UX delta in the PR body.

- [ ] **Step 3: Write a failing test (or update the existing one)**

  Mock `sendChat` to return a `ReadableStream` that emits the four SSE event types (`content_delta`, `tool_call`, `tool_result`, `done`). Assert the hook surfaces the assistant content + tool-call chips correctly.

  Run:
  ```bash
  cd apps/web-dashboard && npx vitest run src/__tests__/useChat.test.ts
  ```
  Expected: FAIL.

- [ ] **Step 4: Implement the switch**

  In `useChat.ts`, replace the `sendSessionChat` call site with `sendChat({ model, messages, stream: true })`. Parse the streaming response per the SSE event shape (`apps/orchestrator/src/types/sse-events.ts` is the contract; mirror the discriminated union on the dashboard side). Drop or stub the session-switching state per the 2a/2b choice from Step 2.

  If `apps/web-dashboard/src/lib/api.ts` doesn't already expose a streaming-aware `sendChat`, add it. The function returns either the parsed `AgentResult` (non-streaming) or yields an `AsyncIterable<SSEEvent>` (streaming) — pick whichever shape the rest of the dashboard's data layer prefers.

- [ ] **Step 5: Run dashboard tests + tsc**

  ```bash
  cd apps/web-dashboard && npm test && npx tsc --noEmit
  ```
  Expected: green. The 182 baseline grows by however many new test cases you added.

- [ ] **Step 6: Manual smoke test against the live stack**

  ```bash
  npm run dev:docker
  ```
  Open `http://localhost/chat`, ask "what's connected to my network?". Confirm: (a) the chat works end-to-end, (b) `gh` orchestrator logs show MCP `tools/call list_network_devices`, (c) the dashboard renders the assistant response. Then ask "block AA:BB:CC:DD:EE:FF" and confirm the dashboard surfaces the `confirmation_required` chip from the existing Tier 2 modal.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/web-dashboard/src/lib/hooks/useChat.ts apps/web-dashboard/src/lib/api.ts apps/web-dashboard/src/__tests__/useChat.test.ts
  git commit -m "feat(dashboard): switch chat hook to /api/llm/chat (MCP path) (WARP-104)"
  ```

### Task 5.5: Final dead-code sweep

- [ ] **Step 1: Run the sweep**

```bash
grep -rn "executor\.py\|tools\.executor\|TOOL_HANDLERS\|llm-tools\|TOOL_REGISTRY\|toolsForModel\|dispatchTool\|execute_tools" apps/ services/ tests/ docs/ 2>/dev/null | grep -v node_modules | grep -v ".next/" | grep -v "^docs/superpowers/specs/" | grep -v "^docs/superpowers/plans/"
```

Expected: zero hits. If anything matches, investigate and remove.

- [ ] **Step 2: Repo-wide tests**

```bash
npm test
```

Expected: green.

- [ ] **Step 3: Final smoke test**

```bash
docker compose -f docker/docker-compose.yml down
docker compose -f docker/docker-compose.yml up -d --build
```

Wait for stack to come up. Open dashboard, ask "what's connected?". Should work end-to-end through MCP.

- [ ] **Step 4: Push**

```bash
git push -u origin WARP-104
```

WARP-104 done. The MCP migration is complete.

---

## Spec coverage cross-check

| Spec section | Implementing tasks |
|---|---|
| §2 Goals | WARP-100 (foundation for one canonical registry), WARP-101 (orchestrator owns loop), WARP-103 (three consumers + RBAC), WARP-104 (cleanup) |
| §5.1 End-state layout | WARP-100 (packages/tools-core, mcp-server skeleton), WARP-101 (orchestrator rewire), WARP-103 (Compose service), WARP-104 (deletions + docs) |
| §5.2 Process model | WARP-100 (stdio), WARP-103 (HTTP + Compose service) |
| §5.3 Three-consumer flow | WARP-100 (in-proc stdio), WARP-103 (HTTP for inference-engine + Claude Desktop) |
| §5.4 ToolContext | WARP-100 task 1.2 (types), task 1.12 (factory) |
| §5.5 Registry | WARP-100 task 1.9, WARP-102 task 3.X |
| §6 Tool inventory | WARP-100 (5 slice tools), WARP-102 (full port + naming reconciliation) |
| §6.2 Name reconciliation | WARP-102 task 3.1 + handler ports |
| §6.3 RBAC table | WARP-100 (per-tool flags), WARP-103 (filter enforcement) |
| §7 MCP protocol surface | WARP-100 task 1.13 (server core) |
| §7.1 ToolResult encoding | WARP-100 task 1.13 (`toolResultToContent`) |
| §7.2 Auth | WARP-103 task 4.1 (JWT), task 4.3 (HTTP transport) |
| §8 Orchestrator agent rewire | WARP-101 (full ticket) |
| §8.2 SSE event shape | WARP-101 task 2.2 |
| §9 ai-gateway slimming | WARP-104 task 5.1 |
| §10 Cleanup audit | WARP-102 task 3.Y, WARP-104 tasks 5.1–5.5 |
| §11.1 Per-package testing | every ticket — TDD throughout |
| §11.2 Compose-stack integration | WARP-103 task 4.5 |
| §12 AC per ticket | one ticket per AC list |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `@modelcontextprotocol/sdk` version churn breaks the SDK API used in WARP-100/103 | Pin to a specific minor in package.json. Test against that version only; bump in a dedicated follow-up ticket. |
| Workspace symlinks misbehave on Docker COPY | The Dockerfile uses `npm install --workspaces` from the workspace root, then copies specific dist outputs. Avoids symlink fragility. |
| Some `/api/sync/*` endpoints turn out to be stubs | WARP-102 task 3.2 has a pre-step to verify; if missing, defer those handlers and note in PR. |
| Matter library reentrancy across orchestrator + mcp-server processes | Mitigation: WARP-100 uses an injected `MatterController` interface. The orchestrator owns the only Matter controller instance; the in-process stdio child re-uses it via the injected dep. The HTTP transport's mcp-server (separate process) can fall back to HTTP-calling the orchestrator's `/api/matter/*` routes for Matter handlers — implement with a small adapter at WARP-102 if reentrancy is a problem. |
| Dashboard chat regression because SSE shape is new | WARP-101 keeps the non-streaming response identical to today's `runAgent` `AgentResult`. The streaming path is opt-in (`stream=true`) and emits structured events the dashboard already needs to parse — verify in WARP-101 task 2.7 manual smoke test. |
| `JWT_SECRET` mismatch between orchestrator and mcp-server | Both read from the same `.env`-sourced env var. Document in `.env.example`. WARP-103 task 4.4 wires it via Compose env. |
