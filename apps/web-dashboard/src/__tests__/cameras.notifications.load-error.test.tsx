/**
 * A failed per-camera read of notification settings was swallowed in an empty
 * branch, leaving the row on "Loading…" forever. It now says what failed, for
 * which camera, and offers a Retry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import type { CameraInfo } from "@/lib/types";

const api = vi.hoisted(() => ({ fetchCameraNotifications: vi.fn(), updateCameraNotifications: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/cameras/notifications",
}));
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn(), useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/notifications/PushSubscriptionCard", () => ({ PushSubscriptionCard: () => null }));
vi.mock("@/components/notifications/PushDeliveryChannel", () => ({ PushDeliveryChannel: () => null }));

const cam = (name: string, displayName: string): CameraInfo => ({
  name,
  displayName,
  manufacturer: null,
  model: null,
  ipAddress: "10.0.0.5",
  macAddress: null,
  enabled: true,
  autoDiscovered: false,
  status: "recording",
  lastSeen: new Date().toISOString(),
  lastDetection: null,
});
const CAMERAS = [cam("front_door", "Front door"), cam("garage", "Garage")];
vi.mock("@/lib/hooks/useCameras", () => ({
  useCameras: () => ({ cameras: CAMERAS, isLoading: false, refresh: vi.fn() }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  ...api,
}));

import NotificationsPage from "@/app/cameras/notifications/page";

const PREFS = { onPerson: true, onVehicle: true, onAnimal: false, onMotion: false };

beforeEach(() => {
  api.fetchCameraNotifications.mockReset();
  api.updateCameraNotifications.mockReset();
});
afterEach(cleanup);

describe("notification settings that fail to load", () => {
  it("names the camera that failed, leaves the other row usable, and does not sit on Loading…", async () => {
    api.fetchCameraNotifications.mockImplementation(async (name: string) => {
      if (name === "garage") throw new Error("Failed: 502");
      return PREFS;
    });
    render(<NotificationsPage />);

    const err = await screen.findByTestId("notification-load-error");
    expect(err.textContent).toContain("Couldn't load notification settings for Garage.");
    expect(screen.getAllByTestId("notification-load-error")).toHaveLength(1);
    expect(screen.queryByText("Loading…")).toBeNull();
    // The camera that did load still has its controls.
    expect(screen.getAllByRole("button", { name: "Notify on person" })).toHaveLength(1);
  });

  it("Retry reads that camera again and replaces the error with its settings", async () => {
    let garageCalls = 0;
    api.fetchCameraNotifications.mockImplementation(async (name: string) => {
      if (name === "garage" && ++garageCalls === 1) throw new Error("Failed: 502");
      return PREFS;
    });
    render(<NotificationsPage />);

    const err = await screen.findByTestId("notification-load-error");
    fireEvent.click(within(err).getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(screen.queryByTestId("notification-load-error")).toBeNull());
    expect(screen.getAllByRole("button", { name: "Notify on person" })).toHaveLength(2);
    expect(garageCalls).toBe(2);
  });

  it("shows no error when every camera loads", async () => {
    api.fetchCameraNotifications.mockResolvedValue(PREFS);
    render(<NotificationsPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Notify on person" })).toHaveLength(2));
    expect(screen.queryByTestId("notification-load-error")).toBeNull();
  });
});
