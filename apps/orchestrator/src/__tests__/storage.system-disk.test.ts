/**
 * WARP-2098 — the system/install disk, and honest data-drive totals.
 *
 * The defect: the only box-level storage figure the API produced was the
 * signed-in user's Nextcloud quota, and on this appliance that describes the
 * OS/BOOT DISK — Nextcloud's data directory is a named volume under the docker
 * data-root, which droplet-luks-provision points at /data, an LV on the install
 * disk, while the storage pool reaches Nextcloud only as external storage
 * (which OCS quota does not count). So one wrong number stood in for the whole
 * box, and the install disk itself appeared nowhere as a drive.
 *
 * The fix has two halves and both are asserted here:
 *   • totals are summed over the POST-FILTER data-drive list, so the OS disk is
 *     excluded by construction rather than by a second rule that could drift;
 *   • the install disk is reported SEPARATELY as `system_disk`, and is still
 *     absent from `drives` and from `disks`.
 *
 * The one test to read first if this file ever goes red is
 * "the OS-disk guard is LOAD-BEARING" — it is the mutation test that proves the
 * totals are computed after the filter and not before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(async () => null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createStorageRouter } from "../routes/storage.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncGetUserQuota } from "../services/nextcloud.client.js";

/** Minimal Prisma stand-in — these routes only ever read the Drive table. */
function prismaStub() {
  return {
    drive: { findMany: async () => [] },
    storagePool: { findMany: async () => [] },
  } as never;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      id: "stefan",
      username: "stefan",
      displayName: "Stefan",
      role: "owner",
    };
    next();
  });
  app.use("/api", createStorageRouter(prismaStub()));
  return app;
}

const GB = 1_000_000_000;

/** The bridge's view of the live box: an OS NVMe whose partitions the
 *  automounter has picked up under /mnt/droplet/ (both must be filtered out —
 *  parent_disk === os_disk) plus one real 2 TB external data drive. */
const SYSTEM_DISK = {
  name: "nvme0n1",
  size_bytes: 512 * GB,
  used_bytes: 120 * GB,
  free_bytes: 392 * GB,
  model: "Samsung SSD 980",
  serial: "S64ANS0T1",
  bus: "nvme",
  filesystems: [
    { mount: "/", role: "root", fs: "ext4", size_bytes: 64 * GB, used_bytes: 20 * GB, free_bytes: 44 * GB },
    { mount: "/data", role: "data", fs: "ext4", size_bytes: 400 * GB, used_bytes: 100 * GB, free_bytes: 300 * GB },
  ],
};

const bootDiskSnapshot = {
  drives: [
    {
      device: "/dev/nvme0n1p1",
      parent_disk: "nvme0n1",
      mount: "/mnt/droplet/boot-efi",
      label: "",
      uuid: "U-OS-EFI",
      size_bytes: 1 * GB,
      used_bytes: 300_000_000,
      free_bytes: 700_000_000,
      mounted: true,
      fs: "vfat",
    },
    {
      device: "/dev/nvme0n1p2",
      parent_disk: "nvme0n1",
      mount: "/mnt/droplet/ubuntu-root",
      label: "ubuntu",
      uuid: "U-OS-ROOT",
      size_bytes: 256 * GB,
      used_bytes: 60 * GB,
      free_bytes: 196 * GB,
      mounted: true,
      fs: "ext4",
    },
    {
      device: "/dev/sdb1",
      parent_disk: "sdb",
      mount: "/mnt/droplet/photos-ab12cd34",
      label: "TOSHIBA EXT",
      uuid: "U-DATA-REAL",
      size_bytes: 2000 * GB,
      used_bytes: 500 * GB,
      free_bytes: 1500 * GB,
      mounted: true,
      fs: "ext4",
      removable: true,
    },
  ],
  count: 3,
  os_disk: "nvme0n1",
  disks: [{ name: "sdb", size_bytes: 2000 * GB, state: "in_use" }],
  system_disk: SYSTEM_DISK,
  snapshot_at: "2026-09-03T00:00:00Z",
};

function stubBridge(snapshot: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => snapshot })),
  );
}

