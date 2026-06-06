/**
 * WARP-825 — Settings "Danger Zone" section.
 *
 * Owner-only, visually separated factory-reset entry that drives the
 * <DestructiveConfirm> flow.
 *
 * Contract under test:
 *   - Renders NOTHING for non-owner roles (admin/family/guest) — the destructive
 *     capability is owner-only on the client too (the server enforces it as well).
 *   - Renders the Danger Zone + a factory-reset entry for an owner.
 *   - Opening the entry shows the consequence copy and the type-to-confirm modal.
 *   - Confirming calls triggerFactoryReset with the typed phrase and then shows
 *     the "returns to first-run setup" progress state.
 *   - A server refusal (e.g. mismatch / already-in-progress) is surfaced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const getResetStatus = vi.fn();
const triggerFactoryReset = vi.fn();
vi.mock("@/lib/api", () => ({
  getResetStatus: (...a: unknown[]) => getResetStatus(...a),
  triggerFactoryReset: (...a: unknown[]) => triggerFactoryReset(...a),
}));

const useAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuth(),
}));

import { DangerZoneSection } from "./DangerZoneSection";

function asOwner() {
  useAuth.mockReturnValue({ user: { id: "o1", username: "owner", displayName: "Owner", role: "owner" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  getResetStatus.mockResolvedValue({ targetName: "droplet-home", job: null });
  triggerFactoryReset.mockResolvedValue({ status: "dispatched", id: "job-1", targetName: "droplet-home" });
});

describe("DangerZoneSection — visibility", () => {
  it("renders nothing for a family role", () => {
    useAuth.mockReturnValue({ user: { id: "f1", username: "fam", displayName: "Fam", role: "family" } });
    const { container } = render(<DangerZoneSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an admin role", () => {
    useAuth.mockReturnValue({ user: { id: "a1", username: "adm", displayName: "Adm", role: "admin" } });
    const { container } = render(<DangerZoneSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the Danger Zone + factory reset entry for an owner", async () => {
    asOwner();
    render(<DangerZoneSection />);
    expect(await screen.findByText(/danger zone/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /factory reset…/i })).toBeInTheDocument();
  });
});

describe("DangerZoneSection — reset flow", () => {
  // The row trigger opens a dialog, so it carries an ellipsis ("Factory reset…");
  // the modal's destructive action is the bare "Factory reset". This keeps them
  // distinguishable for screen-reader users (and these tests).
  const openModal = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /factory reset…/i }));
  };
  const modalActionButton = () =>
    screen.getByRole("button", { name: /^factory reset$/i });

  it("opens the confirm modal with the consequence + first-run copy", async () => {
    asOwner();
    render(<DangerZoneSection />);
    await openModal();
    expect(await screen.findByText(/factory reset this droplet/i)).toBeInTheDocument();
    // The modal consequence copy names the first-run outcome.
    expect(screen.getAllByText(/first-run setup/i).length).toBeGreaterThan(0);
  });

  it("calls triggerFactoryReset with the typed device name and shows progress", async () => {
    asOwner();
    render(<DangerZoneSection />);
    await openModal();

    // Type the device name to clear the friction step.
    const input = await screen.findByLabelText(/type .* to confirm/i);
    fireEvent.change(input, { target: { value: "droplet-home" } });

    fireEvent.click(modalActionButton());

    await waitFor(() => expect(triggerFactoryReset).toHaveBeenCalledWith("droplet-home"));
    // Progress state mentions the box returning to first-run setup.
    await waitFor(() =>
      expect(screen.getByText(/under way/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a server refusal (already in progress)", async () => {
    asOwner();
    triggerFactoryReset.mockRejectedValueOnce(new Error("A factory reset is already in progress."));
    render(<DangerZoneSection />);
    await openModal();
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: "droplet-home" },
    });
    fireEvent.click(modalActionButton());
    expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
  });
});
