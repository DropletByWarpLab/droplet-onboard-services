/**
 * WARP-3306 — the client's side of `preempted_for_chat`: the opt-in header,
 * and both shapes of the gateway's answer becoming one typed error.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { isGatewayPreempted } from "../lib/gateway-preempted.js";

const fetchReturning = (res: () => Response) => vi.stubGlobal("fetch", vi.fn(async () => res()));
const PREEMPTED_BODY = JSON.stringify({ detail: { code: "preempted_for_chat", message: "x" } });

afterEach(() => vi.unstubAllGlobals());

describe("ai-gateway client — preempted for chat (WARP-3306)", () => {
  it("sends X-Preemptible only when the caller opts in", async () => {
    fetchReturning(() => new Response("{}", { status: 200 }));
    const { chat } = await import("../services/ai-gateway.client.js");
    await chat({ model: "m", messages: [] } as never, undefined, undefined, { priority: 10, preemptible: true });
    await chat({ model: "m", messages: [] } as never, undefined, undefined, { priority: 10 });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0][1]?.headers as Record<string, string>)["X-Preemptible"]).toBe("1");
    expect("X-Preemptible" in (calls[1][1]?.headers as Record<string, string>)).toBe(false);
  });

  it("a blocking 409 preempted_for_chat throws the typed error", async () => {
    fetchReturning(() => new Response(PREEMPTED_BODY, { status: 409 }));
    const { chat } = await import("../services/ai-gateway.client.js");
    const err = await chat({ model: "m", messages: [] } as never).catch((e) => e);
    expect(isGatewayPreempted(err)).toBe(true);
  });

  it("a stream refused at open with 409 preempted_for_chat throws the typed error", async () => {
    fetchReturning(() => new Response(PREEMPTED_BODY, { status: 409 }));
    const { chatStream } = await import("../services/ai-gateway.client.js");
    const err = await (async () => {
      for await (const _ of chatStream({ model: "m", messages: [] } as never)) void _;
    })().catch((e) => e);
    expect(isGatewayPreempted(err)).toBe(true);
  });

  it("a stream ended by the preempted frame yields what came before, then throws", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"error": {"code": "preempted_for_chat", "message": "x"}}\n\n';
    fetchReturning(() => new Response(sse, { status: 200 }));
    const { chatStream } = await import("../services/ai-gateway.client.js");
    const got: unknown[] = [];
    const err = await (async () => {
      for await (const c of chatStream({ model: "m", messages: [] } as never)) got.push(c);
    })().catch((e) => e);
    expect(got).toHaveLength(1);
    expect(isGatewayPreempted(err)).toBe(true);
  });

  it("other errors are not mistaken for a preemption", async () => {
    fetchReturning(() => new Response('{"detail":"Queue full"}', { status: 429 }));
    const { chat } = await import("../services/ai-gateway.client.js");
    const err = await chat({ model: "m", messages: [] } as never).catch((e) => e);
    expect(isGatewayPreempted(err)).toBe(false);
    expect(String(err)).toMatch(/AI Gateway error 429/);
  });
});
