/**
 * WARP-3048 — `useRefreshLlmModels` refills the shared `/api/llm/models`
 * cache even when no `useModels()` hook is mounted.
 *
 * The /models page is where the active model changes, and neither /chat nor
 * Home is mounted there. SWR 2.5's bare `mutate(key)` only revalidates
 * mounted hooks, so the cache kept the OLD defaultModel and the next
 * client-side visit to /chat opened on it. These tests pin the cache
 * contents a later mount reads on its FIRST render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { ModelsResponse } from "../types";

const fetchModelsMock = vi.fn();
vi.mock("../api", () => ({
  fetchModels: () => fetchModelsMock(),
}));

import { useModels, useRefreshLlmModels } from "./useModels";

function payload(defaultModel: string): ModelsResponse {
  return {
    models: [
      { id: "model-a", name: "Model A", provider: "local" },
      { id: "model-b", name: "Model B", provider: "local" },
    ],
    defaultModel,
  } as unknown as ModelsResponse;
}

function wrapperWith(cache: Map<string, unknown>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig value={{ provider: () => cache as never, dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    );
  };
}

beforeEach(() => {
  fetchModelsMock.mockReset();
});

describe("useRefreshLlmModels (WARP-3048)", () => {
  it("refills the cache so a LATER mount starts on the new defaultModel", async () => {
    const cache = new Map<string, unknown>();
    const wrapper = wrapperWith(cache);

    // /chat (or Home) visited first: the cache learns defaultModel A.
    fetchModelsMock.mockResolvedValue(payload("model-a"));
    const first = renderHook(() => useModels(), { wrapper });
    await vi.waitFor(() =>
      expect(first.result.current.defaultModel).toBe("model-a"),
    );
    first.unmount();

    // On /models (no useModels mounted) the owner switches to B.
    fetchModelsMock.mockResolvedValue(payload("model-b"));
    const picker = renderHook(() => useRefreshLlmModels(), { wrapper });
    await act(async () => {
      await picker.result.current();
    });

    // Back on /chat: the refetch on mount never answers, so whatever the
    // first render shows came from the cache the helper refilled.
    fetchModelsMock.mockReturnValue(new Promise(() => {}));
    const second = renderHook(() => useModels(), { wrapper });
    expect(second.result.current.defaultModel).toBe("model-b");
  });

  it("evicts the entry when the refetch fails, rather than keeping the stale answer", async () => {
    const cache = new Map<string, unknown>();
    const wrapper = wrapperWith(cache);

    fetchModelsMock.mockResolvedValue(payload("model-a"));
    const first = renderHook(() => useModels(), { wrapper });
    await vi.waitFor(() =>
      expect(first.result.current.defaultModel).toBe("model-a"),
    );
    first.unmount();

    fetchModelsMock.mockRejectedValue(new Error("502"));
    const picker = renderHook(() => useRefreshLlmModels(), { wrapper });
    await act(async () => {
      await picker.result.current();
    });

    fetchModelsMock.mockReturnValue(new Promise(() => {}));
    const second = renderHook(() => useModels(), { wrapper });
    // No stale "model-a" — the next mount waits for a real answer.
    expect(second.result.current.defaultModel).toBeNull();
  });
});

// WARP-3048 review — /chat must tell an INCOMPLETE list (the local runtime
// didn't answer, WARP-1284) from a model that really left, so the hook
// surfaces the orchestrator's `degraded` flag instead of dropping it.
describe("useModels — degraded (WARP-3048)", () => {
  it.each([
    [{ degraded: true }, true],
    [{ degraded: false }, false],
    [{}, false],
  ])("maps %o to degraded=%s", async (extra, expected) => {
    const wrapper = wrapperWith(new Map());
    fetchModelsMock.mockResolvedValue({ ...payload("model-a"), ...extra });
    const { result } = renderHook(() => useModels(), { wrapper });
    await vi.waitFor(() => expect(result.current.defaultModel).toBe("model-a"));
    expect(result.current.degraded).toBe(expected);
  });
});
