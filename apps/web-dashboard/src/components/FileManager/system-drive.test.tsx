/**
 * WARP-2098 — the system/install disk is VISIBLE and SEPARATE.
 *
 * The complaint this answers: the storage figure on screen described the whole
 * box as one pool, and the Droplet's own boot drive appeared nowhere. It had
 * been filtered out of every drive list by WARP-827 — correctly, because those
 * lists feed rename / eject / erase / pool pickers, but the side effect was
 * that the disk Nextcloud actually writes uploads to was invisible.
 *
 * So these tests come in pairs. For each surface: the system drive IS rendered,
 * AND it carries none of the affordances a data drive carries. The second half
 * is the one that matters — a system drive that renders as an ordinary drive
 * card would be worse than one that is hidden.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { DriveInfo, PoolInfo, SystemDiskInfo } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const useDrivesMock = vi.fn();
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: () => useDrivesMock() }));
const usePoolsMock = vi.fn();
vi.mock("@/lib/hooks/usePools", () => ({ usePools: () => usePoolsMock() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "owner" } }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { VolumesPanel } from "./VolumesPanel";
import { DrivesPanel } from "./DrivesPanel";

// The panels format in BINARY units (1024-based) with decimal-looking labels,
// so fixture sizes are powers of two — otherwise 512e9 renders as "477 GB" and
// every assertion below would be an exercise in reading the formatter.
const GB = 1024 ** 3;

/** The live box: a 512 GB install NVMe whose /data LV holds the docker
 *  data-root, i.e. where uploaded files actually land. Root is small — which is
 *  exactly why a root-only reading would have been useless. */
function makeSystemDisk(overrides: Partial<SystemDiskInfo> = {}): SystemDiskInfo {
  return {
    name: "nvme0n1",
    size_bytes: 512 * GB,
    used_bytes: 120 * GB,
    free_bytes: 392 * GB,
    model: "Samsung SSD 980",
    serial: "S64ANS0T1",
    bus: "nvme",
    filesystems: [
      { mount: "/", role: "root", fs: "ext4", size_bytes: 64 * GB, used_bytes: 20 * GB, free_bytes: 44 * GB },
      { mount: "/boot/efi", role: "boot", fs: "vfat", size_bytes: 1 * GB, used_bytes: 0, free_bytes: 1 * GB },
      { mount: "/data", role: "data", fs: "ext4", size_bytes: 400 * GB, used_bytes: 100 * GB, free_bytes: 300 * GB },
    ],
    ...overrides,
  };
}

function makeDrive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/sdb1",
    mount: "/mnt/droplet/photos",
    label: "TOSHIBA EXT",
    uuid: "U-DATA",
    size_bytes: 2000 * GB,
    used_bytes: 500 * GB,
    free_bytes: 1500 * GB,
    mounted: true,
    displayName: null,
    removable: true,
    ...overrides,
  };
}

