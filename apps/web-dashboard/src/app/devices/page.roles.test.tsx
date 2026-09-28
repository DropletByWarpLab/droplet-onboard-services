/**
 * Devices page — controller outage + external-guest read-only (WARP-3276).
 *
 * Pins:
 *   - `_status: "disconnected"` (surfaced as `disconnected`) shows the
 *     "controller not available" card, not "No devices yet";
 *   - an external guest (`guest`) sees the device list with no switch,
 *     no Add device and no Remove in the detail panel; a member (`family`)
 *     keeps the controls, and the switch sends turn_off/turn_on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { MatterDevice } from "@/lib/types";

const request = vi.fn();
const push = vi.fn();

const lamp: MatterDevice = {
  nodeId: "12345",
  name: "Hallway Lamp",
  category: "light",
  state: "on",
  connectionState: "connected",
  endpoints: [],
  attributes: {},
};

const empty = {
  lights: [] as MatterDevice[],
  switches: [],
  sensors: [],
  climate: [],
  media: [],
  covers: [],
  locks: [],
  other: [],
};

let hookState: { grouped: typeof empty; totalDevices: number; disconnected: boolean };
let role: string;

vi.mock("@/lib/hooks/useSmartHome", () => ({
  useSmartHome: () => ({
    ...hookState,
    discovered: [],
    isLoading: false,
    isRefreshing: false,
    error: undefined,
    command: vi.fn(),
    remove: vi.fn(),
    reconnect: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/useMatterCommandConfirm", () => ({
  useMatterCommandConfirm: () => ({ pending: null, request, accept: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/lib/hooks/useSmartHomeEvents", () => ({ useSmartHomeEvents: vi.fn() }));
vi.mock("@/lib/hooks/useScenes", () => ({
  useScenes: () => ({ scenes: [], refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import DevicesPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  role = "owner";
  hookState = { grouped: { ...empty, lights: [lamp] }, totalDevices: 1, disconnected: false };
});

describe("Devices page — controller outage (WARP-3276)", () => {
  it("shows 'controller not available', not 'No devices yet'", () => {
    hookState = { grouped: empty, totalDevices: 0, disconnected: true };
    render(<DevicesPage />);
    expect(screen.getByText("Matter controller not available")).toBeInTheDocument();
    expect(screen.queryByText("No devices yet")).toBeNull();
  });
});

describe("Devices page — role gates (WARP-3276)", () => {
  it("an external guest sees the list with no controls", () => {
    role = "guest";
    render(<DevicesPage />);
    expect(screen.getByText("Hallway Lamp")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add device/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New room|Create a room/ })).toBeNull();

    fireEvent.click(screen.getByText("Hallway Lamp"));
    expect(screen.queryByRole("button", { name: "Remove device" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename device" })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("a member (family) keeps the controls and the switch sends turn_off", () => {
    role = "family";
    render(<DevicesPage />);
    expect(screen.getByRole("button", { name: /Add device/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(request).toHaveBeenCalledWith("12345", "turn_off");
  });
});
