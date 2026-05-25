/**
 * WARP-446 — Coverage Extenders panel (read + render).
 *
 * Tests the panel's render behaviour against the in-memory ApDevice
 * shape returned by `fetchApDevices()`. Mutation flows (approve /
 * decommission) are exercised in CoverageExtendersPanel.actions.test.tsx
 * because they need SWR mutation + fetch mocks.
 *
 * Same shape as DeviceGridSection.test.tsx — render with synthetic
 * SWR data via SWRConfig + provider mock.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoverageExtendersPanel } from "../CoverageExtendersPanel";
import type { ApDeviceInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  fetchApDevices: vi.fn(),
  approveApDevice: vi.fn(),
  decommissionApDevice: vi.fn(),
}));

import { fetchApDevices } from "@/lib/api";

function makeAp(overrides: Partial<ApDeviceInfo> = {}): ApDeviceInfo {
  return {
    mac: "B8:27:EB:00:00:01",
    displayName: "Upstairs",
    model: "raspberrypi,5-model-b",
    serial: "ABC123",
    version: "1.0",
    lastIp: "192.168.50.42",
    hostname: "droplet-extender",
    status: "ONLINE",
    failureReason: null,
    approvedSsid: "Droplet",
    firstSeen: new Date(Date.now() - 86_400_000).toISOString(),
    lastSeen: new Date().toISOString(),
    approvedAt: new Date(Date.now() - 3_600_000).toISOString(),
    approvedBy: "stefan",
    decommissionedAt: null,
    lastOperationId: null,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <CoverageExtendersPanel />
    </SWRConfig>,
  );
}

describe("CoverageExtendersPanel (WARP-446)", () => {
  it("renders the empty state when no APs are known", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({ aps: [] });
    renderPanel();
    // Empty-state copy is operator-friendly, no installer jargon.
    expect(await screen.findByText(/no extra access points yet/i)).toBeInTheDocument();
  });

  it("renders an ONLINE extender card with status pill + display name + last-seen", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ displayName: "Upstairs", status: "ONLINE" })],
    });
    renderPanel();
    expect(await screen.findByText("Upstairs")).toBeInTheDocument();
    expect(screen.getByText(/online/i)).toBeInTheDocument();
  });

  it("highlights AWAITING_APPROVAL above ONLINE so the operator sees action-required first", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({ mac: "B8:27:EB:00:00:01", displayName: "Upstairs", status: "ONLINE" }),
        makeAp({
          mac: "B8:27:EB:00:00:02",
          displayName: null,
          status: "AWAITING_APPROVAL",
          approvedAt: null,
          approvedBy: null,
        }),
      ],
    });
    renderPanel();
    // The Approve button is the actionable item — it must be findable and
    // appear in the document above the ONLINE row's content. Use
    // role-aware queries so a class-name refactor doesn't break this.
    const approveBtn = await screen.findByRole("button", { name: /approve/i });
    expect(approveBtn).toBeInTheDocument();
    // Approve card precedes the "Upstairs" ONLINE card in the DOM order.
    const onlineLabel = screen.getByText("Upstairs");
    expect(
      approveBtn.compareDocumentPosition(onlineLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  it("surfaces FAILED status with the failureReason", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          displayName: "Garage",
          status: "FAILED",
          failureReason: "Router unreachable during apply",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/router unreachable during apply/i)).toBeInTheDocument();
  });

  it("falls back to model + last-3-MAC-octets when displayName is null", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          mac: "B8:27:EB:12:34:56",
          displayName: null,
          model: "raspberrypi,5-model-b",
          status: "ONLINE",
        }),
      ],
    });
    renderPanel();
    // Last-3-octets surfaced for disambiguation when there are multiple
    // unnamed extenders.
    expect(await screen.findByText(/12:34:56/i)).toBeInTheDocument();
  });
});
