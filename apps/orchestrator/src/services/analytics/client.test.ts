/**
 * WARP-615 — analytics portal wire client.
 *
 * Pins the droplet-analytics agent-API contract (agent-api.md §0/§2–§5/§11):
 *   - required headers on every ingest POST: `Authorization: Bearer <token>`,
 *     `X-Droplet-Id`, `X-Droplet-FW`, `X-Idempotency-Key` (client-picked
 *     UUIDv4; the portal dedups on (machine_id, key) for 24h),
 *   - endpoint paths under the configured base URL,
 *   - the standard error envelope `{ error: { code, message, details } }`,
 *   - `429` with `Retry-After` (seconds AND HTTP-date forms),
 *   - `401` flagged distinctly so WARP-616 can trigger re-registration,
 *   - `AbortSignal.timeout` on every call (mirror of ai-gateway.client.ts).
 *
 * All against a mocked global fetch — no portal needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AnalyticsApiError,
  AnalyticsClient,
  machineIdFromIngestToken,
} from "./client.js";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeClient(
  overrides: Partial<ConstructorParameters<typeof AnalyticsClient>[0]> = {},
): AnalyticsClient {
  return new AnalyticsClient({
    baseUrl: "http://portal.test/api/v1",
    ingestToken: "dpl_mach-1_s3cret",
    dropletId: "mach-1",
    firmwareVersion: "0.1.0",
    ...overrides,
  });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

const fetchMock = vi.fn();

function lastFetchCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return { url: call[0] as string, init: call[1] as RequestInit };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnalyticsClient — required headers", () => {
  it("sends Authorization, X-Droplet-Id, X-Droplet-FW, X-Idempotency-Key and JSON Content-Type on every ingest POST", async () => {
    fetchMock.mockResolvedValueOnce(noContent());
    await makeClient().postMetrics([
      { ts: "2026-07-02T00:00:00Z", name: "net.wan.in_bps", value: 1 },
    ]);

    const { init } = lastFetchCall();
    const headers = headersOf(init);
    expect(init.method).toBe("POST");
    expect(headers["Authorization"]).toBe("Bearer dpl_mach-1_s3cret");
    expect(headers["X-Droplet-Id"]).toBe("mach-1");
    expect(headers["X-Droplet-FW"]).toBe("0.1.0");
    expect(headers["X-Idempotency-Key"]).toMatch(UUID_V4_RE);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("picks a fresh idempotency key per request", async () => {
    fetchMock.mockResolvedValue(noContent());
    const client = makeClient();
    await client.postMetrics([]);
    await client.postMetrics([]);
    const [first, second] = fetchMock.mock.calls.map(
      (c) => headersOf(c[1] as RequestInit)["X-Idempotency-Key"],
    );
    expect(first).not.toBe(second);
  });

  it("honours an explicit idempotency key (WARP-617 batch-retry seam: same batch ⇒ same key)", async () => {
    fetchMock.mockResolvedValueOnce(noContent());
    const key = "0f37c1f2-9d2e-4f5b-8a3c-2f75f9f1a111";
    await makeClient().postMetrics([], { idempotencyKey: key });
    expect(headersOf(lastFetchCall().init)["X-Idempotency-Key"]).toBe(key);
  });

  it("attaches an AbortSignal so a hung portal cannot wedge the caller", async () => {
    fetchMock.mockResolvedValueOnce(noContent());
    await makeClient().postMetrics([]);
    expect(lastFetchCall().init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("AnalyticsClient — endpoint paths & payloads", () => {
  it("POSTs metrics batches to /agents/metrics as { samples } and resolves on 204", async () => {
    fetchMock.mockResolvedValueOnce(noContent());
    const samples = [
      {
        ts: "2026-07-02T00:00:00Z",
        name: "service.health",
        value: 1,
        labels: { service: "redis" },
      },
    ];
    await expect(makeClient().postMetrics(samples)).resolves.toBeUndefined();

    const { url, init } = lastFetchCall();
    expect(url).toBe("http://portal.test/api/v1/agents/metrics");
    expect(JSON.parse(init.body as string)).toEqual({ samples });
  });

  it("POSTs event batches to /agents/events and returns the accepted/rejected result", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { accepted: 2, rejected: [] }),
    );
    const events = [
      {
        ts: "2026-07-02T00:00:00Z",
        type: "service.down",
        severity: "error" as const,
        target: "service:redis",
      },
      {
        ts: "2026-07-02T00:00:05Z",
        type: "service.up",
        severity: "info" as const,
        target: "service:redis",
      },
    ];
    const result = await makeClient().postEvents(events);

    const { url, init } = lastFetchCall();
    expect(url).toBe("http://portal.test/api/v1/agents/events");
    expect(JSON.parse(init.body as string)).toEqual({ events });
    expect(result).toEqual({ accepted: 2, rejected: [] });
  });

  it("POSTs a single error report to /agents/errors and returns the dedup result", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { error_id: "err_1", count: 7, deduped: true }),
    );
    const report = {
      ts: "2026-07-02T00:00:00Z",
      severity: "critical" as const,
      fingerprint: "9a3c",
      service: "ai-gateway",
      title: "Inference failed",
      message: "scrubbed",
    };
    const result = await makeClient().postError(report);

    const { url, init } = lastFetchCall();
    expect(url).toBe("http://portal.test/api/v1/agents/errors");
    expect(JSON.parse(init.body as string)).toEqual(report);
    expect(result).toEqual({ error_id: "err_1", count: 7, deduped: true });
  });

  it("POSTs heartbeats to /agents/heartbeat and resolves on 204", async () => {
    fetchMock.mockResolvedValueOnce(noContent());
    await expect(
      makeClient().postHeartbeat({ ts: "2026-07-02T00:00:00Z", uptime_s: 12 }),
    ).resolves.toBeUndefined();
    expect(lastFetchCall().url).toBe(
      "http://portal.test/api/v1/agents/heartbeat",
    );
  });

  it("normalizes a trailing slash on the base URL", async () => {
    fetchMock.mockResolvedValueOnce(noContent());
    await makeClient({ baseUrl: "http://portal.test/api/v1/" }).postMetrics(
      [],
    );
    expect(lastFetchCall().url).toBe(
      "http://portal.test/api/v1/agents/metrics",
    );
  });
});

describe("AnalyticsClient — error envelope, 429, 401, timeout", () => {
  it("parses the standard error envelope into AnalyticsApiError (code, message, details, status)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: {
          code: "VALIDATION",
          message: "geoRegion must not be empty",
          details: { field: "geoRegion" },
        },
      }),
    );
    const err = await makeClient()
      .postMetrics([])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AnalyticsApiError);
    const apiErr = err as AnalyticsApiError;
    expect(apiErr.status).toBe(422);
    expect(apiErr.code).toBe("VALIDATION");
    expect(apiErr.message).toBe("geoRegion must not be empty");
    expect(apiErr.details).toEqual({ field: "geoRegion" });
  });

  it("survives a non-JSON error body with an HTTP_<status> fallback code", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const err = (await makeClient()
      .postMetrics([])
      .catch((e: unknown) => e)) as AnalyticsApiError;

    expect(err).toBeInstanceOf(AnalyticsApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("HTTP_502");
  });

  it("parses a seconds-form Retry-After on 429 into retryAfterMs", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        429,
        { error: { code: "RATE_LIMITED", message: "slow down" } },
        { "Retry-After": "30" },
      ),
    );
    const err = (await makeClient()
      .postEvents([])
      .catch((e: unknown) => e)) as AnalyticsApiError;

    expect(err.status).toBe(429);
    expect(err.isRateLimited).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("parses an HTTP-date Retry-After on 429 into a non-negative retryAfterMs", async () => {
    const inSixtySeconds = new Date(Date.now() + 60_000).toUTCString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        429,
        { error: { code: "RATE_LIMITED", message: "slow down" } },
        { "Retry-After": inSixtySeconds },
      ),
    );
    const err = (await makeClient()
      .postEvents([])
      .catch((e: unknown) => e)) as AnalyticsApiError;

    expect(err.retryAfterMs).toBeGreaterThan(50_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(61_000);
  });

  it("leaves retryAfterMs undefined when the 429 has no Retry-After header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { error: { code: "RATE_LIMITED", message: "later" } }),
    );
    const err = (await makeClient()
      .postEvents([])
      .catch((e: unknown) => e)) as AnalyticsApiError;
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("flags 401 as an auth error so WARP-616 can trigger re-registration", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, {
        error: { code: "INVALID_TOKEN", message: "unknown machine token" },
      }),
    );
    const err = (await makeClient()
      .postError({
        ts: "2026-07-02T00:00:00Z",
        severity: "error",
        fingerprint: "f",
        service: "s",
        title: "t",
        message: "m",
      })
      .catch((e: unknown) => e)) as AnalyticsApiError;

    expect(err.isAuthError).toBe(true);
    expect(err.status).toBe(401);
    expect(err.code).toBe("INVALID_TOKEN");
    expect(err.isRateLimited).toBe(false);
  });

  it("wraps an AbortSignal.timeout abort into a clear timeout error", async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );
    const err = (await makeClient()
      .postMetrics([])
      .catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timeout/i);
    expect(err.message).toContain("/agents/metrics");
  });
});

describe("machineIdFromIngestToken", () => {
  it("extracts the machine id from a dpl_<machineId>_<secret> token (secret may contain base64url underscores)", () => {
    expect(machineIdFromIngestToken("dpl_01J9MZ_abc-_def")).toBe("01J9MZ");
  });

  it("returns null for malformed tokens", () => {
    expect(machineIdFromIngestToken("")).toBeNull();
    expect(machineIdFromIngestToken("dpl_only-one-part")).toBeNull();
    expect(machineIdFromIngestToken("not-a-token")).toBeNull();
  });
});
