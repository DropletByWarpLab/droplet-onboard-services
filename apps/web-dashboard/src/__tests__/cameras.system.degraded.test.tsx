/**
 * With Frigate down the box answers /api/cameras/system with a 200 carrying an
 * all-zero status and `X-Droplet-Degraded`. That used to render as a healthy
 * page of zeros ("0 / 0 cameras live, 0% CPU"). The fetcher now raises the
 * shared "cameras unavailable" error and the page says so instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { CameraSystemStatus } from "@/lib/types";
import { CamerasUnavailableError } from "@/lib/files-unavailable";

const h = vi.hoisted(() => ({ swr: {} as Record<string, unknown> }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/cameras/system",
}));
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn(), useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("swr", () => ({
  default: (key: string) => h.swr[key] ?? { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() },
}));

import CameraSystemPage from "@/app/cameras/system/page";
import { fetchCameraSystemStatus } from "@/lib/api";
import { authFetch } from "@/lib/auth";

const STATUS: CameraSystemStatus = {
  version: "0.17.1",
  uptimeSec: 3600,
  cameraCount: 1,
  camerasLive: 1,
  cameraFps: [],
  detectors: [],
  gpus: [],
  storage: [],
  cpuPct: 5,
};

beforeEach(() => {
  h.swr = {};
});
afterEach(cleanup);

describe("Camera system page when the camera service is down", () => {
  it("says the service is unreachable and shows no stat tiles", () => {
    h.swr["/api/cameras/system"] = {
      data: undefined,
      error: new CamerasUnavailableError(),
      isLoading: false,
      mutate: vi.fn(),
    };
    render(<CameraSystemPage />);

    expect(screen.getByTestId("camera-system-unavailable").textContent).toMatch(
      /camera service is unreachable, so stats are unavailable/i,
    );
    expect(screen.queryByText("Engine")).toBeNull();
    expect(screen.queryByText(/0 \/ 0/)).toBeNull();
  });

  it("does not keep showing the last good stats beside that message", () => {
    h.swr["/api/cameras/system"] = {
      data: STATUS,
      error: new CamerasUnavailableError(),
      isLoading: false,
      mutate: vi.fn(),
    };
    render(<CameraSystemPage />);
    expect(screen.getByTestId("camera-system-unavailable")).toBeTruthy();
    expect(screen.queryByText("Engine")).toBeNull();
  });

  it("any other failure keeps its own wording", () => {
    h.swr["/api/cameras/system"] = {
      data: undefined,
      error: new Error("Failed to fetch system status: 500"),
      isLoading: false,
      mutate: vi.fn(),
    };
    render(<CameraSystemPage />);
    expect(screen.queryByTestId("camera-system-unavailable")).toBeNull();
    expect(screen.getByText(/Failed to fetch system status: 500/)).toBeTruthy();
  });

  it("healthy data renders the tiles and no message", () => {
    h.swr["/api/cameras/system"] = { data: STATUS, error: undefined, isLoading: false, mutate: vi.fn() };
    render(<CameraSystemPage />);
    expect(screen.queryByTestId("camera-system-unavailable")).toBeNull();
    expect(screen.getByText("Engine")).toBeTruthy();
  });
});

describe("fetchCameraSystemStatus", () => {
  it("raises 'cameras unavailable' for a degraded 200, rather than returning the zeroed status", async () => {
    vi.mocked(authFetch).mockResolvedValue(
      new Response(JSON.stringify({ status: { ...STATUS, cameraCount: 0, camerasLive: 0 } }), {
        headers: { "X-Droplet-Degraded": "frigate-unavailable" },
      }),
    );
    await expect(fetchCameraSystemStatus()).rejects.toBeInstanceOf(CamerasUnavailableError);
  });

  it("returns the status for a normal 200", async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ status: STATUS })));
    await expect(fetchCameraSystemStatus()).resolves.toEqual(STATUS);
  });
});
