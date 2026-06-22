/**
 * ADR-024 Phase 5 — Coverage Extenders panel: vendor labelling.
 *
 * Phases 1-4 added the `backend` (DROPLET_IMAGE | EASYMESH | UNIFI) and
 * `vendor` columns to ApDevice so a household can onboard a third-party
 * coverage AP through the SAME single list + approve flow. This suite
 * pins the dashboard surface for §4 ("one list, one approve, the panel
 * just gains a vendor column"):
 *
 *   - A row renders a human vendor label (Droplet / TP-Link / Ubiquiti).
 *   - When `vendor` is null the panel derives a label from `backend`
 *     (DROPLET_IMAGE→Droplet, EASYMESH→EasyMesh, UNIFI→Ubiquiti) — no
 *     blank/color-only badge (a11y: every badge carries text).
 *   - The IA stays one list: no per-vendor section headings.
 *
 * Same render harness as CoverageExtendersPanel.test.tsx (synthetic SWR
 * data via SWRConfig + a mocked fetchApDevices).
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
    model: null,
    serial: null,
    version: null,
    lastIp: "192.168.50.42",
    hostname: "droplet-extender",
    status: "ONLINE",
    backend: "DROPLET_IMAGE",
    vendor: null,
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

describe("CoverageExtendersPanel — vendor labelling (ADR-024 Phase 5)", () => {
  it("renders the explicit vendor label when the row carries one", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          mac: "AA:BB:CC:00:00:01",
          displayName: "Living room",
          backend: "EASYMESH",
          vendor: "TP-Link",
          status: "ONLINE",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Living room")).toBeInTheDocument();
    // The human vendor string surfaces verbatim (it's a text label, not
    // a color-only chip — a11y requirement).
    expect(screen.getByText("TP-Link")).toBeInTheDocument();
  });

  it("renders a vendor badge for each backend across one unified list", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          mac: "AA:BB:CC:00:00:01",
          displayName: "Hallway",
          backend: "DROPLET_IMAGE",
          vendor: "Droplet",
          status: "ONLINE",
        }),
        makeAp({
          mac: "AA:BB:CC:00:00:02",
          displayName: "Kitchen",
          backend: "EASYMESH",
          vendor: "TP-Link",
          status: "ONLINE",
        }),
        makeAp({
          mac: "AA:BB:CC:00:00:03",
          displayName: "Garage",
          backend: "UNIFI",
          vendor: "Ubiquiti",
          status: "ONLINE",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Droplet")).toBeInTheDocument();
    expect(screen.getByText("TP-Link")).toBeInTheDocument();
    expect(screen.getByText("Ubiquiti")).toBeInTheDocument();
    // Single-list IA (ADR-024 §4): no per-vendor section headings split
    // the list. Only the panel's own h2 exists.
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("derives the label from backend when vendor is null (DROPLET_IMAGE → Droplet)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          mac: "AA:BB:CC:00:00:01",
          displayName: "Hallway",
          backend: "DROPLET_IMAGE",
          vendor: null,
          status: "ONLINE",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Droplet")).toBeInTheDocument();
  });

  it("derives the label from backend when vendor is null (EASYMESH → EasyMesh)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          mac: "AA:BB:CC:00:00:02",
          displayName: "Kitchen",
          backend: "EASYMESH",
          vendor: null,
          status: "ONLINE",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("EasyMesh")).toBeInTheDocument();
  });

  it("derives the label from backend when vendor is null (UNIFI → Ubiquiti)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          mac: "AA:BB:CC:00:00:03",
          displayName: "Garage",
          backend: "UNIFI",
          vendor: null,
          status: "ONLINE",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText("Ubiquiti")).toBeInTheDocument();
  });

  it("mentions the supported extender types in the empty-state helper copy, in plain language", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({ aps: [] });
    renderPanel();
    expect(
      await screen.findByText(/no extra access points yet/i),
    ).toBeInTheDocument();
    // ADR-002 home-user tone: the helper names the vendor families a
    // household can buy, with NO installer jargon (1905.1, M1/M2, etc.).
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/EasyMesh/i);
    expect(body).toMatch(/Ubiquiti/i);
    expect(body).not.toMatch(/1905\.1/);
    expect(body).not.toMatch(/M1\/M2/i);
  });
});
