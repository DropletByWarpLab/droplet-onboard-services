/**
 * /cameras: the sub-nav's Recordings chip is fed the page's own camera list,
 * and People / Plates say what they now lead with.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { CameraInfo } from "@/lib/types";

const h = vi.hoisted(() => ({ names: ["front_door"] as string[] }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/cameras",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn(), useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("swr", () => ({ default: () => ({ data: undefined, mutate: vi.fn(), isValidating: false }) }));

const camera = (name: string): CameraInfo => ({
  name,
  displayName: name.replace(/_/g, " "),
  manufacturer: null,
  model: null,
  ipAddress: "10.10.0.5",
  macAddress: null,
  enabled: true,
  autoDiscovered: false,
  status: "live",
  lastSeen: new Date().toISOString(),
  lastDetection: null,
});

vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({
    cameras: h.names.map(camera),
    discovered: [],
    discoveryOnline: true,
    recentEvents: [],
    totalCameras: h.names.length,
    serviceDegraded: false,
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
    groups: [], create: vi.fn(), rename: vi.fn(), setIcon: vi.fn(),
    addMembers: vi.fn(), removeMember: vi.fn(), remove: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/useCameraPins", () => ({
  useCameraPins: () => ({ pins: [], pinnedSet: new Set(), toggle: vi.fn() }),
}));

import CamerasPage from "@/app/cameras/page";

afterEach(() => {
  cleanup();
  h.names = ["front_door"];
});

describe("/cameras sub-nav", () => {
  it("one camera: Recordings links straight to it, before Birdseye", () => {
    const { container } = render(<CamerasPage />);
    const row = container.querySelector(".chiprow") as HTMLElement;
    const link = within(row).getByRole("link", { name: /recordings/i });
    expect(link.getAttribute("href")).toBe("/cameras/front_door/recordings");
    const labels = Array.from(row.querySelectorAll(".chip"), (c) => c.textContent?.trim());
    expect(labels.indexOf("Recordings")).toBeLessThan(labels.indexOf("Birdseye"));
  });

  it("several cameras: Recordings opens a picker", () => {
    h.names = ["front_door", "garage"];
    const { container } = render(<CamerasPage />);
    const row = container.querySelector(".chiprow") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /recordings/i }));
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((a) => a.getAttribute("href"))).toEqual([
      "/cameras/front_door/recordings",
      "/cameras/garage/recordings",
    ]);
  });

  it("no cameras: Recordings is disabled", () => {
    h.names = [];
    const { container } = render(<CamerasPage />);
    const row = container.querySelector(".chiprow") as HTMLElement;
    expect((within(row).getByRole("button", { name: /recordings/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("People and Plates titles say they lead with detections", () => {
    const { container } = render(<CamerasPage />);
    const row = container.querySelector(".chiprow") as HTMLElement;
    expect(within(row).getByRole("link", { name: /people/i }).getAttribute("title")).toBe(
      "People detections and known faces",
    );
    expect(within(row).getByRole("link", { name: /plates/i }).getAttribute("title")).toBe(
      "Vehicle detections and license plates",
    );
  });
});