function stubBridgeUnreachable() {
  const connErr = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
      code: "ECONNREFUSED",
    }),
  });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw connErr;
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveNcToken).mockResolvedValue(null);
  vi.mocked(ncGetUserQuota).mockResolvedValue(null as never);
});

describe("GET /api/storage/drives — data-drive totals (WARP-2098)", () => {
  it("totals cover the data drives ONLY — the OS disk contributes nothing", async () => {
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    // 2 TB: the external drive alone. The two OS partitions add another ~257 GB
    // and must not appear in any of the three figures.
    expect(res.body.totals).toEqual({
      size_bytes: 2000 * GB,
      used_bytes: 500 * GB,
      free_bytes: 1500 * GB,
      drive_count: 1,
      source: "data_drives",
    });
  });

  it("the OS-disk guard is LOAD-BEARING: dropping os_disk changes the total", async () => {
    // isUserDataDrive fails OPEN — with no os_disk the OS partitions are no
    // longer recognisable as such and DO enter the list. If totals were ever
    // computed before the filter, this test and the one above would produce the
    // same number and neither would catch the mistake. They must differ.
    stubBridge({ ...bootDiskSnapshot, os_disk: "" });
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.totals.drive_count).toBe(3);
    expect(res.body.totals.size_bytes).toBeGreaterThan(2000 * GB);
  });

  it("totals are null — not zeroes — when there are no data drives", async () => {
    stubBridge({ drives: [], count: 0, os_disk: "nvme0n1", disks: [], snapshot_at: "x" });
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    // null says "nothing to total". A zeroed object would say "you have drives
    // and they hold nothing" — a different claim, and a false one.
    expect(res.body.totals).toBeNull();
  });

  it("totals are null when the device-bridge is unreachable", async () => {
    stubBridgeUnreachable();
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("bridge_unavailable");
    expect(res.body.totals).toBeNull();
  });

  it("a pool contributes its ONE mounted filesystem, not its member disks", async () => {
    // ADR-019's honesty rule as arithmetic. The members are 2 TB each and live
    // in `disks` as pool_member; the RAID1 array's real usable capacity is the
    // single mounted md filesystem. Summing the members would claim 4 TB of
    // storage that does not exist.
    stubBridge({
      drives: [
        {
          device: "/dev/md127",
          parent_disk: "md127",
          mount: "/mnt/droplet/pool",
          label: "",
          uuid: "U-POOL-FS",
          size_bytes: 2000 * GB,
          used_bytes: 250 * GB,
          free_bytes: 1750 * GB,
          mounted: true,
          fs: "ext4",
        },
      ],
      count: 1,
      os_disk: "nvme0n1",
      disks: [
        { name: "sda", size_bytes: 2000 * GB, state: "pool_member", md: "md127" },
        { name: "sdb", size_bytes: 2000 * GB, state: "pool_member", md: "md127" },
      ],
      snapshot_at: "x",
    });
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.totals.size_bytes).toBe(2000 * GB);
    expect(res.body.totals.drive_count).toBe(1);
  });
});

