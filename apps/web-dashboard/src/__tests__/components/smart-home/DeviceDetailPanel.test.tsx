/**
 * WARP-299 — smart-home DeviceDetailPanel smoke test.
 *
 * Pins the orange (not yellow) connection-state warning on an offline
 * device. Yellow elsewhere in the app means "saved / bookmarked"
 * (`EventCard` saved-badge, `EventClipModal` saved-tag); orange means
 * "warning / needs attention" (`StatusChip` failed pill, `AttachmentChip`
 * failed border, `network/page.tsx` warning banner). An offline smart-home
 * device is a warning, not a saved state — the original
 * `bg-system-yellow/10` from WARP-288 conflated the two semantics.
 *
 * Source: WARP-288 UX review on PR #191
 * (`docs/superpowers/audits/2026-05-08-web-dashboard-ux-audit.md`).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceDetailPanel } from "@/components/smart-home/DeviceDetailPanel";
import type { MatterDevice } from "@/lib/types";

function makeDevice(overrides: Partial<MatterDevice> = {}): MatterDevice {
  return {
    nodeId: "node-1",
    name: "Living Room Lamp",
    category: "light",
    state: "off",
    connectionState: "connected",
    endpoints: [],
    attributes: {},
    ...overrides,
  };
}

describe("DeviceDetailPanel — connection-state warning (WARP-299)", () => {
  it("renders the offline notice with orange (warning) tokens, not yellow", () => {
    const { container } = render(
      <DeviceDetailPanel
        device={makeDevice({ connectionState: "disconnected" })}
        onCommand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Locate the notice via its copy.
    const notice = screen.getByText(/disconnected/i).closest("div");
    expect(notice).not.toBeNull();
    expect(notice?.className).toMatch(/bg-system-orange\/10/);
    expect(notice?.className).toMatch(/border-system-orange\/20/);

    // Belt-and-braces — the old yellow tokens must not appear anywhere
    // in this rendered tree (guards against a future find-and-replace
    // regression that re-introduces the saved-state palette here).
    expect(container.innerHTML).not.toContain("bg-system-yellow/10");
    expect(container.innerHTML).not.toContain("border-system-yellow/20");
  });

  // WARP-289 — verify the panel has the full modal ARIA contract via the
  // shared <Dialog> primitive (role=dialog + aria-modal + aria-labelledby
  // resolving to the device name heading).
  it("renders as a role=dialog with aria-modal and aria-labelledby (WARP-289)", () => {
    render(
      <DeviceDetailPanel
        device={makeDevice()}
        onCommand={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/Living Room Lamp/);
  });

  it("does not render the connection-state notice when the device is connected", () => {
    render(
      <DeviceDetailPanel
        device={makeDevice({ connectionState: "connected" })}
        onCommand={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // "Connected" is shown in the header subtitle ("light · off") but the
    // dedicated notice block ("disconnected" / "reconnecting") should not
    // appear when the device is connected.
    expect(screen.queryByText(/disconnected/i)).toBeNull();
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
  });
});
