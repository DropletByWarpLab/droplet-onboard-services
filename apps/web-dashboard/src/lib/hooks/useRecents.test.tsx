import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useRecents } from "@/lib/hooks/useRecents";

vi.mock("@/lib/api", () => ({ fetchRecents: vi.fn().mockResolvedValue([]) }));
import { fetchRecents } from "@/lib/api";

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

beforeEach(() => vi.clearAllMocks());

describe("useRecents polling gate", () => {
  it("does not fetch file recents when disabled", () => {
    renderHook(() => useRecents(50, { enabled: false }), { wrapper });
    expect(fetchRecents).not.toHaveBeenCalled();
  });

  it("keeps fetching by default", async () => {
    renderHook(() => useRecents(50), { wrapper });
    await waitFor(() => expect(fetchRecents).toHaveBeenCalledWith(50));
  });

  it("makes no requests through polling or explicit refresh while disabled", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useRecents(8, { enabled: false }), { wrapper });
    try {
      await act(async () => {
        await result.current.refresh();
        await vi.advanceTimersByTimeAsync(45_001);
      });
      expect(fetchRecents).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("stops an active poll when disabled and resumes reads and polling when re-enabled", async () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useRecents(8, { enabled }),
      { wrapper, initialProps: { enabled: true } },
    );
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(fetchRecents).toHaveBeenCalledWith(8);
      const initialCalls = vi.mocked(fetchRecents).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
      expect(vi.mocked(fetchRecents).mock.calls.length).toBeGreaterThan(initialCalls);

      await act(async () => { rerender({ enabled: false }); });
      vi.mocked(fetchRecents).mockClear();
      await act(async () => {
        await result.current.refresh();
        await vi.advanceTimersByTimeAsync(45_001);
      });
      expect(fetchRecents).not.toHaveBeenCalled();

      await act(async () => { rerender({ enabled: true }); });
      // Cached SWR reads revalidate on the next animation frame after the
      // key-change effect commits, rather than during rerender itself.
      await act(async () => { await vi.advanceTimersByTimeAsync(20); });
      expect(fetchRecents).toHaveBeenCalledWith(8);
      const resumedCalls = vi.mocked(fetchRecents).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
      expect(vi.mocked(fetchRecents).mock.calls.length).toBeGreaterThan(resumedCalls);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
});
