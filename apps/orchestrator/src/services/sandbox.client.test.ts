/**
 * WARP-2895 — the sandbox client.
 *
 *   - no bearer → fails CLOSED before dialling;
 *   - the request carries code, inputs and the SAME deadline / cap the
 *     service will enforce, under the bearer;
 *   - the caller-side deadline holds even when the service never answers
 *     (MUTATION: drop the AbortController and this hangs → red by timeout);
 *   - `{ error }` from the service is relayed verbatim; 503 is "not
 *     configured"; an unreachable service is its own code.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    SANDBOX_URL: "http://sandbox:8030/",
    SANDBOX_SERVICE_TOKEN: "tok",
    SANDBOX_TRANSFORM_TIMEOUT_MS: 200,
    SANDBOX_OUTPUT_CAP_BYTES: 4096,
  },
}));

import { SandboxError, createSandboxTransformer } from "./sandbox.client.js";

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("createSandboxTransformer", () => {
  it("fails closed with no bearer, without dialling", async () => {
    const fetchImpl = vi.fn();
    const t = createSandboxTransformer({ serviceToken: "", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(t.transform("output = 1", {})).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts code, inputs, and the deadline + cap it will itself enforce, under the bearer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { output: { count: 2 } }));
    const t = createSandboxTransformer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(t.transform("output = {'count': 2}", { a: [1, 2] })).resolves.toEqual({ count: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://sandbox:8030/transform");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(init.body))).toEqual({
      code: "output = {'count': 2}",
      inputs: { a: [1, 2] },
      timeoutMs: 200,
      outputCapBytes: 4096,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("holds its own deadline when the service never answers", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const t = createSandboxTransformer({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const started = Date.now();
    await expect(t.transform("while True: pass", {})).rejects.toMatchObject({ code: "TIMEOUT" });
    // 200 ms deadline + 2 s grace; well under a hung-forever fetch.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("relays the service's own error verbatim, and maps 503 / unreachable to their codes", async () => {
    let t = createSandboxTransformer({
      fetchImpl: vi.fn(async () => jsonResponse(200, { error: "output exceeded 4096 bytes" })) as unknown as typeof fetch,
    });
    await expect(t.transform("x", {})).rejects.toThrow("output exceeded 4096 bytes");

    t = createSandboxTransformer({ fetchImpl: vi.fn(async () => jsonResponse(503, { detail: "unset" })) as unknown as typeof fetch });
    await expect(t.transform("x", {})).rejects.toMatchObject({ code: "NOT_CONFIGURED" });

    t = createSandboxTransformer({
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const err = await t.transform("x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe("UNREACHABLE");
  });
});
