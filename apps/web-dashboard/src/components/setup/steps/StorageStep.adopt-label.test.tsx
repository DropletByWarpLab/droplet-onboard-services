/**
 * WARP-1337 — the setup wizard's adopt/reclaim flows seed the post-wipe
 * filesystem label from the customer's name for the disk.
 *
 * Nothing used to pass the optional `label` the orchestrator accepts, so an
 * adopted drive was mkfs'd label-less and mounted at /mnt/droplet/<fs-uuid> —
 * a GUID the customer then saw as the volume title. The wizard now passes the
 * best customer name available (the name typed in this step's field, else the
 * member's saved displayName, else its existing FS label), sanitized to the
 * route's ^[A-Za-z0-9_-]{1,16}$ contract, and OMITS it when nothing usable
 * remains.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const TB = 1_000_000_000_000;

// One previously-used (foreign) disk `sdb` holding one mounted filesystem the
// customer has already named "Wedding Photos", plus a pool-member disk `sda`
// for the reclaim path. A single poolable disk keeps the RAID chooser off.
const FIXTURE = {
  drives: [
    {
      device: "/dev/sdb1",
      mount: "/mnt/droplet/wedding",
      label: "TOSHIBA",
      uuid: "U-WED",
      parent_disk: "sdb",
      size_bytes: 2 * TB,
      used_bytes: 1e11,
      free_bytes: 1.9e12,
      mounted: true,
      removable: true,
      displayName: "Wedding Photos",
    },
  ],
  count: 1,
  disks: [
    { name: "sdb", size_bytes: 2 * TB, state: "foreign" },
    { name: "sda", size_bytes: 4 * TB, state: "pool_member", md: "md127" },
  ],
};

const requestAdoptDrive = vi.fn();
const reclaimDrive = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDrives: vi.fn(async () => FIXTURE),
    fetchPools: vi.fn(async () => ({ pools: [] })),
    requestAdoptDrive: (...a: unknown[]) => requestAdoptDrive(...a),
    reclaimDrive: (...a: unknown[]) => reclaimDrive(...a),
  };
});

import { StorageStep } from "./StorageStep";

async function openAdoptList() {
  render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
  const toggle = await screen.findByRole("switch", { name: /reclaim existing drives/i });
  fireEvent.click(toggle);
  await screen.findByTestId("adopt-list");
}

beforeEach(() => {
  vi.clearAllMocks();
  requestAdoptDrive.mockResolvedValue({
    status: "confirmation_required",
    confirmationToken: "tok-adopt",
    service: "drive_adopt",
    resourceId: "sdb",
  });
  reclaimDrive.mockResolvedValue({
    status: "confirmation_required",
    confirmationToken: "tok-reclaim",
    service: "drive_reclaim",
    resourceId: "sda",
  });
});

describe("StorageStep — adopt/reclaim seed the sanitized fs label (WARP-1337 AC4)", () => {
  it("passes the member's customer name as the sanitized label on adopt", async () => {
    await openAdoptList();
    fireEvent.click(screen.getByRole("button", { name: /erase & adopt/i }));
    await waitFor(() => expect(requestAdoptDrive).toHaveBeenCalledTimes(1));
    expect(requestAdoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        device: "sdb",
        label: "Wedding_Photos",
      }),
    );
  });

  it("prefers the name freshly typed in this step's field", async () => {
    await openAdoptList();
    // The wizard pre-fills the field with the saved displayName; the customer
    // retypes it — the TYPED name must win.
    const input = screen.getByPlaceholderText(/wedding photos/i);
    fireEvent.change(input, { target: { value: "Backups 2026!" } });
    fireEvent.click(screen.getByRole("button", { name: /erase & adopt/i }));
    await waitFor(() => expect(requestAdoptDrive).toHaveBeenCalledTimes(1));
    expect(requestAdoptDrive).toHaveBeenCalledWith(
      expect.objectContaining({ device: "sdb", label: "Backups_2026" }),
    );
  });

  it("omits the label on reclaim when the disk has no named member", async () => {
    await openAdoptList();
    // sda is a pool member with no mounted filesystems — nothing usable to
    // seed a label from, so the request must NOT carry one.
    fireEvent.click(screen.getByRole("button", { name: /^reclaim$/i }));
    await waitFor(() => expect(reclaimDrive).toHaveBeenCalledTimes(1));
    expect(reclaimDrive.mock.calls[0][0]).toMatchObject({ device: "sda", md: "md127" });
    expect((reclaimDrive.mock.calls[0][0] as { label?: string }).label).toBeUndefined();
  });
});
