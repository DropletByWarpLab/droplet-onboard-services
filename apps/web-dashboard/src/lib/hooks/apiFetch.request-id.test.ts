import { describe, it, expect, vi, afterEach } from "vitest";
import { apiFetch, type TypedError } from "./apiFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch x-request-id", () => {
  it("sends a generated x-request-id header", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
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
