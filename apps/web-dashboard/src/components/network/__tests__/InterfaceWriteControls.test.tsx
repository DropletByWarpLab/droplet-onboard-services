/**
 * InterfaceWriteControls (KAN-10) — Add / Edit / Restart write controls for the
 * Interfaces table.
 *
 * Editing an interface is high blast radius — a wrong setting can cut this
 * dashboard's own connection — so every write rides the shared ConfirmDialog +
 * the Tier-2/3 confirmNetworkCommand flow (the same idiom DhcpPoolForm and the
 * router-restart card use). Pins:
 *  - Add opens the editor; a valid create runs createInterface ->
 *    confirmNetworkCommand -> pollOperation with the entered fields;
 *  - editing the MANAGEMENT interface surfaces an extra confirm and sends
 *    force:true (the connectivity-self-cut guard);
 *  - editing a non-management interface does NOT send force;
 *  - Restart routes through restartNetwork (owner-only control).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  createInterface: vi.fn(),
  editInterface: vi.fn(),
  restartNetwork: vi.fn(),
  confirmNetworkCommand: vi.fn(),
  fetchNetworkOperation: vi.fn(),
}));

import {
  createInterface,
  editInterface,
  restartNetwork,
  confirmNetworkCommand,
  fetchNetworkOperation,
} from "@/lib/api";
import {
  InterfaceWriteControls,
  type InterfaceRow,
} from "../InterfaceWriteControls";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const ROWS: InterfaceRow[] = [
  { name: "lan", device: "br-lan", proto: "static", address: "192.168.1.1/24", zone: "lan", up: true, present: true },
  { name: "iot", device: "br-lan.20", proto: "static", address: "192.168.20.1/24", zone: "iot", up: true, present: true },
];

function renderControls(props?: Partial<React.ComponentProps<typeof InterfaceWriteControls>>) {
  return render(
    <InterfaceWriteControls
      rows={ROWS}
      canEdit
      isOwner
      onApplied={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(confirmNetworkCommand).mockResolvedValue({ operationId: "op-1" });
  asMock(fetchNetworkOperation).mockResolvedValue({ state: "applied" });
});

describe("InterfaceWriteControls", () => {
  it("Add opens the editor and a valid create runs the Tier-2 confirm dance", async () => {
    asMock(createInterface).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-c",
      operation: "create_interface",
    });

    renderControls();
    fireEvent.click(screen.getByRole("button", { name: /add interface/i }));

    fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: "guest" } });
    fireEvent.change(screen.getByLabelText(/address|ip/i), { target: { value: "192.168.40.1" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$|create|save/i }));

    await waitFor(() =>
      expect(createInterface).toHaveBeenCalledWith(
        "guest",
        expect.objectContaining({ proto: expect.any(String), ipaddr: "192.168.40.1" }),
      ),
    );
    await waitFor(() =>
      expect(confirmNetworkCommand).toHaveBeenCalledWith("tok-c", "create_interface"),
    );
  });

  it("editing a non-management interface does NOT send force", async () => {
    asMock(editInterface).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-e",
      operation: "edit_interface",
    });

    renderControls();
    // Edit the `iot` row.
    fireEvent.click(screen.getByRole("button", { name: /edit iot/i }));
    fireEvent.change(await screen.findByLabelText(/address|ip/i), {
      target: { value: "192.168.20.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save|apply|update/i }));

    await waitFor(() => expect(editInterface).toHaveBeenCalledOnce());
    const [, fields] = asMock(editInterface).mock.calls[0];
    expect(fields).toMatchObject({ ipaddr: "192.168.20.2" });
    expect(fields.force).toBeFalsy();
    // No extra management-confirm dialog for a non-management interface.
    expect(screen.queryByText(/this dashboard is reached on|lose your connection/i)).toBeNull();
  });

  it("editing the MANAGEMENT interface surfaces an extra confirm and sends force:true", async () => {
    asMock(editInterface).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-m",
      operation: "edit_interface",
    });

    renderControls();
    fireEvent.click(screen.getByRole("button", { name: /edit lan/i }));
    fireEvent.change(await screen.findByLabelText(/address|ip/i), {
      target: { value: "192.168.99.1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save|apply|update/i }));

    // Extra confirm for the management interface — the write must NOT fire yet.
    // The ConfirmDialog exposes the acknowledgement button.
    const ackBtn = await screen.findByRole("button", {
      name: /continue|proceed|i understand|confirm/i,
    });
    expect(editInterface).not.toHaveBeenCalled();

    // Acknowledge the extra confirm.
    fireEvent.click(ackBtn);

    await waitFor(() => expect(editInterface).toHaveBeenCalledOnce());
    const [name, fields] = asMock(editInterface).mock.calls[0];
    expect(name).toBe("lan");
    expect(fields.force).toBe(true);
  });

  it("Restart routes through restartNetwork after the confirm", async () => {
    asMock(restartNetwork).mockResolvedValue({ operationId: "op-r" });

    renderControls();
    fireEvent.click(screen.getByRole("button", { name: /restart network/i }));
    // ConfirmDialog confirm button — exact "Restart" (the trigger reads
    // "Restart network", so an exact match disambiguates).
    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));

    await waitFor(() => expect(restartNetwork).toHaveBeenCalledOnce());
  });

  it("hides every write control for a non-editor", () => {
    renderControls({ canEdit: false, isOwner: false });
    expect(screen.queryByRole("button", { name: /add interface/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /restart network/i })).toBeNull();
  });

  it("hides Restart for an admin (owner-only) but keeps Add/Edit", () => {
    renderControls({ canEdit: true, isOwner: false });
    expect(screen.getByRole("button", { name: /add interface/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /restart network/i })).toBeNull();
  });
});
