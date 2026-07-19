/**
 * Settings "Danger zone" section (WARP-828 + WARP-825).
 *
 * Owner-only home for irreversible device actions. Two actions live here and
 * the section renders BOTH cards for an owner:
 *   - Reformat a data drive (WARP-828) — wipe + reformat + re-mount via the
 *     existing drive_adopt → confirm backend (storage.ts). The picker drops
 *     system/junk entries client-side; the two-step adopt→confirm flow echoes
 *     the token's service + resourceId. The orchestrator independently enforces
 *     owner-role + a confirm token (storage-pools.routes.test.ts).
 *   - Factory reset (WARP-825) — owner-only, type-to-confirm, then a "returns
 *     to first-run setup" progress state; server refusals are surfaced.
 *
 * The section gates on the client role for DISCOVERY only — the server enforces
 * owner-role on both endpoints too. A non-owner sees nothing and we probe
 * neither the drives feed nor the reset-status feed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const actual =
    await vi.importActual<typeof import("framer-motion")>("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

// Role is injected per-test via a module-level variable.
let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () =>
    mockRole
      ? { user: { id: "u1", username: "owner", displayName: "Owner", role: mockRole } }
      : { user: null },
}));

// A SINGLE @/lib/api mock that covers BOTH cards' calls — the merged section
// renders the reformat card AND the factory-reset card, so both feeds fire.
const fetchDrives = vi.fn();
const adoptDrive = vi.fn();
const confirmStorageCommand = vi.fn();
const getResetStatus = vi.fn();
const triggerFactoryReset = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchDrives: (...a: unknown[]) => fetchDrives(...a),
  adoptDrive: (...a: unknown[]) => adoptDrive(...a),
  confirmStorageCommand: (...a: unknown[]) => confirmStorageCommand(...a),
  getResetStatus: (...a: unknown[]) => getResetStatus(...a),
  triggerFactoryReset: (...a: unknown[]) => triggerFactoryReset(...a),
}));

import { DangerZoneSection } from "./DangerZoneSection";

// A realistic feed: two genuine data drives (one whole-disk, one partition) +
// a couple of entries a robust client must NOT offer to reformat.
function feed() {
  return {
    drives: [
      {
        device: "/dev/sdb",
        mount: "/mnt/droplet/wedding",
        label: "TOSHIBA",
        uuid: "U-WED",
        size_bytes: 2_000_000_000_000,
        used_bytes: 1e11,
        free_bytes: 1.9e12,
        mounted: true,
        displayName: "Wedding Photos",
        removable: true,
      },
      {
        device: "/dev/nvme0n1p1",
        mount: "/mnt/droplet/vault",
        label: "VAULT",
        uuid: "U-VAULT",
        size_bytes: 4_000_000_000_000,
        used_bytes: 0,
        free_bytes: 4e12,
        mounted: true,
        displayName: null,
        removable: false,
      },
      // System/junk shapes a hardened picker must drop client-side:
      // a tiny boot-ish sliver with no uuid, and a zero-byte phantom.
      {
        device: "/dev/sda1",
        mount: "/boot",
        label: "",
        uuid: "",
        size_bytes: 50_000_000,
        used_bytes: 1e6,
        free_bytes: 4.9e7,
        mounted: true,
        displayName: null,
        removable: false,
      },
    ],
    count: 3,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = "owner";
  fetchDrives.mockResolvedValue(feed());
  // The API returns only a MASKED hint of the device name (2026-06-09 sweep)
  // — the owner types the real name from Settings → Device information.
  getResetStatus.mockResolvedValue({ targetHint: "d••••••e", job: null });
  triggerFactoryReset.mockResolvedValue({
    status: "dispatched",
    id: "job-1",
    targetName: "droplet-home",
  });
});

describe("DangerZoneSection — visibility (WARP-828 + WARP-825)", () => {
  it("renders nothing for a non-owner (family)", async () => {
    mockRole = "family";
    const { container } = render(<DangerZoneSection />);
    expect(container).toBeEmptyDOMElement();
    // It must not even probe the drives feed or the reset status for a non-owner.
    expect(fetchDrives).not.toHaveBeenCalled();
    expect(getResetStatus).not.toHaveBeenCalled();
  });

  it("renders nothing for admin (owner-only, per the AC) and for no session", () => {
    mockRole = "admin";
    const a = render(<DangerZoneSection />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    mockRole = undefined;
    const b = render(<DangerZoneSection />);
    expect(b.container).toBeEmptyDOMElement();
  });

  it("renders a danger zone heading + reformat action for an owner", async () => {
    render(<DangerZoneSection />);
    expect(
      await screen.findByRole("heading", { name: /danger zone/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/reformat a drive/i)).toBeInTheDocument();
  });

  it("renders the factory reset entry for an owner", async () => {
    render(<DangerZoneSection />);
    expect(await screen.findByText(/danger zone/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /factory reset…/i }),
    ).toBeInTheDocument();
  });
});

describe("DangerZoneSection — reformat flow (WARP-828)", () => {
  it("lists only real data drives — system/no-uuid entries are dropped", async () => {
    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    const options = within(picker).getAllByRole("option");
    // Two valid data drives + the placeholder option, never the /boot sliver.
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.join(" ")).toMatch(/wedding photos/i);
    expect(labels.join(" ")).toMatch(/vault/i);
    expect(labels.join(" ")).not.toMatch(/boot|sda1/i);
  });

  it("shows the blunt consequence for the chosen drive", async () => {
    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    fireEvent.change(picker, { target: { value: "U-WED" } });
    expect(
      screen.getByText(/erases everything on wedding photos/i),
    ).toBeInTheDocument();
  });

  it("runs the two-step adopt→confirm flow with the WHOLE-disk name and token echo", async () => {
    adoptDrive.mockResolvedValueOnce({
      status: "confirmation_required",
      confirmationToken: "tok-abc",
      service: "drive_adopt",
      resourceId: "sdb",
    });
    confirmStorageCommand.mockResolvedValueOnce({ ok: true });

    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    fireEvent.change(picker, { target: { value: "U-WED" } });

    // Open the type-to-confirm modal.
    fireEvent.click(screen.getByRole("button", { name: /reformat this drive/i }));

    // Type the drive's display name to unlock the destructive button.
    const input = await screen.findByLabelText(/type .*to confirm/i);
    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));

    await waitFor(() => expect(adoptDrive).toHaveBeenCalledTimes(1));
    // WHOLE-disk name derived from /dev/sdb → "sdb" (already whole, no suffix).
    // WARP-1337: the customer's displayName seeds the post-wipe FS label
    // (sanitized to ^[A-Za-z0-9_-]{1,16}$) so the reformatted drive keeps its
    // name instead of re-mounting on a GUID tail.
    expect(adoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({ device: "sdb", wipeMethod: "quick", label: "Wedding_Photos" }),
    );
    await waitFor(() => expect(confirmStorageCommand).toHaveBeenCalledTimes(1));
    // The confirm MUST echo the service + resourceId from the minted token.
    expect(confirmStorageCommand).toHaveBeenCalledWith({
      confirmationToken: "tok-abc",
      service: "drive_adopt",
      resourceId: "sdb",
    });
  });

  it("derives the whole-disk name from a partition device path", async () => {
    adoptDrive.mockResolvedValueOnce({
      status: "confirmation_required",
      confirmationToken: "tok-nvme",
      service: "drive_adopt",
      resourceId: "nvme0n1",
    });
    confirmStorageCommand.mockResolvedValueOnce({ ok: true });

    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    // The vault drive's device is /dev/nvme0n1p1 (a partition).
    fireEvent.change(picker, { target: { value: "U-VAULT" } });
    fireEvent.click(screen.getByRole("button", { name: /reformat this drive/i }));

    const input = await screen.findByLabelText(/type .*to confirm/i);
    // No displayName → confirm phrase falls back to the FS label "VAULT".
    fireEvent.change(input, { target: { value: "VAULT" } });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));

    await waitFor(() => expect(adoptDrive).toHaveBeenCalledTimes(1));
    // WARP-1337: no displayName → the existing FS label is preserved across
    // the reformat.
    expect(adoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({ device: "nvme0n1", label: "VAULT" }),
    );
  });

  // Code review (WARP-1337): the host script mounts at /mnt/droplet/<LABEL>
  // with no busy-target guard — seeding a label a volume on ANOTHER disk
  // already carries would stack the new mount over it (shadow mount). The
  // reformat must suffix the colliding label; the drive's OWN label/mount
  // (erased by the wipe) must not count as a collision — the whole-disk test
  // above pins that side (VAULT reformats to plain "VAULT" over its own
  // /mnt/droplet/vault mount).
  it("suffixes the seeded label when a volume on another disk already carries it", async () => {
    const base = feed();
    base.drives.push({
      device: "/dev/sdd1",
      mount: "/mnt/droplet/Wedding_Photos",
      label: "Wedding_Photos",
      uuid: "U-CLASH",
      size_bytes: 1_000_000_000_000,
      used_bytes: 1e11,
      free_bytes: 9e11,
      mounted: true,
      displayName: null,
      removable: true,
    });
    fetchDrives.mockResolvedValue(base);
    adoptDrive.mockResolvedValueOnce({
      status: "confirmation_required",
      confirmationToken: "tok-abc",
      service: "drive_adopt",
      resourceId: "sdb",
    });
    confirmStorageCommand.mockResolvedValueOnce({ ok: true });

    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    fireEvent.change(picker, { target: { value: "U-WED" } });
    fireEvent.click(screen.getByRole("button", { name: /reformat this drive/i }));
    const input = await screen.findByLabelText(/type .*to confirm/i);
    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));

    await waitFor(() => expect(adoptDrive).toHaveBeenCalledTimes(1));
    expect(adoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({ device: "sdb", label: "Wedding_Phot_sdb" }),
    );
  });

  it("does not call confirmStorageCommand if the mint (adopt) fails", async () => {
    adoptDrive.mockRejectedValueOnce(new Error("403"));
    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    fireEvent.change(picker, { target: { value: "U-WED" } });
    fireEvent.click(screen.getByRole("button", { name: /reformat this drive/i }));
    const input = await screen.findByLabelText(/type .*to confirm/i);
    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /erase and reformat/i }));

    await waitFor(() => expect(adoptDrive).toHaveBeenCalled());
    expect(confirmStorageCommand).not.toHaveBeenCalled();
    // The modal stays open with an error for retry.
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  it("shows an empty hint when there are no data drives to reformat", async () => {
    fetchDrives.mockResolvedValueOnce({
      drives: [
        {
          device: "/dev/sda1",
          mount: "/boot",
          label: "",
          uuid: "",
          size_bytes: 50_000_000,
          used_bytes: 0,
          free_bytes: 5e7,
          mounted: true,
        },
      ],
      count: 1,
    });
    render(<DangerZoneSection />);
    expect(
      await screen.findByText(/no drives available to reformat/i),
    ).toBeInTheDocument();
  });
});

describe("DangerZoneSection — reset flow (WARP-825)", () => {
  // The row trigger opens a dialog, so it carries an ellipsis ("Factory reset…");
  // the modal's destructive action is the bare "Factory reset". This keeps them
  // distinguishable for screen-reader users (and these tests).
  const openModal = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /factory reset…/i }));
  };
  const modalActionButton = () =>
    screen.getByRole("button", { name: /^factory reset$/i });

  it("opens the confirm modal with the consequence + first-run copy", async () => {
    render(<DangerZoneSection />);
    await openModal();
    expect(await screen.findByText(/factory reset this droplet/i)).toBeInTheDocument();
    // The modal consequence copy names the first-run outcome.
    expect(screen.getAllByText(/first-run setup/i).length).toBeGreaterThan(0);
  });

  it("forwards the TYPED device name to the server and shows progress (server-validated confirm)", async () => {
    render(<DangerZoneSection />);
    await openModal();

    // The modal shows only the masked hint — the owner types the real name.
    const input = await screen.findByLabelText(/type .* to confirm/i);
    fireEvent.change(input, { target: { value: "droplet-home" } });

    fireEvent.click(modalActionButton());

    await waitFor(() => expect(triggerFactoryReset).toHaveBeenCalledWith("droplet-home"));
    // Progress state mentions the box returning to first-run setup.
    await waitFor(() => expect(screen.getByText(/under way/i)).toBeInTheDocument());
  });

  it("never renders an exact copy/paste-able confirm phrase — only the masked hint", async () => {
    render(<DangerZoneSection />);
    await openModal();
    await screen.findByLabelText(/type .* to confirm/i);
    // The verbatim device name must not appear anywhere in the modal.
    expect(screen.queryByText(/droplet-home/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/d••••••e/).length).toBeGreaterThan(0);
  });

  it("surfaces a server mismatch (CONFIRM_MISMATCH) for a wrong typed name", async () => {
    triggerFactoryReset.mockRejectedValueOnce(
      new Error("Type your device's name to confirm."),
    );
    render(<DangerZoneSection />);
    await openModal();
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: "wrong-name" },
    });
    fireEvent.click(modalActionButton());
    expect(
      await screen.findByText(/type your device's name to confirm/i),
    ).toBeInTheDocument();
    // Wrong guess never dispatched anything terminal — the modal stays open.
    expect(screen.getByText(/factory reset this droplet/i)).toBeInTheDocument();
  });

  it("surfaces a server refusal (already in progress)", async () => {
    triggerFactoryReset.mockRejectedValueOnce(
      new Error("A factory reset is already in progress."),
    );
    render(<DangerZoneSection />);
    await openModal();
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: "droplet-home" },
    });
    fireEvent.click(modalActionButton());
    expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
  });
});
