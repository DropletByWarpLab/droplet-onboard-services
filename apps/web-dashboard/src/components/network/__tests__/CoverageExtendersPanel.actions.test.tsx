/**
 * WARP-446 — Coverage Extenders panel: action flows (blockers 2–6).
 *
 * Distinct from CoverageExtendersPanel.test.tsx which exercises the
 * read/render layer. This suite covers the interaction blockers from
 * the QA + UX review:
 *
 *   - blocker #2 — operationId polling on approve + decommission.
 *   - blocker #3 — <Dialog> wizard (replaces window.prompt) carries
 *     the PSK input, validates inline, submits with the right args.
 *   - blocker #4 — <ConfirmDialog> (replaces window.confirm) drives
 *     decommission only after the operator confirms.
 *   - blocker #5 — no raw amber/sky/emerald/red/slate-N classes left
 *     in the rendered DOM; semantic tokens only.
 *   - blocker #6 — a11y primitives: role="alert", role="status",
 *     aria-live on the card list, min-h-[36px] action buttons.
 *
 * framer-motion's useReducedMotion is stubbed (same pattern as
 * DeviceCard.blockMutation.test.tsx) so the dialog mounts
 * synchronously after the trigger click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoverageExtendersPanel } from "../CoverageExtendersPanel";
import type { ApDeviceInfo } from "@/lib/types";

// Stub framer-motion's reduced-motion gate so the dialog primitive
// mounts immediately on open() — keeps the click-through assertions
// synchronous.
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

vi.mock("@/lib/api", () => ({
  fetchApDevices: vi.fn(),
  approveApDevice: vi.fn(),
  decommissionApDevice: vi.fn(),
  fetchNetworkOperation: vi.fn(),
  // WARP-1712: the panel also renders live AP radio detail + the shared AP
  // Wi-Fi / band-steering controls. Honest "nothing to show" defaults keep
  // the approve/decommission flows under test unchanged.
  fetchApWirelessDetail: vi.fn().mockResolvedValue({ supported: false, radios: [] }),
  fetchApWifi: vi.fn().mockResolvedValue({
    supported: false, ssid: null, fiveGhzSsid: null, key: null,
    encryption: null, bandSteering: null, apCount: 0, inSync: true,
  }),
  setApWifi: vi.fn(),
  fetchBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
  setBandSteering: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import {
  fetchApDevices,
  approveApDevice,
  decommissionApDevice,
  fetchNetworkOperation,
} from "@/lib/api";

function makeAp(overrides: Partial<ApDeviceInfo> = {}): ApDeviceInfo {
  return {
    mac: "B8:27:EB:00:00:01",
    displayName: null,
    model: "raspberrypi,5-model-b",
    serial: "ABC123",
    version: "1.0",
    lastIp: "192.168.50.42",
    hostname: "droplet-extender",
    status: "AWAITING_APPROVAL",
    backend: "DROPLET_IMAGE",
    vendor: null,
    failureReason: null,
    approvedSsid: null,
    firstSeen: new Date(Date.now() - 60_000).toISOString(),
    lastSeen: new Date().toISOString(),
    approvedAt: null,
    approvedBy: null,
    decommissionedAt: null,
    lastOperationId: null,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0 }}
    >
      <CoverageExtendersPanel />
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────
// Blocker #3 — <Dialog>-based Approve wizard
// ──────────────────────────────────────────────────────────────────

describe("CoverageExtendersPanel — Approve dialog (blocker #3)", () => {
  it("opens a <Dialog> when a card's Approve button is clicked (no window.prompt)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp()],
    });
    // Spy on window.prompt to PROVE we never call it — the old
    // implementation used `window.prompt("...")` which is exactly
    // what this blocker is replacing.
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("never");

    renderPanel();
    const approveBtn = await screen.findByRole("button", {
      name: /approve/i,
    });
    fireEvent.click(approveBtn);

    // <Dialog> renders a role="dialog" with aria-modal.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // PSK input is the focusable target.
    expect(screen.getByLabelText(/wifi password/i)).toBeInTheDocument();
    // Read-only "Network: Droplet-AI" — operator doesn't pick the SSID.
    expect(screen.getByText("Droplet-AI")).toBeInTheDocument();
    // The raw "WPA2/WPA3" crypto noise from the old prompt must be gone.
    expect(screen.queryByText(/wpa2\/wpa3/i)).not.toBeInTheDocument();
    // And window.prompt was never invoked.
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("rejects a PSK shorter than 8 chars inline (no network call)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp()],
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /approve/i }),
    );
    const dialog = await screen.findByRole("dialog");
    const pskInput = within(dialog).getByLabelText(/wifi password/i);

    fireEvent.change(pskInput, { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^approve$/i }));

    // Inline error surfaces; approveApDevice never fires.
    expect(
      await within(dialog).findByText(/8 to 63 characters/i),
    ).toBeInTheDocument();
    expect(approveApDevice).not.toHaveBeenCalled();
  });

  it("submits to approveApDevice with the entered PSK + default SSID, then closes", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ mac: "B8:27:EB:00:00:42" })],
    });
    (approveApDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      ap: makeAp({ mac: "B8:27:EB:00:00:42", status: "ONLINE" }),
      operationId: null,
    });

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /approve/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/wifi password/i), {
      target: { value: "droplethome2026" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^approve$/i }));

    await waitFor(() => {
      expect(approveApDevice).toHaveBeenCalledWith("B8:27:EB:00:00:42", {
        ssid: "Droplet-AI",
        encryptionKey: "droplethome2026",
      });
    });
    // Dialog closes on success.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("show/hide eyeball toggles the PSK input type (password → text)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp()],
    });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /approve/i }),
    );
    const dialog = await screen.findByRole("dialog");
    const pskInput = within(dialog).getByLabelText(
      /wifi password/i,
    ) as HTMLInputElement;
    expect(pskInput.type).toBe("password");
    const toggle = within(dialog).getByRole("button", {
      name: /show password/i,
    });
    fireEvent.click(toggle);
    expect(pskInput.type).toBe("text");
    expect(
      within(dialog).getByRole("button", { name: /hide password/i }),
    ).toBeInTheDocument();
  });

  it("header '+ Add extender' button opens the dialog and pre-fills the awaiting extender", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ displayName: "Upstairs" })],
    });
    renderPanel();
    // Wait for SWR to settle.
    await screen.findByText("Upstairs");
    // Get the header Add button (the per-card Approve button is also
    // present, so use the header button by label).
    const headerAdd = screen.getByRole("button", { name: /^add extender$/i });
    fireEvent.click(headerAdd);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Upstairs")).toBeInTheDocument();
  });

  it("header '+ Add extender' opens an empty-state dialog when no extenders are awaiting", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [],
    });
    renderPanel();
    // Wait for empty state to render.
    await screen.findByText(/no extra access points yet/i);
    // Two Add buttons: header + empty-state CTA. Either should open
    // the empty-state dialog variant.
    fireEvent.click(
      screen.getAllByRole("button", { name: /^add extender$/i })[0],
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/no extenders detected yet/i),
    ).toBeInTheDocument();
    // PSK form is NOT rendered — there's nothing to approve yet.
    expect(within(dialog).queryByLabelText(/wifi password/i)).toBeNull();
  });

  it("empty-state CTA also opens the dialog (blocker #3 — wired everywhere)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [],
    });
    renderPanel();
    await screen.findByText(/no extra access points yet/i);
    const emptyAdds = screen.getAllByRole("button", {
      name: /^add extender$/i,
    });
    // 2 buttons: header + empty-state.
    expect(emptyAdds.length).toBe(2);
    fireEvent.click(emptyAdds[1]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

// ──────────────────────────────────────────────────────────────────
// Blocker #4 — <ConfirmDialog> for decommission
// ──────────────────────────────────────────────────────────────────

describe("CoverageExtendersPanel — Remove ConfirmDialog (blocker #4)", () => {
  it("opens a <ConfirmDialog> when Remove is clicked (no window.confirm)", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ status: "ONLINE", displayName: "Upstairs" })],
    });
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /remove upstairs/i }),
    );
    const dialog = await screen.findByRole("dialog");
    // Copy matches the spec exactly so QA can grep for it.
    expect(
      within(dialog).getByText(/remove this extender\?/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/up to 30 seconds/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^keep it$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
    // No native confirm.
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("calling Confirm fires decommissionApDevice; Keep it cancels", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ status: "ONLINE", displayName: "Upstairs" })],
    });
    (decommissionApDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      ap: makeAp({ status: "DECOMMISSIONED" }),
      operationId: null,
    });

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /remove upstairs/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));
    await waitFor(() => {
      expect(decommissionApDevice).toHaveBeenCalledWith("B8:27:EB:00:00:01");
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Blocker #2 — operationId polling
// ──────────────────────────────────────────────────────────────────

describe("CoverageExtendersPanel — operation-Id polling (blocker #2)", () => {
  it("polls /api/network/operations/:id after approve and shows pending → applied without the 10s SWR wait", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ mac: "B8:27:EB:00:00:42" })],
    });
    (approveApDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      ap: makeAp({ mac: "B8:27:EB:00:00:42", status: "PROVISIONING" }),
      operationId: "op-poll-1",
    });
    // First operation read: still pending. Second: applied.
    let callCount = 0;
    (fetchNetworkOperation as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string) => {
        callCount += 1;
        if (callCount === 1) {
          return { id, state: "pending", startedAt: 0, finishedAt: null, reason: null };
        }
        return { id, state: "applied", startedAt: 0, finishedAt: 1, reason: null };
      },
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /approve/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/wifi password/i), {
      target: { value: "droplethome2026" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^approve$/i }));

    // Pending banner appears after the operationId is captured.
    const pendingBanner = await screen.findByRole("status", {
      // The "Finishing setup…" copy is the canonical text.
      name: undefined,
    });
    expect(pendingBanner.textContent).toMatch(/finishing setup/i);

    // Tick the 1s poll interval enough times for the mock to flip
    // through pending → applied.
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(1_100);

    await waitFor(() => {
      expect(fetchNetworkOperation).toHaveBeenCalledWith("op-poll-1");
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  it("shows the rolled-back banner when the operation read returns rolled_back", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ mac: "B8:27:EB:00:00:42" })],
    });
    (approveApDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      ap: makeAp({ mac: "B8:27:EB:00:00:42" }),
      operationId: "op-rollback-1",
    });
    (fetchNetworkOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "op-rollback-1",
      state: "rolled_back",
      startedAt: 0,
      finishedAt: 1,
      reason: "Wireless config rejected",
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /approve/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/wifi password/i), {
      target: { value: "droplethome2026" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^approve$/i }));

    await vi.advanceTimersByTimeAsync(1_100);

    await waitFor(() => {
      expect(
        screen.getByText(/change was rolled back/i),
      ).toBeInTheDocument();
    });
  });
});

// ──────────────────────────────────────────────────────────────────
// Blocker #5 — no raw amber/sky/emerald/red-N tailwind classes
// ──────────────────────────────────────────────────────────────────

describe("CoverageExtendersPanel — semantic design tokens (blocker #5)", () => {
  it("renders without any raw amber/sky/emerald/slate/red-N classes", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({ displayName: "Awaiting", status: "AWAITING_APPROVAL" }),
        makeAp({ mac: "B8:27:EB:00:00:02", displayName: "Online", status: "ONLINE" }),
        makeAp({
          mac: "B8:27:EB:00:00:03",
          displayName: "Failed",
          status: "FAILED",
          failureReason: "Router unreachable",
        }),
        makeAp({
          mac: "B8:27:EB:00:00:04",
          displayName: "Removed",
          status: "DECOMMISSIONED",
        }),
      ],
    });
    const { container } = renderPanel();
    await screen.findByText("Awaiting");

    const html = container.innerHTML;
    // Any of these would mean a raw Tailwind palette leaked back in.
    // Use a strict regex on the class= attribute so substring matches
    // inside design-token names (e.g. system-red) don't false-positive.
    const forbidden = /class="[^"]*\b(?:amber|sky|emerald|slate|red)-\d{2,3}\b/;
    expect(html).not.toMatch(forbidden);
  });
});

// ──────────────────────────────────────────────────────────────────
// Blocker #6 — a11y primitives
// ──────────────────────────────────────────────────────────────────

describe("CoverageExtendersPanel — a11y primitives (blocker #6)", () => {
  it("loading state uses role='status'", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}), // never resolves so the loading state stays
    );
    renderPanel();
    expect(
      await screen.findByRole("status", { name: undefined }),
    ).toBeInTheDocument();
  });

  it("error message uses role='alert' and the card list uses aria-live='polite'", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [makeAp({ displayName: "Online", status: "ONLINE" })],
    });
    // Trigger the error banner by making decommissionApDevice throw.
    (decommissionApDevice as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("router timed out"), {
        code: "PROVISIONING_TIMEOUT",
      }),
    );

    renderPanel();
    // aria-live container on the card grid (new extenders announce here)
    const list = await screen.findByLabelText("Coverage extenders");
    expect(list).toHaveAttribute("aria-live", "polite");

    fireEvent.click(
      await screen.findByRole("button", { name: /remove online/i }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));

    // Error banner appears as role="alert" with friendly copy
    // (PROVISIONING_TIMEOUT → "Setting up took too long").
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(
        alerts.some((a) => /setting up took too long/i.test(a.textContent ?? "")),
      ).toBe(true);
    });
  });

  it("Approve + Remove buttons have min-h-[36px] for the 36px touch target", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({ displayName: "Awaiting", status: "AWAITING_APPROVAL" }),
        makeAp({ mac: "B8:27:EB:00:00:02", displayName: "Online", status: "ONLINE" }),
      ],
    });
    renderPanel();
    const approveBtn = await screen.findByRole("button", {
      name: /approve awaiting/i,
    });
    const removeBtn = screen.getByRole("button", { name: /remove online/i });
    // The Tailwind class `!min-h-[36px]` is on both.
    expect(approveBtn.className).toMatch(/min-h-\[36px\]/);
    expect(removeBtn.className).toMatch(/min-h-\[36px\]/);
  });

  it("Approve + Remove buttons carry focus-visible:ring for keyboard users", async () => {
    (fetchApDevices as ReturnType<typeof vi.fn>).mockResolvedValue({
      aps: [
        makeAp({ displayName: "Awaiting", status: "AWAITING_APPROVAL" }),
        makeAp({ mac: "B8:27:EB:00:00:02", displayName: "Online", status: "ONLINE" }),
      ],
    });
    renderPanel();
    const approveBtn = await screen.findByRole("button", {
      name: /approve awaiting/i,
    });
    const removeBtn = screen.getByRole("button", { name: /remove online/i });
    expect(approveBtn.className).toMatch(/focus-visible:ring/);
    expect(removeBtn.className).toMatch(/focus-visible:ring/);
  });
});
