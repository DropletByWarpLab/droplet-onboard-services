/**
 * WARP-827 — Drives panel remake.
 *
 * Covers the dashboard-side acceptance criteria:
 *   - AC2: inline, admin-only rename wired to updateDriveLabel(uuid,
 *     { displayName }). Edit → save shows the new name optimistically;
 *     non-admins get no edit affordance; validation rejects empty/too-long.
 *   - AC3/AC6: the raw /dev/sdX device path is NEVER rendered to the user.
 *   - AC5: a drive card deep-links into the existing Nextcloud file browser
 *     scoped to the drive (reuse — no new endpoint).
 *
 * The two data hooks are mocked so the suite drives the render/interaction
 * layer directly; `updateDriveLabel` is mocked to assert the wired call and
 * exercise the optimistic update + rollback. useAuth is mocked to flip the
 * admin gate (same pattern as the auth-gate suites).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { DriveInfo } from "@/lib/types";

// next/link → plain anchor so we can assert href without a Next router.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const useAuthMock = vi.fn();
vi.mock("@/lib/auth", () => ({ useAuth: () => useAuthMock() }));

const useDrivesMock = vi.fn();
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: () => useDrivesMock() }));

const usePoolsMock = vi.fn();
vi.mock("@/lib/hooks/usePools", () => ({ usePools: () => usePoolsMock() }));

const toastMock = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/lib/api", () => ({
  updateDriveLabel: vi.fn(),
  ejectDrive: vi.fn(),
  rescanDrives: vi.fn(),
  // WARP-936 — adopt + format flows on the panel. The remaining names exist
  // because DrivesPanel imports helpers from StorageStep, whose module-level
  // imports must all resolve on the mocked module.
  adoptDrive: vi.fn(),
  confirmStorageCommand: vi.fn(),
  requestFormatPool: vi.fn(),
  fetchDrives: vi.fn(),
  fetchPools: vi.fn(),
  requestCreatePool: vi.fn(),
  confirmPoolCommand: vi.fn(),
  requestAdoptDrive: vi.fn(),
}));

import {
  updateDriveLabel,
  adoptDrive,
  confirmStorageCommand,
  requestFormatPool,
} from "@/lib/api";
import type { DiskInfo, PoolInfo } from "@/lib/types";
import { DrivesPanel } from "./DrivesPanel";

function makeDrive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/sdb1",
    mount: "/mnt/droplet/photos-ab12cd34",
    label: "TOSHIBA EXT",
    uuid: "U-DATA-1",
    size_bytes: 2_000_000_000_000,
    used_bytes: 100_000_000_000,
    free_bytes: 1_900_000_000_000,
    mounted: true,
    bus: "usb",
    fs: "ext4",
    removable: true,
    displayName: null,
    icon: null,
    notes: null,
    ...overrides,
  };
}

const refresh = vi.fn();

function setup({
  role = "owner",
  drives = [makeDrive()],
  disks = [],
  pools = [],
  bridgeError = undefined,
}: {
  role?: "owner" | "admin" | "family" | "guest";
  drives?: DriveInfo[];
  disks?: DiskInfo[];
  pools?: PoolInfo[];
  bridgeError?: string;
} = {}) {
  useAuthMock.mockReturnValue({ user: { id: "u1", username: "u", displayName: "U", role } });
  useDrivesMock.mockReturnValue({
    drives,
    disks,
    isLoading: false,
    bridgeError,
    refresh,
  });
  usePoolsMock.mockReturnValue({ pools, refresh: vi.fn() });
  return render(<DrivesPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DrivesPanel — no raw device path (WARP-827 AC3/AC6)", () => {
  it("never renders the raw /dev/sdX path", () => {
    setup();
    expect(screen.queryByText(/\/dev\/sd/)).not.toBeInTheDocument();
    expect(screen.queryByText("/dev/sdb1")).not.toBeInTheDocument();
  });

  it("still shows the friendly bus label", () => {
    setup();
    expect(screen.getByText("USB")).toBeInTheDocument();
  });
});

describe("DrivesPanel — drive contents deep-link (WARP-827 AC5)", () => {
  it("links the drive into the file browser scoped to its mount tail", () => {
    setup({ drives: [makeDrive({ mount: "/mnt/droplet/photos-ab12cd34" })] });
    const link = screen.getByRole("link", { name: /open|view|browse|contents|files/i });
    // The existing FilesPage honors ?path=; the drive surfaces in Nextcloud at
    // /<mount-tail>, so the deep-link must target that path.
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("/files?path=%2Fphotos-ab12cd34"),
    );
  });
});

describe("DrivesPanel — inline rename (WARP-827 AC2)", () => {
  it("shows no edit affordance for a non-admin (family) user", () => {
    setup({ role: "family" });
    expect(screen.queryByRole("button", { name: /rename|edit name/i })).not.toBeInTheDocument();
  });

  it("admin can edit → save and sees the new name optimistically", async () => {
    (updateDriveLabel as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "U-DATA-1",
      displayName: "Wedding Photos",
      icon: null,
      notes: null,
    });
    setup({ role: "owner" });

    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    const input = screen.getByRole("textbox", { name: /drive name/i });
    fireEvent.change(input, { target: { value: "Wedding Photos" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // Wired to the existing client fn with the right shape.
    await waitFor(() =>
      expect(updateDriveLabel).toHaveBeenCalledWith("U-DATA-1", {
        displayName: "Wedding Photos",
      }),
    );
    // Optimistic: the new name is on screen before/without a refetch.
    expect(await screen.findByText("Wedding Photos")).toBeInTheDocument();
  });

  it("trims and rejects an empty name without calling the API", () => {
    setup({ role: "owner" });
    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    const input = screen.getByRole("textbox", { name: /drive name/i });
    fireEvent.change(input, { target: { value: "   " } });
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    fireEvent.click(save);
    expect(updateDriveLabel).not.toHaveBeenCalled();
  });

  it("cancel exits edit mode and keeps the original name", () => {
    setup({ role: "owner", drives: [makeDrive({ displayName: "Photos" })] });
    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /drive name/i }), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("textbox", { name: /drive name/i })).not.toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });

  it("rolls back the optimistic name when the save fails", async () => {
    (updateDriveLabel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    setup({ role: "owner", drives: [makeDrive({ displayName: "Photos" })] });

    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /drive name/i }), {
      target: { value: "Wedding Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // After the rejected save the original name is restored and an error toast
    // fires — with SAVE copy (WARP-1141), not the files-domain "couldn't load
    // those files" fallback that made a failed rename read as a load hiccup.
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.stringMatching(/couldn.t save/i),
        "error",
      ),
    );
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.queryByText("Wedding Photos")).not.toBeInTheDocument();
  });

  // WARP-1141 — a role-blocked rename (403: the session's token role isn't
  // owner/admin even though the pencil rendered) must name the permission
  // problem, never fail silently or as a generic blip.
  it("surfaces the permission copy when the save is refused with 403", async () => {
    (updateDriveLabel as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("Forbidden: role not permitted"), { status: 403 }),
    );
    setup({ role: "owner", drives: [makeDrive({ displayName: "Photos" })] });

    fireEvent.click(screen.getByRole("button", { name: /rename|edit name/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /drive name/i }), {
      target: { value: "Wedding Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.stringMatching(/owner or an admin/i),
        "error",
      ),
    );
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });

  // WARP-1141 — the rename PATCH is keyed by FS UUID; the bridge can report a
  // drive without one, and renaming it can never persist. The pencil must not
  // offer a save that is guaranteed to fail.
  it("shows no rename affordance for a drive the bridge reports without a UUID", () => {
    setup({ role: "owner", drives: [makeDrive({ uuid: "" })] });
    expect(screen.queryByRole("button", { name: /rename|edit name/i })).not.toBeInTheDocument();
  });
});

// =====================================================================
// WARP-936 — adoptable drives: the panel must never hide a pool (or a
// present-but-unmounted disk) behind the drives.length===0 early return.
// The live box's exact shape: drives=[], pools=[md127 resyncing],
// disks=[sda/sdb pool_member] — and the old panel said "No drives mounted".
// =====================================================================

const md127: PoolInfo = {
  device: "md127",
  level: "raid1",
  status: "resyncing",
  members: ["sda", "sdb"],
  displayName: null,
  notes: null,
};

function makeDisk(overrides: Partial<DiskInfo> = {}): DiskInfo {
  return {
    name: "sdc",
    size_bytes: 2_000_000_000_000,
    state: "foreign",
    fstype: "ntfs",
    bus: "usb",
    model: "Samsung T7",
    serial: "S-1",
    ...overrides,
  };
}

describe("DrivesPanel — pools stay visible with zero mounted drives (WARP-936)", () => {
  it("renders the pool card instead of the 'No drives mounted' dead end", () => {
    setup({ drives: [], pools: [md127], disks: [
      makeDisk({ name: "sda", state: "pool_member", md: "md127" }),
      makeDisk({ name: "sdb", state: "pool_member", md: "md127" }),
    ] });
    expect(screen.queryByText(/no drives mounted/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/storage pool/i).length).toBeGreaterThan(0);
    // The resyncing banner still fires for the pool that needs attention.
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps the honest bridge-unavailable state", () => {
    setup({ drives: [], bridgeError: "bridge_unavailable" });
    expect(
      // Curly apostrophe in the rendered copy — match around it.
      screen.getByText(/storage service isn.t reachable/i),
    ).toBeInTheDocument();
  });

  it("shows a calm inline empty state for the drives section when nothing is mounted", () => {
    setup({ drives: [], pools: [md127] });
    expect(screen.getByText(/plug in a drive/i)).toBeInTheDocument();
  });
});

describe("DrivesPanel — available drives + erase & adopt (WARP-936)", () => {
  it("lists a foreign disk and wires Erase & adopt through the confirm-token flow", async () => {
    (adoptDrive as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-adopt",
      service: "drive_adopt",
      resourceId: "sdc",
    });
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setup({ disks: [makeDisk()] });

    expect(screen.getByText(/available drives/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /erase & adopt/i }));

    await waitFor(() =>
      expect(adoptDrive).toHaveBeenCalledWith(
        expect.objectContaining({
          device: "sdc",
          wipeMethod: "quick",
          confirmPhrase: "ERASE sdc",
        }),
      ),
    );
    // Blast-radius dialog opens; nothing executes until confirmed.
    expect(confirmStorageCommand).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /erase & adopt/i }));
    await waitFor(() =>
      expect(confirmStorageCommand).toHaveBeenCalledWith({
        confirmationToken: "tok-adopt",
        service: "drive_adopt",
        resourceId: "sdc",
      }),
    );
  });

  it("offers adopt for an empty (available) disk too", () => {
    setup({ disks: [makeDisk({ name: "sdd", state: "available", fstype: "", model: "" })] });
    expect(screen.getByRole("button", { name: /erase & adopt/i })).toBeInTheDocument();
  });

  it("routes a pool-member disk to the pool card — never an individual adopt", () => {
    setup({
      pools: [md127],
      disks: [
        makeDisk({ name: "sda", state: "pool_member", md: "md127" }),
        makeDisk({ name: "sdb", state: "pool_member", md: "md127" }),
      ],
    });
    expect(screen.queryByRole("button", { name: /erase & adopt/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/part of .*pool/i).length).toBeGreaterThan(0);
  });

  it("hides the adopt affordance from non-admins", () => {
    setup({ role: "family", disks: [makeDisk()] });
    expect(screen.queryByRole("button", { name: /erase & adopt/i })).not.toBeInTheDocument();
  });

  it("never renders a raw /dev/ path in the available-drives section", () => {
    setup({ disks: [makeDisk()] });
    expect(screen.queryByText(/\/dev\//)).not.toBeInTheDocument();
  });
});

describe("DrivesPanel — format & mount an unformatted pool (WARP-936)", () => {
  it("offers Format & mount on a pool with no mounted filesystem and wires the confirm flow", async () => {
    (requestFormatPool as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-fmt",
      service: "pool_format",
      resourceId: "md127",
    });
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setup({ drives: [], pools: [md127] });

    fireEvent.click(screen.getByRole("button", { name: /format & mount/i }));
    await waitFor(() =>
      expect(requestFormatPool).toHaveBeenCalledWith(
        "md127",
        expect.objectContaining({ confirmPhrase: "ERASE md127" }),
      ),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /format & mount/i }));
    await waitFor(() =>
      expect(confirmStorageCommand).toHaveBeenCalledWith({
        confirmationToken: "tok-fmt",
        service: "pool_format",
        resourceId: "md127",
      }),
    );
  });

  it("reports the honest outcome — formatted AND mounted (UX review)", async () => {
    // pool_format really does mount now (host script mirrors drive_adopt's
    // final step), so the success toast must say so — a bare "formatted"
    // contradicted the "Format & mount" button on the same flow.
    (requestFormatPool as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-fmt",
      service: "pool_format",
      resourceId: "md127",
    });
    (confirmStorageCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    setup({ drives: [], pools: [md127] });

    fireEvent.click(screen.getByRole("button", { name: /format & mount/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /format & mount/i }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.stringMatching(/formatted and mounted/i),
        "success",
      ),
    );
  });

  it("returns focus to the row CTA when the confirm dialog is cancelled (WCAG 2.4.3)", async () => {
    (requestFormatPool as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "confirmation_required",
      confirmationToken: "tok-fmt",
      service: "pool_format",
      resourceId: "md127",
    });
    setup({ drives: [], pools: [md127] });

    const cta = screen.getByRole("button", { name: /format & mount/i });
    cta.focus();
    fireEvent.click(cta);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(cta).toHaveFocus());
  });

  it("does NOT offer Format & mount when the pool is already mounted as a drive", () => {
    setup({
      drives: [makeDrive({ device: "/dev/md127", mount: "/mnt/droplet/pool" })],
      pools: [{ ...md127, status: "active" }],
    });
    expect(screen.queryByRole("button", { name: /format & mount/i })).not.toBeInTheDocument();
  });

  it("does NOT offer Format & mount when the pool is mounted via a partition of the array (md127p1)", () => {
    // UX-review secondary: keying only on the exact md node re-offered the
    // erase CTA forever for an exotically-partitioned pool.
    setup({
      drives: [makeDrive({ device: "/dev/md127p1", mount: "/mnt/droplet/pool" })],
      pools: [{ ...md127, status: "active" }],
    });
    expect(screen.queryByRole("button", { name: /format & mount/i })).not.toBeInTheDocument();
  });

  it("still offers Format & mount when only a DIFFERENT md pool is mounted (md12 vs md127)", () => {
    // Prefix-match pitfall: /dev/md127p1 must not count as a mount of md12.
    setup({
      drives: [makeDrive({ device: "/dev/md127p1", mount: "/mnt/droplet/pool" })],
      pools: [
        { ...md127, status: "active" },
        { ...md127, device: "md12" },
      ],
    });
    expect(screen.getByRole("button", { name: /format & mount/i })).toBeInTheDocument();
  });

  it("hides Format & mount from non-admins", () => {
    setup({ role: "family", drives: [], pools: [md127] });
    expect(screen.queryByRole("button", { name: /format & mount/i })).not.toBeInTheDocument();
  });
});
