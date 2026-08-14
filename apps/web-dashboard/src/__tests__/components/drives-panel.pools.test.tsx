import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// next/link → plain anchor (the global setup stub stringifies children, which
// would swallow the WARP-1339 pool card's browse-link title). Same per-file
// override DrivesPanel.test.tsx uses.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { useDrivesMock, usePoolsMock, toastMock, useAuthMock } = vi.hoisted(() => ({
  useDrivesMock: vi.fn(),
  usePoolsMock: vi.fn(),
  toastMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: useDrivesMock }));
vi.mock("@/lib/hooks/usePools", () => ({ usePools: usePoolsMock }));
// WARP-827: DrivesPanel now reads useAuth() (admin gate for inline rename) and
// updateDriveLabel(); mock both so this pools-focused suite renders without an
// AuthProvider. Backed by a hoisted vi.fn() so a single test can flip the role
// (the non-admin reclaim-hiding case) instead of always returning owner.
vi.mock("@/lib/auth", () => ({
  useAuth: () => useAuthMock(),
}));
const { reclaimDriveMock, updatePoolLabelMock, confirmStorageCommandMock } = vi.hoisted(() => ({
  reclaimDriveMock: vi.fn(),
  updatePoolLabelMock: vi.fn(),
  confirmStorageCommandMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ejectDrive: vi.fn(),
  rescanDrives: vi.fn(),
  updateDriveLabel: vi.fn(),
  // WARP-936 — adopt/format flows on the panel, plus the api names
  // StorageStep (whose helpers DrivesPanel imports) pulls at module load.
  adoptDrive: vi.fn(),
  confirmStorageCommand: confirmStorageCommandMock,
  requestFormatPool: vi.fn(),
  fetchDrives: vi.fn(),
  fetchPools: vi.fn(),
  requestCreatePool: vi.fn(),
  confirmPoolCommand: vi.fn(),
  requestAdoptDrive: vi.fn(),
  // WARP-1048 — reclaim a pool-member disk + rename a pool.
  reclaimDrive: reclaimDriveMock,
  updatePoolLabel: updatePoolLabelMock,
}));

import type { DiskInfo, PoolInfo } from "@/lib/types";
import { DrivesPanel } from "@/components/FileManager/DrivesPanel";

const drive = (over: Record<string, unknown> = {}) => ({
  device: "/dev/sda",
  mount: "/mnt/droplet/data",
  label: "DISK",
  uuid: "u-1",
  size_bytes: 1_000_000_000_000,
  used_bytes: 100_000_000_000,
  free_bytes: 900_000_000_000,
  mounted: true,
  bus: "sata",
  ...over,
});

beforeEach(() => {
  reclaimDriveMock.mockReset();
  updatePoolLabelMock.mockReset();
  confirmStorageCommandMock.mockReset();
  toastMock.mockReset();
  // Default to owner so the card structure is fully exercised; the non-admin
  // case re-points this to a family role for its render only.
  useAuthMock.mockReturnValue({
    user: { id: "u1", username: "u", displayName: "U", role: "owner" },
  });
  useDrivesMock.mockReturnValue({
    drives: [drive()],
    disks: [],
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  });
  usePoolsMock.mockReturnValue({
    pools: [],
    isLoading: false,
    bridgeError: undefined,
    refresh: vi.fn(),
  });
});

