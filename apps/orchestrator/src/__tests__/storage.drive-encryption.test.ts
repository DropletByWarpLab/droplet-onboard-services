/**
 * WARP-3513 — encrypted bay drives, as the drives API reports them.
 *
 * Every drive the dashboard prepares ("Erase & adopt", reclaim, pool format) is
 * now ALWAYS LUKS2 + TPM2 + ext4. This file pins the read side and the
 * prepare-confirm response:
 *
 *   - GET /api/storage/drives gives every drive an `encryption` that is one of
 *     a CLOSED set, a `preparation` enum computed from it, a `usage` shape
 *     WARP-3514 will fill, and an `isSystemDisk` flag. Nothing is derived from
 *     the absence or nullness of another field, and a bridge that says
 *     something outside the set is "unknown", not trusted.
 *   - `unknown` is `needs_preparing`, not `prepared`: a drive whose state is in
 *     doubt is never offered for allocation (fail closed).
 *   - a LUKS-over-md pool still joins the pool card, through the bridge's `md`.
 *   - the confirm response of a prepare op carries the host's `encrypted` /
 *     `uuid` and a strict camelCase `recoveryKeyPending`, and can never relay a
 *     recovery key.
 *
 * Fake keys only; the bridge is a stub.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/recordings-drive-guard.service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/recordings-drive-guard.service.js")>(),
  guardRecordingsDrive: vi.fn(async () => null),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import {
  DRIVE_ENCRYPTION_STATES,
  DRIVE_PREPARATION_STATES,
  bridgeMdName,
  createStorageRouter,
  drivePreparationFor,
  isOnSystemDisk,
  normaliseDriveEncryption,
  unassignedDriveUsage,
  type DriveEncryption,
  type DrivePreparation,
} from "../routes/storage.js";

const GB = 1_000_000_000;
const FAKE_RECOVERY_KEY = "cccccc-fakefake-cccccc-fakefake-cccccc-fakefake-cccccc-fakefake";
const FS_UUID = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";

// ── fixtures ────────────────────────────────────────────────────────────────

type BridgeObject = Record<string, unknown>;

/** A drive as the bridge reports it. Every override may be a WRONG type: the
 *  bridge is untrusted input and the route must cope. */
function bridgeDrive(over: BridgeObject = {}): BridgeObject {
  return {
    device: "/dev/mapper/droplet-bay-1a2b3c4d",
    parent_disk: "sdb",
    mount: "/mnt/droplet/drive-9f8e7d6c",
    label: "drive",
    uuid: FS_UUID,
    size_bytes: 2000 * GB,
    used_bytes: 100 * GB,
    free_bytes: 1900 * GB,
    mounted: true,
    fs: "ext4",
    bus: "usb",
    readonly: false,
    removable: true,
    smart: "PASSED",
    temp_c: 38,
    ...over,
  };
}

function snapshot(drives: BridgeObject[], extra: BridgeObject = {}): BridgeObject {
  return { drives, count: drives.length, snapshot_at: "2026-10-03T00:00:00Z", ...extra };
}

/** The drive rows the route returned. */
interface RouteDrive extends BridgeObject {
  uuid: string;
  encryption: unknown;
  preparation: unknown;
  usage: unknown;
  isSystemDisk: unknown;
  pool: unknown;
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = {
      id: "owner-1",
      username: "owner",
      displayName: "Owner",
      role: "owner",
    };
    next();
  });
  // The drives routes only ever read the Drive table; the prepare flow also
  // writes a CommandAuditLog row, which a stub that swallows it is enough for.
  const prisma = {
    drive: { findMany: async () => [] },
    storagePool: { findMany: async () => [] },
    commandAuditLog: { create: async () => ({}) },
  };
  app.use("/api", createStorageRouter(prisma as never));
  return app;
}

