/**
 * WARP-857 item 5 — the RAID capacity calculator prices the pool from the
 * WHOLE-disk size (the orchestrator's disk inventory), not the sum of the
 * per-filesystem sizes. A pool is created on the whole disk, so a disk holding
 * one small partition must still contribute its full capacity to the usable
 * figure (and it must agree with the reclaim list, which already uses the
 * whole-disk size).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const TB = 1_000_000_000_000;
const GB = 1_000_000_000;

// Two poolable disks (removable), each with ONE small 100 GB filesystem but a
// 2 TB whole-disk capacity in the bridge inventory.
const FIXTURE = {
  drives: [
    {
      device: "/dev/sda1",
      mount: "/mnt/droplet/a",
      label: "DISK A",
      uuid: "UUID-A",
      parent_disk: "sda",
      size_bytes: 100 * GB,
      used_bytes: 0,
      free_bytes: 100 * GB,
      mounted: true,
      removable: true,
      displayName: null,
    },
    {
      device: "/dev/sdb1",
      mount: "/mnt/droplet/b",
      label: "DISK B",
      uuid: "UUID-B",
      parent_disk: "sdb",
      size_bytes: 100 * GB,
      used_bytes: 0,
      free_bytes: 100 * GB,
      mounted: true,
      removable: true,
      displayName: null,
    },
  ],
  count: 2,
  disks: [
    { name: "sda", size_bytes: 2 * TB, state: "available" },
    { name: "sdb", size_bytes: 2 * TB, state: "available" },
  ],
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDrives: vi.fn(async () => FIXTURE),
    fetchPools: vi.fn(async () => ({ pools: [] })),
  };
});

import { StorageStep } from "./StorageStep";

describe("StorageStep capacity uses whole-disk sizes (WARP-857)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prices the RAID calculator from the whole disk, not the filesystem sum", async () => {
    render(<StorageStep onComplete={() => {}} onSkip={() => {}} />);
    // With 2 poolable disks the pool toggle auto-enables and the chooser shows.
    // JBOD / RAID 0 usable = 2 TB + 2 TB = 4 TB (whole-disk). The pre-fix
    // sum-of-filesystem estimate would be 200 GB and never render a TB figure.
    await waitFor(() =>
      expect(screen.getAllByText(/4\.0 TB/).length).toBeGreaterThan(0),
    );
    // The 100 GB filesystem-sum (2 × 100 GB = 200 GB) must NOT drive an option.
    expect(screen.queryByText(/200 GB/)).toBeNull();
  });
});
