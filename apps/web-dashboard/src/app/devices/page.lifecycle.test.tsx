/**
 * Devices page — device lifecycle wiring (WARP-1469).
 *
 * Pins the page-level glue the isolated DeviceDetailPanel test can't cover:
 * that opening an offline device and using its Remove / Try-to-reconnect /
 * Re-pair affordances routes through useSmartHome's remove()/reconnect() and
 * the router with the right nodeId, closes the panel, and (for re-pair) sends
 * the user to the add-device screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { MatterDevice } from "@/lib/types";

const command = vi.fn();
const refresh = vi.fn();
const remove = vi.fn().mockResolvedValue(undefined);
const reconnect = vi.fn().mockResolvedValue({ status: "reconnecting", nodeId: "12345" });
const push = vi.fn();

const offlineLamp: MatterDevice = {
  nodeId: "12345",
  name: "Hallway Lamp",
  category: "light",
  state: "off",
  connectionState: "disconnected",
  endpoints: [],
  attributes: {},
};

const grouped = {
  lights: [offlineLamp],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
};

vi.mock("@/lib/hooks/useSmartHome", () => ({
  useSmartHome: () => ({
    grouped,
    discovered: [],
    totalDevices: 1,
    isLoading: false,
    isRefreshing: false,
    error: undefined,
    command,
    remove,
    reconnect,
    refresh,
  }),
}));
vi.mock("@/lib/hooks/useSmartHomeEvents", () => ({ useSmartHomeEvents: vi.fn() }));
vi.mock("@/lib/hooks/useScenes", () => ({
  useScenes: () => ({ scenes: [], refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import DevicesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
});

function openLampPanel() {
  fireEvent.click(screen.getByText("Hallway Lamp"));
}

describe("Devices page — lifecycle wiring (WARP-1469)", () => {
  it("Remove device confirms and calls remove() with the nodeId, then closes the panel", async () => {
    render(<DevicesPage />);
    openLampPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Remove device" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove this device?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove device" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("12345"));
    // Panel closes on success — the device heading is gone.
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Hallway Lamp" })).toBeNull(),
    );
  });

  it("Try to reconnect calls reconnect() with the nodeId", async () => {
    render(<DevicesPage />);
    openLampPanel();

    fireEvent.click(await screen.findByRole("button", { name: /Try to reconnect/ }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith("12345"));
  });

  it("Re-pair removes the device and routes to the add-device screen", async () => {
    render(<DevicesPage />);
    openLampPanel();

    // Re-pair is revealed only after a reconnect attempt.
    fireEvent.click(await screen.findByRole("button", { name: /Try to reconnect/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Re-pair/ }));

    const confirm = await screen.findByRole("dialog", { name: "Re-pair this device?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove & re-pair" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("12345"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/devices/add-matter"));
  });
});
