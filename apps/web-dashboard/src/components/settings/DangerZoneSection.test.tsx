/**
 * WARP-828 — Settings "Danger zone" section.
 *
 * Owner-only home for irreversible device actions. v1 action: reformat a data
 * drive (wipe + reformat + re-mount) via the existing drive_adopt → confirm
 * backend (storage.ts). The section gates on the client role for DISCOVERY
 * only — the orchestrator independently enforces owner-role + a confirm token,
 * so a non-owner who forced the request still can't execute (covered in
 * storage-pools.routes.test.ts).
 *
 * Covers:
 *   - renders nothing for a non-owner (family / admin / undefined);
 *   - renders the danger zone + reformat action for an owner;
 *   - the picker lists ONLY real data drives — system/junk entries are guarded
 *     out client-side regardless of what the feed returns (WARP-827 may or may
 *     not have landed the server-side filter when we branch);
 *   - choosing a drive shows its name + size and a blunt consequence;
 *   - the two-step flow calls adoptDrive (whole-disk name) then
 *     confirmStorageCommand, echoing service + resourceId from the token;
 *   - the whole-disk name is derived from a partition device path.
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

// Role is injected per-test.
let mockRole: string | undefined = "owner";
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: mockRole ? { id: "u1", role: mockRole } : null }),
}));

const fetchDrives = vi.fn();
const adoptDrive = vi.fn();
const confirmStorageCommand = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchDrives: (...a: unknown[]) => fetchDrives(...a),
  adoptDrive: (...a: unknown[]) => adoptDrive(...a),
  confirmStorageCommand: (...a: unknown[]) => confirmStorageCommand(...a),
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
});

describe("DangerZoneSection (WARP-828)", () => {
  it("renders nothing for a non-owner (family)", async () => {
    mockRole = "family";
    const { container } = render(<DangerZoneSection />);
    expect(container).toBeEmptyDOMElement();
    // It must not even probe the drives feed for a non-owner.
    expect(fetchDrives).not.toHaveBeenCalled();
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
    expect(
      screen.getByText(/reformat a drive/i),
    ).toBeInTheDocument();
  });

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

  it("drops non-whole-disk shapes (loop / md / dm) even with a uuid + size + data mount", async () => {
    // Regression (rjouffret): loop0 / md0 / dm-0 are NOT whole disks the host
    // wipe script can reformat. They can carry a real FS uuid, a non-trivial
    // size, and a /mnt data mount, so they sail past every OTHER guard — the
    // only thing that must exclude them is wholeDiskName() returning falsy for
    // an unrecognised shape. If that contract leaks the raw tail, these appear
    // in the picker and a selection 400s server-side instead of being excluded
    // up front. One real drive is mixed in to prove the filter is selective,
    // not a blanket "hide everything".
    fetchDrives.mockResolvedValueOnce({
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
          device: "/dev/loop0",
          mount: "/mnt/droplet/loopback",
          label: "LOOP",
          uuid: "U-LOOP",
          size_bytes: 8_000_000_000,
          used_bytes: 0,
          free_bytes: 8e9,
          mounted: true,
          displayName: "Loopback",
          removable: false,
        },
        {
          device: "/dev/md0",
          mount: "/mnt/droplet/raid",
          label: "RAID",
          uuid: "U-MD",
          size_bytes: 4_000_000_000_000,
          used_bytes: 0,
          free_bytes: 4e12,
          mounted: true,
          displayName: "Raid Array",
          removable: false,
        },
        {
          device: "/dev/dm-0",
          mount: "/mnt/droplet/mapper",
          label: "MAPPER",
          uuid: "U-DM",
          size_bytes: 1_000_000_000_000,
          used_bytes: 0,
          free_bytes: 1e12,
          mounted: true,
          displayName: "Mapped Volume",
          removable: false,
        },
      ],
      count: 4,
    });

    render(<DangerZoneSection />);
    const picker = await screen.findByLabelText(/choose a drive/i);
    const labels = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent ?? "")
      .join(" ");
    // The one genuine whole disk survives…
    expect(labels).toMatch(/wedding photos/i);
    // …and none of the non-whole-disk shapes are offered for a reformat.
    expect(labels).not.toMatch(/loopback|loop0/i);
    expect(labels).not.toMatch(/raid array|md0/i);
    expect(labels).not.toMatch(/mapped volume|dm-0/i);
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
    expect(adoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({ device: "sdb", wipeMethod: "quick" }),
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
    expect(adoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({ device: "nvme0n1" }),
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
