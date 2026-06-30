# WARP-108 Request-id / trace-id Propagation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate a single `x-request-id` from the dashboard (or a freshly minted per-tick id) through orchestrator → ai-gateway → routing, stamping it onto every log line so one `grep <id>` reconstructs a request end-to-end.

**Architecture:** Context propagation — `AsyncLocalStorage` in the orchestrator (a pino `mixin` stamps the id onto every log line) and `ContextVar` in the two Python FastAPI services (a `logging.Filter` stamps it onto every record). Inbound middleware adopts a valid `x-request-id` header or generates one; background ticks mint a fresh id; outbound HTTP calls carry the id as the `x-request-id` header.

**Tech Stack:** Express + pino + pino-http (orchestrator), FastAPI + stdlib `logging` (ai-gateway, routing), Next.js + native fetch (dashboard). Tests: vitest (TS), pytest (Py).

## Global Constraints

- **Header name:** `x-request-id` (lowercase). Same everywhere.
- **ID value:** a UUIDv4 string. TS/dashboard: `crypto.randomUUID()`. Python: `uuid.uuid4()`. **No new dependency** in any package (do NOT add `nanoid`).
- **Inbound validation regex:** `^[A-Za-z0-9_-]{8,64}$`. Adopt the inbound id iff it matches; otherwise generate a fresh one. Never log an unvalidated inbound id.
- **Log key:** `requestId` (orchestrator/dashboard, camelCase) / `request_id` (Python, snake_case). No-context marker: the literal string `no-request-context`.
- **Echo:** every service sets `x-request-id` on its response.
- **Python middleware is pure ASGI** (NOT `BaseHTTPMiddleware`) so the contextvar set in the middleware is visible in the endpoint and downstream provider calls.
- **ESM imports in the orchestrator** use `.js` extensions (e.g. `import { getRequestId } from "../lib/request-context.js"`). Match this.
- **Repo rules (CLAUDE.md):** surgical changes; no speculative features; no `while True` schedulers (use the existing cron-runtime / apscheduler).
- **Branch:** `warp-108-request-id-propagation` (already created off `main`). The spec lives at `docs/superpowers/specs/2026-06-30-warp-108-request-id-propagation-design.md`.
- **Test commands:** `npm run test:orchestrator`, `npm run test:ai-gateway`; routing via `cd services/routing && python -m pytest`; dashboard via `cd apps/web-dashboard && npx vitest run`.

---

## File structure

**Orchestrator (`apps/orchestrator/src/`)**
- Create `lib/request-context.ts` — ALS store + id helpers.
- Create `lib/logger.ts` — `createLogger(name)` (pino + requestId mixin).
- Create `middleware/request-id.ts` — inbound adopt/generate + ALS run + echo.
- Modify `middleware/request-logger.ts` — pino-http from mixin logger + customProps.
- Modify `app.ts` — mount request-id middleware before requestLogger.
- Modify `services/cron-runtime.service.ts` — wrap each tick in a fresh id.
- Modify `services/ai-gateway.client.ts`, `services/openwrt.client.ts`, `services/switch.client.ts` — add the header.
- Modify the module-logger instantiations (`pino({ name })` → `createLogger(name)`).
- Tests under `src/__tests__/` and `src/middleware/`.

**ai-gateway (`services/ai-gateway/`)**
- Create `request_context.py` — contextvar + helpers + `configure_logging()`.
- Create `middleware/request_id.py` — pure ASGI middleware.
- Create `grpc_request_id.py` — gRPC interceptor (fresh id per call).
- Modify `main.py` — logging config + register middleware + CORS allow_headers + gRPC interceptor.
- Modify `providers/anthropic_cloud.py`, `providers/openai_cloud.py`, `providers/ollama_local.py` — propagate header.
- Modify `scheduler.py` — capture/reset id across the queue boundary.
- Tests under `tests/`.

**routing (`services/routing/`)**
- Create `request_context.py` — contextvar + helpers + `configure_logging()`.
- Create `middleware.py` — pure ASGI request-id middleware + `with_fresh_request_id` decorator.
- Modify `main.py` — logging config + register middleware.
- Modify `droplet_openwrt_sdk.py` — add header to ubus `_post`.
- Modify `scheduler.py`, `egress_meter.py`, `dns_block_meter.py` — decorate `_tick`.
- Tests under `tests/`.

**dashboard (`apps/web-dashboard/src/`)**
- Modify `lib/hooks/apiFetch.ts` and `lib/auth.tsx` — generate + attach + capture id.
- Tests under `src/lib/`.

---

## Task 1: Orchestrator — request context module

**Files:**
- Create: `apps/orchestrator/src/lib/request-context.ts`
- Test: `apps/orchestrator/src/__tests__/request-context.test.ts`

**Interfaces — Produces:**
- `newRequestId(): string` — a UUIDv4.
- `sanitizeRequestId(raw: string | undefined | null): string | undefined` — returns `raw` iff it matches `^[A-Za-z0-9_-]{8,64}$`, else `undefined`.
- `getRequestId(): string | undefined` — current id from ALS, or `undefined`.
- `runWithRequestId<T>(id: string, fn: () => T): T` — run `fn` with `{ requestId: id }` in the ALS store.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/src/__tests__/request-context.test.ts
import { describe, it, expect } from "vitest";
import {
  newRequestId,
  sanitizeRequestId,
  getRequestId,
  runWithRequestId,
} from "../lib/request-context.js";

