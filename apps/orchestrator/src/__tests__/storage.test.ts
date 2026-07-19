/**
 * WARP-174 — Storage routes.
 *
 * Covers the wizard-relevant slice:
 *   - GET /api/storage/drives left-joins the Drive table so bridge
 *     entries surface the customer-chosen displayName / icon / notes
 *     when one exists, or null fields when one doesn't.
 *   - PATCH /api/storage/drives/:uuid upserts the Drive row. First
 *     PATCH requires displayName; subsequent PATCHes can be partial.
 *
 * Mocks the device-bridge fetch + ncGetUserQuota, builds an in-memory
 * Prisma stand-in for the Drive table, hands the result to
 * createStorageRouter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock Nextcloud session resolution so the existing /api/storage path
// doesn't try to call out — these tests focus on /drives, not quota.
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(),
}));

// WARP-1062 (audit item B): the local isAdmin() denials now emit the WARP-237
// policy-violation row — capture the singleton to assert it.
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createStorageRouter } from "../routes/storage.js";

// Bridge response fixture — three drives, one with a friendly name in
// the Drive table, two without.
const fixtureSnapshot = {
  drives: [
    {
      device: "/dev/sda1",
      mount: "/mnt/droplet/data",
      label: "TOSHIBA EXT",
      uuid: "UUID-MAIN-DRIVE",
      size_bytes: 2_000_000_000_000,
      used_bytes: 100_000_000_000,
      free_bytes: 1_900_000_000_000,
      mounted: true,
    },
    {
      device: "/dev/sda2",
      mount: "/mnt/droplet/nvr",
      label: "WD ELEMENTS",
      uuid: "UUID-NVR-DRIVE",
      size_bytes: 1_000_000_000_000,
      used_bytes: 0,
      free_bytes: 1_000_000_000_000,
      mounted: true,
    },
    {
      device: "/dev/sdb1",
      mount: "/mnt/droplet/data2",
      label: "SAMSUNG T7",
      uuid: "UUID-BACKUP",
      size_bytes: 500_000_000_000,
      used_bytes: 50_000_000_000,
      free_bytes: 450_000_000_000,
      mounted: true,
    },
  ],
  count: 3,
  snapshot_at: "2026-05-14T12:00:00Z",
};

// In-memory Prisma stand-in for the Drive table.
function createPrismaMock() {
  const rows = new Map<string, any>();
  return {
    rows,
    drive: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        const uuids = where?.uuid?.in ?? [];
        return uuids
          .map((u: string) => rows.get(u))
          .filter((r: any): r is any => !!r);
      }),
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.uuid) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.uuid);
        if (existing) {
          const next = {
            ...existing,
            ...update,
            updatedAt: new Date(),
          };
          rows.set(where.uuid, next);
          return next;
        }
        const created = {
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(where.uuid, created);
        return created;
      }),
    },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>, role = "owner") {
  const app = express();
  app.use(express.json());
  // WARP-171: PATCH /api/storage/drives/:uuid now sits behind a
  // requireRole("owner", "admin") guard. The real authMiddleware isn't
  // in this test's pipeline; inject a synthetic user so the guard sees a
  // role (owner by default; WARP-1141's role-denied cases pass "family").
  // Same shape the rbac matrix and the vpn test use.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; username: string; displayName: string; role: string } }).user = {
      id: "stefan",
      username: "stefan",
      displayName: "Stefan",
      role,
    };
    next();
  });
  app.use("/api", createStorageRouter(prisma as any));
  return app;
}

beforeEach(() => {
  // Mock global fetch so the storage router's bridge call gets the fixture.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => fixtureSnapshot,
    })),
  );
});

describe("storage routes (WARP-174)", () => {
  describe("GET /api/storage/drives", () => {
    it("returns bridge drives with null displayName when no Drive rows exist", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      expect(res.body.drives).toHaveLength(3);
      for (const d of res.body.drives) {
        expect(d.displayName).toBeNull();
        expect(d.icon).toBeNull();
        expect(d.notes).toBeNull();
      }
    });

    it("attaches displayName when a Drive row exists for the UUID", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set("UUID-MAIN-DRIVE", {
        uuid: "UUID-MAIN-DRIVE",
        displayName: "Wedding Photos",
        icon: "camera",
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const app = buildApp(prisma);
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      const main = res.body.drives.find(
        (d: any) => d.uuid === "UUID-MAIN-DRIVE",
      );
      expect(main.displayName).toBe("Wedding Photos");
      expect(main.icon).toBe("camera");
      // Other drives untouched.
      const nvr = res.body.drives.find(
        (d: any) => d.uuid === "UUID-NVR-DRIVE",
      );
      expect(nvr.displayName).toBeNull();
    });

    it("survives a bridge failure without 500-ing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 502,
          json: async () => ({}),
        })),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(502);
      expect(res.body.drives).toEqual([]);
    });

    // WARP-645: the device-bridge only runs with the OLED/display compose
    // profile. On hosts without it the fetch throws ECONNREFUSED — an expected
    // deployment shape, not an error. Degrade to 200 + reason rather than the
    // raw "fetch failed" error string.
    it("degrades cleanly when the bridge is not running (ECONNREFUSED)", async () => {
      const connErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
          code: "ECONNREFUSED",
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw connErr;
        }),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      expect(res.body.drives).toEqual([]);
      expect(res.body.count).toBe(0);
      expect(res.body.reason).toBe("bridge_unavailable");
      // The raw error string must NOT leak through on this expected path.
      expect(res.body.error).toBeUndefined();
    });
  });

  describe("PATCH /api/storage/drives/:uuid", () => {
    it("creates a Drive row on first PATCH with displayName", async () => {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ displayName: "Wedding Photos" });
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("Wedding Photos");
      expect(prisma.rows.get("UUID-MAIN-DRIVE")).toBeDefined();
    });

    it("rejects first PATCH without displayName", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ icon: "camera" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/displayName is required/i);
    });

    it("updates only the provided fields on subsequent PATCH", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set("UUID-MAIN-DRIVE", {
        uuid: "UUID-MAIN-DRIVE",
        displayName: "Old Name",
        icon: "drive",
        notes: "keep me",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ displayName: "Wedding Photos" });
      expect(res.status).toBe(200);
      const row = prisma.rows.get("UUID-MAIN-DRIVE");
      expect(row.displayName).toBe("Wedding Photos");
      expect(row.icon).toBe("drive"); // unchanged
      expect(row.notes).toBe("keep me"); // unchanged
    });

    it("rejects a body with no fields", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set("UUID-MAIN-DRIVE", {
        uuid: "UUID-MAIN-DRIVE",
        displayName: "Existing",
        icon: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects an invalid UUID", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .patch("/api/storage/drives/has spaces in it")
        .send({ displayName: "X" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid drive UUID/i);
    });

    // WARP-1141 — rename gating + validation. Owner IS allowed (covered by
    // the success cases above, which run as owner); family is refused by the
    // canonical requireRole guard and the row is never written.
    it("refuses a family user (403) and never writes the row", async () => {
      const prisma = createPrismaMock();
      const app = buildApp(prisma, "family");
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ displayName: "Sneaky Rename" });
      expect(res.status).toBe(403);
      expect(prisma.drive.upsert).not.toHaveBeenCalled();
      expect(prisma.rows.get("UUID-MAIN-DRIVE")).toBeUndefined();
    });

    it("rejects a displayName over 64 characters (400, no write)", async () => {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ displayName: "x".repeat(65) });
      expect(res.status).toBe(400);
      expect(prisma.drive.upsert).not.toHaveBeenCalled();
    });

    it("rejects the literal 'undefined'/'null' uuid instead of upserting a junk row (WARP-1141)", async () => {
      // A client that stringifies a missing uuid produces
      // PATCH /storage/drives/undefined — which passes the charset regex,
      // upserts a Drive row keyed "undefined", answers 200, and the rename
      // silently never joins back to any real drive.
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      for (const junk of ["undefined", "null"]) {
        const res = await request(app)
          .patch(`/api/storage/drives/${junk}`)
          .send({ displayName: "Burrito" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid drive UUID/i);
        expect(prisma.rows.has(junk)).toBe(false);
      }
    });
  });
});

describe("storage routes — data-drive inclusion filter (WARP-827)", () => {
  // The home-user persona (ADR-002) must never see firmware/boot/swap/loop
  // pseudo-devices or the OS/system disk presented as "your drives". The
  // device-bridge already scopes its /mnt/* enumeration (it excludes
  // /mnt/droplet, non-data fstypes, and trivially small mounts), but the
  // orchestrator is the CI-testable boundary and must defend in depth against
  // a bridge — older, future, or mis-scoped — that leaks junk. This fixture
  // mixes representative junk in with two real data drives and asserts only
  // the real ones survive.
  const junkAndDataSnapshot = {
    drives: [
      // EFI system partition — firmware, never user storage.
      {
        device: "/dev/sda1",
        mount: "/boot/efi",
        label: "EFI",
        uuid: "U-EFI",
        size_bytes: 536_870_912,
        used_bytes: 30_000_000,
        free_bytes: 506_870_912,
        mounted: true,
        fs: "vfat",
      },
      // Swap — not a filesystem the user browses.
      {
        device: "/dev/sda2",
        mount: "[SWAP]",
        label: "",
        uuid: "U-SWAP",
        size_bytes: 8_589_934_592,
        used_bytes: 0,
        free_bytes: 8_589_934_592,
        mounted: true,
        fs: "swap",
      },
      // Loop device — squashfs snap/appimage backing mount.
      {
        device: "/dev/loop0",
        mount: "/snap/core/1234",
        label: "",
        uuid: "",
        size_bytes: 104_857_600,
        used_bytes: 104_857_600,
        free_bytes: 0,
        mounted: true,
        fs: "squashfs",
      },
      // The OS / system disk mounted at root — the install, not a data drive.
      {
        device: "/dev/nvme0n1p2",
        mount: "/",
        label: "ubuntu",
        uuid: "U-OSROOT",
        size_bytes: 256_060_514_304,
        used_bytes: 60_000_000_000,
        free_bytes: 196_060_514_304,
        mounted: true,
        fs: "ext4",
      },
      // The OS-root shared-mount bind the automounter creates — backed by the
      // OS disk, so it would show the install as a "drive" (device-bridge
      // hides this at /mnt/droplet; defend here too).
      {
        device: "/dev/nvme0n1p2",
        mount: "/mnt/droplet",
        label: "ubuntu",
        uuid: "U-OSROOT",
        size_bytes: 256_060_514_304,
        used_bytes: 60_000_000_000,
        free_bytes: 196_060_514_304,
        mounted: true,
        fs: "ext4",
      },
      // A real external data drive (hot-plug, under /mnt/droplet/<name>).
      {
        device: "/dev/sdb1",
        mount: "/mnt/droplet/photos-ab12cd34",
        label: "TOSHIBA EXT",
        uuid: "U-DATA-1",
        size_bytes: 2_000_000_000_000,
        used_bytes: 100_000_000_000,
        free_bytes: 1_900_000_000_000,
        mounted: true,
        fs: "ext4",
        removable: true,
      },
      // A real installed data drive (fstab) under /mnt/.
      {
        device: "/dev/sdc1",
        mount: "/mnt/cloud-storage",
        label: "VAULT",
        uuid: "U-DATA-2",
        size_bytes: 4_000_000_000_000,
        used_bytes: 1_000_000_000_000,
        free_bytes: 3_000_000_000_000,
        mounted: true,
        fs: "xfs",
      },
    ],
    count: 7,
    snapshot_at: "2026-06-06T00:00:00Z",
  };

  it("returns only real data drives — drops EFI/swap/loop/OS-disk/OS-root", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => junkAndDataSnapshot })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    const uuids = res.body.drives.map((d: any) => d.uuid).sort();
    expect(uuids).toEqual(["U-DATA-1", "U-DATA-2"]);
    // count must reflect the FILTERED set, not the raw bridge count.
    expect(res.body.count).toBe(2);
    // None of the junk leaks through.
    const mounts = res.body.drives.map((d: any) => d.mount);
    expect(mounts).not.toContain("/boot/efi");
    expect(mounts).not.toContain("[SWAP]");
    expect(mounts).not.toContain("/snap/core/1234");
    expect(mounts).not.toContain("/");
    expect(mounts).not.toContain("/mnt/droplet");
  });

  it("does NOT drop everything — a snapshot of only data drives passes through intact", async () => {
    // Regression guard against an over-aggressive predicate: the original
    // WARP-174 fixture (all real /mnt/droplet drives) must survive unchanged.
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives).toHaveLength(3);
    expect(res.body.count).toBe(3);
  });

  it("preserves the bridge_unavailable degradation (filter never fabricates drives)", async () => {
    const connErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
        code: "ECONNREFUSED",
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw connErr;
      }),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives).toEqual([]);
    expect(res.body.reason).toBe("bridge_unavailable");
  });

  it("returns an empty list (not an error) when every drive is junk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/sda1", mount: "/boot/efi", label: "EFI", uuid: "U-EFI", size_bytes: 5e8, used_bytes: 0, free_bytes: 5e8, mounted: true, fs: "vfat" },
            { device: "/dev/loop1", mount: "/snap/x/1", label: "", uuid: "", size_bytes: 1e8, used_bytes: 1e8, free_bytes: 0, mounted: true, fs: "squashfs" },
          ],
          count: 2,
          snapshot_at: "2026-06-06T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("drops an OS-disk partition auto-mounted as a data drive (os_disk/parent_disk — the real .87 case)", async () => {
    // The automounter mounted the install disk's EFI/boot partitions under
    // /mnt/droplet/drive-<uuid>: they pass rules 2-3 (ext4/vfat, under /mnt/,
    // not the bind) yet live on the OS disk. The bridge tags parent_disk +
    // reports os_disk so the orchestrator drops them. Mirrors what the live
    // single-box (.87) actually returned: nvme0n1p1/p2 -> nvme0n1 == root.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          os_disk: "nvme0n1",
          drives: [
            { device: "/dev/nvme0n1p1", parent_disk: "nvme0n1", mount: "/mnt/droplet/drive-13EE-1E3", label: "drive", uuid: "U-EFI-AUTO", size_bytes: 1_073_741_824, used_bytes: 5e7, free_bytes: 1e9, mounted: true, fs: "vfat" },
            { device: "/dev/nvme0n1p2", parent_disk: "nvme0n1", mount: "/mnt/droplet/drive-538963df", label: "drive", uuid: "U-BOOT-AUTO", size_bytes: 2_147_483_648, used_bytes: 3e8, free_bytes: 1.8e9, mounted: true, fs: "ext4" },
            { device: "/dev/sdb1", parent_disk: "sdb", mount: "/mnt/droplet/data2-1380a14d", label: "data2", uuid: "U-DATA-REAL", size_bytes: 2e12, used_bytes: 1e11, free_bytes: 1.9e12, mounted: true, fs: "ext4", removable: true },
          ],
          count: 3,
          snapshot_at: "2026-06-06T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives.map((d: any) => d.uuid)).toEqual(["U-DATA-REAL"]);
    expect(res.body.count).toBe(1);
    const mounts = res.body.drives.map((d: any) => d.mount);
    expect(mounts).not.toContain("/mnt/droplet/drive-13EE-1E3");
    expect(mounts).not.toContain("/mnt/droplet/drive-538963df");
  });

  it("fails open: with no os_disk reported, a parent_disk tag never hides a real drive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/sdb1", parent_disk: "sdb", mount: "/mnt/droplet/data2", label: "data2", uuid: "U-NO-OSDISK", size_bytes: 2e12, used_bytes: 1e11, free_bytes: 1.9e12, mounted: true, fs: "ext4", removable: true },
          ],
          count: 1,
          snapshot_at: "2026-06-06T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives.map((d: any) => d.uuid)).toEqual(["U-NO-OSDISK"]);
  });
});

describe("storage routes — adoptable-disks passthrough (WARP-936)", () => {
  // The bridge's /drives snapshot now carries a top-level `disks` array —
  // whole-disk inventory with explicit states (in_use | pool_member |
  // foreign | available) — so present-but-unmounted disks are no longer
  // invisible to the dashboard. The orchestrator forwards it with the same
  // WARP-827 defense-in-depth: anything matching os_disk is dropped here
  // too, even though the bridge already excludes it.
  const disksSnapshot = {
    os_disk: "nvme0n1",
    drives: [],
    count: 0,
    disks: [
      { name: "sda", size_bytes: 1.8e12, state: "pool_member", md: "md127", fstype: "linux_raid_member", bus: "sata", model: "WDC WD20EARZ", serial: "WD-A" },
      { name: "sdb", size_bytes: 1.8e12, state: "pool_member", md: "md127", fstype: "linux_raid_member", bus: "sata", model: "WDC WD20EARZ", serial: "WD-B" },
      { name: "sdc", size_bytes: 2e12, state: "foreign", fstype: "ntfs", bus: "usb", model: "Samsung T7", serial: "S-1" },
      { name: "sdd", size_bytes: 1e12, state: "available", fstype: "", bus: "sata", model: "", serial: "" },
    ],
    snapshot_at: "2026-07-03T00:00:00Z",
  };

  it("forwards the bridge's disks array on GET /api/storage/drives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => disksSnapshot })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.disks.map((d: any) => d.name)).toEqual(["sda", "sdb", "sdc", "sdd"]);
    const sda = res.body.disks.find((d: any) => d.name === "sda");
    expect(sda.state).toBe("pool_member");
    expect(sda.md).toBe("md127");
    // The mounted-drives contract is untouched: still filtered, still counted.
    expect(res.body.drives).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("drops a disk matching os_disk (defense in depth over a mis-scoped bridge)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          ...disksSnapshot,
          disks: [
            ...disksSnapshot.disks,
            { name: "nvme0n1", size_bytes: 5e11, state: "in_use", fstype: "", bus: "nvme", model: "OS SSD", serial: "OS-1" },
          ],
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.disks.map((d: any) => d.name)).not.toContain("nvme0n1");
  });

  it("OMITS the disks key (not an error) for an older bridge without the field", async () => {
    // fixtureSnapshot predates WARP-936 — no `disks` key at all. The key must
    // be ABSENT (not `[]`) in the response: the setup wizard discriminates on
    // `resp.disks ?? null` to fall back to the WARP-662 mounted-drives reclaim
    // list, and host-side bridges only update on reflash while this container
    // updates independently — an empty array would read as an authoritative
    // "no disks" and silently drop that fallback during setup.
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect("disks" in res.body).toBe(false);
    expect(res.body.drives).toHaveLength(3);
  });
});

describe("storage routes — device-bridge URL (WARP-660)", () => {
  // Regression lock: the bridge URL default MUST be the host.docker.internal
  // form, NOT the docker0 gateway (172.17.0.1). On the single-box deployment
  // shape the orchestrator container is on the `droplet_default` bridge
  // network (gateway 172.18.0.1) and docker0 is down, so a 172.17.0.1 default
  // can never reach the host-side device-bridge — drives silently enumerate
  // empty. host.docker.internal resolves via the orchestrator's
  // `extra_hosts: host-gateway` mapping (same mechanism screen-qr already
  // uses for /openwrt/qr), so it's the proven-reachable address.
  it("fetches drives from host.docker.internal, not the docker0 gateway", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => fixtureSnapshot,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe("http://host.docker.internal:9090/drives");
    // Explicitly assert the buggy docker0 default is gone.
    expect(url).not.toContain("172.17.0.1");
  });

  // Backward-compat: storage.ts historically read the `BRIDGE_URL` env var.
  // The value now flows through `config.DEVICE_BRIDGE_URL`, which is resolved
  // at module-load time (like every other *_SERVICE_URL in config.ts), so we
  // assert the alias resolution against a fresh config load with the env set
  // rather than a per-request stub (config snapshots env at import).
  it("honors a legacy BRIDGE_URL env var via config (alias)", async () => {
    vi.stubEnv("DEVICE_BRIDGE_URL", "");
    vi.stubEnv("BRIDGE_URL", "http://192.0.2.10:9090");
    vi.resetModules();
    const { config } = await import("../config.js");
    expect(config.DEVICE_BRIDGE_URL).toBe("http://192.0.2.10:9090");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("prefers DEVICE_BRIDGE_URL over the legacy BRIDGE_URL when both are set", async () => {
    vi.stubEnv("DEVICE_BRIDGE_URL", "http://198.51.100.5:9090");
    vi.stubEnv("BRIDGE_URL", "http://192.0.2.10:9090");
    vi.resetModules();
    const { config } = await import("../config.js");
    expect(config.DEVICE_BRIDGE_URL).toBe("http://198.51.100.5:9090");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("targets host.docker.internal for the rescan cache-invalidation too", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(createPrismaMock());
    await request(app).post("/api/storage/drives/rescan");
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe("http://host.docker.internal:9090/drives/changed");
  });

  it("sends the bridge auth token on the rescan proxy (this PR gates /drives/changed — a bare POST 401s and rescan dies as 502)", async () => {
    vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(createPrismaMock());
    const res = await request(app).post("/api/storage/drives/rescan");
    expect(res.status).toBe(200);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(
      (init.headers as Record<string, string>)["X-Droplet-Auth"],
    ).toBe("secret-token");
    vi.unstubAllEnvs();
  });

  it("targets host.docker.internal for the eject path too", async () => {
    vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(createPrismaMock());
    await request(app).post("/api/storage/drives/UUID-MAIN-DRIVE/eject");
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toBe("http://host.docker.internal:9090/drives/UUID-MAIN-DRIVE/eject");
    vi.unstubAllEnvs();
  });
});

describe("storage routes — bus enrichment + rescan (WARP-612)", () => {
  it("falls back to a neutral bus class when the bridge omits it", async () => {
    // The bridge sends the real transport (it reads lsblk on the host). When
    // an older bridge omits it, the orchestrator name-guesses: nvme is
    // unambiguous, but sd* stays neutral 'disk' — it could be SATA/SAS, not
    // necessarily USB (ADR-011, no hardware assumption).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/nvme0n1p1", mount: "/mnt/droplet/vault", label: "Vault", uuid: "U-NVME", size_bytes: 4e12, used_bytes: 1e12, free_bytes: 3e12, mounted: true },
            { device: "/dev/sda1", mount: "/mnt/droplet/data", label: "Data", uuid: "U-SD", size_bytes: 2e12, used_bytes: 0, free_bytes: 2e12, mounted: true },
          ],
          count: 2,
          snapshot_at: "2026-05-31T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    const byUuid = Object.fromEntries(res.body.drives.map((d: any) => [d.uuid, d]));
    expect(byUuid["U-NVME"].bus).toBe("nvme");
    expect(byUuid["U-SD"].bus).toBe("disk");
  });

  it("passes through the bridge's fs/bus/readonly when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/sda1", mount: "/mnt/x", label: "X", uuid: "U1", size_bytes: 1e9, used_bytes: 0, free_bytes: 1e9, mounted: true, bus: "usb", fs: "exfat", readonly: true },
          ],
          count: 1,
          snapshot_at: "2026-05-31T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.drives[0].bus).toBe("usb");
    expect(res.body.drives[0].fs).toBe("exfat");
    expect(res.body.drives[0].readonly).toBe(true);
  });

  describe("POST /api/storage/drives/rescan", () => {
    it("returns ok when the bridge accepts the cache-invalidation", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("502s when the bridge is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(502);
      expect(res.body.ok).toBe(false);
    });

    // WARP-645: a connection error (bridge not running) must degrade with a
    // typed reason instead of leaking the raw "fetch failed" string.
    it("degrades with 503 + reason when the bridge is not running (ECONNREFUSED)", async () => {
      const connErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
          code: "ECONNREFUSED",
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw connErr;
        }),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe("bridge_unavailable");
      // The raw error string must NOT leak through on this expected path.
      expect(res.body.error).not.toMatch(/fetch failed/i);
    });

    it("forbids non-admins", async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: { id: string; username: string; displayName: string; role: string } }).user = {
          id: "fam",
          username: "fam",
          displayName: "Fam",
          role: "family",
        };
        next();
      });
      app.use("/api", createStorageRouter(createPrismaMock() as any));
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(403);
      // WARP-1062 (audit item B): the local isAdmin() deny emits the same
      // WARP-237 "Access denied" row as the central requireRole.
      expect(recordActivityMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "auth",
          severity: "warn",
          what: "Access denied",
          refs: expect.objectContaining({
            role: "family",
            reason: "role-not-permitted",
          }),
        }),
      );
    });

    it("fails closed when no authenticated user is present", async () => {
      // No synthetic user injected — mirrors a request that never passed
      // authMiddleware. isAdmin() must treat a missing req.user.role as
      // not-admin (fail closed): 403, not a throw and not an allow.
      const app = express();
      app.use(express.json());
      app.use("/api", createStorageRouter(createPrismaMock() as any));
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(403);
    });
  });
});

describe("storage routes — SMART + eject (WARP-612)", () => {
  it("passes through SMART health + temperature when the bridge provides them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/sda1", mount: "/mnt/droplet/x", label: "X", uuid: "U1", size_bytes: 1e9, used_bytes: 0, free_bytes: 1e9, mounted: true, smart: "PASSED", temp_c: 41 },
          ],
          count: 1,
          snapshot_at: "2026-05-31T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.drives[0].smart).toBe("PASSED");
    expect(res.body.drives[0].temp_c).toBe(41);
  });

  describe("POST /api/storage/drives/:uuid/eject", () => {
    it("forbids non-admins", async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: { id: string; username: string; displayName: string; role: string } }).user = {
          id: "fam", username: "fam", displayName: "Fam", role: "family",
        };
        next();
      });
      app.use("/api", createStorageRouter(createPrismaMock() as any));
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(403);
    });

    it("rejects an invalid UUID", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/has spaces/eject");
      expect(res.status).toBe(400);
    });

    it("503s when no device-bridge auth token is configured", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "");
      vi.stubEnv("SERVICE_TOKEN_DISPLAY", "");
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(503);
      vi.unstubAllEnvs();
    });

    it("forwards to the bridge with auth + returns ok on success", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, ejected: "U1" }) }));
      vi.stubGlobal("fetch", fetchMock);
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
      expect(String(url)).toMatch(/\/drives\/U1\/eject$/);
      expect(init.headers["X-Droplet-Auth"]).toBe("secret-token");
      vi.unstubAllEnvs();
    });

    // WARP-645: a connection error (bridge not running) must degrade with a
    // typed reason instead of leaking the raw "fetch failed" string.
    it("degrades with 503 + reason when the bridge is not running (ECONNREFUSED)", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
      const connErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
          code: "ECONNREFUSED",
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw connErr;
        }),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe("bridge_unavailable");
      // The raw error string must NOT leak through on this expected path.
      expect(res.body.error).not.toMatch(/fetch failed/i);
      vi.unstubAllEnvs();
    });

    it("surfaces a 409 from the bridge (drive busy / not ejectable)", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: "umount failed — the drive may be in use" }) })),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/in use/i);
      vi.unstubAllEnvs();
    });
  });
});

// =====================================================================
// WARP-1339 — pool annotation on GET /storage/drives.
//
// The mounted md filesystem is the pool's ONLY fs-level capacity/browse
// source, so it must stay in the list (never dropped server-side) but carry
// an explicit `pool: "<mdN>"` marker the dashboard can join on (the pools
// payload names arrays bare — "md127" — while drives carry "/dev/md127").
// Partitions of the array (md127p1) are tagged with the ARRAY's name.
// =====================================================================
describe("GET /api/storage/drives — pool annotation (WARP-1339)", () => {
  const mdSnapshot = {
    drives: [
      {
        device: "/dev/md127",
        mount: "/mnt/droplet/a0f10a84-7116-46a7-a3e3-5e00ea1c7d08",
        label: "",
        uuid: "U-POOL-FS",
        size_bytes: 4_000_000_000_000,
        used_bytes: 1_000_000_000_000,
        free_bytes: 3_000_000_000_000,
        mounted: true,
        fs: "ext4",
      },
      {
        device: "/dev/md127p1",
        mount: "/mnt/droplet/pool-part",
        label: "",
        uuid: "U-POOL-PART",
        size_bytes: 2_000_000_000_000,
        used_bytes: 500_000_000_000,
        free_bytes: 1_500_000_000_000,
        mounted: true,
        fs: "ext4",
      },
      {
        device: "/dev/sda1",
        mount: "/mnt/droplet/data",
        label: "TOSHIBA EXT",
        uuid: "U-PLAIN",
        size_bytes: 2_000_000_000_000,
        used_bytes: 100_000_000_000,
        free_bytes: 1_900_000_000_000,
        mounted: true,
        fs: "ext4",
      },
    ],
    count: 3,
    snapshot_at: "2026-07-17T00:00:00Z",
  };

  it("tags md-node drives with their bare pool name and leaves plain drives untagged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => mdSnapshot })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    const byUuid = new Map(res.body.drives.map((d: any) => [d.uuid, d]));
    // The md node itself AND a partition of it both join on the bare array
    // name (the /storage/pools payload's `device` field).
    expect((byUuid.get("U-POOL-FS") as any).pool).toBe("md127");
    expect((byUuid.get("U-POOL-PART") as any).pool).toBe("md127");
    // A plain drive carries an explicit null — the dashboard branches on the
    // field, never on its absence.
    expect((byUuid.get("U-PLAIN") as any).pool).toBeNull();
  });

  it("never drops the pool-backed drive server-side (it is the pool's only capacity source)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => mdSnapshot })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    expect(res.body.drives).toHaveLength(3);
    expect(res.body.count).toBe(3);
  });
});
