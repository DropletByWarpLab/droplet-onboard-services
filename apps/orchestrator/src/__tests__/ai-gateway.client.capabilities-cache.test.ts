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

/**
 * WARP-2851 review follow-up — the per-turn context-window lookup is FREE on
 * the shipping chat path, and this suite is what keeps it that way.
 *
 * `routes/llm.ts` awaits `getModelContextWindow(agentModel)` before it does
 * four unrelated Prisma reads, which reads like a gateway round-trip newly
 * bolted onto the hot path. It is not one: the SAME request already called
 * `getModelProvider` twice before it gets there — unconditionally, via
 * `decideCloudTurn` and `resolveOffLanProvider` — and `findModelInfo` caches
 * the whole model LIST, not one model's entry. So by the time the window
 * lookup runs, the list is in `_modelsCache` and the call costs no I/O.
 *
 * That is a property of THIS module (list-scoped cache), not of the route, so
 * it is pinned here. Make the cache per-model, or drop the `now` parameter's
 * TTL semantics, and the WARP-2851 lookup silently becomes a real fetch on
 * every turn — including local-only turns that always resolve to the local
 * default and gain nothing from it.
 */
describe("WARP-2851 — the context-window lookup rides the cache the turn already warmed", () => {
  it("costs no extra fetch after the provider lookups the same turn already did", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(modelsResponse({ models: [LLAMA, LLAVA] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    // routes/llm.ts:~990 decideCloudTurn → getModelProvider
    expect(await client.getModelProvider("llama3.1:70b", t0)).toBe("ollama");
    // routes/llm.ts:~1014 resolveOffLanProvider → getModelProvider
    expect(await client.getModelProvider("llama3.1:70b", t0 + 1)).toBe("ollama");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // routes/llm.ts:~1793 the WARP-2851 budget lookup, later in the SAME turn.
    expect(await client.getModelContextWindow("llama3.1:70b", t0 + 2)).toBe(
      131072,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers for a DIFFERENT model than the one that warmed it (vision auto-routing)", async () => {
    // The budget keys off `agentModel`, which vision auto-routing may have
    // swapped for a local VISION_MODEL after the provider lookups ran against
    // `chatReq.model`. A per-model cache would miss here and fetch again; the
    // list-scoped cache does not.
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(modelsResponse({ models: [LLAMA, LLAVA] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    expect(await client.getModelProvider("llama3.1:70b", t0)).toBe("ollama");
    expect(await client.getModelContextWindow("llava:13b", t0 + 2)).toBe(4096);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the window as undefined — not a guess — for a model the list omits", async () => {
    // Still no extra fetch: an unknown id resolves against the cached list and
    // degrades to the local window, it does not re-query the gateway.
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(modelsResponse({ models: [LLAMA] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    expect(await client.getModelProvider("llama3.1:70b", t0)).toBe("ollama");
    expect(
      await client.getModelContextWindow("claude-opus-4", t0 + 2),
    ).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a null published window to undefined (every local model)", async () => {
    // `?? undefined` matters: `null` is what ollama publishes, and a `null`
    // leaking into `resolveTurnContextWindow` as a number would be a window of
    // zero. Pinned here because the ollama fixtures above all carry a number.
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(
      modelsResponse({
        models: [{ ...LLAMA, id: "qwen3:8b", context_window: null }],
      }),
    );
    const client = await freshClient();

    expect(
      await client.getModelContextWindow("qwen3:8b", 1_000_000),
    ).toBeUndefined();
  });
});