function stubBridge(body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

async function getDrives(snap: BridgeObject): Promise<{ status: number; drives: RouteDrive[]; body: Record<string, unknown> }> {
  stubBridge(snap);
  const res = await request(buildApp()).get("/api/storage/drives");
  return { status: res.status, drives: res.body.drives as RouteDrive[], body: res.body as Record<string, unknown> };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("BRIDGE_AUTH_TOKEN", "test-bridge-token");
});

// ── the pure helpers, as tables ─────────────────────────────────────────────

describe("encryption / preparation enums (WARP-3513)", () => {
  it("the closed sets are exactly the documented ones", () => {
    expect([...DRIVE_ENCRYPTION_STATES]).toEqual(["luks2", "none", "unknown"]);
    expect([...DRIVE_PREPARATION_STATES]).toEqual(["prepared", "needs_preparing"]);
  });

  it.each([
    ["luks2", "luks2"],
    ["none", "none"],
    ["unknown", "unknown"],
    // Anything outside the closed set — absent, wrong type, wrong spelling,
    // an unlisted scheme — is "unknown". Never trusted, never forwarded raw.
    [undefined, "unknown"],
    [null, "unknown"],
    ["", "unknown"],
    [" luks2", "unknown"],
    ["luks2 ", "unknown"],
    ["LUKS2", "unknown"],
    ["Luks2", "unknown"],
    ["luks1", "unknown"],
    ["luks", "unknown"],
    ["crypto_LUKS", "unknown"],
    ["plain", "unknown"],
    ["encrypted", "unknown"],
    [true, "unknown"],
    [false, "unknown"],
    [0, "unknown"],
    [42, "unknown"],
    [["luks2"], "unknown"],
    [{ type: "luks2" }, "unknown"],
  ] as Array<[unknown, DriveEncryption]>)("normalises %j -> %s", (raw, expected) => {
    expect(normaliseDriveEncryption(raw)).toBe(expected);
  });

  it.each([
    ["luks2", "prepared"],
    ["none", "needs_preparing"],
    ["unknown", "needs_preparing"], // fail closed: in doubt is never "prepared"
  ] as Array<[DriveEncryption, DrivePreparation]>)("%s -> %s", (encryption, expected) => {
    expect(drivePreparationFor(encryption)).toBe(expected);
  });

  it("every encryption state maps to a preparation state, and only luks2 is prepared", () => {
    const prepared = DRIVE_ENCRYPTION_STATES.filter((e) => drivePreparationFor(e) === "prepared");
    expect(prepared).toEqual(["luks2"]);
    for (const e of DRIVE_ENCRYPTION_STATES) {
      expect(DRIVE_PREPARATION_STATES).toContain(drivePreparationFor(e));
    }
  });

  it("usage is the explicit all-null shape, and a fresh object each time", () => {
    expect(unassignedDriveUsage()).toStrictEqual({ role: null, reservedBytes: null });
    expect(unassignedDriveUsage()).not.toBe(unassignedDriveUsage());
  });

  it.each([
    ["nvme0n1", "nvme0n1", true],
    ["nvme0n1", "sdb", false],
    [undefined, "sdb", false], // no os_disk reported -> fail open
    ["", "sdb", false],
    ["nvme0n1", undefined, false], // no parent_disk tag -> fail open
    ["nvme0n1", "", false],
    [undefined, undefined, false],
  ] as Array<[string | undefined, string | undefined, boolean]>)(
    "isOnSystemDisk(os_disk=%j, parent_disk=%j) -> %s",
    (osDisk, parentDisk, expected) => {
      expect(isOnSystemDisk({ parent_disk: parentDisk }, osDisk)).toBe(expected);
    },
  );

  it.each([
    ["md0", "md0"],
    ["md127", "md127"],
    ["md5", "md5"],
    [undefined, null],
    [null, null],
    ["", null],
    ["md", null],
    ["md12x", null],
    ["md127p1", null],
    ["/dev/md127", null],
    ["MD127", null],
    [" md127", null],
    ["md127 ", null],
    ["md127\n", null],
    ["md127; rm -rf /", null],
    ["sda", null],
    [127, null],
    [{}, null],
    [["md127"], null],
  ] as Array<[unknown, string | null]>)("bridgeMdName(%j) -> %j", (raw, expected) => {
    expect(bridgeMdName(raw)).toBe(expected);
  });
});

