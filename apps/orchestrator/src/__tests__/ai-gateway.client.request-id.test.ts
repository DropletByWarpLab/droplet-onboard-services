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
