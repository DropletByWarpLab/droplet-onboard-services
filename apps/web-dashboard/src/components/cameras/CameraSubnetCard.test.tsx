/**
 * Camera network isolation card.
 *
 * camera_subnet_setup / camera_subnet_teardown are Tier-2 network commands:
 * the orchestrator answers 202 + confirmationToken and does NOTHING until the
 * token is redeemed at /api/cameras/command/confirm. The card used to treat the
 * 202 as success, so "Enable Isolation" silently did nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  authFetch: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => h.authFetch(...a),
}));

vi.mock("@/lib/api", () => ({
  confirmCameraCommand: (...a: unknown[]) => h.confirm(...a),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: h.toast, dismissAll: vi.fn() }),
}));

import { CameraSubnetCard } from "./CameraSubnetCard";

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const pending = (token = "tok-123") =>
  json(202, { status: "confirmation_required", confirmationToken: token, reason: "r", tier: 2, expiresIn: 60 });

function renderCard(config: Parameters<typeof CameraSubnetCard>[0]["config"], onRefresh = vi.fn()) {
  render(<CameraSubnetCard config={config} onRefresh={onRefresh} />);
  return { onRefresh };
}

const dialog = () => within(screen.getByRole("dialog"));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("enabling isolation", () => {
  it("asks first on a 202, then redeems the token for camera_subnet_setup and refreshes", async () => {
    h.authFetch.mockResolvedValue(pending("tok-setup"));
    h.confirm.mockResolvedValue(undefined);
    const { onRefresh } = renderCard({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /Enable Isolation/i }));

    expect(await screen.findByText("Move cameras to an isolated network?")).toBeTruthy();
    expect(h.authFetch).toHaveBeenCalledWith(
      "/api/cameras/subnet/setup",
      expect.objectContaining({ method: "POST" }),
    );
    // Nothing is executed, and nothing refreshes, until the user agrees.
    expect(h.confirm).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByText(/VLAN 100/)).toBeTruthy();

    fireEvent.click(dialog().getByRole("button", { name: /Enable isolation/i }));

    await waitFor(() => expect(h.confirm).toHaveBeenCalledWith("tok-setup", "camera_subnet_setup"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(h.toast).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("toasts the server error when the confirm fails, and keeps the dialog open for a retry", async () => {
    h.authFetch.mockResolvedValue(pending());
    h.confirm.mockRejectedValue(new Error("Routing service unavailable"));
    const { onRefresh } = renderCard({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /Enable Isolation/i }));
    await screen.findByRole("dialog");
    fireEvent.click(dialog().getByRole("button", { name: /Enable isolation/i }));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Routing service unavailable", "error"));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says the confirmation expired and resets when the 60 s token is rejected", async () => {
    h.authFetch.mockResolvedValue(pending());
    h.confirm.mockRejectedValue(new Error("Confirmation token has expired (60s limit)"));
    const { onRefresh } = renderCard({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /Enable Isolation/i }));
    await screen.findByRole("dialog");
    fireEvent.click(dialog().getByRole("button", { name: /Enable isolation/i }));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Confirmation expired, try again", "error"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRefresh).not.toHaveBeenCalled();
    // Reset: the Enable button is available again.
    expect(screen.getByRole("button", { name: /Enable Isolation/i })).toBeTruthy();
  });

  it("does not execute anything when the user cancels", async () => {
    h.authFetch.mockResolvedValue(pending());
    renderCard({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /Enable Isolation/i }));
    await screen.findByRole("dialog");
    fireEvent.click(dialog().getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("still works when no confirmation is required (200)", async () => {
    h.authFetch.mockResolvedValue(json(200, { success: true }));
    const { onRefresh } = renderCard({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /Enable Isolation/i }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("toasts a blocked (429) request and opens no dialog", async () => {
    h.authFetch.mockResolvedValue(json(429, { error: "Too many network changes", blocked: true }));
    renderCard({ enabled: false });

    fireEvent.click(screen.getByRole("button", { name: /Enable Isolation/i }));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Too many network changes", "error"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("disabling isolation", () => {
  const enabled = { enabled: true, subnet: "192.168.100.1", netmask: "255.255.255.0" };

  it("on a 202 redeems the token for camera_subnet_teardown straight away, with no second dialog", async () => {
    h.authFetch.mockResolvedValue(pending("tok-down"));
    h.confirm.mockResolvedValue(undefined);
    const { onRefresh } = renderCard(enabled);

    fireEvent.click(screen.getByRole("button", { name: /Disable/i }));
    await screen.findByText("Remove camera subnet isolation?");
    fireEvent.click(dialog().getByRole("button", { name: "Disable isolation" }));

    await waitFor(() => expect(h.confirm).toHaveBeenCalledWith("tok-down", "camera_subnet_teardown"));
    expect(h.authFetch).toHaveBeenCalledWith("/api/cameras/subnet", { method: "DELETE" });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("toasts and keeps the dialog open when the teardown confirm fails", async () => {
    h.authFetch.mockResolvedValue(pending());
    h.confirm.mockRejectedValue(new Error("Router rejected the change"));
    const { onRefresh } = renderCard(enabled);

    fireEvent.click(screen.getByRole("button", { name: /Disable/i }));
    await screen.findByRole("dialog");
    fireEvent.click(dialog().getByRole("button", { name: "Disable isolation" }));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Router rejected the change", "error"));
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("router unreachable", () => {
  it("shows the error state instead of 'not isolated' and disables Enable", () => {
    renderCard({ enabled: false, error: "Router not reachable" });

    expect(screen.getByText("Router not reachable — isolation can't be changed right now")).toBeTruthy();
    expect(screen.queryByText("Cameras on main LAN — not isolated")).toBeNull();
    const enable = screen.getByRole("button", { name: /Enable Isolation/i }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);

    fireEvent.click(enable);
    expect(h.authFetch).not.toHaveBeenCalled();
  });

  it("shows the plain 'not isolated' state when there is no error", () => {
    renderCard({ enabled: false });
    expect(screen.getByText("Cameras on main LAN — not isolated")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Enable Isolation/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
