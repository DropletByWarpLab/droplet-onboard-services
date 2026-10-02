/**
 * WARP-3047 — `getCachedModelListing` is what `resolveActiveModel` reads the
 * installed set from. It MUST be the existing 30 s vision-routing snapshot,
 * not a second cache: the resolver runs inside chat turns and tool
 * back-ends, and two caches would disagree about what is installed for up
 * to a TTL. It must also tell the caller when the list it hands back is a
 * one-off PARTIAL (degraded) list, so the resolver can refuse to trust it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type FetchMock = ReturnType<typeof vi.fn>;

function modelsResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const GPT_OSS = {
  id: "docker.io/ai/gpt-oss:20B-F16",
  provider: "local",
  name: "Gpt-oss 20B F16",
  context_window: null,
  capabilities: { vision: false, tools: true },
};

async function freshClient() {
  vi.resetModules();
  return await import("../services/ai-gateway.client.js");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getCachedModelListing (WARP-3047)", () => {
  it("shares ONE snapshot with the capability lookups — no second gateway call inside the TTL", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValue(modelsResponse({ models: [GPT_OSS] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    const listing = await client.getCachedModelListing(t0);
    expect(listing).toEqual({ models: [GPT_OSS], degradedProviders: [] });
    await client.getModelCapabilities(GPT_OSS.id, t0 + 1_000);
    await client.getCachedModelListing(t0 + 2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a one-off partial list as degraded (and does not cache it)", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValueOnce(
      modelsResponse({ models: [], degraded_providers: ["local"] }),
    );
    fetchMock.mockResolvedValueOnce(modelsResponse({ models: [GPT_OSS] }));
    const client = await freshClient();

    const t0 = 1_000_000;
    expect(await client.getCachedModelListing(t0)).toEqual({
      models: [],
      degradedProviders: ["local"],
    });
    expect(await client.getCachedModelListing(t0 + 1_000)).toEqual({
      models: [GPT_OSS],
      degradedProviders: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a stale-but-complete snapshot over a degraded refresh", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockResolvedValueOnce(modelsResponse({ models: [GPT_OSS] }));
    fetchMock.mockResolvedValueOnce(
      modelsResponse({ models: [], degraded_providers: ["local"] }),
    );
    const client = await freshClient();

    const t0 = 1_000_000;
    await client.getCachedModelListing(t0);
    // Past the 30 s TTL: the refresh is degraded, the old complete list stands.
    expect(await client.getCachedModelListing(t0 + 31_000)).toEqual({
      models: [GPT_OSS],
      degradedProviders: [],
    });
  });

  it("answers null when the gateway is unreachable and nothing was ever cached", async () => {
    const fetchMock = fetch as unknown as FetchMock;
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const client = await freshClient();

    expect(await client.getCachedModelListing(1_000_000)).toBeNull();
  });
});
