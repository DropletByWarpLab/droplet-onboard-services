/**
 * Devices page — Tier-2 command confirmation (KAN-5).
 *
 * Pins the device-control confirmation flow end-to-end at the page level: a
 * lock toggle whose `command` resolves `confirmation_required` must open a
 * confirm dialog (reusing the shared <ConfirmDialog>, with the orange Write
 * chip), and confirming must echo the token + service to `confirmMatterCommand`
 * and refresh device state. Pre-KAN-5 the 202 was swallowed and the lock never
 * actuated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MatterDevice, MatterCommandResult } from "@/lib/types";

const command = vi.fn();
const refresh = vi.fn();

// A thermostat is the Tier-2 path exercisable through the existing UI:
// raising the setpoint toward >= 30C trips the safety override server-side, and
// ClimateControl in the detail panel issues the `set_temperature` write.
const thermostat: MatterDevice = {
  nodeId: "12345",
  name: "Living Room",
  category: "climate",
  state: "29.5°",
  connectionState: "connected",
  endpoints: [],
  attributes: {
    localTemperature: 2950,
    occupiedHeatingSetpoint: 2950,
    systemMode: 4, // heat
  },
};

const grouped = {
  lights: [],
  switches: [],
  sensors: [],
  climate: [thermostat],
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
    refresh,
  }),
}));
vi.mock("@/lib/hooks/useSmartHomeEvents", () => ({
  useSmartHomeEvents: vi.fn(),
}));
vi.mock("@/lib/hooks/useScenes", () => ({
  useScenes: () => ({ scenes: [], refresh: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { role: "owner" } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, confirmMatterCommand: vi.fn() };
});

import { confirmMatterCommand } from "@/lib/api";
import DevicesPage from "./page";

const CONFIRMATION: MatterCommandResult = {
  status: "confirmation_required",
  nodeId: "12345",
  confirmationToken: "tok-abc",
  service: "set_temperature",
  reason: "Temperature >= 30C may be unsafe",
  tier: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Devices page — Tier-2 confirmation (KAN-5)", () => {
  it("opens a confirm dialog when a climate setpoint write needs confirmation", async () => {
    command.mockResolvedValue(CONFIRMATION);
    render(<DevicesPage />);

    // Open the thermostat detail panel and raise the setpoint toward >= 30C.
    fireEvent.click(screen.getByText("Living Room"));
    fireEvent.click(await screen.findByLabelText(/raise target temperature/i));

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith("12345", "set_temperature", {
        temperature: 30,
        mode: 0,
      }),
    );
    // The shared ConfirmDialog appears with the safety-tier copy + Write chip.
    expect(await screen.findByText(/may be unsafe/i)).toBeTruthy();
    expect(screen.getByText(/confirm to apply/i)).toBeTruthy();
  });

  it("echoes token + service to confirmMatterCommand and refreshes on confirm", async () => {
    command.mockResolvedValue(CONFIRMATION);
    vi.mocked(confirmMatterCommand).mockResolvedValue({
      confirmed: true,
      nodeId: "12345",
    });
    render(<DevicesPage />);

    fireEvent.click(screen.getByText("Living Room"));
    fireEvent.click(await screen.findByLabelText(/raise target temperature/i));

    const confirmBtn = await screen.findByRole("button", {
      name: /confirm & apply/i,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(confirmMatterCommand).toHaveBeenCalledWith(
        "12345",
        "tok-abc",
        "set_temperature",
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("does not open a dialog for a Tier-1 command", async () => {
    command.mockResolvedValue({ status: "ok" } as MatterCommandResult);
    render(<DevicesPage />);

    fireEvent.click(screen.getByText("Living Room"));
    fireEvent.click(await screen.findByLabelText(/raise target temperature/i));

    await waitFor(() => expect(command).toHaveBeenCalled());
    expect(screen.queryByText(/confirm to apply/i)).toBeNull();
  });
});
