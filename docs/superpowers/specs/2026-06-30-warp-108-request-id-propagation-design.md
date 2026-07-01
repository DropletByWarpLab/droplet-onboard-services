# WARP-108 — Request-id / trace-id propagation: design spec

- **Date:** 2026-06-30
- **Ticket:** [WARP-108](https://warp-lab.atlassian.net/browse/WARP-108) (parent epic WARP-320 — LLM Agent, MCP & Chat)
- **Origin:** 2026-04-18 architectural review
- **Status:** Design

## Problem

Each service logs to its own stream — pino on the orchestrator, Python stdlib
`logging` on ai-gateway and routing — and no correlation id is carried across
them. Answering "why was device X blocked at 21:07?" means hand-correlating
timestamps across three log streams plus Postgres. There is **no** request-id
today (the only adjacent thing is ai-gateway's `correlation_id`, a 12-char hex
minted *on provider errors only* — a different concept, left untouched here).

## Goal

A single `x-request-id` that originates at the dashboard (or is minted fresh by a
background tick), flows through every downstream call, and is stamped onto
**every** log line in all three services, so one `grep <id>` reconstructs a
request end-to-end.

## Approach (decided)

**Context propagation**, not explicit threading and not OpenTelemetry:

- Orchestrator: `AsyncLocalStorage` holds the current id; a pino `mixin` stamps
  it onto every log line. This is *less* churn than threading the id through call
  signatures, and unlike threading it actually reaches deep module-scoped loggers.
- ai-gateway / routing: a `ContextVar` holds the id; a `logging.Filter` on the
  root handler stamps it onto every record (all module loggers propagate to root,
  so one install covers everything).
- OpenTelemetry was rejected: it needs a trace backend this air-gapped edge
  appliance does not have, and the requirement is a grep-able id in logs, not a
  tracing platform (repo rule: "simplicity first, nothing speculative").

## 1. The cross-service contract

- **Header:** `x-request-id`.
- **Value:** a UUIDv4 string — `crypto.randomUUID()` (TS / dashboard, already used
  in `jwt.service.ts`) and `uuid.uuid4()` (Python). **No new dependency** in any
  package (the ticket's `nanoid(10)` suggestion is intentionally not adopted — it
  would add a dep to the dashboard and orchestrator for no benefit now).
- **Inbound rule:** read `x-request-id`; **adopt** it iff it matches
  `^[A-Za-z0-9_-]{8,64}$`; otherwise **generate** a fresh one. Untrusted ids are
  never logged verbatim — this caps length and forbids newlines, so a hostile
  header cannot inject log lines.
- **Echo:** every service sets `x-request-id` on its response. (Cheap, and lets
  the dashboard capture the id for the deferred "copy diagnostic code" button
  without rework.)
- **Log key:** `requestId` (TS) / `request_id` (Python). When there is no context
  (process startup, un-propagated gRPC) the literal marker `no-request-context`
  is logged instead — satisfying "every log line includes a request-id **or** an
  explicit no-context marker."

## 2. Orchestrator (`apps/orchestrator`, Express + pino-http)

### New modules
- **`src/lib/request-context.ts`** — wraps `AsyncLocalStorage<{ requestId: string }>`:
  - `getRequestId(): string | undefined`
  - `runWithRequestId<T>(id, fn): T` → `als.run({ requestId: id }, fn)`
  - `newRequestId(): string` → `randomUUID()`
  - `sanitizeRequestId(raw): string | undefined` → the regex check above.
- **`src/lib/logger.ts`** — `createLogger(name)` returns
  `pino({ name, mixin: () => ({ requestId: getRequestId() ?? "no-request-context" }) })`.
  The `mixin` runs at log-time, reading ALS, so the value is correct per request.

### Changes
- **Swap module loggers:** replace the `pino({ name: "…" })` instantiations
  (`auth.ts:10`, `scope.ts:41`, `error-handler.ts:5`, `openwrt.client.ts:41`,
  `index.ts:76`, …) with `createLogger("…")`. Mechanical, but this is what gets
  the id onto *every* line. (`req.log` from pino-http is handled separately below.)
- **New `src/middleware/request-id.ts`** — adopt/generate the id, set the response
  header, then `runWithRequestId(id, () => next())`. Mounted in `app.ts`
  **before** `requestLogger` (currently `app.ts:127`).
- **pino-http config** (`src/middleware/request-logger.ts`): construct it from a
  mixin-enabled base logger — `pinoHttp({ logger: createLogger("http"), … })` — so
  every `req.log.*` line in route handlers inherits the `requestId` mixin while the
  ALS context is live. The automatic "request completed" line fires on the response
  `finish` event, where the ALS context may already have exited, so the middleware
  also stashes the id on the request object and pino-http reads it back via
  `customProps: (req) => ({ requestId: req.requestId ?? "no-request-context" })`
  (the per-log object wins over the mixin, so this line is always tagged).
- **Tick chokepoint** (`src/services/cron-runtime.service.ts`): in the `safeRun`
  wrapper used by `scheduleInterval`/`scheduleCron`, invoke the handler as
  `runWithRequestId(newRequestId(), handler)` and emit `tick-start` / `tick-end`
  with the id. **One edit** covers all ~14 schedulers (schedule ticker, egress
  reconciler, device-reconcile poller, AP discovery, tool/scene tickers, daily
  purge, guest sweep, email reconcile, pattern miner, camera purge, TLS renewal…).
- **Pollers not on cron-runtime:** `startRemindersPoller` (`app.ts:382`) and
  `startScreenQRPoller` (`app.ts:391`) — wrap each iteration in
  `runWithRequestId(newRequestId(), …)` the same way if they use raw `setInterval`.
- **Outbound propagation:** add `x-request-id: getRequestId()` to the header
  builders in `src/services/ai-gateway.client.ts` (`authHeaders`),
  `src/services/openwrt.client.ts` (`routingFetch`), and
  `src/services/switch.client.ts` (`authHeaders`). Other fetch clients
  (frigate/nextcloud/file-indexer/docserver) take the identical one-liner if/when
  needed; the three above are the ai-gateway + routing + openwrt paths the ticket
  names.

## 3. ai-gateway (`services/ai-gateway`, FastAPI; HTTP primary)

### New modules
- **`request_context.py`** — `request_id_var: ContextVar[str | None]` +
  `get_request_id()`, `set_request_id(id)`, `new_request_id()` (uuid4),
  `sanitize_request_id(raw)`.
- **`middleware/request_id.py`** — a **pure ASGI middleware** (not
  `BaseHTTPMiddleware`: a contextvar set in `BaseHTTPMiddleware.dispatch` is not
  reliably visible in the endpoint — the known Starlette gotcha — whereas a pure
  ASGI middleware runs in the same context so the id reaches handlers and provider
  calls). Adopt/generate, `set_request_id(id)`, append `x-request-id` to the
  response start headers. Registered in `main.py` **outermost** (added last, after
  CORS).

### Changes
- **Logging** (`main.py:77-78`): replace `logging.basicConfig(level=INFO)` with a
  `configure_logging()` that installs a `RequestIdFilter`
  (`record.request_id = get_request_id() or "no-request-context"`) and a formatter
  containing `%(request_id)s` on the root handler. Module loggers
  (`getLogger(__name__)`) propagate to root → covered centrally.
- **Outbound providers:** pass `extra_headers={"x-request-id": get_request_id()}`
  to `litellm.acompletion(...)` in `providers/anthropic_cloud.py` (lines 47, 64)
  and `providers/openai_cloud.py` (lines 47, 64); pass `headers={...}` on the
  httpx `post`/`stream` calls in `providers/ollama_local.py` (lines 436, 454).
- **No scheduler plumbing needed** (`scheduler.py`): the `enqueue`d provider call
  runs in the caller's (endpoint's) asyncio task, not a separate worker task, so
  it already has the contextvar set by the inbound middleware. No capture/re-set
  across an async boundary is required — there isn't one.
