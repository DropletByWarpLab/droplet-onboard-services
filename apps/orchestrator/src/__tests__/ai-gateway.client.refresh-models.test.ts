/**
 * WARP-3046 — `refreshModels()`: after a model download succeeds, the
 * orchestrator asks the gateway to drop its 60 s ModelRegistry listing
 * (POST /ai/models/refresh) AND drops its own in-process 30 s model cache.
 *
 * The in-process half matters on its own: `getModelCapabilities` resolves a
 * turn's model from that cache, so without the clear a just-installed vision
 * model reads as "unknown" for its first turns and image routing degrades to
 * the OCR fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type FetchMock = ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GPT_OSS = {
  id: "docker.io/ai/gpt-oss:20B-F16",
  provider: "local",
  name: "gpt-oss",
  capabilities: { vision: false, tools: true },
};
const QWEN_VL = {
  id: "docker.io/ai/qwen3-vl:8B-UD-Q4_K_XL",
  provider: "local",
  name: "qwen3-vl",
  capabilities: { vision: true, tools: true },
};

async function freshClient() {
  // Module-level cache state — a fresh import per test isolates it.
  vi.resetModules();
  return await import("../services/ai-gateway.client.js");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ai-gateway client refreshModels (WARP-3046)", () => {
  it("POSTs /ai/models/refresh", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(json({ status: "invalidated" }));
    const client = await freshClient();

    await client.refreshModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/ai\/models\/refresh$/);
    expect(init.method).toBe("POST");
  });

  it("drops the in-process model cache so a just-pulled model resolves at once", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock
      .mockResolvedValueOnce(json({ models: [GPT_OSS] })) // pre-pull listing
      .mockResolvedValueOnce(json({ status: "invalidated" })) // the refresh
      .mockResolvedValueOnce(json({ models: [GPT_OSS, QWEN_VL] })); // post-pull
    const client = await freshClient();

    const t0 = 1_000_000;
    expect(await client.getModelCapabilities(QWEN_VL.id, t0)).toBeUndefined();

    await client.refreshModels();

    // Well inside the 30 s TTL: without the clear this is still undefined.
    const caps = await client.getModelCapabilities(QWEN_VL.id, t0 + 1_000);
    expect(caps?.vision).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("still drops the in-process cache when the gateway refresh fails, then throws", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock
      .mockResolvedValueOnce(json({ models: [GPT_OSS] }))
      .mockResolvedValueOnce(json({ error: "Invalid or missing service token" }, 401))
      .mockResolvedValueOnce(json({ models: [GPT_OSS, QWEN_VL] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    await client.getModelCapabilities(GPT_OSS.id, t0);
    await expect(client.refreshModels()).rejects.toThrow(/401/);

    const caps = await client.getModelCapabilities(QWEN_VL.id, t0 + 1_000);
    expect(caps?.vision).toBe(true);
  });
});