function setup(opts: {
  drives?: DriveInfo[];
  pools?: PoolInfo[];
  systemDisk?: SystemDiskInfo;
  totals?: unknown;
  disks?: unknown[];
}) {
  useDrivesMock.mockReturnValue({
    drives: opts.drives ?? [],
    disks: opts.disks ?? [],
    totals: opts.totals ?? null,
    systemDisk: opts.systemDisk,
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  });
  usePoolsMock.mockReturnValue({
    pools: opts.pools ?? [],
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Storage screen — System drive card (WARP-2098)", () => {
  it("shows the system drive, named as the system drive", async () => {
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    const section = await screen.findByRole("list", { name: "System drive" });
    expect(within(section).getByText("System drive")).toBeTruthy();
    // The kernel name is present for support, but never as the title.
    expect(within(section).getByText("nvme0n1")).toBeTruthy();
  });

  it("labels it as NOT user storage", async () => {
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    const section = await screen.findByRole("list", { name: "System drive" });
    expect(within(section).getByText("Not user storage")).toBeTruthy();
    expect(
      within(section).getByText(/isn.t part of your storage pool/i),
    ).toBeTruthy();
  });

  it("carries NO Browse / Rename / Eject affordance", async () => {
    // The whole reason this is a distinct component. A DriveCard has a stretched
    // link into the Nextcloud browser, an inline rename and an eject footer —
    // all three are wrong for a disk with no files_external registration and no
    // Drive row to name.
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    const section = await screen.findByRole("list", { name: "System drive" });
    expect(within(section).queryAllByRole("link")).toHaveLength(0);
    expect(within(section).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows the per-filesystem breakdown, so the owner sees where files land", async () => {
    // The useful part: /data is the docker data-root, so this row is the
    // answer to "why is my Droplet full when the pool is empty?".
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    const section = await screen.findByRole("list", { name: "System drive" });
    expect(within(section).getByText("App data and files")).toBeTruthy();
    expect(within(section).getByText("System software")).toBeTruthy();
    expect(within(section).getByText("Startup files")).toBeTruthy();
  });

  it("renders no meter and says so when usage could not be measured", async () => {
    // null usage means the bridge identified the disk but statvfs failed. A 0%
    // meter would claim a pristine empty disk.
    setup({
      drives: [makeDrive()],
      systemDisk: makeSystemDisk({ used_bytes: null, free_bytes: null, filesystems: [] }),
    });
    render(<DrivesPanel />);
    const section = await screen.findByRole("list", { name: "System drive" });
    expect(within(section).getByText("Usage unavailable.")).toBeTruthy();
    // Capacity is still stated — the disk is real.
    expect(within(section).getByText(/512 GB/)).toBeTruthy();
  });

  it("renders nothing at all on a bridge that does not report a system disk", async () => {
    // Host-side Python updates on reflash while the container updates
    // independently, so an older bridge is a real deployment. The page must be
    // exactly what it is today — no section, no skeleton, no placeholder.
    setup({ drives: [makeDrive()], systemDisk: undefined });
    render(<DrivesPanel />);
    expect(screen.queryByRole("list", { name: "System drive" })).toBeNull();
    expect(screen.queryByText("Not user storage")).toBeNull();
  });

  it("does not appear among the mounted drives or the available drives", async () => {
    // The load-bearing separation. If the system disk ever reached those grids
    // it would gain Eject, Rename and "Erase & adopt".
    setup({
      drives: [makeDrive()],
      systemDisk: makeSystemDisk(),
      disks: [{ name: "sdc", size_bytes: 1000 * GB, state: "available" }],
    });
    render(<DrivesPanel />);
    const mounted = await screen.findByRole("list", { name: "Mounted drives" });
    expect(within(mounted).queryByText("nvme0n1")).toBeNull();
    const available = screen.getByRole("list", { name: "Available drives" });
    expect(within(available).queryByText("nvme0n1")).toBeNull();
  });
});

describe("Storage screen — data-drive headline (WARP-2098)", () => {
  const totals = {
    size_bytes: 2000 * GB,
    used_bytes: 500 * GB,
    free_bytes: 1500 * GB,
    drive_count: 1,
    source: "data_drives" as const,
  };

  it("states the total across the owner's drives", async () => {
    setup({ drives: [makeDrive()], totals, systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    expect(
      await screen.findByText(/used across your drives/i),
    ).toBeTruthy();
  });

  it("never calls it pooled storage", async () => {
    // ADR-019 deleted a client-side byte-sum labelled "Total pooled storage"
    // because it described no disk that existed. This figure is also a sum, so
    // the naming guard travels with it.
    setup({ drives: [makeDrive()], totals, pools: [], systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    expect(screen.queryByText(/pooled storage/i)).toBeNull();
    expect(screen.queryByText(/total pooled/i)).toBeNull();
  });

  it("renders no headline at all when there is nothing to total", async () => {
    // totals null → no meter. A 0 B headline reads like a full disk.
    setup({ drives: [], totals: null, systemDisk: makeSystemDisk() });
    render(<DrivesPanel />);
    expect(screen.queryByText(/used across your drives/i)).toBeNull();
  });
});

describe("Files screen — System drive tile (WARP-2098)", () => {
  it("shows the system drive beside the owner's volumes", () => {
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<VolumesPanel />);
    const list = screen.getByRole("list", { name: "Storage volumes" });
    expect(within(list).getByText("System drive")).toBeTruthy();
    expect(within(list).getByText(/separate from your storage/i)).toBeTruthy();
  });

  it("is NOT a link — unlike every other tile on this screen", () => {
    // The other tiles are stretched links into the Nextcloud browser. The
    // system disk has no files_external registration, so a link would be dead.
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<VolumesPanel />);
    const list = screen.getByRole("list", { name: "Storage volumes" });
    const tiles = within(list).getAllByRole("listitem");
    const systemTile = tiles.find((t) => t.textContent?.includes("System drive"));
    expect(systemTile).toBeTruthy();
    expect(within(systemTile as HTMLElement).queryAllByRole("link")).toHaveLength(0);
    // …while the data drive next to it still is one.
    const dataTile = tiles.find((t) => t.textContent?.includes("TOSHIBA EXT"));
    expect(within(dataTile as HTMLElement).getAllByRole("link").length).toBeGreaterThan(0);
  });

  it("comes last — the owner's own storage leads", () => {
    setup({ drives: [makeDrive()], systemDisk: makeSystemDisk() });
    render(<VolumesPanel />);
    const tiles = screen.getAllByRole("listitem");
    expect(tiles[tiles.length - 1].textContent).toContain("System drive");
  });

  it("still appears on a box with no data drives yet", () => {
    // This is the box where "where do my files go?" is most urgent, and the
    // answer is the install disk. The panel used to render nothing here.
    setup({ drives: [], systemDisk: makeSystemDisk() });
    render(<VolumesPanel />);
    expect(screen.getByText("System drive")).toBeTruthy();
  });

  it("renders nothing when there are neither drives nor a system disk", () => {
    setup({ drives: [], systemDisk: undefined });
    const { container } = render(<VolumesPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("shows capacity without a meter when usage is unavailable", () => {
    setup({
      drives: [makeDrive()],
      systemDisk: makeSystemDisk({ used_bytes: null, free_bytes: null, filesystems: [] }),
    });
    render(<VolumesPanel />);
    expect(screen.getByText("Usage unavailable")).toBeTruthy();
  });
});

describe("byte formatting at pool scale (WARP-2098)", () => {
  it("renders a real unit at 1 PiB and beyond", () => {
    // VolumesPanel's formatBytes did not clamp its unit index, so a volume of
    // 1 PiB or more indexed past the end of the units array and rendered
    // "1.0 undefined". The sibling formatter in DrivesPanel has always clamped,
    // so the two disagreed on exactly the sizes a large pool can reach.
    setup({
      drives: [
        makeDrive({
          size_bytes: 2 ** 50,
          used_bytes: 2 ** 49,
          free_bytes: 2 ** 49,
        }),
      ],
    });
    render(<VolumesPanel />);
    expect(screen.queryByText(/undefined/)).toBeNull();
    expect(screen.getAllByText(/TB/).length).toBeGreaterThan(0);
  });
});
