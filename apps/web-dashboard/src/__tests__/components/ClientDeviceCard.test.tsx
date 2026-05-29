/**
 * WARP-300 — ClientDeviceCard revoke action.
 *
 * The revoke icon used to be hidden behind
 * `opacity-0 group-hover:opacity-100`, making it unreachable for touch
 * and keyboard users (mirror of WARP-220 / WARP-292).
 *
 * Invariants:
 *   - Revoke is always rendered (no opacity-0 gate) for active clients.
 *   - The button carries an aria-label naming the action AND the row's
 *     primary identifier (deviceName ?? id).
 *   - p-2.5-or-larger hit-target token.
 *   - Revoked clients still hide the button (revoke is a no-op).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

import { ClientDeviceCard } from "@/components/ClientDeviceCard";
import type { DeviceClientInfo } from "@/lib/types";

function makeClient(overrides: Partial<DeviceClientInfo> = {}): DeviceClientInfo {
  return {
    id: "client-1",
    deviceName: "Alice's Mac",
    deviceType: "desktop",
    platform: "macos",
    appVersion: "1.2.3",
    lastSeen: new Date().toISOString(),
    status: "active",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ClientDeviceCard — revoke action (WARP-300)", () => {
  it("revoke button is visible without hover and carries deviceName in aria-label", () => {
    render(
      <ClientDeviceCard client={makeClient()} onRevoke={vi.fn()} />,
    );

    const revokeBtn = screen.getByRole("button", {
      name: /revoke alice's mac/i,
    });
    expect(revokeBtn).toBeInTheDocument();
    expect(revokeBtn.className).not.toMatch(/opacity-0/);
    expect(revokeBtn.className).toMatch(/(^|\s)p-2\.5(\s|$)/);
  });

  it("aria-label falls back to client id when deviceName is empty", () => {
    render(
      <ClientDeviceCard
        client={makeClient({ id: "abc-xyz", deviceName: "" })}
        onRevoke={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /revoke abc-xyz/i }),
    ).toBeInTheDocument();
  });

  it("revoked clients do not render a revoke button", () => {
    render(
      <ClientDeviceCard
        client={makeClient({ status: "revoked" })}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });
});
