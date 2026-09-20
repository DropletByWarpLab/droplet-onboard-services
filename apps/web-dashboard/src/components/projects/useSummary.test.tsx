// useSummary — no request when the Projects module is off (WARP-2875).
//
// /business mounts this hook unconditionally (hooks cannot sit behind a
// condition). On a default box Projects is OFF, so an unguarded key fired a
// guaranteed `module_disabled` 404 on every visit, which SWR then retried on
// backoff and on window focus. The hook takes the capability flag and hands
// useSWR a null key when it is false — exactly how useCrmSummary is told not
// to fetch without a pipeline.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useSummary } from "./usePm";

const authFetchMock = vi.fn((_url: string) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ summary: { open: 1 } }),
  } as unknown as Response),
);

vi.mock("@/lib/auth", () => ({
  authFetch: (url: string) => authFetchMock(url),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSummary(enabled) — WARP-2875", () => {
  it("fetches /api/pm/summary when Projects is on", async () => {
    const { result } = renderHook(() => useSummary(true), { wrapper });
    await waitFor(() => {
      expect(result.current.summary).toBeDefined();
    });
    expect(authFetchMock).toHaveBeenCalledWith("/api/pm/summary");
  });

  it("issues NO request when Projects is off", async () => {
    const { result } = renderHook(() => useSummary(false), { wrapper });
    // Give SWR a tick to fire if it were going to.
    await new Promise((r) => setTimeout(r, 20));
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(result.current.summary).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
