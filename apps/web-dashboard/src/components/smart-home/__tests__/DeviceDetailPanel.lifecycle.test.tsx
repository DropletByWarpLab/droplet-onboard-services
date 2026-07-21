/**
 * WARP-1469 — device lifecycle actions on the detail panel.
 *
 * Pins the three affordances this ticket adds, and that they only appear
 * when their handler is supplied (control-only callers stay unchanged):
 *   1. Remove device → confirm → onRemove(nodeId).
 *   2. Offline banner "Try to reconnect" → onReconnect(nodeId), then the
 *      re-pair fallback is revealed.
 *   3. Re-pair → confirm → onRepair(nodeId).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DeviceDetailPanel } from "../DeviceDetailPanel";
import type { MatterDevice } from "@/lib/types";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function makeDevice(overrides: Partial<MatterDevice> = {}): MatterDevice {
  return {
    nodeId: "n1",
    name: "Test Lamp",
    category: "light",
    state: "off",
    connectionState: "disconnected",
    vendorName: "Acme",
    productName: "Lamp",
    serialNumber: "SN-1",
    endpoints: [],
    attributes: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Remove device", () => {
  it("confirms then calls onRemove with the nodeId", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(
      <DeviceDetailPanel
        device={makeDevice()}
        onCommand={vi.fn()}
        onClose={vi.fn()}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove device" }));

    // The confirm dialog is a separate role="dialog" labelled by its heading.
    const confirm = await screen.findByRole("dialog", {
      name: "Remove this device?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Remove device" }),
    );

    expect(onRemove).toHaveBeenCalledWith("n1");
  });

  it("is absent when no onRemove handler is supplied", () => {
    render(
      <DeviceDetailPanel device={makeDevice()} onCommand={vi.fn()} onClose={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: "Remove device" }),
    ).not.toBeInTheDocument();
  });
});

describe("Reconnect + re-pair (offline)", () => {
  it("reconnects, then reveals the re-pair fallback which confirms into onRepair", async () => {
    const onReconnect = vi.fn().mockResolvedValue({ status: "reconnecting" });
    const onRepair = vi.fn().mockResolvedValue(undefined);
    render(
      <DeviceDetailPanel
        device={makeDevice()}
        onCommand={vi.fn()}
        onClose={vi.fn()}
        onReconnect={onReconnect}
        onRepair={onRepair}
      />,
    );

    // Re-pair is hidden until a reconnect has been attempted.
    expect(
      screen.queryByRole("button", { name: /Re-pair/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Try to reconnect/ }));
    expect(onReconnect).toHaveBeenCalledWith("n1");

    // After the attempt resolves, the re-pair fallback appears.
    const repair = await screen.findByRole("button", { name: /Re-pair/ });
    fireEvent.click(repair);

    const confirm = await screen.findByRole("dialog", {
      name: "Re-pair this device?",
    });
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Remove & re-pair" }),
    );

    expect(onRepair).toHaveBeenCalledWith("n1");
  });

  it("shows no reconnect affordance for a connected device", () => {
    render(
      <DeviceDetailPanel
        device={makeDevice({ connectionState: "connected", state: "on" })}
        onCommand={vi.fn()}
        onClose={vi.fn()}
        onReconnect={vi.fn()}
        onRepair={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Try to reconnect/ }),
    ).not.toBeInTheDocument();
  });
});
