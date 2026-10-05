/**
 * WARP-3511 — the way between a camera's recordings, settings, notifications
 * and the system page.
 *
 * Camera system answers "what is using my disk"; the answer to "so what do I do
 * about it" is on that camera's own pages, and nothing led there. The two
 * global pages (System, Notifications) also pointed nowhere but back to the
 * grid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { CameraInfo, CameraStorageSummary, CameraSystemStatus } from "@/lib/types";

const h = vi.hoisted(() => ({ role: "owner" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras/system",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  useAuth: () => ({ user: { role: h.role } }),
}));

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

const STORAGE: CameraStorageSummary = {
  volume: {
    path: "/media/frigate/recordings",
    totalBytes: 2 * 1024 ** 4,
    usedBytes: 100 * 1024 ** 3,
    freeBytes: 2 * 1024 ** 4 - 100 * 1024 ** 3,
    usedPercent: 4.9,
  },
  cameras: [
    {
      camera: "front_door",
      usedBytes: 46 * 1024 ** 3,
      bytesPerHour: 1024 ** 3,
      sharePercent: 2.2,
      daysAtCurrentRate: 1.9,
    },
  ],
  nearFull: false,
  recordingsOnBootDisk: false,
  totalBytesPerHour: 1024 ** 3,
};

vi.mock("swr", () => ({
  default: (key: unknown) => {
    if (key === "/api/cameras/system") return { data: STATUS, error: undefined, isLoading: false, mutate: vi.fn() };
    if (key === "/api/cameras/storage") return { data: STORAGE, error: undefined };
    return { data: undefined, error: undefined, mutate: vi.fn(), isValidating: false };
  },
}));

const cameraRow: CameraInfo = {
  name: "front_door",
  displayName: "Front door",
  manufacturer: null,
  model: null,
  ipAddress: "10.0.0.5",
  macAddress: null,
  enabled: true,
  autoDiscovered: false,
  status: "recording",
  lastSeen: new Date().toISOString(),
  lastDetection: null,
};

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({ cameras: [cameraRow], isLoading: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchCameraNotifications: vi.fn().mockResolvedValue({ onPerson: true, onVehicle: true, onAnimal: false, onMotion: false }),
    updateCameraNotifications: vi.fn(),
  };
});

vi.mock("@/components/notifications/PushSubscriptionCard", () => ({ PushSubscriptionCard: () => null }));
vi.mock("@/components/notifications/PushDeliveryChannel", () => ({ PushDeliveryChannel: () => null }));

import CameraSystemPage from "@/app/cameras/system/page";
import NotificationsPage from "@/app/cameras/notifications/page";

beforeEach(() => {
  h.role = "owner";
});
afterEach(cleanup);

describe("Camera system", () => {
  const storageRow = () => screen.getByText("46.0 GiB", { exact: false }).closest("li") as HTMLElement;

  it("links each camera in 'Storage by camera' to that camera's recordings", () => {
    render(<CameraSystemPage />);
    const link = within(storageRow()).getByRole("link", { name: "front_door" });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/recordings");
  });

  it("and, for an owner or admin, to its settings — where retention is set", () => {
    render(<CameraSystemPage />);
    const link = within(storageRow()).getByRole("link", { name: "Settings" });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/settings");
  });

  it("not to settings for a member, who would be refused there", () => {
    h.role = "family";
    render(<CameraSystemPage />);
    expect(within(storageRow()).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(within(storageRow()).getByRole("link", { name: "front_door" })).toBeTruthy();
  });

  it("points to Notifications", () => {
    render(<CameraSystemPage />);
    // The shell has its own Notifications entry; this page's is the one that
    // goes to the CAMERA notifications.
    const hrefs = screen.getAllByRole("link", { name: /Notifications/ }).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/cameras/notifications");
  });

  it("keeps the binary-unit figures it has always shown", () => {
    render(<CameraSystemPage />);
    expect(storageRow().textContent).toContain("46.0 GiB");
    expect(storageRow().textContent).toContain("1.00 GiB/hr");
  });
});

describe("Camera notifications", () => {
  it("points to the Camera system page, where the footage behind the alerts is accounted for", () => {
    render(<NotificationsPage />);
    const hrefs = screen.getAllByRole("link", { name: /System/ }).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/cameras/system");
  });
});
