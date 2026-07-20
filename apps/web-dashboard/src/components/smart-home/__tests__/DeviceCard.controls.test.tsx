/**
 * WARP-897 — per-category control widgets on the device card.
 *
 * Pins:
 *   - a color-capable light shows the swatch strip and dispatches
 *     set_color / set_color_temperature; a plain light shows none;
 *   - a cover has NO toggle (the old toggle sent onOff a WindowCovering
 *     never implements) and its motion buttons dispatch the real
 *     cover commands; the position slider inverts lift→percent-open;
 *   - a lock renders Lock/Unlock dispatching lock/unlock and reflects
 *     the derived "locked" state;
 *   - a fan with FanControl shows mode chips dispatching set_fan_mode;
 *   - a media player dispatches the playback verbs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceCard } from "../DeviceCard";
import type { MatterDevice } from "@/lib/types";

const onCommand = vi.fn();

function device(over: Partial<MatterDevice> = {}): MatterDevice {
  return {
    nodeId: "42",
    name: "Test device",
    category: "light",
    state: "on",
    connectionState: "connected",
    endpoints: [
      { endpointId: 1, deviceTypes: [{ deviceType: 0x010d, revision: 1 }], clusters: [0x0006, 0x0008, 0x0300] },
    ],
    attributes: { onOff: true, currentLevel: 254, currentHue: 212 },
    ...over,
  } as MatterDevice;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DeviceCard naming (WARP-1396)", () => {
  it("shows the friendly alias on the card, falling back to product then Matter name", () => {
    const { rerender } = render(
      <DeviceCard
        device={device({ friendlyName: "Kitchen strip", productName: "Cync X", name: "Node-1" })}
        onCommand={onCommand}
      />,
    );
    expect(screen.getByText("Kitchen strip")).toBeInTheDocument();
    rerender(
      <DeviceCard
        device={device({ friendlyName: null, productName: "Cync X", name: "Node-1" })}
        onCommand={onCommand}
      />,
    );
    expect(screen.getByText("Cync X")).toBeInTheDocument();
  });
});

describe("DeviceCard control widgets (WARP-897)", () => {
  it("shows color controls only for ColorControl-capable lights", () => {
    render(<DeviceCard device={device()} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "Purple" }));
    expect(onCommand).toHaveBeenCalledWith("42", "set_color", {
      hue: 275,
      saturation: 100,
    });
    fireEvent.click(screen.getByRole("button", { name: "Warm white" }));
    expect(onCommand).toHaveBeenCalledWith("42", "set_color_temperature", {
      kelvin: 2700,
    });
  });

  it("renders the color wheel and dispatches hue/saturation from keyboard steering", async () => {
    render(<DeviceCard device={device()} onCommand={onCommand} />);
    const wheel = screen.getByRole("slider", { name: "Color" });
    // currentHue 212 raw -> 300 deg; ArrowRight steps hue +5, ArrowDown sat -5.
    fireEvent.keyDown(wheel, { key: "ArrowRight" });
    fireEvent.keyDown(wheel, { key: "ArrowDown" });
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith("42", "set_color", {
        hue: 305,
        saturation: 95,
      }),
    );
    expect(wheel).toHaveAttribute("aria-valuetext", expect.stringContaining("saturated"));
  });

  it("hides color controls for a plain on/off light", () => {
    const plain = device({
      endpoints: [
        { endpointId: 1, deviceTypes: [{ deviceType: 0x0100, revision: 1 }], clusters: [0x0006, 0x0008] },
      ],
    });
    render(<DeviceCard device={plain} onCommand={onCommand} />);
    expect(screen.queryByRole("button", { name: "Purple" })).not.toBeInTheDocument();
  });

  it("gives covers motion buttons and NO toggle", () => {
    const cover = device({
      category: "cover",
      state: "open",
      endpoints: [
        { endpointId: 1, deviceTypes: [{ deviceType: 0x0202, revision: 1 }], clusters: [0x0102] },
      ],
      attributes: { liftPercent100ths: 2500 },
    });
    render(<DeviceCard device={cover} onCommand={onCommand} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "open_cover");
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "stop_cover");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "close_cover");

    // 2500 hundredths closed → 75% open.
    expect(screen.getByRole("slider", { name: "Position" })).toHaveValue("75");
  });

  it("renders lock/unlock dispatching the lock commands", () => {
    const lock = device({
      category: "lock",
      state: "locked",
      endpoints: [
        { endpointId: 1, deviceTypes: [{ deviceType: 0x000a, revision: 1 }], clusters: [0x0101] },
      ],
      attributes: { lockState: 1 },
    });
    render(<DeviceCard device={lock} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "unlock");
    fireEvent.click(screen.getByRole("button", { name: /^lock$/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "lock");
  });

  it("renders fan mode chips dispatching set_fan_mode", () => {
    const fan = device({
      category: "fan",
      state: "on",
      endpoints: [
        { endpointId: 1, deviceTypes: [{ deviceType: 0x002b, revision: 1 }], clusters: [0x0006, 0x0202] },
      ],
      attributes: { onOff: true, fanPercent: 40, fanMode: 2 },
    });
    render(<DeviceCard device={fan} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    expect(onCommand).toHaveBeenCalledWith("42", "set_fan_mode", { mode: "auto" });
    expect(screen.getByRole("button", { name: "medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders media playback verbs", () => {
    const media = device({
      category: "media_player",
      state: "playing",
      endpoints: [
        { endpointId: 1, deviceTypes: [{ deviceType: 0x0022, revision: 1 }], clusters: [0x0506] },
      ],
      attributes: {},
    });
    render(<DeviceCard device={media} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "pause_media");
    fireEvent.click(screen.getByRole("button", { name: /play/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "play_media");
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onCommand).toHaveBeenCalledWith("42", "stop_media");
  });
});
