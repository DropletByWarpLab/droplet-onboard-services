/**
 * WARP-3511 — the cameras grid at /cameras.
 *
 *  - Each tile has a settings gear for owners and admins, and none for anyone
 *    else (the box refuses a member's PATCH, so a gear would lead to a refusal).
 *    It goes to that camera's settings, not its detail screen.
 *  - While the camera service cannot be read the page says so once, above the
 *    grid, instead of letting every tile read Offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CameraInfo, CameraRecordingState } from "@/lib/types";

const h = vi.hoisted(() => ({
  role: "owner",
  push: vi.fn(),
  cameras: [] as CameraInfo[],
  serviceDegraded: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: h.role } }),
}));

vi.mock("swr", () => ({
  default: () => ({ data: undefined, mutate: vi.fn(), isValidating: false }),
}));

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({
    cameras: h.cameras,
    discovered: [],
    discoveryOnline: true,
    recentEvents: [],
    totalCameras: h.cameras.length,
    serviceDegraded: h.serviceDegraded,
    isLoading: false,
    isRefreshing: false,
    error: undefined,
    refresh: vi.fn(),
    setDiscovered: vi.fn(),
    acceptCamera: vi.fn(),
    rejectCamera: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useCameraEvents", () => ({
  useCameraEvents: () => ({ notifications: [], dismissNotification: vi.fn() }),
}));

vi.mock("@/lib/hooks/useCameraGroups", () => ({
  useCameraGroups: () => ({
    groups: [],
    create: vi.fn(),
    rename: vi.fn(),
    setIcon: vi.fn(),
    addMembers: vi.fn(),
    removeMember: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/useCameraPins", () => ({
  useCameraPins: () => ({ pins: [], pinnedSet: new Set<string>(), toggle: vi.fn() }),
}));

import CamerasPage from "@/app/cameras/page";

function rec(over: Partial<CameraRecordingState> = {}): CameraRecordingState {
  return {
    degraded: false,
    mode: "continuous",
    retentionDays: { continuous: 11, motion: 0, alerts: 0, detections: 0 },
    lastSegmentAt: new Date(Date.now() - 8_000).toISOString(),
    usedBytes: 3 * 1024 ** 3,
    bytesPerDay: null,
    ...over,
  };
}

function cam(name: string, over: Partial<CameraInfo> = {}): CameraInfo {
  return {
    name,
    displayName: name.replace(/_/g, " "),
    manufacturer: null,
    model: null,
    ipAddress: "10.10.0.5",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: "recording",
    lastSeen: new Date().toISOString(),
    lastDetection: null,
    recording: rec(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "owner";
  h.cameras = [cam("front_door"), cam("garage")];
  h.serviceDegraded = false;
});
afterEach(cleanup);

describe("the settings gear on each tile", () => {
  it("an owner sees one per camera, named for its camera", () => {
    render(<CamerasPage />);
    expect(screen.getByRole("button", { name: "Settings for front door" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settings for garage" })).toBeTruthy();
  });

  it("an admin sees them too", () => {
    h.role = "admin";
    render(<CamerasPage />);
    expect(screen.getAllByRole("button", { name: /^Settings for / })).toHaveLength(2);
  });

  it("a member sees none — and still sees the tiles", () => {
    h.role = "family";
    render(<CamerasPage />);
    expect(screen.queryByRole("button", { name: /^Settings for / })).toBeNull();
    expect(screen.getByText("front door")).toBeTruthy();
  });

  it("opens that camera's settings, not its detail screen", () => {
    render(<CamerasPage />);
    fireEvent.click(screen.getByRole("button", { name: "Settings for garage" }));
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledWith("/cameras/garage/settings");
  });

  it("a tile click still opens the detail screen", () => {
    render(<CamerasPage />);
    // The tile's own name (the card is a role=button wrapper, so a click on
    // anything inside it that is not a control bubbles to it).
    fireEvent.click(screen.getByText("front door", { selector: "h3" }));
    expect(h.push).toHaveBeenCalledWith("/cameras/front_door");
  });
});

describe("the tile's recording line", () => {
  it("shows the mode chip for each camera", () => {
    h.cameras = [cam("front_door"), cam("garage", { recording: rec({ mode: "motion" }) })];
    render(<CamerasPage />);
    expect(screen.getAllByTestId("recording-mode-chip").map((c) => c.textContent)).toEqual(["24/7", "Motion"]);
  });
});

describe("when the camera service cannot be read", () => {
  const down = (name: string) =>
    cam(name, {
      status: "offline",
      recording: rec({ degraded: true, mode: null, retentionDays: null, lastSegmentAt: null, usedBytes: null }),
    });

  beforeEach(() => {
    h.cameras = [down("front_door"), down("garage")];
    h.serviceDegraded = true;
  });

  it("says so once, above the grid", () => {
    render(<CamerasPage />);
    expect(screen.getAllByTestId("camera-service-notice")).toHaveLength(1);
    expect(screen.getByText("Camera service restarting…")).toBeTruthy();
  });

  it("no tile says Offline — they say their status is unavailable", () => {
    render(<CamerasPage />);
    expect(screen.queryByText("Offline")).toBeNull();
    // Scoped to the tiles: the page chrome has its own, unrelated status chip.
    expect(screen.getAllByTestId("status-badge").map((b) => b.textContent)).toEqual([
      "Status unavailable",
      "Status unavailable",
    ]);
  });

  it("the gear is still there, so settings stay reachable", () => {
    render(<CamerasPage />);
    expect(screen.getAllByRole("button", { name: /^Settings for / })).toHaveLength(2);
  });
});

describe("when the service is fine", () => {
  it("there is no banner", () => {
    render(<CamerasPage />);
    expect(screen.queryByTestId("camera-service-notice")).toBeNull();
  });
});