describe("request-context", () => {
  it("newRequestId returns a v4 uuid string", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sanitizeRequestId accepts valid ids and rejects junk", () => {
    expect(sanitizeRequestId(newRequestId())).toBeTypeOf("string");
    expect(sanitizeRequestId("abc123_-Z9")).toBe("abc123_-Z9");
    expect(sanitizeRequestId("short")).toBeUndefined(); // < 8 chars
    expect(sanitizeRequestId("has space")).toBeUndefined();
    expect(sanitizeRequestId("bad\nnewline")).toBeUndefined();
    expect(sanitizeRequestId("x".repeat(65))).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });

  it("getRequestId is undefined outside a context and set inside", () => {
    expect(getRequestId()).toBeUndefined();
    const out = runWithRequestId("test-id-123", () => getRequestId());
    expect(out).toBe("test-id-123");
    expect(getRequestId()).toBeUndefined();
  });

  it("propagates across awaits", async () => {
    const seen = await runWithRequestId("async-id-1", async () => {
      await Promise.resolve();
      return getRequestId();
    });
    expect(seen).toBe("async-id-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/request-context.test.ts`
Expected: FAIL — cannot find module `../lib/request-context.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/orchestrator/src/lib/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestStore>();

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function newRequestId(): string {
  return randomUUID();
}

export function sanitizeRequestId(
  raw: string | undefined | null,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  return REQUEST_ID_RE.test(raw) ? raw : undefined;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(id: string, fn: () => T): T {
  return storage.run({ requestId: id }, fn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/request-context.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/request-context.ts apps/orchestrator/src/__tests__/request-context.test.ts
git commit -m "feat(orchestrator): request-id ALS context module (WARP-108)"
```

---

## Task 2: Orchestrator — logger factory with requestId mixin

**Files:**
- Create: `apps/orchestrator/src/lib/logger.ts`
- Test: `apps/orchestrator/src/__tests__/logger.test.ts`

**Interfaces:**
- Consumes: `getRequestId` from Task 1.
- Produces: `createLogger(name: string): pino.Logger` — every line includes `requestId` (current id, or `no-request-context`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/src/__tests__/logger.test.ts
import { describe, it, expect } from "vitest";
import { createLogger } from "../lib/logger.js";
import { runWithRequestId } from "../lib/request-context.js";

function capture(fn: (log: ReturnType<typeof createLogger>) => void): any[] {
  const lines: any[] = [];
  const log = createLogger("test");
  // Re-bind to a stream we can read by spying on process.stdout via pino is
  // awkward; instead assert the mixin output directly.
  // pino exposes no public mixin getter, so we log to a custom destination.
  return lines;
}

describe("createLogger", () => {
  it("stamps requestId from context, no-request-context otherwise", () => {
    const lines: string[] = [];
    const log = createLogger("test", {
      write: (s: string) => lines.push(s),
    });
    log.info("outside");
    runWithRequestId("rid-42", () => log.info("inside"));
    const outside = JSON.parse(lines[0]);
    const inside = JSON.parse(lines[1]);
    expect(outside.requestId).toBe("no-request-context");
    expect(inside.requestId).toBe("rid-42");
    expect(outside.name).toBe("test");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/logger.test.ts`
Expected: FAIL — cannot find module `../lib/logger.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/orchestrator/src/lib/logger.ts
import pino from "pino";
import { getRequestId } from "./request-context.js";

/**
 * Canonical orchestrator logger factory. The `mixin` runs on every log call
 * and stamps the current request id (from AsyncLocalStorage) onto the line, so
 * deep service-layer logs carry the same `requestId` as request handlers
 * without threading it through call signatures (WARP-108).
 *
 * `dest` is for tests only (a writable sink); production omits it and pino
 * writes JSON to stdout as before.
 */
export function createLogger(
  name: string,
  dest?: { write: (s: string) => void },
): pino.Logger {
  const opts: pino.LoggerOptions = {
    name,
    mixin() {
      return { requestId: getRequestId() ?? "no-request-context" };
    },
  };
  return dest ? pino(opts, dest as pino.DestinationStream) : pino(opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/logger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/logger.ts apps/orchestrator/src/__tests__/logger.test.ts
git commit -m "feat(orchestrator): pino logger factory with requestId mixin (WARP-108)"
```

---

## Task 3: Orchestrator — inbound request-id middleware + pino-http wiring

**Files:**
- Create: `apps/orchestrator/src/middleware/request-id.ts`
- Test: `apps/orchestrator/src/middleware/request-id.test.ts`
- Modify: `apps/orchestrator/src/middleware/request-logger.ts`
- Modify: `apps/orchestrator/src/app.ts` (mount before `requestLogger`, currently line 127)

**Interfaces:**
- Consumes: `sanitizeRequestId`, `newRequestId`, `runWithRequestId` (Task 1).
- Produces: `requestIdMiddleware(req, res, next)` — sets `req.requestId`, echoes `x-request-id`, runs `next()` inside the ALS context.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/src/middleware/request-id.test.ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestIdMiddleware } from "./request-id.js";
import { getRequestId } from "../lib/request-context.js";

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers, header: (h: string) => headers[h.toLowerCase()] } as unknown as Request;
}
function mockRes(): Response & { _headers: Record<string, string> } {
  const _headers: Record<string, string> = {};
  return { setHeader: (k: string, v: string) => { _headers[k.toLowerCase()] = v; }, _headers } as any;
}

describe("requestIdMiddleware", () => {
  it("adopts a valid inbound x-request-id and echoes it", () => {
    const req = mockReq({ "x-request-id": "valid_id_123" });
    const res = mockRes();
    let seen: string | undefined;
    requestIdMiddleware(req, res, (() => { seen = getRequestId(); }) as NextFunction);
    expect(seen).toBe("valid_id_123");
    expect((req as any).requestId).toBe("valid_id_123");
    expect(res._headers["x-request-id"]).toBe("valid_id_123");
  });

  it("generates a fresh id when the header is missing", () => {
    const req = mockReq();
    const res = mockRes();
    let seen: string | undefined;
    requestIdMiddleware(req, res, (() => { seen = getRequestId(); }) as NextFunction);
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(res._headers["x-request-id"]).toBe(seen);
  });

  it("regenerates when the inbound id is invalid", () => {
    const req = mockReq({ "x-request-id": "bad id!" });
    const res = mockRes();
    let seen: string | undefined;
    requestIdMiddleware(req, res, (() => { seen = getRequestId(); }) as NextFunction);
    expect(seen).not.toBe("bad id!");
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/middleware/request-id.test.ts`
Expected: FAIL — cannot find module `./request-id.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/orchestrator/src/middleware/request-id.ts
import type { Request, Response, NextFunction } from "express";
import {
  newRequestId,
  sanitizeRequestId,
  runWithRequestId,
} from "../lib/request-context.js";

/**
 * WARP-108. Adopt a valid inbound `x-request-id` or mint a fresh one, stash it
 * on `req.requestId` (so pino-http's finish-time log can read it), echo it on
 * the response, and run the rest of the request inside the ALS context so every
 * downstream log line and outbound call carries the same id.
 *
 * Mounted BEFORE the pino-http request logger.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = sanitizeRequestId(
    (req.headers["x-request-id"] as string | undefined) ?? undefined,
  );
  const id = inbound ?? newRequestId();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader("x-request-id", id);
  runWithRequestId(id, () => next());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/middleware/request-id.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire pino-http to the mixin logger + finish-time customProps**

Replace the body of `apps/orchestrator/src/middleware/request-logger.ts` with:

```ts
import pinoHttp from "pino-http";
import { createLogger } from "../lib/logger.js";

const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;

export const requestLogger = pinoHttp({
  logger: createLogger("http"),
  level: isTest ? "silent" : "info",
  // The auto "request completed" line fires on the response `finish` event,
  // where the ALS context may already have exited — so read the id stashed on
  // the request by requestIdMiddleware. The per-log object wins over the mixin,
  // so this line is always tagged. In-handler `req.log.*` lines are covered by
  // the mixin while the ALS context is live.
  customProps: (req) => ({
    requestId:
      (req as typeof req & { requestId?: string }).requestId ??
      "no-request-context",
  }),
});
```

- [ ] **Step 6: Mount the middleware in `app.ts`**

In `apps/orchestrator/src/app.ts`, add the import near the other middleware imports:

```ts
import { requestIdMiddleware } from "./middleware/request-id.js";
```

Then insert the middleware immediately BEFORE `app.use(requestLogger);` (line 127):

```ts
  app.use(requestIdMiddleware);
  app.use(requestLogger);
```

- [ ] **Step 7: Run the full orchestrator suite**

Run: `npm run test:orchestrator`
Expected: PASS (existing + the new request-id/logger/context tests).

- [ ] **Step 8: Commit**

```bash
git add apps/orchestrator/src/middleware/request-id.ts apps/orchestrator/src/middleware/request-id.test.ts apps/orchestrator/src/middleware/request-logger.ts apps/orchestrator/src/app.ts
git commit -m "feat(orchestrator): inbound x-request-id middleware + pino-http wiring (WARP-108)"
```

---

## Task 4: Orchestrator — fresh request-id per cron/ticker run

**Files:**
- Modify: `apps/orchestrator/src/services/cron-runtime.service.ts` (`safeRun`, lines 188-209)
- Test: `apps/orchestrator/src/__tests__/cron-runtime.request-id.test.ts`

**Interfaces:**
- Consumes: `newRequestId`, `runWithRequestId`, `getRequestId` (Task 1).
- Produces: every cron/interval handler runs inside a fresh-id ALS context; `tick-start`/`tick-end` logged.

- [ ] **Step 1: Write the failing test**

```ts
// apps/orchestrator/src/__tests__/cron-runtime.request-id.test.ts
import { describe, it, expect } from "vitest";
import { createCronRuntime } from "../services/cron-runtime.service.js";
import { getRequestId } from "../lib/request-context.js";

describe("cron-runtime request-id", () => {
  it("runs the handler inside a fresh request-id context", async () => {
    const ids: (string | undefined)[] = [];
    const silent = { warn() {}, error() {}, debug() {} };
    const rt = createCronRuntime(undefined, silent);
    // Drive one tick by registering a 10ms interval then stopping.
    await new Promise<void>((resolve) => {
      rt.scheduleInterval(10, () => {
        ids.push(getRequestId());
        rt.stop();
        resolve();
      });
    });
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    // Outside any tick there is no context.
    expect(getRequestId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/cron-runtime.request-id.test.ts`
Expected: FAIL — `ids[0]` is `undefined` (no context yet).

- [ ] **Step 3: Implement — wrap the handler in `safeRun`**

In `apps/orchestrator/src/services/cron-runtime.service.ts`:

Add to the imports at the top (after line 69):

```ts
import {
  newRequestId,
  runWithRequestId,
  getRequestId,
} from "../lib/request-context.js";
```

Replace the `safeRun` function body so the handler runs inside a fresh id. Change:

```ts
  async function safeRun(
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ) {
    try {
      if (opts?.lockKey) {
        await withAdvisoryLock(opts.lockKey, handler);
      } else {
        await handler();
      }
      failureCounts.set(handler, 0);
    } catch (err) {
```

to:

```ts
  async function safeRun(
    handler: () => void | Promise<void>,
    opts?: CronScheduleOpts,
  ) {
    const requestId = newRequestId();
    try {
      await runWithRequestId(requestId, async () => {
        logger.debug?.({ requestId }, "tick-start");
        if (opts?.lockKey) {
          await withAdvisoryLock(opts.lockKey, handler);
        } else {
          await handler();
        }
        logger.debug?.({ requestId }, "tick-end");
      });
      failureCounts.set(handler, 0);
    } catch (err) {
```

> Note: `logger` here is the cron-runtime logger. `defaultLog` (line 71) becomes `createLogger("cron-runtime")` in Task 6 so these lines also carry `requestId`; the explicit `requestId` field above guarantees grouping regardless.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/cron-runtime.request-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full orchestrator suite (existing cron-runtime tests must still pass)**

Run: `npm run test:orchestrator`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/cron-runtime.service.ts apps/orchestrator/src/__tests__/cron-runtime.request-id.test.ts
git commit -m "feat(orchestrator): fresh request-id per cron tick (WARP-108)"
```

---

## Task 5: Orchestrator — outbound header propagation

**Files:**
- Modify: `apps/orchestrator/src/services/ai-gateway.client.ts` (`authHeaders`, ~lines 23-33)
- Modify: `apps/orchestrator/src/services/openwrt.client.ts` (`routingFetch` header build, ~line 242)
- Modify: `apps/orchestrator/src/services/switch.client.ts` (`authHeaders`, ~lines 49-56)
- Test: `apps/orchestrator/src/__tests__/ai-gateway.client.request-id.test.ts`

**Interfaces:**
- Consumes: `getRequestId` (Task 1).

- [ ] **Step 1: Write the failing test (ai-gateway client carries the header)**

```ts
// apps/orchestrator/src/__tests__/ai-gateway.client.request-id.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithRequestId } from "../lib/request-context.js";

describe("ai-gateway client request-id header", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends x-request-id from the active context", async () => {
    const { listModels } = await import("../services/ai-gateway.client.js");
    await runWithRequestId("ctx-req-id-123", () => listModels());
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (call[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-request-id"]).toBe("ctx-req-id-123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/ai-gateway.client.request-id.test.ts`
Expected: FAIL — `headers["x-request-id"]` is `undefined`.

- [ ] **Step 3: Implement — add the header in each client's header builder**

In `apps/orchestrator/src/services/ai-gateway.client.ts`, add the import and extend `authHeaders`:

```ts
import { getRequestId } from "../lib/request-context.js";
```

```ts
function authHeaders(userId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = config.SERVICE_TOKEN_AI_GATEWAY || config.SERVICE_SECRET;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (userId) headers["X-Droplet-User"] = userId;
  const rid = getRequestId();
  if (rid) headers["x-request-id"] = rid;
  return headers;
}
```

In `apps/orchestrator/src/services/switch.client.ts`, mirror it in `authHeaders`:

```ts
import { getRequestId } from "../lib/request-context.js";
```
```ts
  const rid = getRequestId();
  if (rid) headers["x-request-id"] = rid;
  return headers;
```

In `apps/orchestrator/src/services/openwrt.client.ts`, add the import and set the header where `routingFetch` builds its headers (around line 242, alongside the `Authorization` header):

```ts
import { getRequestId } from "../lib/request-context.js";
```
```ts
  const rid = getRequestId();
  if (rid) headers["x-request-id"] = rid;
```

> Read each file first and place the two lines next to the existing `Authorization` assignment; the `headers` object name may differ per file — match what's there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/orchestrator && npx vitest run src/__tests__/ai-gateway.client.request-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full orchestrator suite**

Run: `npm run test:orchestrator`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/services/ai-gateway.client.ts apps/orchestrator/src/services/openwrt.client.ts apps/orchestrator/src/services/switch.client.ts apps/orchestrator/src/__tests__/ai-gateway.client.request-id.test.ts
git commit -m "feat(orchestrator): propagate x-request-id on outbound service calls (WARP-108)"
```

---

## Task 6: Orchestrator — swap module loggers to the factory

**Files:**
- Modify: every orchestrator source file that calls `pino({ name: "…" })` (e.g. `index.ts:76`, `services/cron-runtime.service.ts:71`, `middleware/auth.ts:10`, `middleware/scope.ts:41`, `middleware/error-handler.ts:5`, `services/openwrt.client.ts:41`, and the rest).

- [ ] **Step 1: Enumerate the call sites**

Run: `cd apps/orchestrator && grep -rn "pino({" src --include=*.ts | grep -v "lib/logger.ts" | grep -v ".test.ts"`
Expected: a list of `const X = pino({ name: "…" });` lines.

- [ ] **Step 2: Replace each instantiation**

For each file in the list, replace:

```ts
import pino from "pino";
// ...
const logger = pino({ name: "some-name" });
```

with:

```ts
import { createLogger } from "../lib/logger.js"; // adjust depth: ./lib, ../lib, ../../lib
// ...
const logger = createLogger("some-name");
```

Remove the now-unused `import pino from "pino";` in each file (only where `pino` is no longer otherwise referenced). Keep the same variable name and `name` string. For `cron-runtime.service.ts`, replace `const defaultLog = pino({ name: "cron-runtime" });` (line 71) with `const defaultLog = createLogger("cron-runtime");`.

> Do NOT change `lib/logger.ts` itself (it legitimately calls `pino`). Leave `*.test.ts` files alone. If a file constructs pino with options beyond `{ name }` (transport, level, serializers), leave it and note it — none were found in exploration, but verify per file.

- [ ] **Step 3: Verify no stray bare-pino name loggers remain**

Run: `cd apps/orchestrator && grep -rn "pino({ name" src --include=*.ts | grep -v "lib/logger.ts"`
Expected: no output (empty).

- [ ] **Step 4: Run the full orchestrator suite**

Run: `npm run test:orchestrator`
Expected: PASS. (If a swapped file’s relative import depth is wrong, TypeScript/vitest will error on module resolution — fix the `../` depth.)

- [ ] **Step 5: Commit**

```bash
git add -A apps/orchestrator/src
git commit -m "refactor(orchestrator): route module loggers through requestId factory (WARP-108)"
```

---

## Task 7: ai-gateway — request context + logging config

**Files:**
- Create: `services/ai-gateway/request_context.py`
- Modify: `services/ai-gateway/main.py` (lines 77-78 — replace `logging.basicConfig`)
- Test: `services/ai-gateway/tests/test_request_context.py`

**Interfaces — Produces:**
- `new_request_id() -> str` (uuid4), `sanitize_request_id(raw: str | None) -> str | None`,
  `get_request_id() -> str | None`, `set_request_id(value: str) -> None`,
  `configure_logging() -> None` (installs `RequestIdFilter` + a formatter with `%(request_id)s` on the root handler).

- [ ] **Step 1: Write the failing test**

```python
# services/ai-gateway/tests/test_request_context.py
import logging
import re
import uuid

from request_context import (
    new_request_id,
    sanitize_request_id,
    get_request_id,
    set_request_id,
    configure_logging,
    RequestIdFilter,
)


def test_new_request_id_is_uuid4():
    val = new_request_id()
    assert uuid.UUID(val).version == 4


def test_sanitize_accepts_valid_rejects_junk():
    assert sanitize_request_id(new_request_id()) is not None
    assert sanitize_request_id("abc123_-Z9") == "abc123_-Z9"
    assert sanitize_request_id("short") is None
    assert sanitize_request_id("has space") is None
    assert sanitize_request_id("bad\nnl") is None
    assert sanitize_request_id("x" * 65) is None
    assert sanitize_request_id(None) is None


def test_get_set_request_id():
    set_request_id("rid-77")
    assert get_request_id() == "rid-77"


def test_filter_injects_marker_when_unset(caplog):
    # Fresh contextvar state: a new id, then assert the record carries it.
    f = RequestIdFilter()
    record = logging.LogRecord("n", logging.INFO, __file__, 1, "msg", None, None)
    set_request_id("rid-filter-1")
    assert f.filter(record) is True
    assert record.request_id == "rid-filter-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && python -m pytest tests/test_request_context.py -v`
Expected: FAIL — `ModuleNotFoundError: request_context`.

- [ ] **Step 3: Write minimal implementation**

```python
# services/ai-gateway/request_context.py
"""WARP-108 — request-id context + logging integration for the AI gateway.

A ContextVar holds the current request id; a logging Filter stamps it onto
every record (all module loggers propagate to the root handler, so installing
the filter+formatter once covers the whole service).
"""
from __future__ import annotations

import logging
import re
import uuid
from contextvars import ContextVar

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_NO_CONTEXT = "no-request-context"

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


def new_request_id() -> str:
    return str(uuid.uuid4())


def sanitize_request_id(raw: str | None) -> str | None:
    if not isinstance(raw, str):
        return None
    return raw if _REQUEST_ID_RE.match(raw) else None


def get_request_id() -> str | None:
    return request_id_var.get()


def set_request_id(value: str) -> None:
    request_id_var.set(value)


class RequestIdFilter(logging.Filter):
    """Attach `request_id` to every record (or the no-context marker)."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get() or _NO_CONTEXT
        return True


def configure_logging(level: int = logging.INFO) -> None:
    """Install the request-id filter + formatter on the root handler. Idempotent."""
    root = logging.getLogger()
    root.setLevel(level)
    if not root.handlers:
        root.addHandler(logging.StreamHandler())
    fmt = "%(asctime)s %(levelname)s [%(name)s] [request_id=%(request_id)s] %(message)s"
    formatter = logging.Formatter(fmt)
    for handler in root.handlers:
        # Avoid stacking duplicate filters on repeat calls.
        if not any(isinstance(f, RequestIdFilter) for f in handler.filters):
            handler.addFilter(RequestIdFilter())
        handler.setFormatter(formatter)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/ai-gateway && python -m pytest tests/test_request_context.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Replace `logging.basicConfig` in `main.py`**

In `services/ai-gateway/main.py`, change lines 77-78 from:

```python
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
```

to:

```python
from request_context import configure_logging

configure_logging()
logger = logging.getLogger(__name__)
```

- [ ] **Step 6: Run the ai-gateway suite**

Run: `npm run test:ai-gateway`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/ai-gateway/request_context.py services/ai-gateway/tests/test_request_context.py services/ai-gateway/main.py
git commit -m "feat(ai-gateway): request-id contextvar + logging filter (WARP-108)"
```

---

## Task 8: ai-gateway — inbound ASGI middleware

**Files:**
- Create: `services/ai-gateway/middleware/request_id.py`
- Modify: `services/ai-gateway/main.py` (register middleware after CORS; add `x-request-id` to CORS `allow_headers` at line 271)
- Test: `services/ai-gateway/tests/test_request_id_middleware.py`

**Interfaces:**
- Consumes: `request_context` (Task 7).
- Produces: `RequestIdMiddleware` (pure ASGI class: `__init__(self, app)`, `async __call__(self, scope, receive, send)`).

- [ ] **Step 1: Write the failing test**

```python
# services/ai-gateway/tests/test_request_id_middleware.py
import pytest


@pytest.mark.anyio
async def test_response_echoes_generated_id(client):
    r = await client.get("/health")
    rid = r.headers.get("x-request-id")
    assert rid is not None and len(rid) >= 8


@pytest.mark.anyio
async def test_adopts_valid_inbound_id(client):
    r = await client.get("/health", headers={"x-request-id": "inbound_valid_1"})
    assert r.headers.get("x-request-id") == "inbound_valid_1"


@pytest.mark.anyio
async def test_regenerates_invalid_inbound_id(client):
    r = await client.get("/health", headers={"x-request-id": "bad id!"})
    assert r.headers.get("x-request-id") != "bad id!"
    assert r.headers.get("x-request-id") is not None
```

> Uses the existing `client` AsyncClient fixture in `tests/conftest.py`. `/health` is auth-exempt.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && python -m pytest tests/test_request_id_middleware.py -v`
Expected: FAIL — `x-request-id` header absent.

- [ ] **Step 3: Write minimal implementation**

```python
# services/ai-gateway/middleware/request_id.py
"""WARP-108 — pure ASGI middleware that adopts/generates x-request-id.

Pure ASGI (not BaseHTTPMiddleware) so the contextvar set here is visible in the
endpoint and downstream provider calls — BaseHTTPMiddleware runs the app in a
separate task and the contextvar would not propagate.
"""
from __future__ import annotations

from request_context import new_request_id, sanitize_request_id, set_request_id


class RequestIdMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        raw = None
        for name, value in scope.get("headers", []):
            if name == b"x-request-id":
                raw = value.decode("latin-1")
                break
        request_id = sanitize_request_id(raw) or new_request_id()
        set_request_id(request_id)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("latin-1")))
            await send(message)

        await self.app(scope, receive, send_wrapper)
```

- [ ] **Step 4: Register it in `main.py` (outermost) and extend CORS allow_headers**

Add the import near the other middleware imports:

```python
from middleware.request_id import RequestIdMiddleware
```

Add `x-request-id` to CORS `allow_headers` (line 271):

```python
    allow_headers=["Authorization", "Content-Type", "X-Request-Priority", "x-request-id", PRINCIPAL_HEADER],
```

Register the middleware AFTER the CORS block (so it is outermost — Starlette applies last-added first), right after the `app.add_middleware(CORSMiddleware, ...)` call:

```python
app.add_middleware(RequestIdMiddleware)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/ai-gateway && python -m pytest tests/test_request_id_middleware.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the ai-gateway suite (streaming must still work)**

Run: `npm run test:ai-gateway`
Expected: PASS — confirm streaming-chat tests are green (the middleware does not buffer bodies).

- [ ] **Step 7: Commit**

```bash
git add services/ai-gateway/middleware/request_id.py services/ai-gateway/main.py services/ai-gateway/tests/test_request_id_middleware.py
git commit -m "feat(ai-gateway): inbound x-request-id ASGI middleware (WARP-108)"
```

---

## Task 9: ai-gateway — outbound provider propagation + scheduler boundary

**Files:**
- Modify: `services/ai-gateway/providers/anthropic_cloud.py` (lines 47, 64)
- Modify: `services/ai-gateway/providers/openai_cloud.py` (same two `acompletion` calls)
- Modify: `services/ai-gateway/providers/ollama_local.py` (httpx `post`/`stream`, lines 436, 454)
- Modify: `services/ai-gateway/scheduler.py` (capture id at enqueue, set at dequeue)
- Test: `services/ai-gateway/tests/test_provider_request_id.py`

**Interfaces:**
- Consumes: `get_request_id`, `set_request_id` (Task 7).

- [ ] **Step 1: Write the failing test (Anthropic provider passes extra_headers)**

```python
# services/ai-gateway/tests/test_provider_request_id.py
import sys
import types
import pytest

from request_context import set_request_id
from schemas import ChatMessage


@pytest.mark.anyio
async def test_anthropic_passes_request_id_extra_header(monkeypatch):
    captured = {}

    async def fake_acompletion(**kwargs):
        captured.update(kwargs)
        class R:
            def model_dump(self):
                return {"ok": True}
        return R()

    fake_litellm = types.ModuleType("litellm")
    fake_litellm.acompletion = fake_acompletion
    monkeypatch.setitem(sys.modules, "litellm", fake_litellm)

    from providers.anthropic_cloud import AnthropicCloudProvider

    set_request_id("prov-rid-9")
    provider = AnthropicCloudProvider(api_key="sk-test")
    await provider.chat([ChatMessage(role="user", content="hi")], "claude-3-5-haiku-20241022")

    assert captured.get("extra_headers", {}).get("x-request-id") == "prov-rid-9"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && python -m pytest tests/test_provider_request_id.py -v`
Expected: FAIL — `extra_headers` not present.

- [ ] **Step 3: Implement — add a shared header helper and pass it**

In each of `anthropic_cloud.py` and `openai_cloud.py`, add the import:

```python
from request_context import get_request_id
```

Define a tiny helper near the top of each provider module (or inline). Then add `extra_headers` to **both** `litellm.acompletion(...)` calls (non-stream ~line 47, stream ~line 64):

```python
        rid = get_request_id()
        extra_headers = {"x-request-id": rid} if rid else None
        response = await litellm.acompletion(
            model=litellm_model,
            messages=litellm_messages,
            api_key=self.api_key,
            temperature=kwargs.get("temperature", 0.7),
            max_tokens=kwargs.get("max_tokens", 4096),
            extra_headers=extra_headers,
            **extra,
        )
```

For the streaming call, add `extra_headers=extra_headers` the same way (compute `rid`/`extra_headers` at the top of `_stream_chat`).

In `ollama_local.py`, add the import and attach a header on the httpx `post` (line 436) and `stream` (line 454) calls:

```python
from request_context import get_request_id
```
```python
        rid = get_request_id()
        headers = {"x-request-id": rid} if rid else None
        resp = await self.client.post(_CHAT_PATH, json=body, headers=headers)
```
(and the same `headers=headers` on the `self.client.stream("POST", _CHAT_PATH, json=body, headers=headers)` call.)

- [ ] **Step 4: Handle the scheduler async boundary**

In `services/ai-gateway/scheduler.py`, where a request is enqueued, capture the id; where the worker dequeues and runs it, re-set it. Read the file to find the enqueue dataclass/structure and the worker (`_process_loop`/`_run`). Add a `request_id` field captured via `get_request_id()` at submit time, and `set_request_id(item.request_id)` at the top of the worker body before the provider call. If the captured id is `None`, skip the set. Add the import:

```python
from request_context import get_request_id, set_request_id
```

> This keeps provider-call logs tagged even though the work runs in a different task than the request.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/ai-gateway && python -m pytest tests/test_provider_request_id.py -v`
Expected: PASS.

- [ ] **Step 6: Run the ai-gateway suite**

Run: `npm run test:ai-gateway`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/ai-gateway/providers/anthropic_cloud.py services/ai-gateway/providers/openai_cloud.py services/ai-gateway/providers/ollama_local.py services/ai-gateway/scheduler.py services/ai-gateway/tests/test_provider_request_id.py
git commit -m "feat(ai-gateway): propagate x-request-id to providers + scheduler boundary (WARP-108)"
```

---

## Task 10: ai-gateway — gRPC handlers self-seed a fresh id

**Files:**
- Create: `services/ai-gateway/grpc_request_id.py`
- Modify: `services/ai-gateway/grpc_server.py` (register the interceptor on the aio server)
- Test: `services/ai-gateway/tests/test_grpc_request_id.py`

**Interfaces:**
- Produces: `RequestIdInterceptor` (a `grpc.aio.ServerInterceptor`) that sets a fresh `request_id` on every gRPC call (cross-service gRPC propagation is out of scope; this just keeps gRPC log lines grouped, not `no-request-context`).

- [ ] **Step 1: Write the failing test**

```python
# services/ai-gateway/tests/test_grpc_request_id.py
import pytest

from request_context import get_request_id, request_id_var


@pytest.mark.anyio
async def test_interceptor_sets_fresh_id():
    from grpc_request_id import RequestIdInterceptor

    request_id_var.set(None)
    interceptor = RequestIdInterceptor()

    captured = {}

    async def fake_continuation(handler_call_details):
        async def behavior(request, context):
            captured["rid"] = get_request_id()
            return "ok"
        return behavior

    handler = await interceptor.intercept_service(fake_continuation, object())
    result = await handler("req", None)
    assert result == "ok"
    assert captured["rid"] is not None and len(captured["rid"]) >= 8
```

> If `grpc_server.py` uses unary/stream handler shapes that don't match this simplified behavior wrapper, adapt the test to the actual `intercept_service` contract used by the existing gRPC handler registration — read `grpc_server.py` first and model the interceptor + test on its real handler signatures.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/ai-gateway && python -m pytest tests/test_grpc_request_id.py -v`
Expected: FAIL — `ModuleNotFoundError: grpc_request_id`.

- [ ] **Step 3: Write minimal implementation**

```python
# services/ai-gateway/grpc_request_id.py
"""WARP-108 — gRPC server interceptor that seeds a fresh request id per call.

Cross-service gRPC metadata propagation is out of scope; this only ensures gRPC
handler log lines are grouped under a real id instead of the no-context marker.
"""
from __future__ import annotations

import grpc

from request_context import new_request_id, set_request_id


class RequestIdInterceptor(grpc.aio.ServerInterceptor):
    async def intercept_service(self, continuation, handler_call_details):
        handler = await continuation(handler_call_details)

        def _wrap(behavior):
            async def wrapper(request, context):
                set_request_id(new_request_id())
                return await behavior(request, context)
            return wrapper

        # Wrap the unary-unary behavior; if the server also exposes
        # streaming RPCs, wrap those behaviors the same way per their handler
        # shape (read grpc_server.py to confirm which RpcMethodHandler fields
        # are populated).
        if handler is None:
            return handler
        return _wrap(handler) if callable(handler) else handler
```

> Read `grpc_server.py` and adapt `_wrap` to the real `RpcMethodHandler` (it likely returns a `grpc.aio` handler object with `unary_unary` / `unary_stream` attributes; wrap whichever is set and rebuild via `grpc.unary_unary_rpc_method_handler`, etc.). The test in Step 1 models the simplified shape; align both.

- [ ] **Step 4: Register the interceptor in `grpc_server.py`**

Where the aio server is created (`grpc.aio.server(...)`), pass `interceptors=[RequestIdInterceptor()]`. Add the import:

```python
from grpc_request_id import RequestIdInterceptor
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/ai-gateway && python -m pytest tests/test_grpc_request_id.py -v`
Expected: PASS.

- [ ] **Step 6: Run the ai-gateway suite (gRPC tests green)**

Run: `npm run test:ai-gateway`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/ai-gateway/grpc_request_id.py services/ai-gateway/grpc_server.py services/ai-gateway/tests/test_grpc_request_id.py
git commit -m "feat(ai-gateway): seed fresh request-id on gRPC calls (WARP-108)"
```

---

## Task 11: routing — request context + logging config

**Files:**
- Create: `services/routing/request_context.py` (identical shape to ai-gateway's)
- Modify: `services/routing/main.py` (line 81 — replace `logging.basicConfig`)
- Test: `services/routing/tests/test_request_context.py`

- [ ] **Step 1: Write the failing test**

```python
# services/routing/tests/test_request_context.py
import logging
import uuid

from request_context import (
    new_request_id, sanitize_request_id, get_request_id, set_request_id, RequestIdFilter,
)


def test_new_request_id_is_uuid4():
    assert uuid.UUID(new_request_id()).version == 4


def test_sanitize():
    assert sanitize_request_id("abc123_-Z9") == "abc123_-Z9"
    assert sanitize_request_id("short") is None
    assert sanitize_request_id("has space") is None
    assert sanitize_request_id(None) is None


def test_filter_injects():
    f = RequestIdFilter()
    rec = logging.LogRecord("n", logging.INFO, __file__, 1, "m", None, None)
    set_request_id("rid-r-1")
    assert f.filter(rec) is True
    assert rec.request_id == "rid-r-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/routing && python -m pytest tests/test_request_context.py -v`
Expected: FAIL — `ModuleNotFoundError: request_context`.

- [ ] **Step 3: Write minimal implementation**

Create `services/routing/request_context.py` with **the same content** as `services/ai-gateway/request_context.py` from Task 7 (contextvar, `new_request_id`, `sanitize_request_id`, `get_request_id`, `set_request_id`, `RequestIdFilter`, `configure_logging`). The two services are separate Python roots with no shared package, so the module is duplicated intentionally (keep them byte-identical for easy diffing).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/routing && python -m pytest tests/test_request_context.py -v`
Expected: PASS.

- [ ] **Step 5: Replace `logging.basicConfig` in `main.py`**

In `services/routing/main.py`, change line 81 from:

```python
logging.basicConfig(level=logging.INFO)
```

to:

```python
from request_context import configure_logging

configure_logging()
```

(Keep the existing `logger = logging.getLogger("droplet.routing")` line as-is.)

- [ ] **Step 6: Run the routing suite**

Run: `cd services/routing && python -m pytest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/routing/request_context.py services/routing/tests/test_request_context.py services/routing/main.py
git commit -m "feat(routing): request-id contextvar + logging filter (WARP-108)"
```

---

## Task 12: routing — inbound ASGI middleware

**Files:**
- Create: `services/routing/middleware.py`
- Modify: `services/routing/main.py` (register after the existing `OperationTrackingMiddleware`)
- Test: `services/routing/tests/test_request_id_middleware.py`

**Interfaces:**
- Produces: `RequestIdMiddleware` (pure ASGI, same shape as ai-gateway's) and `with_fresh_request_id` decorator (used by Task 13).

- [ ] **Step 1: Write the failing test**

```python
# services/routing/tests/test_request_id_middleware.py
def test_health_echoes_request_id(connected_client):
    r = connected_client.get("/health")
    assert r.headers.get("x-request-id") is not None


def test_adopts_valid_inbound(connected_client):
    r = connected_client.get("/health", headers={"x-request-id": "inbound_ok_1"})
    assert r.headers.get("x-request-id") == "inbound_ok_1"


def test_regenerates_invalid_inbound(connected_client):
    r = connected_client.get("/health", headers={"x-request-id": "bad id!"})
    assert r.headers.get("x-request-id") not in (None, "bad id!")
```

> `/health` is auth-exempt (`require_bearer` is skipped for it) and the `connected_client` fixture provides a TestClient.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/routing && python -m pytest tests/test_request_id_middleware.py -v`
Expected: FAIL — header absent.

- [ ] **Step 3: Write minimal implementation**

```python
# services/routing/middleware.py
"""WARP-108 — request-id ASGI middleware + tick decorator for the routing service."""
from __future__ import annotations

import functools

from request_context import new_request_id, sanitize_request_id, set_request_id


class RequestIdMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        raw = None
        for name, value in scope.get("headers", []):
            if name == b"x-request-id":
                raw = value.decode("latin-1")
                break
        request_id = sanitize_request_id(raw) or new_request_id()
        set_request_id(request_id)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("latin-1")))
            await send(message)

        await self.app(scope, receive, send_wrapper)


def with_fresh_request_id(fn):
    """Decorator for apscheduler ticks: mint a fresh request id per tick."""

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        set_request_id(new_request_id())
        return await fn(*args, **kwargs)

    return wrapper
```

- [ ] **Step 4: Register in `main.py`**

Add the import:

```python
from middleware import RequestIdMiddleware
```

After the existing `app.add_middleware(OperationTrackingMiddleware)` (line 408), add:

```python
app.add_middleware(RequestIdMiddleware)
```

(Last-added = outermost, so the request id is set before OperationTracking runs.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/routing && python -m pytest tests/test_request_id_middleware.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the routing suite**

Run: `cd services/routing && python -m pytest`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/routing/middleware.py services/routing/main.py services/routing/tests/test_request_id_middleware.py
git commit -m "feat(routing): inbound x-request-id ASGI middleware (WARP-108)"
```

---

## Task 13: routing — ubus header + fresh id per sampler tick

**Files:**
- Modify: `services/routing/droplet_openwrt_sdk.py` (`_post`, line 309 headers dict)
- Modify: `services/routing/scheduler.py` (`_tick`, line 149)
- Modify: `services/routing/egress_meter.py` (`_tick`)
- Modify: `services/routing/dns_block_meter.py` (`_tick`)
- Test: `services/routing/tests/test_tick_request_id.py`

**Interfaces:**
- Consumes: `get_request_id` (Task 11), `with_fresh_request_id` (Task 12).

- [ ] **Step 1: Write the failing test (throughput tick sets an id that the sampler POST would carry)**

```python
# services/routing/tests/test_tick_request_id.py
import pytest

import scheduler
from request_context import request_id_var, get_request_id


@pytest.mark.anyio
async def test_throughput_tick_sets_request_id(monkeypatch):
    request_id_var.set(None)
    seen = {}

    # Stub the inner steps so _tick reaches _post_sample quickly.
    monkeypatch.setattr(scheduler, "_resolve_wan_device", lambda r: "eth0")
    monkeypatch.setattr(scheduler, "_read_counters", lambda r, d: (1, 2))
    monkeypatch.setattr(scheduler, "_derive_bps", lambda a, b: (10, 20))
    scheduler._previous = (0, 0)  # already primed so it emits a sample

    async def fake_post_sample(down, up):
        seen["rid"] = get_request_id()

    monkeypatch.setattr(scheduler, "_post_sample", fake_post_sample)

    await scheduler._tick(object())
    assert seen.get("rid") is not None and len(seen["rid"]) >= 8
```

> Field/function names (`_previous`, `_resolve_wan_device`, `_read_counters`, `_derive_bps`, `_post_sample`) are from the current `scheduler.py`; verify against the file and adjust the stubs to match its real tick path.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/routing && python -m pytest tests/test_tick_request_id.py -v`
Expected: FAIL — `seen["rid"]` is `None`.

- [ ] **Step 3: Implement — decorate the three ticks**

In `services/routing/scheduler.py`, add the import and decorate `_tick`:

```python
from middleware import with_fresh_request_id
```
```python
@with_fresh_request_id
async def _tick(router: DropletRouter) -> None:
    ...  # unchanged body
```

Do the same in `services/routing/egress_meter.py` and `services/routing/dns_block_meter.py` (decorate each module's `_tick`).

In `services/routing/droplet_openwrt_sdk.py`, attach the header in `_post` (line 309). Add the import at the top:

```python
from request_context import get_request_id
```

and change the headers dict:

```python
        _hdrs = {"Content-Type": "application/json"}
        _rid = get_request_id()
        if _rid:
            _hdrs["x-request-id"] = _rid
        req = Request(self.base_url, data=data, headers=_hdrs)
```

> The three sampler modules build their own `httpx.AsyncClient` POSTs with an `Authorization` header; add `"x-request-id": get_request_id()` to each of those header dicts too (`scheduler.py:_post_sample`, `egress_meter.py:_post_batch`, `dns_block_meter.py:_post_sample`) so the orchestrator sees the tick's id. Import `get_request_id` in each.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/routing && python -m pytest tests/test_tick_request_id.py -v`
Expected: PASS.

- [ ] **Step 5: Run the routing suite**

Run: `cd services/routing && python -m pytest`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/routing/droplet_openwrt_sdk.py services/routing/scheduler.py services/routing/egress_meter.py services/routing/dns_block_meter.py services/routing/tests/test_tick_request_id.py
git commit -m "feat(routing): fresh request-id per tick + propagate on ubus/sampler calls (WARP-108)"
```

---

## Task 14: dashboard — attach x-request-id + capture on errors

**Files:**
- Modify: `apps/web-dashboard/src/lib/hooks/apiFetch.ts` (lines 19-23 interface; 57-70 fetch; 95-107 error throw)
- Modify: `apps/web-dashboard/src/lib/auth.tsx` (`authFetch`, lines 238-314)
- Test: `apps/web-dashboard/src/lib/hooks/apiFetch.request-id.test.ts`

**Interfaces:**
- Produces: every dashboard request carries a generated `x-request-id`; `TypedError.requestId?: string` captured from the response.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web-dashboard/src/lib/hooks/apiFetch.request-id.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { apiFetch, type TypedError } from "./apiFetch";

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch x-request-id", () => {
  it("sends a generated x-request-id header", async () => {
    const spy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "srv-echo-1" },
      }),
    );
    vi.stubGlobal("fetch", spy);
    await apiFetch("/api/x");
    const headers = (spy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("captures the response x-request-id onto thrown errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "BOOM", message: "no" } }), {
          status: 500,
          headers: { "content-type": "application/json", "x-request-id": "srv-echo-2" },
        }),
      ),
    );
    const err = await apiFetch("/api/x").catch((e: TypedError) => e);
    expect((err as TypedError).requestId).toBe("srv-echo-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-dashboard && npx vitest run src/lib/hooks/apiFetch.request-id.test.ts`
Expected: FAIL — header not set / `requestId` undefined.

- [ ] **Step 3: Implement in `apiFetch.ts`**

Add `requestId` to the `TypedError` interface (line 19-23):

```ts
export interface TypedError extends Error {
  code?: string;
  status?: number;
  body?: unknown;
  requestId?: string;
}
```

Generate the id and merge it into headers before the fetch (around lines 57-70):

```ts
  const { timeoutMs = DEFAULT_API_FETCH_TIMEOUT_MS, signal: callerSignal, headers: callerHeaders, ...rest } = init ?? {};
  const requestId = crypto.randomUUID();
  // ... existing signal-composition block unchanged ...
  let r: Response;
  try {
    r = await fetch(path, {
      ...rest,
      headers: { ...(callerHeaders as Record<string, string> | undefined), "x-request-id": requestId },
      signal,
    });
  } catch (err) {
```

When throwing the non-ok error (lines 102-106), attach the echoed id (fall back to the generated one):

```ts
    const e: TypedError = new Error(typed.message ?? `HTTP ${r.status}`);
    e.code = typed.code;
    e.status = r.status;
    e.body = body;
    e.requestId = r.headers.get("x-request-id") ?? requestId;
    throw e;
```

- [ ] **Step 4: Implement in `auth.tsx` (`authFetch`)**

Generate one id per `authFetch` call and attach it to BOTH the initial and the post-refresh retry fetch. At the top of `authFetch` (line 238):

```ts
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const requestId = crypto.randomUUID();
  const withRid = (i?: RequestInit): RequestInit => ({
    ...i,
    headers: { ...(i?.headers as Record<string, string> | undefined), "x-request-id": requestId },
  });
  const res = await fetch(url, { ...withRid(init), credentials: "same-origin" });
```

In the post-refresh retry (lines 285-289), wrap the retry init too:

```ts
    const { signal: _staleSignal, ...rest } = init ?? {};
    return fetch(url, {
      ...withRid(rest),
      signal: timeoutSignal(AUTHFETCH_RETRY_TIMEOUT_MS),
      credentials: "same-origin",
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web-dashboard && npx vitest run src/lib/hooks/apiFetch.request-id.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the dashboard suite**

Run: `cd apps/web-dashboard && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web-dashboard/src/lib/hooks/apiFetch.ts apps/web-dashboard/src/lib/auth.tsx apps/web-dashboard/src/lib/hooks/apiFetch.request-id.test.ts
git commit -m "feat(dashboard): attach x-request-id to API calls + capture on errors (WARP-108)"
```

---

## Task 15: Full verification + manual grep acceptance + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run every affected suite**

```bash
npm run test:orchestrator
npm run test:ai-gateway
cd services/routing && python -m pytest && cd ../..
cd apps/web-dashboard && npx vitest run && cd ../..
```
Expected: all PASS.

- [ ] **Step 2: Lint/type-check the orchestrator and dashboard**

```bash
cd apps/orchestrator && npx tsc --noEmit && cd ../..
cd apps/web-dashboard && npx tsc --noEmit && cd ../..
```
Expected: no type errors (catches wrong `../lib/logger.js` import depths from Task 6).

- [ ] **Step 3: Manual acceptance — grep one id across the three services**

Document the result in the PR body. With the stack running (`npm run dev:docker`):

```bash
# Hit a dashboard-backed route that fans out to ai-gateway and/or routing:
curl -s -H 'x-request-id: probe-warp108-acceptance' http://localhost/api/models >/dev/null
# Then confirm the id appears across the streams:
docker compose -f docker/docker-compose.yml logs orchestrator ai-gateway routing 2>&1 | grep probe-warp108-acceptance
```
Expected: the id appears in orchestrator AND ai-gateway log lines (routing for a routing-backed route). Confirms acceptance criterion 3. If the appliance stack is unavailable in this environment, record that the criterion is covered by the unit tests for inbound adoption + outbound propagation per service and note the grep test as a follow-up to run on a live box.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin warp-108-request-id-propagation
gh pr create --title "WARP-108: request-id / trace-id propagation across orchestrator + ai-gateway + routing" --body "<see PR body template below>"
```

PR body should include: the goal, the per-service summary, the deferred items (copy-diagnostic toast button; cross-service gRPC metadata propagation; pre-auth dashboard fetches), a link to the spec, and the manual grep acceptance result (or the note that it needs a live box).

---

## Self-review (against the spec)

- **§1 contract** → Tasks 1, 7, 11 (id format, sanitize regex, no-context marker); echo header in Tasks 3, 8, 12. ✓
- **§2 orchestrator** → Tasks 1-6 (context, logger mixin, inbound mw + pino-http, cron ticks, outbound clients, module-logger swap). ✓
- **§3 ai-gateway** → Tasks 7-10 (context+logging, ASGI mw + CORS, providers + scheduler boundary, gRPC self-seed). ✓
- **§4 routing** → Tasks 11-13 (context+logging, ASGI mw, ubus + sampler ticks). ✓
- **§5 dashboard** → Task 14 (apiFetch + authFetch header + `.requestId` capture; no toast UI). ✓
- **§6 data flow / §9 acceptance** → Task 15 (grep across three streams). ✓
- **§7 error handling** → invalid/missing → regenerate (Tasks 3/8/12 tests); no-context marker (Tasks 2/7/11); scheduler boundary (Task 9). ✓
- **§8 testing** → each task is TDD; Task 15 aggregates. ✓
- **§10 out of scope** → copy-diagnostic button (Task 14 captures id only); gRPC metadata propagation (Task 10 self-seeds only); pre-auth fetches (noted). ✓

**Placeholder scan:** no TBD/TODO; the gRPC interceptor (Task 10) and scheduler boundary (Task 9) carry explicit "read the file and adapt to the real handler shape" notes because those exact signatures must be confirmed against current source at implementation time — the test and the shape are specified, the anchoring is verified live.

**Type/name consistency:** `getRequestId`/`runWithRequestId`/`newRequestId`/`sanitizeRequestId` (TS) and `get_request_id`/`set_request_id`/`new_request_id`/`sanitize_request_id`/`RequestIdFilter`/`configure_logging` (Py) are used consistently across all consuming tasks. Log key `requestId` (TS) / `request_id` (Py) consistent.
