/**
 * WARP-1289 (fold-in) — the vision-routing model cache in
 * ai-gateway.client.ts must consult `degraded_providers` before caching a
 * listing. Without that, a degraded fan-out (Ollama down for one blip)
 * would be snapshotted for the full 30s TTL: models that are actually
 * installed read as "unknown capabilities" (vision routing degrades to
 * OCR-fallback) until the stale partial list ages out.
 *
 * Rules pinned here:
 *   1. A clean listing is cached (second call within TTL → no re-fetch).
 *   2. A degraded listing is NEVER cached — the next call re-queries.
 *   3. A degraded listing never clobbers a previously cached clean list;
 *      the stale-but-complete snapshot keeps serving lookups.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type FetchMock = ReturnType<typeof vi.fn>;

function modelsResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const LLAMA = {
  id: "llama3.1:70b",
  provider: "ollama",
  name: "llama3.1:70b",
  context_window: 131072,
  capabilities: { vision: false, tools: true },
};
const LLAVA = {
  id: "llava:13b",
  provider: "ollama",
  name: "llava:13b",
  context_window: 4096,
  capabilities: { vision: true },
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

describe("ai-gateway client capabilities cache vs degraded_providers (WARP-1289)", () => {
  it("caches a clean listing — second lookup within TTL does not re-fetch", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(modelsResponse({ models: [LLAVA] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    const caps1 = await client.getModelCapabilities("llava:13b", t0);
    expect(caps1?.vision).toBe(true);
    const caps2 = await client.getModelCapabilities("llava:13b", t0 + 5_000);
    expect(caps2?.vision).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a degraded listing — the next lookup re-queries", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    // First fan-out: ollama raised — partial list, degraded_providers set.
    fetchMock.mockResolvedValueOnce(
      modelsResponse({ models: [], degraded_providers: ["ollama"] }),
    );
    // Second fan-out: ollama recovered.
    fetchMock.mockResolvedValueOnce(modelsResponse({ models: [LLAVA] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    const caps1 = await client.getModelCapabilities("llava:13b", t0);
    expect(caps1).toBeUndefined(); // genuinely unknown during the blip
    // 5s later — well inside the 30s TTL. A cached degraded snapshot would
    // still answer "unknown"; the fix re-queries and finds the model.
    const caps2 = await client.getModelCapabilities("llava:13b", t0 + 5_000);
    expect(caps2?.vision).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still resolves lookups from the degraded partial list (one-off, uncached)", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(
      modelsResponse({ models: [LLAVA], degraded_providers: ["openai"] }),
    );
    const client = await freshClient();

    const caps = await client.getModelCapabilities("llava:13b", 1_000_000);
    expect(caps?.vision).toBe(true);
  });

  it("a degraded listing never clobbers a previously cached clean list", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValueOnce(
      modelsResponse({ models: [LLAMA, LLAVA] }),
    );
    fetchMock.mockResolvedValue(
      modelsResponse({ models: [], degraded_providers: ["ollama"] }),
    );
    const client = await freshClient();

    const t0 = 1_000_000;
    const caps1 = await client.getModelCapabilities("llava:13b", t0);
    expect(caps1?.vision).toBe(true);
    // TTL expired → refresh happens and comes back degraded/empty. The
    // stale-but-complete snapshot must keep serving (same posture as the
    // existing catch-path: serve stale rather than fail the turn).
    const caps2 = await client.getModelCapabilities("llava:13b", t0 + 60_000);
    expect(caps2?.vision).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
