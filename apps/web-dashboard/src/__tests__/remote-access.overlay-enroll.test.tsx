/**
 * WARP-1475 — Remote Access "Link a device" (overlay QR-enroll, ADR-030).
 *
 * Owner/admin-only surface added to the Remote Access page:
 *   - a "Link a device" action that mints a one-shot link token and renders it
 *     as a `droplet://overlay-enroll` QR (token shown once, cleared on close,
 *     NEVER logged);
 *   - a pending-approval queue that lists staged enrollments (device-presented
 *     label rendered as TEXT, never HTML), flags conflict rows as security
 *     events, and approves/denies with honest per-case copy for the 409/503
 *     failures the orchestrator returns.
 *
 * Real transport is mocked at the api seam (WARP-1288), not the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({
  role: "owner" as "owner" | "admin" | "family" | "guest" | null,
  mint: vi.fn(),
  pending: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  fetchVpnStatus: vi.fn(),
  fetchVpnPeers: vi.fn(),
  createVpnPeer: vi.fn(),
  deleteVpnPeer: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchVpnStatus: (...a: unknown[]) => h.fetchVpnStatus(...a),
  fetchVpnPeers: (...a: unknown[]) => h.fetchVpnPeers(...a),
  createVpnPeer: (...a: unknown[]) => h.createVpnPeer(...a),
  deleteVpnPeer: (...a: unknown[]) => h.deleteVpnPeer(...a),
  mintOverlayLinkToken: (...a: unknown[]) => h.mint(...a),
  fetchPendingOverlayEnrollments: (...a: unknown[]) => h.pending(...a),
  approveOverlayEnrollment: (...a: unknown[]) => h.approve(...a),
  denyOverlayEnrollment: (...a: unknown[]) => h.deny(...a),
  fetchSystemHealth: () => Promise.resolve({ status: "ok" }),
}));

vi.mock("@/lib/hooks/useDevice", () => ({
  useDevice: () => ({
    device: null,
    devices: [],
    health: null,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: h.role
      ? { id: "owner", username: "owner", displayName: "Owner", role: h.role }
      : null,
  }),
}));

// Render the QR as an inspectable stub so we can read the encoded deep link.
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <svg data-testid="overlay-qr" data-value={value} />
  ),
}));

import { ToastProvider } from "@/components/Toast";
import RemoteAccessPage from "@/app/remote-access/page";

function renderPage() {
  return render(
    <ToastProvider>
      <RemoteAccessPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  h.role = "owner";
  h.mint.mockReset();
  h.pending.mockReset();
  h.approve.mockReset();
  h.deny.mockReset();
  h.fetchVpnStatus.mockReset();
  h.fetchVpnPeers.mockReset();
  h.createVpnPeer.mockReset();
  h.deleteVpnPeer.mockReset();

  h.fetchVpnStatus.mockResolvedValue({
    configured: true,
    endpointConfigured: true,
    endpointHost: "box.example",
    homeEndpointHost: "192.168.1.87",
    listenPort: 51820,
    addresses: ["10.10.0.0/24"],
    serverPublicKey: "key12345abcdef",
  });
  h.fetchVpnPeers.mockResolvedValue({ peers: [] });
  h.pending.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Remote Access — Link a device (mint + QR)", () => {
  it("shows the owner-gated 'Link a device' action and polls the pending queue", async () => {
    renderPage();
    expect(
      await screen.findByRole("button", { name: /link a device/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(h.pending).toHaveBeenCalled());
  });

  it("hides the action and never fetches the queue for a non-owner", async () => {
    h.role = "family";
    renderPage();
    // Let the page settle its status/peer fetches.
    await waitFor(() => expect(h.fetchVpnStatus).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /link a device/i }),
    ).not.toBeInTheDocument();
    expect(h.pending).not.toHaveBeenCalled();
  });

  it("mints a token and renders it as a droplet://overlay-enroll QR, then forgets it on close", async () => {
    h.mint.mockResolvedValue({
      token: "b64urlToken-_09",
      server: "box.example",
      box_name: "Front Desk",
      expires_at: "2026-07-21T18:00:00.000Z",
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /link a device/i }));

    const qr = await screen.findByTestId("overlay-qr");
    const value = qr.getAttribute("data-value") ?? "";
    expect(value).toContain("droplet://overlay-enroll?");
    expect(value).toContain("server=box.example");
    expect(value).toContain("token=b64urlToken-_09");
    expect(value).toContain("box_name=Front%20Desk");

    // The one-shot warning copy.
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
    expect(screen.getByText(/invalidates|re-mint/i)).toBeInTheDocument();

    // Close → token forgotten (QR gone from the DOM).
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("overlay-qr")).not.toBeInTheDocument(),
    );
  });

  it("NEVER logs the minted token to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const secret = "SUPERSECRETtoken-_0929";
    h.mint.mockResolvedValue({
      token: secret,
      server: "box.example",
      box_name: "Droplet",
      expires_at: "2026-07-21T18:00:00.000Z",
    });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /link a device/i }));
    // The QR renders the token (proves it reached the UI)…
    const qr = await screen.findByTestId("overlay-qr");
    expect(qr.getAttribute("data-value") ?? "").toContain(secret);

    // …but nothing was ever written to the console containing it.
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secret);
      }
    }
  });
});

describe("Remote Access — pending enrollment queue", () => {
  const baseRow = {
    id: "pe-1",
    label: "Alice's iPhone",
    fingerprint_short: "a1b2c3d4",
    presented_at: new Date().toISOString(),
    state: "pending" as const,
    conflict: false,
  };

  it("renders a device-presented label as TEXT (no HTML injection)", async () => {
    const xss = '<img src=x onerror="alert(1)">pwn';
    h.pending.mockResolvedValue([{ ...baseRow, id: "pe-x", label: xss }]);

    const { container } = renderPage();

    // The payload appears verbatim as text…
    expect(await screen.findByText(xss)).toBeInTheDocument();
    // …and NOT as a live <img> element parsed from the label.
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it("flags a conflict row as a security event (distinct from a benign pending row)", async () => {
    h.pending.mockResolvedValue([
      { ...baseRow, id: "ok", label: "My laptop", conflict: false },
      { ...baseRow, id: "bad", label: "Unknown phone", conflict: true },
    ]);

    renderPage();

    // The conflict row carries the security-event marker; the benign one does not.
    const marker = await screen.findByText(/unexpected device/i);
    expect(marker).toBeInTheDocument();
    expect(screen.getAllByText(/unexpected device/i)).toHaveLength(1);
  });

  it("approves an enrollment and refreshes the queue", async () => {
    h.pending
      .mockResolvedValueOnce([baseRow])
      .mockResolvedValue([]);
    h.approve.mockResolvedValue({ state: "approved", device_id: "dev-1" });

    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: /approve device alice's iphone/i }),
    );

    await waitFor(() => expect(h.approve).toHaveBeenCalledWith("pe-1"));
    // Queue re-polled after the approve.
    await waitFor(() => expect(h.pending.mock.calls.length).toBeGreaterThan(1));
  });

  it("shows honest copy for a 409 wg_key_conflict on approve", async () => {
    h.pending.mockResolvedValue([baseRow]);
    h.approve.mockRejectedValue(
      Object.assign(new Error("wg_key_conflict"), {
        status: 409,
        code: "wg_key_conflict",
      }),
    );

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /approve device alice's iphone/i }),
    );

    // The mapped, honest message (mentions the key) — not a raw code or generic.
    expect(await screen.findByText(/key is already linked/i)).toBeInTheDocument();
    expect(screen.queryByText(/^wg_key_conflict$/)).not.toBeInTheDocument();
  });

  it("denies an enrollment", async () => {
    h.pending.mockResolvedValueOnce([baseRow]).mockResolvedValue([]);
    h.deny.mockResolvedValue({ state: "denied" });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: /deny device alice's iphone/i }),
    );

    await waitFor(() => expect(h.deny).toHaveBeenCalledWith("pe-1"));
  });
});
