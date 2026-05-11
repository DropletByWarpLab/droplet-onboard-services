/**
 * WARP-291: Block/Unblock now opens a <ConfirmDialog> with
 * consequence-clear copy before firing the mutation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";

import { DeviceCard } from "@/components/network/DeviceCard";
import type { EnrichedNetworkDevice } from "@/lib/types";

vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

const toggleBlockMock = vi.fn();
vi.mock("@/lib/hooks/useDeviceBlockMutation", () => ({
  useDeviceBlockMutation: () => ({ toggleBlock: toggleBlockMock }),
}));

function device(partial: Partial<EnrichedNetworkDevice> = {}): EnrichedNetworkDevice {
  return {
    mac: "aa:bb:cc:dd:ee:ff",
    displayName: "Alice's iPad",
    hostname: null,
    vendor: "Apple",
    icon: null,
    notes: null,
    lastIp: "192.168.1.42",
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    online: true,
    isBlocked: false,
    groups: [],
    presenceDays: [],
    ...partial,
  } as EnrichedNetworkDevice;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  toggleBlockMock.mockReset();
});

describe("<DeviceCard> Block → ConfirmDialog (WARP-291 / WARP-41)", () => {
  it("clicking Block opens a destructive ConfirmDialog with the display name + consequence copy", () => {
    render(
      <Wrap>
        <DeviceCard device={device()} onOpen={() => {}} />
      </Wrap>,
    );
    const blockBtn = screen.getByRole("button", { name: /^Block device$/i });
    fireEvent.click(blockBtn);

    expect(screen.getByText("Block Alice's iPad?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This device won't be able to reach the internet until you unblock it.",
      ),
    ).toBeInTheDocument();

    // The confirm button (inside the dialog) uses the destructive bg-system-red class.
    const confirmInDialog = screen.getAllByRole("button", { name: "Block" })[0];
    expect(confirmInDialog.className).toMatch(/bg-system-red/);
  });

  it("clicking Unblock opens a neutral ConfirmDialog with the regain-access copy", () => {
    render(
      <Wrap>
        <DeviceCard device={device({ isBlocked: true })} onOpen={() => {}} />
      </Wrap>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Unblock device/i }));
    expect(screen.getByText("Unblock Alice's iPad?")).toBeInTheDocument();
    expect(
      screen.getByText("This device will regain internet access."),
    ).toBeInTheDocument();
    const confirmInDialog = screen.getAllByRole("button", { name: "Unblock" })[0];
    expect(confirmInDialog.className).toMatch(/dp-btn-primary/);
  });

  it("Confirm fires toggleBlock; Cancel does NOT", async () => {
    toggleBlockMock.mockResolvedValue(undefined);
    render(
      <Wrap>
        <DeviceCard device={device()} onOpen={() => {}} />
      </Wrap>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Block device/i }));
    expect(toggleBlockMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(toggleBlockMock).not.toHaveBeenCalled();
    // Re-open and confirm this time.
    fireEvent.click(screen.getByRole("button", { name: /Block device/i }));
    const confirmInDialog = screen.getAllByRole("button", { name: "Block" })[0];
    fireEvent.click(confirmInDialog);
    await waitFor(() => {
      expect(toggleBlockMock).toHaveBeenCalledTimes(1);
    });
  });
});
