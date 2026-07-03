/**
 * WARP-615 — analytics portal wire client (droplet-analytics agent-API).
 *
 * Thin, stateless HTTP I/O: every ingest POST carries the portal's required
 * headers (agent-api.md §0) and a per-request `X-Idempotency-Key` (UUIDv4;
 * the portal dedups on (machine_id, key) for 24h). Callers may supply the
 * key explicitly — WARP-617's buffer reuses ONE key across retries of the
 * SAME batch so a resent events batch never duplicates server-side.
 *
 * Built on `fetch` + `AbortSignal.timeout`, mirroring ai-gateway.client.ts.
 * This class THROWS on failure (AnalyticsApiError / timeout Error) — the
 * fail-open guarantee lives one layer up (index.ts wrapFailOpen), never here,
 * so WARP-616/617 can see 401/429 and react.
 */
import { randomUUID } from "node:crypto";
import type {
  AnalyticsErrorResult,
  AnalyticsEventsResult,
  AnalyticsHeartbeatBody,
  AnalyticsMetricSample,
  AnalyticsWireError,
  AnalyticsWireEvent,
} from "./types.js";

/**
 * Same budget rationale as ai-gateway.client.ts's DEFAULT_GATEWAY_TIMEOUT_MS:
 * the portal is a small ingest API — anything over 10 s is broken upstream,
 * and failing fast keeps the (future) flush crons from stacking hung batches.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface AnalyticsClientOptions {
  /** Portal base URL including the version path, e.g. `https://analytics.warp-lab.ai/api/v1`. */
  baseUrl: string;
  /** Bearer ingest token (`dpl_<machineId>_<secret>`). Never logged. */
  ingestToken: string;
  /** The portal's machine UUID — must match the token's machine (§0). */
  dropletId: string;
  /** Firmware/orchestrator version reported as `X-Droplet-FW`. */
  firmwareVersion: string;
  timeoutMs?: number;
}

/**
 * Portal error envelope `{ error: { code, message, details } }` mapped onto
 * a typed Error. 429 carries `retryAfterMs` (parsed from `Retry-After`,
 * seconds or HTTP-date form) so the flush layer can back off; 401 is flagged
 * via `isAuthError` so WARP-616 can trigger its one re-registration attempt.
 */
export class AnalyticsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    retryAfterMs?: number;
  }) {
    super(args.message);
    this.name = "AnalyticsApiError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
    this.retryAfterMs = args.retryAfterMs;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Extract the portal machine id from an ingest token
 * (`dpl_<machineId>_<secret>`, agent-api.md §0). The machine id itself never
 * contains `_`; the base64url secret MAY, so only the first two separators
 * split. Returns null on malformed input — callers fall back to a configured
 * id (and WARP-616's persisted AnalyticsIdentity supersedes this entirely).
 */
export function machineIdFromIngestToken(token: string): string | null {
  const match = /^dpl_([^_]+)_.+$/.exec(token);
  return match ? match[1] : null;
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/** True when `err` is the abort thrown by an `AbortSignal.timeout` firing. */
function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "TimeoutError" || name === "AbortError";
}

async function toApiError(res: Response): Promise<AnalyticsApiError> {
  // Fallbacks for a body that isn't the documented envelope (nginx 502
  // page, empty body, …) — the status code is still actionable.
  let code = `HTTP_${res.status}`;
  let message = `analytics portal error ${res.status}`;
  let details: unknown;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body?.error) {
      if (typeof body.error.code === "string") code = body.error.code;
      if (typeof body.error.message === "string") message = body.error.message;
      details = body.error.details;
    }
  } catch {
    // Non-JSON body — keep the fallbacks.
  }
  return new AnalyticsApiError({
    status: res.status,
    code,
    message,
    details,
    retryAfterMs:
      res.status === 429
        ? parseRetryAfterMs(res.headers.get("retry-after"))
        : undefined,
  });
}

export class AnalyticsClient {
  private readonly baseUrl: string;
  private readonly ingestToken: string;
  private readonly dropletId: string;
  private readonly firmwareVersion: string;
  private readonly timeoutMs: number;

  constructor(opts: AnalyticsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.ingestToken = opts.ingestToken;
    this.dropletId = opts.dropletId;
    this.firmwareVersion = opts.firmwareVersion;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /agents/heartbeat (§2) — 204 on success; idempotent on (machine, ts). */
  async postHeartbeat(
    body: AnalyticsHeartbeatBody,
    opts?: { idempotencyKey?: string },
  ): Promise<void> {
    await this.post("/agents/heartbeat", body, opts);
  }

  /** POST /agents/metrics (§3) — batched samples, ≤5000 per request, 204. */
  async postMetrics(
    samples: AnalyticsMetricSample[],
    opts?: { idempotencyKey?: string },
  ): Promise<void> {
    await this.post("/agents/metrics", { samples }, opts);
  }

  /** POST /agents/events (§4) — batched events, ≤100 per request. */
  async postEvents(
    events: AnalyticsWireEvent[],
    opts?: { idempotencyKey?: string },
  ): Promise<AnalyticsEventsResult> {
    const res = await this.post("/agents/events", { events }, opts);
    return (await res.json()) as AnalyticsEventsResult;
  }

  /** POST /agents/errors (§5) — single report; portal dedups on fingerprint. */
  async postError(
    report: AnalyticsWireError,
    opts?: { idempotencyKey?: string },
  ): Promise<AnalyticsErrorResult> {
    const res = await this.post("/agents/errors", report, opts);
    return (await res.json()) as AnalyticsErrorResult;
  }

  private async post(
    path: string,
    body: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.ingestToken}`,
          "X-Droplet-Id": this.dropletId,
          "X-Droplet-FW": this.firmwareVersion,
          "X-Idempotency-Key": opts?.idempotencyKey ?? randomUUID(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new Error(
          `analytics portal timeout after ${this.timeoutMs}ms during POST ${path}`,
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }
}