describe("GET /api/storage/drives — system disk passthrough (WARP-2098)", () => {
  it("reports the system disk separately, and never inside drives or disks", async () => {
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    // Visible…
    expect(res.body.system_disk).toEqual(SYSTEM_DISK);
    // …but not as a drive (which would gain Rename / Eject / Browse and reach
    // the Settings reformat picker) nor as a disk (which would gain
    // "Erase & adopt" and the setup wizard's poolable list).
    expect(res.body.drives.map((d: { uuid: string }) => d.uuid)).toEqual(["U-DATA-REAL"]);
    expect(res.body.count).toBe(1);
    expect(res.body.drives.map((d: { device: string }) => d.device)).not.toContain(
      "/dev/nvme0n1p2",
    );
    expect(res.body.disks.map((d: { name: string }) => d.name)).not.toContain("nvme0n1");
    // And its bytes are not folded into the total.
    expect(res.body.totals.size_bytes).toBe(2000 * GB);
  });

  it("the system disk names the same disk the filter excluded", async () => {
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.body.system_disk.name).toBe(bootDiskSnapshot.os_disk);
  });

  it("carries the /data filesystem, which is where uploads actually land", async () => {
    // The reason the breakdown exists: root is a small LV and /data holds the
    // docker data-root, so a root-only reading would call this disk nearly
    // empty while the box is filling up.
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage/drives");
    const roles = res.body.system_disk.filesystems.map(
      (f: { role: string }) => f.role,
    );
    expect(roles).toContain("data");
    expect(res.body.system_disk.used_bytes).toBe(120 * GB);
  });

  it("omits system_disk entirely on a bridge that does not report one", async () => {
    // Host-side Python updates on reflash while this container updates
    // independently, so an older bridge is a real deployment shape. The key
    // must be ABSENT rather than null — the same rule `disks` follows — so the
    // dashboard renders no System drive card at all.
    const { system_disk: _omitted, ...older } = bootDiskSnapshot;
    stubBridge(older);
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect("system_disk" in res.body).toBe(false);
    // The rest of the payload is unaffected.
    expect(res.body.totals.size_bytes).toBe(2000 * GB);
    expect(res.body.count).toBe(1);
  });

  it("passes through an unmeasurable disk as null usage, never zero", async () => {
    stubBridge({
      ...bootDiskSnapshot,
      system_disk: {
        ...SYSTEM_DISK,
        used_bytes: null,
        free_bytes: null,
        filesystems: [],
      },
    });
    const res = await request(buildApp()).get("/api/storage/drives");
    expect(res.body.system_disk.used_bytes).toBeNull();
    expect(res.body.system_disk.size_bytes).toBe(512 * GB);
  });
});

describe("GET /api/storage — the headline (WARP-2098)", () => {
  it("describes the data drives, not the Nextcloud quota on the boot disk", async () => {
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2000 * GB);
    expect(res.body.used).toBe(500 * GB);
    expect(res.body.available).toBe(1500 * GB);
    expect(res.body.percentage).toBe(25);
    expect(res.body.totals.source).toBe("data_drives");
    // The install disk rides alongside the headline, never inside it.
    expect(res.body.system_disk).toEqual(SYSTEM_DISK);
    expect(res.body.total).not.toBe(SYSTEM_DISK.size_bytes);
  });

  it("still reports the Nextcloud account quota, under a name that says so", async () => {
    vi.mocked(resolveNcToken).mockResolvedValue("nc-token");
    vi.mocked(ncGetUserQuota).mockResolvedValue({
      used: 1_000_000,
      total: 10_000_000,
      free: 9_000_000,
    } as never);
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage");
    expect(res.status).toBe(200);
    expect(res.body.cloud).toEqual({
      used: 1_000_000,
      total: 10_000_000,
      available: 9_000_000,
      percentage: 10,
    });
    // …and it is not the headline any more.
    expect(res.body.total).toBe(2000 * GB);
  });

  it("reports zeroes rather than the boot disk when the bridge is unreachable", async () => {
    // The old value of these four fields WAS the Nextcloud quota, i.e. the
    // boot-disk figure this ticket removed. Falling back to it would reintroduce
    // the defect exactly when the box is least healthy.
    vi.mocked(resolveNcToken).mockResolvedValue("nc-token");
    vi.mocked(ncGetUserQuota).mockResolvedValue({
      used: 120 * GB,
      total: 512 * GB,
      free: 392 * GB,
    } as never);
    stubBridgeUnreachable();
    const res = await request(buildApp()).get("/api/storage");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.totals).toBeNull();
    // The quota is still reported — just never promoted to the headline.
    expect(res.body.cloud.total).toBe(512 * GB);
  });

  it("survives a Nextcloud failure without losing the drive figures", async () => {
    vi.mocked(resolveNcToken).mockRejectedValue(new Error("nc down"));
    stubBridge(bootDiskSnapshot);
    const res = await request(buildApp()).get("/api/storage");
    expect(res.status).toBe(200);
    expect(res.body.cloud).toBeNull();
    expect(res.body.total).toBe(2000 * GB);
  });
});
