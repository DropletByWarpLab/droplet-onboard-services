/**
 * WARP-289: assert ClientDetailPanel exposes full modal ARIA via the
 * shared <Dialog> primitive.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientDetailPanel } from "@/components/ClientDetailPanel";
import type { DeviceClientInfo } from "@/lib/types";

function makeClient(overrides: Partial<DeviceClientInfo> = {}): DeviceClientInfo {
  return {
    id: "c-1",
    deviceName: "Alice MacBook",
    deviceType: "desktop",
    platform: "macos",
    status: "active",
    appVersion: "1.0.0",
    lastSeen: "2026-05-01T12:00:00Z",
    createdAt: "2026-04-01T12:00:00Z",
    ...overrides,
  } as DeviceClientInfo;
}

describe("ClientDetailPanel ARIA (WARP-289)", () => {
  it("renders role=dialog + aria-modal + aria-labelledby resolving to the device name", () => {
    render(
      <ClientDetailPanel
        client={makeClient()}
        onRevoke={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/Alice MacBook/);
  });
});
