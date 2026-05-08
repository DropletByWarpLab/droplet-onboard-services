import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const getBrainMemoryItemsMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getBrainMemoryItems: () => getBrainMemoryItemsMock() };
});

import { useBrainStatus } from "@/lib/hooks/useBrainStatus";

describe("useBrainStatus", () => {
  beforeEach(() => {
    getBrainMemoryItemsMock.mockReset();
  });

  it("seeds state from GET /api/files/brain", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "bmi-1",
          filename: "a.wav",
          mimeType: "audio/wav",
          sizeBytes: 100,
          uploadedAt: "2026-05-01",
          status: "queued_for_transcription",
        },
        {
          id: "bmi-2",
          filename: "b.txt",
          mimeType: "text/plain",
          sizeBytes: 50,
          uploadedAt: "2026-05-02",
          status: "ready",
        },
      ],
    });

    const { result } = renderHook(() => useBrainStatus());
    await waitFor(() => {
      expect(result.current.items.size).toBe(2);
    });
    expect(result.current.items.get("bmi-1")?.status).toBe(
      "queued_for_transcription",
    );
    expect(result.current.items.get("bmi-2")?.status).toBe("ready");
  });

  it("merges WS message into state by itemId", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "bmi-1",
          filename: "a.wav",
          mimeType: "audio/wav",
          sizeBytes: 100,
          uploadedAt: "2026-05-01",
          status: "indexing",
        },
      ],
    });

    const { result } = renderHook(() => useBrainStatus());
    await waitFor(() => expect(result.current.items.size).toBe(1));

    act(() => {
      result.current._testInjectWsMessage?.({
        topic: "droplet/files/dev/brain/indexed",
        payload: { itemId: "bmi-1", status: "ready" },
      });
    });

    expect(result.current.items.get("bmi-1")?.status).toBe("ready");
  });

  it("ignores WS messages on unrelated topics", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "bmi-1",
          filename: "a.wav",
          mimeType: "audio/wav",
          sizeBytes: 100,
          uploadedAt: "2026-05-01",
          status: "indexing",
        },
      ],
    });

    const { result } = renderHook(() => useBrainStatus());
    await waitFor(() => expect(result.current.items.size).toBe(1));

    act(() => {
      result.current._testInjectWsMessage?.({
        topic: "droplet/devices/dev/online",
        payload: { itemId: "bmi-1", status: "ready" },
      });
    });

    expect(result.current.items.get("bmi-1")?.status).toBe("indexing");
  });

  it("ignores WS messages without itemId or status", async () => {
    getBrainMemoryItemsMock.mockResolvedValue({
      items: [
        {
          id: "bmi-1",
          filename: "a.wav",
          mimeType: "audio/wav",
          sizeBytes: 100,
          uploadedAt: "2026-05-01",
          status: "indexing",
        },
      ],
    });

    const { result } = renderHook(() => useBrainStatus());
    await waitFor(() => expect(result.current.items.size).toBe(1));

    act(() => {
      result.current._testInjectWsMessage?.({
        topic: "droplet/files/dev/brain/indexed",
        payload: {},
      });
    });

    expect(result.current.items.get("bmi-1")?.status).toBe("indexing");
  });
});
