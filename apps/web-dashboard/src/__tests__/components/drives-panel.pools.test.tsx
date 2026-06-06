import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { useDrivesMock, usePoolsMock, toastMock } = vi.hoisted(() => ({
  useDrivesMock: vi.fn(),
  usePoolsMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("@/lib/hooks/useDrives", () => ({ useDrives: useDrivesMock }));
vi.mock("@/lib/hooks/usePools", () => ({ usePools: usePoolsMock }));
// WARP-827: DrivesPanel now reads useAuth() (admin gate for inline rename) and
// updateDriveLabel(); mock both so this pools-focused suite renders without an
// AuthProvider. Default to an admin so the card structure is fully exercised.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "u", displayName: "U", role: "owner" } }),
}));
vi.mock("@/lib/api", () => ({
  ejectDrive: vi.fn(),
  rescanDrives: vi.fn(),
  updateDriveLabel: vi.fn(),
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
  useDrivesMock.mockReturnValue({
    drives: [drive()],
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
});
