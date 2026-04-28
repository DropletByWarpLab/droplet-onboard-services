import { describe, it, expect, vi } from "vitest";
import getSystemHealth from "../../../src/handlers/system/get-system-health.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: ReturnType<typeof vi.fn>): ToolContext {
  return {
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
}

describe("get_system_health", () => {
  it("returns the aggregate-health body", async () => {
    const body = { db: "ok", redis: "ok" };
    const get = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await getSystemHealth.handler({}, ctxWithGet(get));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(body);
    expect(get).toHaveBeenCalledWith("/health/aggregate", expect.anything());
  });
});
