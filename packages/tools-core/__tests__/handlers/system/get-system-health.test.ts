import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getSystemHealth from "../../../src/handlers/system/get-system-health.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

describe("get_system_health", () => {
  it("returns the orchestrator's aggregate-health snapshot", async () => {
    const body = { status: "ok", services: { db: true, redis: true } };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await getSystemHealth.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
    expect(get).toHaveBeenCalledWith("/api/orchestrator/health", expect.anything());
  });

  it("surfaces HEALTH_FAILED on a non-2xx response", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
    const r = await getSystemHealth.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEALTH_FAILED");
      expect(r.error.message).toContain("503");
    }
  });

  it("reads creation readiness as the acting person without sending file credentials", async () => {
    const body = { capabilities: [{ id: "slides", status: "ready" }] };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const ctx = { ...ctxWithGet(get), userId: "alice", ncToken: "private-file-token" };
    expect(await getSystemHealth.handler({ creation: true }, ctx)).toEqual({ ok: true, data: body });
    expect(get).toHaveBeenCalledWith("/api/capabilities/creation", { headers: { Accept: "application/json", "X-Nextcloud-User": "alice" }, signal: ctx.signal });
    expect(JSON.stringify(get.mock.calls)).not.toContain("private-file-token");
  });

  it("rejects missing actor and invalid readiness arguments before requesting anything", async () => {
    const get = vi.fn();
    expect(await getSystemHealth.handler({ creation: true }, ctxWithGet(get))).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(await getSystemHealth.handler({ creation: "yes" }, ctxWithGet(get))).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("preserves readiness route refusals as errors", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }));
    expect(await getSystemHealth.handler({ creation: true }, { ...ctxWithGet(get), userId: "alice" })).toMatchObject({ ok: false, error: { code: "HEALTH_FAILED", message: "creation readiness returned 403" } });
  });
});
