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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends x-request-id from the active context", async () => {
    const { listModels } = await import("../services/ai-gateway.client.js");
    await runWithRequestId("ctx-req-id-123", () => listModels());
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (call[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-request-id"]).toBe("ctx-req-id-123");
  });

  it("stamps X-Request-Priority only when the caller asks for one (WARP-2749)", async () => {
    const { chat } = await import("../services/ai-gateway.client.js");
    await chat({ model: "m", messages: [] } as never, undefined, undefined, { priority: 10 });
    await chat({ model: "m", messages: [] } as never);
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const withPriority = (calls[0][1]?.headers ?? {}) as Record<string, string>;
    const without = (calls[1][1]?.headers ?? {}) as Record<string, string>;
    expect(withPriority["X-Request-Priority"]).toBe("10");
    expect("X-Request-Priority" in without).toBe(false);
  });
});
