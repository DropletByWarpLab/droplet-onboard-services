import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

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
});
