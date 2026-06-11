/**
 * WARP-860 — auth-header policy of the tool-side Plane client.
 *
 * Every exported client fn now takes a trailing optional `apiKey`
 * (the runtime-provisioned Plane service token forwarded from
 * `ctx.pmApiKey`). `authHeaders` must:
 *
 *   1. prefer the per-call `apiKey` param over the legacy env var;
 *   2. fall back to `process.env.DROPLET_PM_ADMIN_TOKEN` when no param
 *      is given (legacy / HTTP-transport path);
 *   3. send NO X-API-Key header when neither exists — Plane's uniform
 *      401 then surfaces as PlaneApiError(401), same as before.
 *
 * Mock `global.fetch` and inspect the headers on the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { listProjects } from "../../../src/handlers/pm/pm-client.js";

const realFetch = globalThis.fetch;

function mockFetchCapturingHeaders(captured: { apiKey?: string }) {
  const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.apiKey = headers["X-API-Key"];
    return new Response("[]", { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("pm-client authHeaders precedence (WARP-860)", () => {
  beforeEach(() => {
    process.env.DROPLET_PM_API_URL = "http://pm-api:8000";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.DROPLET_PM_API_URL;
    delete process.env.DROPLET_PM_ADMIN_TOKEN;
    vi.restoreAllMocks();
  });

  it("prefers the per-call apiKey param over DROPLET_PM_ADMIN_TOKEN", async () => {
    process.env.DROPLET_PM_ADMIN_TOKEN = "env-token";
    const captured: { apiKey?: string } = {};
    mockFetchCapturingHeaders(captured);

    await listProjects("acme", 10, "param-token");

    expect(captured.apiKey).toBe("param-token");
  });

  it("falls back to DROPLET_PM_ADMIN_TOKEN when no apiKey param is given", async () => {
    process.env.DROPLET_PM_ADMIN_TOKEN = "env-token";
    const captured: { apiKey?: string } = {};
    mockFetchCapturingHeaders(captured);

    await listProjects("acme", 10);

    expect(captured.apiKey).toBe("env-token");
  });

  it("sends no X-API-Key header when neither the param nor the env var is set", async () => {
    const captured: { apiKey?: string } = {};
    mockFetchCapturingHeaders(captured);

    await listProjects("acme", 10);

    expect(captured.apiKey).toBeUndefined();
  });
});
