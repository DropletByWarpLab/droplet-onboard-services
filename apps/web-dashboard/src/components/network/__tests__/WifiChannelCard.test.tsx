/**
 * WARP-871 — WifiChannelCard: pick the Wi-Fi channel from the Network → WiFi
 * tab. Reads the live radio section + current channel, then writes via the
 * (previously orphaned) setWifiChannel helper, polling for the safe-apply
 * outcome with the shared calm error ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { WifiChannelCard } from "../WifiChannelCard";
import {
  fetchWifiSettings,
  setWifiChannel,
  fetchNetworkOperation,
  RouterStatusError,
} from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual, // keep real RouterStatusError + routerUnreachableNotice
    fetchWifiSettings: vi.fn(),
    setWifiChannel: vi.fn(),
    fetchNetworkOperation: vi.fn(),
  };
});

const wifiMock = vi.mocked(fetchWifiSettings);
const chanMock = vi.mocked(setWifiChannel);
const opMock = vi.mocked(fetchNetworkOperation);

// A 5 GHz AP radio on channel 149 (the shipped default).
const RADIO_5G = {
  radio3: {
    up: true,
    config: { channel: 149, hwmode: "11a", htmode: "HE80" },
    interfaces: [{ config: { mode: "ap", ssid: "Droplet" } }],
  },
};

beforeEach(() => {
  wifiMock.mockReset();
  chanMock.mockReset();
  opMock.mockReset();
  wifiMock.mockResolvedValue(RADIO_5G as never);
  chanMock.mockResolvedValue({ status: "ok", operationId: "op-ch" } as never);
  opMock.mockResolvedValue({
    id: "op-ch",
    state: "applied",
    startedAt: 0,
    finishedAt: 1,
    reason: null,
  } as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

async function loaded() {
  render(<WifiChannelCard />);
  // Wait for the async fetchWifiSettings → select to appear.
  return screen.findByLabelText(/channel/i);
}

describe("WifiChannelCard (WARP-871)", () => {
  it("reads the live radio and preselects its current channel", async () => {
    const select = (await loaded()) as HTMLSelectElement;
    expect(select.value).toBe("149");
    // Save is disabled until the selection changes.
    expect(screen.getByRole("button", { name: /save channel/i })).toBeDisabled();
  });

  it("posts the chosen channel with the LIVE radio section, polls, applies", async () => {
    const select = (await loaded()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "36" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save channel/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(chanMock).toHaveBeenCalledWith("36", "radio3");
    expect(opMock).toHaveBeenCalledWith("op-ch");
    expect(await screen.findByText(/channel updated/i)).toBeInTheDocument();
  });

  it("supports the Automatic option", async () => {
    const select = (await loaded()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "auto" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save channel/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(chanMock).toHaveBeenCalledWith("auto", "radio3");
  });

  it("shows a calm amber notice (not the raw error) when the router is unreachable", async () => {
    chanMock.mockRejectedValue(
      new RouterStatusError("UNREACHABLE", "ECONNREFUSED 192.168.50.1", 503),
    );
    const select = (await loaded()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "44" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save channel/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText(/isn't reachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it("surfaces a rolled-back op.reason in red", async () => {
    opMock.mockResolvedValue({
      id: "op-ch",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Reverted: channel 44 is not allowed in this region.",
    } as never);
    const select = (await loaded()) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "44" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save channel/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      await screen.findByText(/reverted: channel 44 is not allowed/i),
    ).toBeInTheDocument();
  });
});
