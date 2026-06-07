/**
 * WARP-837 — SWR hooks for the Email surface.
 *
 * Mirrors the useModels/useToolCatalog pattern: each hook wraps a typed api.ts
 * fetcher and surfaces `{ data, error, isLoading }`. These tests mock the api
 * layer and assert (a) the happy data flows through, (b) the filter param is
 * threaded into useEmailThreads' fetcher, (c) errors land on the error channel,
 * and (d) the conditional-key hooks DON'T fetch when their ids are missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const fetchEmailAccounts = vi.fn();
const fetchEmailThreads = vi.fn();
const fetchEmailThread = vi.fn();
const fetchThreadAnalysis = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchEmailAccounts: () => fetchEmailAccounts(),
    fetchEmailThreads: (a: string, f: string) => fetchEmailThreads(a, f),
    fetchEmailThread: (a: string, t: string) => fetchEmailThread(a, t),
    fetchThreadAnalysis: (a: string, t: string) => fetchThreadAnalysis(a, t),
  };
});

import {
  useEmailAccounts,
  useEmailThreads,
  useEmailThread,
  useThreadAnalysis,
} from "@/lib/hooks/useEmail";

// Fresh SWR cache per test so one hook's data can't leak into another's key.
function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  fetchEmailAccounts.mockReset();
  fetchEmailThreads.mockReset();
  fetchEmailThread.mockReset();
  fetchThreadAnalysis.mockReset();
});

describe("useEmailAccounts", () => {
  it("returns accounts from the fetcher", async () => {
    fetchEmailAccounts.mockResolvedValue([
      { id: "a1", address: "me@home.net", imapStatus: "idle" },
    ]);
    const { result } = renderHook(() => useEmailAccounts(), { wrapper });
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));
    expect(result.current.accounts[0].id).toBe("a1");
    expect(result.current.error).toBeUndefined();
  });

  it("surfaces a fetch error on the error channel", async () => {
    fetchEmailAccounts.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useEmailAccounts(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.accounts).toEqual([]);
  });
});

describe("useEmailThreads", () => {
  it("passes the accountId + filter through to the fetcher", async () => {
    fetchEmailThreads.mockResolvedValue([{ id: "t1", subject: "Hi" }]);
    const { result } = renderHook(() => useEmailThreads("acc-1", "triaged"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(fetchEmailThreads).toHaveBeenCalledWith("acc-1", "triaged");
  });

  it("re-fetches with the new filter when it changes", async () => {
    fetchEmailThreads.mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ f }: { f: "inbox" | "triaged" | "droplet" }) =>
        useEmailThreads("acc-1", f),
      { wrapper, initialProps: { f: "inbox" as const } },
    );
    await waitFor(() =>
      expect(fetchEmailThreads).toHaveBeenCalledWith("acc-1", "inbox"),
    );
    rerender({ f: "droplet" });
    await waitFor(() =>
      expect(fetchEmailThreads).toHaveBeenCalledWith("acc-1", "droplet"),
    );
  });

  it("does NOT fetch when accountId is null", async () => {
    const { result } = renderHook(() => useEmailThreads(null, "inbox"), {
      wrapper,
    });
    // Give SWR a tick; it must not call the fetcher with a null key.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchEmailThreads).not.toHaveBeenCalled();
    expect(result.current.threads).toEqual([]);
  });
});

describe("useEmailThread", () => {
  it("fetches the thread detail when both ids are present", async () => {
    fetchEmailThread.mockResolvedValue({
      id: "t1",
      subject: "Hi",
      messages: [{ id: "m1" }],
    });
    const { result } = renderHook(() => useEmailThread("acc-1", "t1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.thread?.id).toBe("t1"));
    expect(fetchEmailThread).toHaveBeenCalledWith("acc-1", "t1");
  });

  it("does NOT fetch when threadId is null (no thread selected)", async () => {
    const { result } = renderHook(() => useEmailThread("acc-1", null), {
      wrapper,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchEmailThread).not.toHaveBeenCalled();
    expect(result.current.thread).toBeUndefined();
  });
});

describe("useThreadAnalysis", () => {
  it("fetches analysis when both ids are present", async () => {
    fetchThreadAnalysis.mockResolvedValue({
      summary: "A summary.",
      callouts: [],
      suggestedActions: [],
      related: { files: [], threads: [], cameras: [], tools: [] },
    });
    const { result } = renderHook(() => useThreadAnalysis("acc-1", "t1"), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.analysis?.summary).toBe("A summary."),
    );
    expect(fetchThreadAnalysis).toHaveBeenCalledWith("acc-1", "t1");
  });

  it("does NOT fetch when threadId is null", async () => {
    renderHook(() => useThreadAnalysis("acc-1", null), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchThreadAnalysis).not.toHaveBeenCalled();
  });

  it("surfaces analysis errors so the panel can show a retry", async () => {
    fetchThreadAnalysis.mockRejectedValue(new Error("503"));
    const { result } = renderHook(() => useThreadAnalysis("acc-1", "t1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.error).toBeDefined());
  });
});
