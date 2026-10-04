/**
 * WARP-3515 — the one hook behind every Recording storage surface.
 *
 * It turns "what the orchestrator answered" into a single state a surface can
 * branch on, and the distinctions matter: an endpoint that is not there yet, a
 * role that may not read it, a fetch that failed and a first load still in
 * flight each call for different words (or none). `enabled: false` is how a
 * family account — which gets a 403 on this route — never issues the request at
 * all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { RecordingStorage } from "../types";

vi.mock("../api", () => ({ fetchRecordingStorage: vi.fn() }));

import { fetchRecordingStorage } from "../api";
import { useRecordingStorage } from "./useRecordingStorage";

const fetchMock = vi.mocked(fetchRecordingStorage);

const data = { status: "active" } as unknown as RecordingStorage;

function wrapper({ children }: { children: ReactNode }) {
  // A fresh cache per test, and no dedupe window, so one test's answer never
  // leaks into the next.
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("useRecordingStorage", () => {
  it("starts in `loading`, then is `ready` with the recording", async () => {
    fetchMock.mockResolvedValue({ available: true, data });
    const { result } = renderHook(() => useRecordingStorage(), { wrapper });
    expect(result.current.state).toBe("loading");
    expect(result.current.recording).toBeNull();
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.recording).toBe(data);
  });

  it("is `not_supported` when the endpoint is absent — no recording, not an error", async () => {
    fetchMock.mockResolvedValue({ available: false, reason: "not_supported" });
    const { result } = renderHook(() => useRecordingStorage(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("not_supported"));
    expect(result.current.recording).toBeNull();
  });

  it("is `forbidden` when the role may not read it", async () => {
    fetchMock.mockResolvedValue({ available: false, reason: "forbidden" });
    const { result } = renderHook(() => useRecordingStorage(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("forbidden"));
  });

  it("is `error` when the fetch itself fails — distinct from 'not available'", async () => {
    fetchMock.mockRejectedValue(new Error("502"));
    const { result } = renderHook(() => useRecordingStorage(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.recording).toBeNull();
  });

  it("keeps cached facts marked stale after refresh fails, then clears stale after recovery", async () => {
    fetchMock
      .mockResolvedValueOnce({ available: true, data })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ available: true, data });
    const { result } = renderHook(() => useRecordingStorage(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.stale).toBe(false);

    await act(async () => {
      await result.current.refresh().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.recording).toBe(data);

    await act(async () => {
      await result.current.refresh().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.stale).toBe(false));
    expect(result.current.recording).toBe(data);
  });

  it("with `enabled: false` it is `forbidden` and never fetches (a family account's 403 is never provoked)", async () => {
    const { result } = renderHook(() => useRecordingStorage({ enabled: false }), { wrapper });
    expect(result.current.state).toBe("forbidden");
    expect(result.current.recording).toBeNull();
    expect(result.current.stale).toBe(false);
    // Give any stray request a chance to fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches by default (enabled defaults to true)", async () => {
    fetchMock.mockResolvedValue({ available: true, data });
    renderHook(() => useRecordingStorage(), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