describe("DrivesPanel — real pools replace the fake pooled sum (BUG-3)", () => {
  it("shows an explicit 'no storage pool' state when no array exists (no fabricated sum)", () => {
    render(<DrivesPanel />);
    // The old fiction was a "Total pooled storage" summary computed by summing
    // drive bytes. With no pool, the panel must say so honestly.
    expect(screen.queryByText(/total pooled storage/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no storage pool/i)).toBeInTheDocument();
  });

  it("renders a real pool with its level + usable capacity when one exists", () => {
    // WARP-1339: "usable capacity" is the mounted md filesystem's REAL
    // fs-level numbers (ADR-019 — never a fabricated raw-member sum), joined
    // from the drives list onto the pool card.
    useDrivesMock.mockReturnValue({
      drives: [
        drive({
          device: "/dev/md0",
          pool: "md0",
          mount: "/mnt/droplet/pool",
          label: "",
          uuid: "u-md0",
          size_bytes: 4 * 1024 ** 4,
          used_bytes: 1 * 1024 ** 4,
          free_bytes: 3 * 1024 ** 4,
        }),
      ],
      disks: [],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    usePoolsMock.mockReturnValue({
      pools: [
        {
          device: "md0",
          level: "raid1",
          status: "active",
          members: ["sda", "sdb"],
          displayName: "Vault",
        },
      ],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    expect(screen.getByText("Vault")).toBeInTheDocument();
    // RAID level is surfaced (mirrors-mode capacity ≠ raw sum).
    expect(screen.getByText(/raid 1/i)).toBeInTheDocument();
    // The capacity meter renders the md filesystem's actual bytes.
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    expect(poolsList).toHaveTextContent(/1\.0 TB of 4\.0 TB/);
    expect(poolsList).toHaveTextContent(/3\.0 TB free/);
  });

  it("shows a degraded-array banner when a pool is degraded", () => {
    usePoolsMock.mockReturnValue({
      pools: [
        { device: "md0", level: "raid5", status: "degraded", members: ["sda", "sdb", "sdc"] },
      ],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    const banner = screen.getByRole("alert");
    expect(banner).toBeInTheDocument();
    // The banner itself names the degraded state (badge also says it — both
    // are intended, so scope the assertion to the alert).
    expect(banner).toHaveTextContent(/degraded/i);
  });

  it("shows a rebuild affordance when a pool is resyncing", () => {
    usePoolsMock.mockReturnValue({
      pools: [
        { device: "md0", level: "raid1", status: "resyncing", members: ["sda", "sdb"] },
      ],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(/rebuild|resync/i);
  });

  it("still lists the underlying drives alongside pools", () => {
    render(<DrivesPanel />);
    // Drive cards remain (named from the mount tail when no displayName).
    expect(screen.getByRole("list", { name: /drives/i })).toBeInTheDocument();
  });

  it("never surfaces raw /dev paths or kernel device names in the pool card (ADR-002)", () => {
    usePoolsMock.mockReturnValue({
      pools: [
        {
          device: "md0",
          level: "raid1",
          status: "active",
          members: ["sda", "sdb"],
          displayName: "Vault",
        },
      ],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    // No raw kernel names — the user is non-technical (ADR-002).
    expect(poolsList).not.toHaveTextContent("/dev/");
    expect(poolsList).not.toHaveTextContent(/\bmd0\b/);
    expect(poolsList).not.toHaveTextContent(/\bsda\b/);
    expect(poolsList).not.toHaveTextContent(/\bsdb\b/);
    // Friendly presentation instead: name + level + member count.
    expect(poolsList).toHaveTextContent("Vault");
    expect(poolsList).toHaveTextContent(/raid 1/i);
    expect(poolsList).toHaveTextContent(/2 drives/i);
  });

  it("falls back to a friendly pool name (never md0) when there is no displayName", () => {
    usePoolsMock.mockReturnValue({
      pools: [
        { device: "md0", level: "raid1", status: "active", members: ["sda"] },
      ],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    expect(poolsList).toHaveTextContent(/storage pool/i);
    expect(poolsList).not.toHaveTextContent(/\bmd0\b/);
    // Asserted on the chip element itself: toHaveTextContent joins
    // siblings without spaces, so the WARP-936 format-footer copy right
    // after the chip would defeat a word-boundary regex on the joined string.
    expect(within(poolsList).getByText(/^1 drive$/i)).toBeInTheDocument();
  });
});

// =====================================================================
// WARP-1339 — ONE pooled entry instead of pool card + anonymous GUID
// drive tile. The mounted md filesystem is annotated pool:"<mdN>" by the
// orchestrator (bare array name — the /storage/pools join key); the panel
// merges it INTO the pool card (capacity + browse link) and excludes it
// from the drives grid. The merge shape was previously tested NOWHERE.
// =====================================================================
describe("DrivesPanel — one pooled entry with real capacity (WARP-1339)", () => {
  const TIB = 1024 ** 4;
  const GUID = "a0f10a84-7116-46a7-a3e3-5e00ea1c7d08";
  const activePool: PoolInfo = {
    device: "md127",
    level: "raid1",
    status: "active",
    members: ["sdb", "sdc"],
    displayName: null,
    notes: null,
  };
  const mdDrive = () =>
    drive({
      device: "/dev/md127",
      pool: "md127",
      mount: `/mnt/droplet/${GUID}`,
      label: "",
      uuid: "U-POOL-FS",
      size_bytes: 4 * TIB,
      used_bytes: 1 * TIB,
      free_bytes: 3 * TIB,
    });

  function setupMerged({
    drives = [mdDrive()],
    pools = [activePool],
    disks = [],
  }: {
    drives?: unknown[];
    pools?: PoolInfo[];
    disks?: DiskInfo[];
  } = {}) {
    useDrivesMock.mockReturnValue({
      drives,
      disks,
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    usePoolsMock.mockReturnValue({
      pools,
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    return render(<DrivesPanel />);
  }

  it("renders ONE pooled entry with the md filesystem's capacity — no separate DriveCard", () => {
    setupMerged();
    // The pool card carries the real fs-level meter (ADR-019 usable capacity).
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    expect(poolsList).toHaveTextContent(/1\.0 TB of 4\.0 TB/);
    expect(poolsList).toHaveTextContent(/3\.0 TB free/);
    // The md drive is NOT doubled into the drives grid: with no standalone
    // drive left the grid shows its calm empty state instead of a GUID card.
    expect(screen.queryByRole("list", { name: /mounted drives/i })).toBeNull();
    expect(screen.getByText(/plug in a drive/i)).toBeInTheDocument();
    // The GUID mount tail is never rendered anywhere (ADR-002).
    expect(screen.queryByText(new RegExp(GUID.slice(0, 8), "i"))).not.toBeInTheDocument();
  });

  it("gives the pool card the matched drive's browse link", () => {
    setupMerged();
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    const link = within(poolsList).getByRole("link", { name: /open storage pool/i });
    // driveContentsHref of the matched md drive — the automounter registers
    // the pool's fs in Nextcloud under its mount tail like any drive.
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining(`/files?path=%2F${GUID.slice(0, 8)}`),
    );
  });

  it("keeps mapping standalone drives into the grid — only the pool-backed one is excluded", () => {
    setupMerged({ drives: [mdDrive(), drive()] });
    const grid = screen.getByRole("list", { name: /mounted drives/i });
    const cards = within(grid).getAllByRole("listitem");
    expect(cards).toHaveLength(1);
    // The standalone /dev/sda drive card survives (titled from its FS label).
    expect(within(grid).getByText("DISK")).toBeInTheDocument();
  });

  it("still merges via the md-device regex when the orchestrator predates the pool field", () => {
    const legacy = { ...mdDrive(), pool: undefined };
    setupMerged({ drives: [legacy] });
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    expect(poolsList).toHaveTextContent(/3\.0 TB free/);
    expect(screen.queryByRole("list", { name: /mounted drives/i })).toBeNull();
  });

  it("keeps the md drive in the grid when its pool is missing from the pools payload", () => {
    // Degraded /storage/pools fetch (or bridge gap): hiding the drive with no
    // pool card to merge into would lose the volume everywhere. Honest
    // fallback: render it as a drive (GUID-guarded title says Storage pool).
    setupMerged({ pools: [] });
    const grid = screen.getByRole("list", { name: /mounted drives/i });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(1);
  });

  // AC4 — DEGRADED-EDGE REGRESSION GUARD: only drives whose DEVICE is the md
  // node are hidden from the grid. A dropped member disk (state pool_member,
  // out of the degraded array) must STAY visible with its Reclaim action, and
  // the degraded banner must still fire.
  it("keeps a dropped member visible with Reclaim + fires the degraded banner (merge shape)", () => {
    setupMerged({
      drives: [mdDrive()],
      pools: [{ ...activePool, status: "degraded" as const }],
      disks: [
        {
          name: "sda",
          size_bytes: 2 * TIB,
          state: "pool_member",
          fstype: "linux_raid_member",
          bus: "sata",
          model: "WDC WD20EARZ",
          md: "md127",
        },
      ],
    });
    // The degraded banner still fires.
    expect(screen.getByRole("alert")).toHaveTextContent(/degraded/i);
    // The dropped member stays in Available drives with its Reclaim action.
    expect(screen.getByRole("button", { name: /^reclaim & erase$/i })).toBeInTheDocument();
    // And the pool card still shows the (still-mounted) array's capacity.
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    expect(poolsList).toHaveTextContent(/3\.0 TB free/);
  });
});

// WARP-1048 — a pool-member disk gets a "Reclaim" action (break it out of the
// array, then adopt it) instead of the read-only "manage it from the pool"
// dead-end #824 shipped. Same tier-3 confirm-token flow as adopt.
describe("DrivesPanel — reclaim a pool-member drive (WARP-1048)", () => {
  const poolMemberDisk = {
    name: "sda",
    size_bytes: 2_000_000_000_000,
    state: "pool_member" as const,
    fstype: "linux_raid_member",
    bus: "sata",
    model: "WDC WD20EARZ",
    md: "md127",
  };

  it("offers a Reclaim action on a pool-member disk (not just 'manage from pool')", () => {
    useDrivesMock.mockReturnValue({
      drives: [drive()],
      disks: [poolMemberDisk],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    expect(screen.getByRole("button", { name: /reclaim/i })).toBeInTheDocument();
  });

  it("mints a reclaim confirm token carrying the disk + its md array", async () => {
    reclaimDriveMock.mockResolvedValue({
      confirmationToken: "tok-1",
      service: "drive_reclaim",
      resourceId: "sda",
    });
    useDrivesMock.mockReturnValue({
      drives: [drive()],
      disks: [poolMemberDisk],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /reclaim/i }));
    await waitFor(() => expect(reclaimDriveMock).toHaveBeenCalledTimes(1));
    const arg = reclaimDriveMock.mock.calls[0][0];
    expect(arg.device).toBe("sda");
    expect(arg.md).toBe("md127");
    // The typed phrase names the disk being erased (host-script gate).
    expect(String(arg.confirmPhrase)).toContain("sda");
  });

  it("does not offer Reclaim to a non-admin (read-only member card)", () => {
    // A family (non-admin) user must never see the destructive Reclaim action —
    // it is admin-gated exactly like adopt (isAdmin === owner || admin). Flip
    // the hoisted auth mock to a family role for this render only.
    useAuthMock.mockReturnValue({ user: { id: "u2", role: "family" } });
    useDrivesMock.mockReturnValue({
      drives: [drive()],
      disks: [poolMemberDisk],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    // The member card still renders (read-only), but with NO Reclaim button.
    expect(screen.queryByRole("button", { name: /reclaim/i })).toBeNull();
  });

  it("offers Reclaim to an admin on the same member card (control case)", () => {
    // The positive counterpart to the non-admin case above: owner (the
    // beforeEach default) DOES get the gated Reclaim action on the member card.
    useDrivesMock.mockReturnValue({
      drives: [drive()],
      disks: [poolMemberDisk],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    expect(screen.getByRole("button", { name: /reclaim/i })).toBeInTheDocument();
  });
});

// WARP-1048 — rename a pool inline on its card, mirroring the per-drive rename.
describe("DrivesPanel — rename a storage pool (WARP-1048)", () => {
  const resyncingPool = {
    device: "md127",
    level: "raid1" as const,
    status: "resyncing" as const,
    members: ["sda", "sdb"],
    displayName: null,
  };

  it("shows a rename control on the pool card for admins", () => {
    usePoolsMock.mockReturnValue({
      pools: [resyncingPool],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    expect(
      within(poolsList).getByRole("button", { name: /rename/i }),
    ).toBeInTheDocument();
  });

  it("saves the new pool name via updatePoolLabel", async () => {
    updatePoolLabelMock.mockResolvedValue({
      device: "md127",
      displayName: "Family Vault",
    });
    const refreshPools = vi.fn();
    usePoolsMock.mockReturnValue({
      pools: [resyncingPool],
      isLoading: false,
      bridgeError: undefined,
      refresh: refreshPools,
    });
    render(<DrivesPanel />);
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    fireEvent.click(within(poolsList).getByRole("button", { name: /rename/i }));
    const input = within(poolsList).getByRole("textbox", { name: /pool name/i });
    fireEvent.change(input, { target: { value: "Family Vault" } });
    fireEvent.click(within(poolsList).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(updatePoolLabelMock).toHaveBeenCalledTimes(1));
    expect(updatePoolLabelMock.mock.calls[0][0]).toBe("md127");
    expect(updatePoolLabelMock.mock.calls[0][1]).toMatchObject({
      displayName: "Family Vault",
    });
  });

  // WARP-1141 — a failed pool rename must surface a visible, action-naming
  // error and roll the optimistic name back; a role-blocked save (403) gets
  // the permission copy, never the misleading files-load fallback.
  it("rolls back and toasts the permission copy when the save is role-blocked (403)", async () => {
    updatePoolLabelMock.mockRejectedValue(
      Object.assign(new Error("Forbidden: role not permitted"), { status: 403 }),
    );
    usePoolsMock.mockReturnValue({
      pools: [{ ...resyncingPool, displayName: "Vault" }],
      isLoading: false,
      bridgeError: undefined,
      refresh: vi.fn(),
    });
    render(<DrivesPanel />);
    const poolsList = screen.getByRole("list", { name: /storage pools/i });
    fireEvent.click(within(poolsList).getByRole("button", { name: /rename/i }));
    fireEvent.change(within(poolsList).getByRole("textbox", { name: /pool name/i }), {
      target: { value: "Family Vault" },
    });
    fireEvent.click(within(poolsList).getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.stringMatching(/owner or an admin/i),
        "error",
      ),
    );
    // The optimistic "Family Vault" is rolled back to the persisted name.
    expect(within(poolsList).getByText("Vault")).toBeInTheDocument();
    expect(within(poolsList).queryByText("Family Vault")).not.toBeInTheDocument();
  });
});
