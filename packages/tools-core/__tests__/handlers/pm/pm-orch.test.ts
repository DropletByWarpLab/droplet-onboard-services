/**
 * WARP-887 — callOrch must ABORT the in-flight request when its 8s deadline
 * fires, not just race a rejection while the fetch keeps running (which leaked
 * an open socket per pm_* call under a slow/unresponsive orchestrator).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { callOrch, OrchPmError } from "../../../src/handlers/pm/pm-orch.js";
import type { HttpClient, ToolContext } from "../../../src/types.js";

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// An HttpClient whose GET resolves to a fixed response; other verbs unused here.
function fakeHttp(response: Response): HttpClient {
  return {
    get: async () => response,
    post: async () => response,
    patch: async () => response,
    delete: async () => response,
  } as unknown as HttpClient;
}

function ctxWith(http: HttpClient): ToolContext {
  return { http: { orchestrator: http } } as unknown as ToolContext;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("callOrch (WARP-887)", () => {
  it("aborts the in-flight request on the deadline and throws a 504 (no leaked socket)", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    // Models a hung orchestrator: never resolves on its own; only settles when
    // its request is aborted — exactly the leak the fix targets.
    const http = {
      async get(_path: string, opts?: { signal?: AbortSignal }) {
        seenSignal = opts?.signal;
        return new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        });
      },
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as unknown as HttpClient;

    const p = callOrch(ctxWith(http), "get", "/api/pm/projects");
    // Attach the rejection expectation before advancing so it's never unhandled.
    const expectation = expect(p).rejects.toBeInstanceOf(OrchPmError);
    await vi.advanceTimersByTimeAsync(8000); // fire the deadline -> controller.abort()
    await expectation;
    await expect(p).rejects.toMatchObject({ status: 504 });
    // The underlying request was actually cancelled, not left dangling.
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("passes an un-aborted signal through on a normal (fast) call", async () => {
    let seenSignal: AbortSignal | undefined;
    const http = {
      async get(_path: string, opts?: { signal?: AbortSignal }) {
        seenSignal = opts?.signal;
        return makeResponse(200, { id: "p1", name: "Roadmap" });
      },
    } as unknown as HttpClient;

    const r = await callOrch<{ id: string; name: string }>(
      ctxWith(http),
      "get",
      "/api/pm/projects/p1",
    );
    expect(r).toMatchObject({ id: "p1", name: "Roadmap" });
    expect(seenSignal?.aborted).toBe(false); // deadline cleared, request not cancelled
  });

  it("maps a non-2xx response to OrchPmError with the upstream status", async () => {
    await expect(
      callOrch(ctxWith(fakeHttp(makeResponse(404, { error: "not found" }))), "get", "/api/pm/work-items/x"),
    ).rejects.toMatchObject({ name: "OrchPmError", status: 404 });
  });
});