// ── GET /api/storage/drives ─────────────────────────────────────────────────

describe("GET /api/storage/drives — encryption, preparation, usage, isSystemDisk (WARP-3513)", () => {
  it("gives every drive all four fields", async () => {
    const { status, drives } = await getDrives(
      snapshot([
        bridgeDrive({ uuid: "U-LUKS", encryption: "luks2" }),
        bridgeDrive({ uuid: "U-PLAIN", device: "/dev/sdc1", encryption: "none" }),
        bridgeDrive({ uuid: "U-OLD", device: "/dev/sdd1" }), // a bridge that predates WARP-3513
      ]),
    );
    expect(status).toBe(200);
    const byUuid = new Map(drives.map((d) => [d.uuid, d]));

    expect(byUuid.get("U-LUKS")).toMatchObject({ encryption: "luks2", preparation: "prepared" });
    expect(byUuid.get("U-PLAIN")).toMatchObject({ encryption: "none", preparation: "needs_preparing" });
    expect(byUuid.get("U-OLD")).toMatchObject({ encryption: "unknown", preparation: "needs_preparing" });
    for (const d of drives) {
      expect(DRIVE_ENCRYPTION_STATES).toContain(d.encryption);
      expect(DRIVE_PREPARATION_STATES).toContain(d.preparation);
      expect(d.usage).toStrictEqual({ role: null, reservedBytes: null });
      expect(typeof d.isSystemDisk).toBe("boolean");
    }
  });

  it.each([
    { name: "luks2", raw: "luks2", encryption: "luks2", preparation: "prepared" },
    { name: "none", raw: "none", encryption: "none", preparation: "needs_preparing" },
    { name: "unknown", raw: "unknown", encryption: "unknown", preparation: "needs_preparing" },
    { name: "omitted", raw: undefined, encryption: "unknown", preparation: "needs_preparing" },
    { name: "null", raw: null, encryption: "unknown", preparation: "needs_preparing" },
    { name: "empty", raw: "", encryption: "unknown", preparation: "needs_preparing" },
    { name: "wrong case", raw: "LUKS2", encryption: "unknown", preparation: "needs_preparing" },
    { name: "an unlisted scheme", raw: "luks1", encryption: "unknown", preparation: "needs_preparing" },
    { name: "the raw blkid type", raw: "crypto_LUKS", encryption: "unknown", preparation: "needs_preparing" },
    { name: "a number", raw: 2, encryption: "unknown", preparation: "needs_preparing" },
    { name: "a boolean", raw: true, encryption: "unknown", preparation: "needs_preparing" },
    { name: "an object", raw: { luks2: true }, encryption: "unknown", preparation: "needs_preparing" },
  ] as Array<{ name: string; raw: unknown; encryption: DriveEncryption; preparation: DrivePreparation }>)(
    "bridge encryption: $name -> $encryption / $preparation",
    async ({ raw, encryption, preparation }) => {
      const over: BridgeObject = raw === undefined ? {} : { encryption: raw };
      const { drives } = await getDrives(snapshot([bridgeDrive(over)]));
      expect(drives[0].encryption).toBe(encryption);
      expect(drives[0].preparation).toBe(preparation);
      // The bridge's raw value is never what is forwarded.
      expect(DRIVE_ENCRYPTION_STATES).toContain(drives[0].encryption);
    },
  );

  it("preparation follows `encryption` alone — never another field's nullness or absence", async () => {
    // Hold the encryption fixed, vary everything a sloppy derivation might key on.
    const variations: BridgeObject[] = [
      {},
      { device: "/dev/md127", md: "md127" }, // a pool member
      { smart: null, temp_c: null },
      { readonly: true },
      { removable: false },
      { bus: undefined },
      { parent_disk: undefined },
      { label: "" },
    ];
    for (const encryption of ["luks2", "none", "unknown"] as const) {
      for (const over of variations) {
        const { drives } = await getDrives(snapshot([bridgeDrive({ ...over, encryption })]));
        expect(drives[0].preparation, `${encryption} ${JSON.stringify(over)}`).toBe(
          drivePreparationFor(encryption),
        );
      }
    }
  });

  it("an unprepared drive is still LISTED (and counted) — it is never hidden or auto-wiped", async () => {
    const { drives, body } = await getDrives(
      snapshot([
        bridgeDrive({ uuid: "U-LUKS", encryption: "luks2" }),
        bridgeDrive({ uuid: "U-PLAIN", device: "/dev/sdc1", encryption: "none" }),
      ]),
    );
    expect(drives.map((d) => d.uuid)).toEqual(["U-LUKS", "U-PLAIN"]);
    expect(body.count).toBe(2);
    expect((body.totals as { drive_count: number }).drive_count).toBe(2);
  });

  it("keeps every existing key, value for value (only encryption and md are reworked)", async () => {
    const source = bridgeDrive({ encryption: "luks2", md: "md127" });
    const { drives } = await getDrives(snapshot([source]));
    const out = drives[0];
    for (const [key, value] of Object.entries(source)) {
      if (key === "encryption" || key === "md") continue;
      expect(out[key], key).toEqual(value);
    }
    // The label join and bus keys are still there.
    expect(out).toMatchObject({ displayName: null, icon: null, notes: null, bus: "usb" });
  });

  it("falls back to the neutral bus class exactly as before when the bridge omits it", async () => {
    const { drives } = await getDrives(snapshot([bridgeDrive({ bus: undefined, device: "/dev/sdc1" })]));
    expect(drives[0].bus).toBe("disk");
  });

  describe("usage (WARP-3514 fills it later)", () => {
    it("is the explicit all-null shape for every drive, whatever the bridge said", async () => {
      const { drives } = await getDrives(
        snapshot([
          bridgeDrive({ uuid: "A", encryption: "luks2" }),
          bridgeDrive({ uuid: "B", device: "/dev/sdc1", encryption: "none" }),
          // A bridge that (wrongly) volunteers a usage of its own must not win.
          bridgeDrive({ uuid: "C", device: "/dev/sdd1", usage: { role: "recordings", reservedBytes: 7 } }),
        ]),
      );
      for (const d of drives) expect(d.usage, d.uuid).toStrictEqual({ role: null, reservedBytes: null });
    });
  });

  describe("isSystemDisk", () => {
    const osSnapshot = (extra: BridgeObject = {}): BridgeObject =>
      snapshot(
        [
          // The OS disk's own partitions, auto-mounted under /mnt/droplet.
          bridgeDrive({ uuid: "U-OS-ROOT", device: "/dev/nvme0n1p2", parent_disk: "nvme0n1", mount: "/mnt/droplet/ubuntu-root" }),
          bridgeDrive({ uuid: "U-DATA", encryption: "luks2" }),
        ],
        { os_disk: "nvme0n1", ...extra },
      );

    it("is false for every listed data drive; an OS-disk partition is not listed at all", async () => {
      const { drives } = await getDrives(osSnapshot());
      expect(drives.map((d) => d.uuid)).toEqual(["U-DATA"]);
      expect(drives[0].isSystemDisk).toBe(false);
    });

    it("is false (a real boolean, not undefined) when the bridge reports no os_disk — it fails open", async () => {
      const { drives } = await getDrives(
        snapshot([bridgeDrive({ uuid: "U-DATA", parent_disk: "nvme0n1", encryption: "luks2" })]),
      );
      // No os_disk -> nothing is hidden, and the drive is not claimed to be the OS disk.
      expect(drives).toHaveLength(1);
      expect(drives[0].isSystemDisk).toBe(false);
    });

    it("is false when the bridge omits parent_disk", async () => {
      const { drives } = await getDrives(
        snapshot([bridgeDrive({ uuid: "U-DATA", parent_disk: undefined })], { os_disk: "nvme0n1" }),
      );
      expect(drives[0].isSystemDisk).toBe(false);
    });
  });

  describe("pool join through a LUKS container (LUKS-over-md)", () => {
    it.each([
      { name: "a plain md node (the WARP-1339 regex)", over: { device: "/dev/md127" }, pool: "md127" },
      { name: "a partition of an md node", over: { device: "/dev/md127p1" }, pool: "md127" },
      { name: "a mapper node over an md, via the bridge's md", over: { device: "/dev/mapper/droplet-bay-1a2b3c4d", md: "md127" }, pool: "md127" },
      { name: "a mapper node over a different md", over: { device: "/dev/mapper/droplet-bay-1a2b3c4d", md: "md5" }, pool: "md5" },
      { name: "the device regex wins over a conflicting md", over: { device: "/dev/md127", md: "md5" }, pool: "md127" },
      { name: "a standalone mapper drive (md null)", over: { device: "/dev/mapper/droplet-bay-1a2b3c4d", md: null }, pool: null },
      { name: "a standalone mapper drive (md absent)", over: { device: "/dev/mapper/droplet-bay-1a2b3c4d" }, pool: null },
      { name: "a plain partition", over: { device: "/dev/sdb1" }, pool: null },
    ] as Array<{ name: string; over: BridgeObject; pool: string | null }>)("$name -> pool $pool", async ({ over, pool }) => {
      const { drives } = await getDrives(snapshot([bridgeDrive({ ...over, encryption: "luks2" })]));
      expect(drives[0].pool).toBe(pool);
    });

    it.each([
      "md",
      "md12x",
      "md127p1",
      "/dev/md127",
      "MD127",
      " md127",
      "md127 ",
      "md127; rm -rf /",
      "sda",
      "",
      127,
      {},
      ["md127"],
    ])("never trusts a malformed bridge md (%j) — the pool stays null", async (md) => {
      const { drives } = await getDrives(
        snapshot([bridgeDrive({ device: "/dev/mapper/droplet-bay-1a2b3c4d", md, encryption: "luks2" })]),
      );
      expect(drives[0].pool).toBeNull();
    });

    it("does not forward the bridge's raw md — it reaches the client only as the validated pool", async () => {
      const { drives } = await getDrives(
        snapshot([
          bridgeDrive({ uuid: "A", device: "/dev/mapper/droplet-bay-1a2b3c4d", md: "md127", encryption: "luks2" }),
          bridgeDrive({ uuid: "B", device: "/dev/sdc1", md: "md127; rm -rf /", encryption: "luks2" }),
        ]),
      );
      for (const d of drives) expect("md" in d, d.uuid).toBe(false);
    });

    it("still never drops the pool-backed drive (it is the pool's only capacity source)", async () => {
      const { drives, body } = await getDrives(
        snapshot([bridgeDrive({ device: "/dev/mapper/droplet-bay-1a2b3c4d", md: "md127", encryption: "luks2" })]),
      );
      expect(drives).toHaveLength(1);
      expect(body.count).toBe(1);
    });
  });

  describe("disks[] (the whole-disk inventory)", () => {
    const disk = (over: BridgeObject = {}): BridgeObject => ({
      name: "sdb",
      size_bytes: 2000 * GB,
      state: "available",
      fstype: "",
      bus: "usb",
      model: "Samsung T7",
      serial: "S-1",
      ...over,
    });

    it.each([
      ["luks2", "luks2"],
      ["none", "none"],
      ["unknown", "unknown"],
      [undefined, "unknown"],
      [null, "unknown"],
      ["LUKS2", "unknown"],
      ["crypto_LUKS", "unknown"],
      [3, "unknown"],
    ] as Array<[unknown, DriveEncryption]>)("normalises a disk's encryption %j -> %s", async (raw, expected) => {
      const source = disk(raw === undefined ? {} : { encryption: raw });
      const { body } = await getDrives(snapshot([], { disks: [source], os_disk: "nvme0n1" }));
      const out = (body.disks as BridgeObject[])[0];
      expect(out.encryption).toBe(expected);
      // Everything else is forwarded as it always was.
      for (const [key, value] of Object.entries(source)) {
        if (key === "encryption") continue;
        expect(out[key], key).toEqual(value);
      }
    });

    it("normalises each disk independently and still drops the OS disk", async () => {
      const { body } = await getDrives(
        snapshot([], {
          os_disk: "nvme0n1",
          disks: [
            disk({ name: "sda", state: "pool_member", md: "md127", encryption: "none" }),
            disk({ name: "sdb", encryption: "luks2" }),
            disk({ name: "sdc" }),
            disk({ name: "nvme0n1", state: "in_use", encryption: "luks2" }),
          ],
        }),
      );
      const disks = body.disks as Array<{ name: string; encryption: string; md?: string }>;
      expect(disks.map((d) => [d.name, d.encryption])).toEqual([
        ["sda", "none"],
        ["sdb", "luks2"],
        ["sdc", "unknown"],
      ]);
      expect(disks[0].md).toBe("md127"); // the pool_member md hint is untouched
    });

    it("keeps the key ABSENT (not []) for a bridge that sends no disks", async () => {
      const { body } = await getDrives(snapshot([bridgeDrive({ encryption: "luks2" })]));
      expect("disks" in body).toBe(false);
    });

    it("keeps an explicit empty disks list as an empty list", async () => {
      const { body } = await getDrives(snapshot([], { disks: [] }));
      expect(body.disks).toEqual([]);
    });
  });
});

