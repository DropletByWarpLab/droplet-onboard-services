/**
 * WARP-3511 — `useCameras` says when the camera service could not be read.
 *
 * Every camera in a degraded list reports status "offline" because nothing
 * could be asked. That is not the same as every camera being offline, and the
 * pages need one flag to tell the two apart.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { useCameras } from "@/lib/hooks/useCameras";
import { fetchCameras, fetchCameraCandidates, fetchCameraEvents } from "@/lib/api";
import type { CameraInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  fetchCameras: vi.fn(),
  fetchCameraCandidates: vi.fn(),
  fetchCameraEvents: vi.fn(),
  acceptDiscoveredCamera: vi.fn(),
  rejectDiscoveredCamera: vi.fn(),
  enableCamera: vi.fn(),
  disableCamera: vi.fn(),
  removeCamera: vi.fn(),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
    {children}
  </SWRConfig>
);

function cam(name: string, degraded: boolean | undefined): CameraInfo {
  return {
    name,
    displayName: name,
    manufacturer: null,
    model: null,
    ipAddress: "10.0.0.5",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: degraded ? "offline" : "recording",
    lastSeen: new Date().toISOString(),
    lastDetection: null,
    recording:
      degraded === undefined
        ? undefined
        : {
            degraded,
            mode: degraded ? null : "continuous",
            retentionDays: null,
            lastSegmentAt: null,
            usedBytes: null,
            bytesPerDay: null,
          },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchCameraCandidates).mockResolvedValue({ cameras: [], discoveryOnline: true } as never);
  vi.mocked(fetchCameraEvents).mockResolvedValue([]);
});

describe("useCameras().serviceDegraded", () => {
  it("is true when the cameras came back degraded", async () => {
    vi.mocked(fetchCameras).mockResolvedValue([cam("a", true), cam("b", true)]);
    const { result } = renderHook(() => useCameras(), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(2));
    expect(result.current.serviceDegraded).toBe(true);
  });

  it("is false for a healthy list", async () => {
    vi.mocked(fetchCameras).mockResolvedValue([cam("a", false)]);
    const { result } = renderHook(() => useCameras(), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
    expect(result.current.serviceDegraded).toBe(false);
  });

  it("is false for a box that does not send a recording block", async () => {
    vi.mocked(fetchCameras).mockResolvedValue([cam("a", undefined)]);
    const { result } = renderHook(() => useCameras(), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
    expect(result.current.serviceDegraded).toBe(false);
  });

  it("is false before anything has loaded, and with no cameras", async () => {
    vi.mocked(fetchCameras).mockResolvedValue([]);
    const { result } = renderHook(() => useCameras(), { wrapper });
    expect(result.current.serviceDegraded).toBe(false);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.serviceDegraded).toBe(false);
  });
});