- **gRPC — out of scope (noted follow-up):** the chat path is HTTP. The gRPC
  handlers (`grpc_server.py`: `EmbedText`, `Chat`, …) **seed a fresh id per call**
  so no line is untagged, but reading/propagating an id via gRPC **metadata**
  across services is deferred.

## 4. routing (`services/routing`, FastAPI; HTTP only)

### New modules
- **`request_context.py`** — same shape as ai-gateway.
- **Request-id middleware** in `main.py` — a **pure ASGI middleware** (same
  contextvar-visibility reason as ai-gateway) covering **all** methods (the existing
  `OperationTrackingMiddleware` only wraps POST/PUT/DELETE), registered outermost,
  echoes the header.

### Changes
- **Logging** (`main.py:81`): same `RequestIdFilter` + formatter install
  (logger `droplet.routing`).
- **Outbound ubus:** add `x-request-id` (from the contextvar) to the headers dict
  in `droplet_openwrt_sdk.py` `UbusClient._post()` (`:309`). OpenWrt won't correlate
  it back, but sending it *is* the propagation the ticket asks for.
- **Tick loops:** the three apscheduler ticks — `scheduler.py:_tick`,
  `egress_meter.py:_tick`, `dns_block_meter.py:_tick` — set a fresh id at the top
  (shared `@with_fresh_request_id` decorator) and emit `tick-start`. Each tick's
  sampler `httpx.post(...)` to the orchestrator
  (`/api/network/throughput-sample`, `/off-lan-sample-batch`, `/dns-block-sample`)
  then carries the id, so a routing tick is greppable straight into orchestrator
  logs.

