/**
 * WARP-836 — `useModelsPage()` (the read-only Models surface hook).
 *
 * Mirrors `useModels` but targets `GET /api/models` (the page payload), not
 * `/api/llm/models` (the chat model selector). These tests drive the data
 * mapping against a mocked `fetchModelsPage` so they stay deterministic, and
 * pin the contract that matters for the page: it surfaces `local`/`cloud`
 * arrays + the scalar KPIs, and tolerates an empty `local` list (ai-gateway
 * down) without throwing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { ModelsPagePayload } from "@/lib/types";

const fetchModelsPageMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchModelsPage: (...a: unknown[]) => fetchModelsPageMock(...a),
}));

import { useModelsPage } from "./useModelsPage";

// Fresh SWR cache per render so the shared `/api/models` key doesn't leak
// resolved data between cases (SWR dedupes globally otherwise).
function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

function payload(over: Partial<ModelsPagePayload> = {}): ModelsPagePayload {
  return {
    local: [
      {
        name: "llama3.1:70b",
        family: "llama",
        provider: "ollama",
        contextLength: 131072,
        gbOnDisk: null,
        role: null,
        status: "ready",
        tokensPerSec: null,
        diskBarPct: null,
      },
    ],
    cloud: [
      { provider: "anthropic", enabled: false, lastUsedAt: null, spendUsd: 0 },
      { provider: "openai", enabled: false, lastUsedAt: null, spendUsd: 0 },
      { provider: "gemini", enabled: false, lastUsedAt: null, spendUsd: 0 },
    ],
    gpu: null,
    avgLatencyMs: 0,
    cloudSpendUsd: 0,
    ...over,
  };
}

beforeEach(() => {
  fetchModelsPageMock.mockReset();
});

describe("useModelsPage (WARP-836)", () => {
  it("fetches /api/models and maps the payload through", async () => {
    fetchModelsPageMock.mockResolvedValue(payload());
    const { result } = renderHook(() => useModelsPage(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data?.local).toHaveLength(1);
    expect(result.current.data?.local[0].name).toBe("llama3.1:70b");
    expect(result.current.data?.cloud.map((c) => c.provider)).toEqual([
      "anthropic",
      "openai",
      "gemini",
    ]);
    expect(result.current.data?.cloudSpendUsd).toBe(0);
    expect(result.current.error).toBeUndefined();
  });

  it("tolerates an empty local list (ai-gateway down) without erroring", async () => {
    fetchModelsPageMock.mockResolvedValue(payload({ local: [] }));
    const { result } = renderHook(() => useModelsPage(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The page must still render: empty local, cloud placeholders intact.
    expect(result.current.data?.local).toEqual([]);
    expect(result.current.data?.cloud).toHaveLength(3);
    expect(result.current.error).toBeUndefined();
  });

  it("surfaces a fetch failure on the error channel", async () => {
    fetchModelsPageMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useModelsPage(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.data).toBeUndefined();
  });

  it("exposes a refresh handle for manual revalidation", async () => {
    fetchModelsPageMock.mockResolvedValue(payload());
    const { result } = renderHook(() => useModelsPage(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(typeof result.current.refresh).toBe("function");
  });
});