// ── POST /api/storage/command/confirm — the prepare ops ─────────────────────

describe("POST /api/storage/command/confirm — a prepare op reports its encryption (WARP-3513)", () => {
  interface Prepare {
    service: "drive_adopt" | "drive_reclaim" | "pool_format";
    resourceId: string;
    mintPath: string;
    mintBody: BridgeObject;
  }
  const PREPARES: Prepare[] = [
    {
      service: "drive_adopt",
      resourceId: "sdb",
      mintPath: "/api/storage/drives/adopt",
      mintBody: { device: "sdb", confirmPhrase: "ERASE sdb" },
    },
    {
      service: "drive_reclaim",
      resourceId: "sda",
      mintPath: "/api/storage/drives/reclaim",
      mintBody: { device: "sda", md: "md127", confirmPhrase: "ERASE sda" },
    },
    {
      service: "pool_format",
      resourceId: "md0",
      mintPath: "/api/storage/pools/md0/format",
      mintBody: { confirmPhrase: "ERASE md0" },
    },
  ];

  /** Mint a token, then confirm it against a bridge that answers `hostReply`. */
  async function confirmWith(
    prepare: Prepare,
    hostReply: unknown,
    status = 200,
  ): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => hostReply })),
    );
    const app = buildApp();
    const mint = await request(app).post(prepare.mintPath).send(prepare.mintBody);
    expect(mint.status).toBe(202);
    const res = await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: mint.body.confirmationToken,
        service: prepare.service,
        resourceId: prepare.resourceId,
      });
    return { status: res.status, body: res.body as Record<string, unknown>, text: res.text };
  }

  describe.each(PREPARES)("$service", (prepare) => {
    const hostReply = (): BridgeObject => ({
      ok: true,
      operation: prepare.service,
      encrypted: true,
      uuid: FS_UUID,
      recovery_key_pending: true,
      mount: "/mnt/droplet/drive-1a2b3c4d",
    });

    it("passes `encrypted` and `uuid` through and adds a strict camelCase recoveryKeyPending", async () => {
      const res = await confirmWith(prepare, hostReply());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        status: "ok",
        operation: prepare.service,
        device: prepare.resourceId,
        encrypted: true,
        uuid: FS_UUID,
        recoveryKeyPending: true,
      });
      // The host's own snake_case field and the rest of its reply still come through.
      expect(res.body.recovery_key_pending).toBe(true);
      expect(res.body.mount).toBe("/mnt/droplet/drive-1a2b3c4d");
    });

    it("says encrypted:false / recoveryKeyPending:false (not absent) when an older host reports neither", async () => {
      const res = await confirmWith(prepare, { ok: true, operation: prepare.service });
      expect(res.status).toBe(200);
      expect(res.body.encrypted).toBe(false);
      expect(res.body.recoveryKeyPending).toBe(false);
      expect("uuid" in res.body).toBe(false);
    });

    it.each([
      ["a string", "true"],
      ["a number", 1],
      ["null", null],
      ["an object", { pending: true }],
    ])("treats %s as NOT true — only a real boolean true counts", async (_name, junk) => {
      const res = await confirmWith(prepare, { ...hostReply(), encrypted: junk, recovery_key_pending: junk });
      expect(res.status).toBe(200);
      expect(res.body.encrypted).toBe(false);
      expect(res.body.recoveryKeyPending).toBe(false);
    });

    it("reports recoveryKeyPending:false when the host says the key is not pending", async () => {
      const res = await confirmWith(prepare, { ...hostReply(), recovery_key_pending: false });
      expect(res.body.recoveryKeyPending).toBe(false);
      expect(res.body.encrypted).toBe(true);
    });

    it.each(["recovery_key", "recoveryKey"])(
      "NEVER relays a recovery key even if the host attaches one (%s)",
      async (field) => {
        const res = await confirmWith(prepare, { ...hostReply(), [field]: FAKE_RECOVERY_KEY });
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
        expect(field in res.body).toBe(false);
        // …and the legitimate fields are unharmed.
        expect(res.body.recoveryKeyPending).toBe(true);
      },
    );

    // ADR-070: Prepare REQUIRES a TPM2 (and an encrypted /data to hold the recovery
    // key). The host refuses before touching anything with a machine code; the
    // owner sees one fixed sentence, never the script's own words.
    it.each([
      ["tpm_required", /no usable TPM2 chip.*Nothing was erased/s],
      ["encrypted_data_required", /not encrypted yet.*Nothing was changed/s],
    ])("a host precondition refusal (%s) is a 409 with that code and a fixed message", async (code, message) => {
      const res = await confirmWith(
        prepare,
        { ok: false, error: "droplet-storage-pool: refusing: /sys/class/tpm/tpm0 is missing", code },
        409,
      );
      expect(res.status).toBe(409);
      expect(Object.keys(res.body).sort()).toEqual(["code", "error", "ok"]);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe(code);
      expect(res.body.error).toMatch(message);
      expect(res.text).not.toContain("/sys/class/tpm");
    });

    it("a refusal carrying a code this route does not know stays a 422 with the host's message", async () => {
      const res = await confirmWith(prepare, { ok: false, error: "refusing: /dev/sdb is mounted", code: "mystery" }, 409);
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ ok: false, error: "refusing: /dev/sdb is mounted" });
    });

    it("a `code` on a SUCCESSFUL reply does not turn it into a refusal", async () => {
      const res = await confirmWith(prepare, { ...hostReply(), code: "tpm_required" });
      expect(res.status).toBe(200);
    });

    it("a refused op stays a 422 with the host's message, and still never relays a key", async () => {
      const res = await confirmWith(
        prepare,
        { ok: false, error: "refusing to erase the OS disk", recovery_key: FAKE_RECOVERY_KEY },
        409,
      );
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ ok: false, error: "refusing to erase the OS disk" });
      expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
    });
  });

  it("a non-prepare op's response is unchanged — no encryption fields are invented for it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, device: "md0" }) })),
    );
    const app = buildApp();
    const mint = await request(app)
      .post("/api/storage/pools")
      .send({ device: "md0", level: "raid1", members: ["/dev/sda", "/dev/sdb"], confirmPhrase: "ERASE sda sdb" });
    const res = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: mint.body.confirmationToken, service: "pool_create", resourceId: "md0" });
    expect(res.status).toBe(200);
    expect("encrypted" in res.body).toBe(false);
    expect("recoveryKeyPending" in res.body).toBe(false);
  });
});