## 5. Dashboard (`apps/web-dashboard`, Next.js)

- In **`src/lib/hooks/apiFetch.ts`** and the **`authFetch()`** in
  **`src/lib/auth.tsx`**: generate `crypto.randomUUID()`, set `x-request-id` on the
  outgoing request, and read the echoed `x-request-id` off the response, attaching
  it to thrown errors as `.requestId`.
- **No toast UI** — the "copy diagnostic code" button is deferred. Capturing
  `.requestId` now (near-free) makes that button a pure-additive follow-up.
- **Follow-up (noted):** the pre-auth raw `fetch()` probes in `lib/api.ts` /
  `lib/auth.tsx` are not wrapped; the two central wrappers cover essentially all
  authenticated traffic.

## 6. Data flow

```
dashboard apiFetch (mint R) ──x-request-id:R──▶ nginx ──▶ orchestrator
  request-id mw adopts R → ALS{R} → every line requestId=R
  └─ ai-gateway.client ──x-request-id:R──▶ ai-gateway
       mw adopts R → ContextVar{R} → every line request_id=R
       └─ provider call extra_headers/headers x-request-id:R
  └─ openwrt.client ──x-request-id:R──▶ routing
       mw adopts R → ContextVar{R} → every line request_id=R
       └─ ubus _post headers x-request-id:R
```

Tick loops have no inbound request, so each mints its own `R'` at tick-start and
threads it downstream (orchestrator cron-runtime; routing apscheduler ticks).

## 7. Error handling & edge cases

- **Invalid / oversized / missing inbound id** → regenerate; never trust verbatim.
- **No context** (startup, gRPC) → `no-request-context` marker (not a crash).
- **Async boundaries** — ALS propagates across Promises/`await` in Node;
  ContextVars copy into asyncio tasks at creation. ai-gateway's `scheduler.py`
  has no such boundary to manage: the enqueued provider call runs in the
  caller's own asyncio task, so no capture/re-set is needed. Documented above.
- **Log injection** — the sanitize regex caps length and forbids control chars, so
  a client- or peer-supplied header cannot forge log lines.

## 8. Testing

| Service | Runner | Cases |
|---|---|---|
| orchestrator | vitest | request-id mw: adopts valid header / regenerates invalid+missing / sets response header / runs `next` inside ALS. cron-runtime wraps a handler with a fresh id (logs grouped). One outbound client includes the header. |
| ai-gateway | pytest | mw adopt+generate+echo (`client` fixture); a log line carries `request_id` (`caplog`); mocked `litellm.acompletion` receives `extra_headers["x-request-id"]`. |
| routing | pytest | mw on a GET + echo (`connected_client` fixture); a `_tick` sets a fresh id and the mocked sampler `httpx.post` carries `x-request-id`. |
| dashboard | vitest | `apiFetch` sets `x-request-id` (mock fetch) and lifts the echoed id onto a thrown error. |

**Manual acceptance (the DoD grep test):**
`curl -H 'x-request-id: probe-warp108' …` to a dashboard-backed route, then
`grep probe-warp108` across the orchestrator, ai-gateway, and routing container
logs and confirm the request appears in all three.

## 9. Acceptance criteria (from the ticket)

- [ ] Every log line across the 3 services includes a request-id (or the explicit
  `no-request-context` marker).
- [ ] Tick-driven logs are grouped by request-id (`tick-start` … `tick-end`).
- [ ] One id can be grepped dashboard click → orchestrator → ai-gateway → routing.

## 10. Out of scope (explicit)

- The dashboard "copy diagnostic code" toast button (ticket part 6, optional) —
  deferred; the response-echo + `.requestId` capture land now so it is additive.
- gRPC **metadata** propagation between orchestrator and ai-gateway — gRPC handlers
  self-seed a fresh id; cross-service gRPC correlation is a follow-up.
- Pre-auth raw `fetch()` probes in the dashboard.
- ai-gateway's existing per-error `correlation_id` is left as-is.
