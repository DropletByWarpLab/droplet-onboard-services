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
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ApDeviceInfo } from "@/lib/types";

// The setup.ts global next/link mock renders a string template; the panel's
// read-only Wi-Fi reflection (WARP-1723) carries a real navigation link whose
// role + href this suite asserts, so re-mock it as a plain <a> (the
// CitationCard.test.tsx pattern).
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { CoverageExtendersPanel } from "../CoverageExtendersPanel";

vi.mock("@/lib/api", () => ({
  fetchApDevices: vi.fn(),
  approveApDevice: vi.fn(),
  decommissionApDevice: vi.fn(),
  // WARP-1712: the panel now also renders the AP's live radio detail and the
  // shared AP Wi-Fi / band-steering controls, so their API surface has to
  // exist on this mock. Defaults are the honest "nothing to show" answers.
  fetchApWirelessDetail: vi.fn().mockResolvedValue({ supported: false, radios: [] }),
  fetchApWifi: vi.fn().mockResolvedValue({
    supported: false, ssid: null, fiveGhzSsid: null, key: null,
    encryption: null, bandSteering: null, apCount: 0, inSync: true,
  }),
  setApWifi: vi.fn(),
  fetchBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
  setBandSteering: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import { fetchApDevices, fetchApWifi } from "@/lib/api";

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

function renderPanel(
  props: React.ComponentProps<typeof CoverageExtendersPanel> = {},
) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <CoverageExtendersPanel {...props} />
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
    // Exact match on the status pill. A loose /online/i also catches the
    // WARP-1712 control cards' copy ("…access point that's online"), which
    // isn't what this test is about.
    expect(screen.getByText("Online")).toBeInTheDocument();
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

  it("surfaces FAILED status with friendly home-user copy keyed off failureReason (blocker #7)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({
          displayName: "Garage",
          status: "FAILED",
          // "unreachable" in the failureReason maps to the
          // ROUTER_UNREACHABLE copy bucket via the panel's
          // copyForFailureReason heuristic. The raw technical string
          // must NOT appear on the home-user surface — only the
          // mapped friendly copy.
          failureReason: "Router unreachable during apply",
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText(/failed/i)).toBeInTheDocument();
    // Friendly title from AP_ONBOARD_ERROR_COPY.ROUTER_UNREACHABLE.
    expect(
      screen.getByText(/couldn't reach the main router/i),
    ).toBeInTheDocument();
    // The raw "Router unreachable during apply" string must NOT leak
    // to the user. The friendly body talks about the router not
    // responding; the raw "during apply" technical phrasing should
    // be absent.
    expect(screen.queryByText(/during apply/i)).not.toBeInTheDocument();
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
    // The auto-generated label is hardware-agnostic (ADR-011): the device-tree
    // match string is still `raspberrypi,5-model-b`, but the operator-facing
    // fallback name must NOT carry the "Pi5" framing.
    expect(screen.getByText(/AP \(12:34:56\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/Pi5/i)).not.toBeInTheDocument();
  });

  /**
   * WARP-1712 — the founder's ask: the AP belongs to the network, so it lives
   * in the extender surface, not just listed. WARP-1723 tightened HOW: the
   * household Wi-Fi is editable in exactly ONE place (Network → Wi-Fi), so
   * this panel reflects the live name read-only and links there instead of
   * mounting a second editable form.
   */
  describe("the AP as network infrastructure", () => {
    beforeEach(() => {
      // Deterministic default regardless of test order — individual tests
      // override with a reachable AP where they need one.
      (fetchApWifi as ReturnType<typeof vi.fn>).mockResolvedValue({
        supported: false, ssid: null, fiveGhzSsid: null, key: null,
        encryption: null, bandSteering: null, apCount: 0, inSync: true,
      });
    });

    it("shows a read-only household Wi-Fi reflection + band steering once one is ONLINE", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "DROPLET_IMAGE" })],
      });
      (fetchApWifi as ReturnType<typeof vi.fn>).mockResolvedValue({
        supported: true, ssid: "Fotonia Home", fiveGhzSsid: null,
        key: "correct-horse-psk", encryption: "psk2", bandSteering: true,
        apCount: 1, inSync: true,
      });
      renderPanel();
      expect(await screen.findByText("Access point Wi-Fi")).toBeInTheDocument();
      // The live network name the AP broadcasts — never the PSK.
      expect(await screen.findByText("Fotonia Home")).toBeInTheDocument();
      expect(screen.queryByText("correct-horse-psk")).not.toBeInTheDocument();
      expect(screen.getByText("Band steering")).toBeInTheDocument();
    });

    it("has NO editable Wi-Fi form — edits route to the Wi-Fi tab (WARP-1723)", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "DROPLET_IMAGE" })],
      });
      (fetchApWifi as ReturnType<typeof vi.fn>).mockResolvedValue({
        supported: true, ssid: "Fotonia Home", fiveGhzSsid: null,
        key: "correct-horse-psk", encryption: "psk2", bandSteering: true,
        apCount: 1, inSync: true,
      });
      renderPanel();
      await screen.findByText("Access point Wi-Fi");
      // No SSID/password inputs, no save button — a second editable surface is
      // exactly the bug WARP-1723 removed.
      expect(
        screen.queryByLabelText("Network name (SSID)"),
      ).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Wi-Fi password")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save Wi-Fi settings" }),
      ).not.toBeInTheDocument();
      // Instead: a link to the one canonical edit surface.
      const link = screen.getByRole("link", {
        name: /change in wi-fi settings/i,
      });
      expect(link).toHaveAttribute("href", "/network?tab=wifi");
    });

    /**
     * UX blocker 2 (second pass) — the summary destructured only `{ data }`,
     * so a persistent fetch failure left `data` undefined forever and the card
     * said "Reading its network name…" permanently. A read-only reflection
     * that can get stuck lying is worse than one that admits it failed; the
     * honest string was already written one branch away.
     */
    it("admits a failed read instead of 'reading…' forever", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "DROPLET_IMAGE" })],
      });
      (fetchApWifi as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Failed to fetch access point Wi-Fi: 502"),
      );
      renderPanel();
      await screen.findByText("Access point Wi-Fi");

      expect(
        await screen.findByText(/network name couldn't be read right now/i),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/reading its network name/i),
      ).not.toBeInTheDocument();
    });

    /**
     * UX a11y (second pass) — the tabpanels conditionally unmount, so
     * activating this link destroys the focused <a> and focus falls to
     * <body>: a keyboard/SR user lands nowhere and has to re-Tab through the
     * shell. The panel hands the activation back to the page, which owns the
     * post-activation focus machinery (`keyboardFocusTarget` → focus
     * `#network-tab-wifi`). Plain <a> navigation stays the fallback.
     */
    it("hands cross-tab activation to the page so focus can follow", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "DROPLET_IMAGE" })],
      });
      (fetchApWifi as ReturnType<typeof vi.fn>).mockResolvedValue({
        supported: true, ssid: "Fotonia Home", fiveGhzSsid: null,
        key: "correct-horse-psk", encryption: "psk2", bandSteering: true,
        apCount: 1, inSync: true,
      });
      const onOpenWifiSettings = vi.fn();
      renderPanel({ onOpenWifiSettings });
      const link = await screen.findByRole("link", {
        name: /change in wi-fi settings/i,
      });

      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(onOpenWifiSettings).toHaveBeenCalledTimes(1);
      // The handler replaces the navigation, so the page keeps control of
      // focus rather than the browser tearing the panel down mid-activation.
      expect(event.defaultPrevented).toBe(true);
      // …but it is still a real link: the href survives for middle-click,
      // "open in new tab", and the no-JS path.
      expect(link).toHaveAttribute("href", "/network?tab=wifi");
    });

    /**
     * UX mobile (second pass) — `type-footnote` + `inline-flex` with no
     * padding is an 18px hit area, under WCAG 2.2 SC 2.5.8's 24px floor, and
     * it sits on its own line just above the 56px bottom tab bar. `py-1` takes
     * it to 26px; the margins absorb the padding so nothing moves. The quiet
     * link colour is used elsewhere for SUPPLEMENTARY links; here it is the
     * sole route to a primary task, so it reads at full text weight.
     */
    it("meets the 24px tap target and reads as a primary route", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "DROPLET_IMAGE" })],
      });
      renderPanel();
      const link = await screen.findByRole("link", {
        name: /change in wi-fi settings/i,
      });

      expect(link.className).toContain("py-1");
      expect(link.className).toContain("text-[color:var(--text)]");
      expect(link.className).not.toContain("text-[color:var(--text-muted)]");
    });

    it("identifies it as Droplet infrastructure, not a generic device", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "DROPLET_IMAGE" })],
      });
      renderPanel();
      // The vendor badge is the "whose hardware is this" signal (ADR-024 §4).
      // Exact match — the control cards' copy also mentions Droplet.
      expect(await screen.findByText("Droplet")).toBeInTheDocument();
    });

    it("hides the controls when no Droplet AP is ONLINE — no fake surface", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "AWAITING_APPROVAL" })],
      });
      renderPanel();
      await screen.findByText(/approve/i);
      expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
      expect(screen.queryByText("Band steering")).not.toBeInTheDocument();
    });

    it("hides the controls for a vendor-managed AP — its controller owns them", async () => {
      (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
        aps: [makeAp({ status: "ONLINE", backend: "UNIFI", vendor: "Ubiquiti" })],
      });
      renderPanel();
      await screen.findByText("Upstairs");
      expect(screen.queryByText("Access point Wi-Fi")).not.toBeInTheDocument();
    });
  });
});
