/**
 * WARP-1450 — `get_drive_health` LLM tool.
 *
 * SMART status + temperature per data drive from the orchestrator's
 * GET /api/storage/drives (the WARP-1144-corrected source of truth
 * list_drives also uses). The device-bridge only attaches `smart`
 * ("PASSED"/"FAILED") and `temp_c` when DRIVE_SMART_ENABLED is set
 * (WARP-612) — an all-drives-missing-smart snapshot is an INFORMATIVE
 * SUCCESS (smartEnabled:false + hint), never an error. Tier-1 read.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getDriveHealth from "../../../src/handlers/system/get-drive-health.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithGet(get: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

/** One drive in the /api/storage/drives response shape (BridgeDrive +
 *  WARP-174 label join + WARP-1339 pool annotation — see
 *  apps/orchestrator/src/routes/storage.ts DriveWithLabel). */
function drive(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    device: "/dev/sda1",
    mount: "/mnt/droplet/data",
    label: "data",
    uuid: "U-1",
    size_bytes: 1_000_000_000_000,
    used_bytes: 400_000_000_000,
    free_bytes: 600_000_000_000,
    mounted: true,
    bus: "usb",
    displayName: null,
    icon: null,
    notes: null,
    pool: null,
    ...overrides,
  };
}

function okResponse(drives: unknown[]): Response {
  return new Response(
    JSON.stringify({ drives, count: drives.length, snapshot_at: "2026-07-20T12:00:00Z" }),
    { status: 200 },
  );
}

describe("get_drive_health", () => {
  it("maps the WARP-612 smart/temp_c enrichment into the health shape (smartEnabled:true)", async () => {
    const get = vi.fn().mockResolvedValue(
      okResponse([
        drive({
          device: "/dev/nvme0n1p1",
          mount: "/mnt/droplet/media-1a2b",
          label: "media",
          displayName: "Media drive",
          smart: "PASSED",
          temp_c: 41,
        }),
        drive({
          device: "/dev/sdb1",
          mount: "/mnt/droplet/backup",
          label: "backup",
          uuid: "U-2",
          size_bytes: 2_000_000_000_000,
          used_bytes: 1_500_000_000_000,
          free_bytes: 500_000_000_000,
          smart: "PASSED",
          temp_c: 38,
        }),
      ]),
    );
    const res = await getDriveHealth.handler({}, ctxWithGet(get));

    expect(get).toHaveBeenCalledWith("/api/storage/drives", {
      headers: { Accept: "application/json" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "get_drive_health",
        drives: [
          {
            name: "Media drive",
            device: "/dev/nvme0n1p1",
            mount: "/mnt/droplet/media-1a2b",
            sizeBytes: 1_000_000_000_000,
            usedBytes: 400_000_000_000,
            freeBytes: 600_000_000_000,
            smart: "PASSED",
            tempC: 41,
          },
          {
            name: "backup",
            device: "/dev/sdb1",
            mount: "/mnt/droplet/backup",
            sizeBytes: 2_000_000_000_000,
            usedBytes: 1_500_000_000_000,
            freeBytes: 500_000_000_000,
            smart: "PASSED",
            tempC: 38,
          },
        ],
        smartEnabled: true,
      });
      // All drives PASSED → no warning, no hint.
      expect(res.data).not.toHaveProperty("warning");
      expect(res.data).not.toHaveProperty("hint");
    }
  });

  it("surfaces a top-level warning naming the drive when SMART reports FAILED", async () => {
    const get = vi.fn().mockResolvedValue(
      okResponse([
        drive({ label: "photos", smart: "PASSED", temp_c: 39 }),
        drive({
          device: "/dev/sdc1",
          mount: "/mnt/droplet/old-usb",
          label: "old-usb",
          uuid: "U-3",
          smart: "FAILED",
          temp_c: 55,
        }),
      ]),
    );
    const res = await getDriveHealth.handler({}, ctxWithGet(get));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as {
        drives: Array<{ smart: string | null }>;
        smartEnabled: boolean;
        warning?: string;
      };
      expect(data.smartEnabled).toBe(true);
      expect(data.drives[1]!.smart).toBe("FAILED");
      expect(data.warning).toContain("old-usb");
      expect(data.warning).toContain("FAILED");
    }
  });

  it("is an INFORMATIVE SUCCESS (not an error) when every drive lacks smart data", async () => {
    // DRIVE_SMART_ENABLED off on the bridge → no smart/temp_c on any drive
    // (older bridges omit the fields entirely; newer ones may send null).
    const get = vi.fn().mockResolvedValue(
      okResponse([
        drive({}), // fields absent
        drive({ device: "/dev/sdb1", mount: "/mnt/droplet/b", uuid: "U-2", smart: null, temp_c: null }),
      ]),
    );
    const res = await getDriveHealth.handler({}, ctxWithGet(get));
    // The load-bearing assertion: SMART-off is a healthy-unknown SUCCESS.
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as {
        type: string;
        drives: Array<{ smart: string | null; tempC: number | null }>;
        smartEnabled: boolean;
        hint?: string;
        warning?: string;
      };
      expect(data.type).toBe("get_drive_health");
      expect(data.smartEnabled).toBe(false);
      expect(data.hint).toBe(
        "SMART monitoring is disabled — set DRIVE_SMART_ENABLED=1 on the device bridge",
      );
      expect(data.warning).toBeUndefined();
      // Drives are still listed, with explicit nulls the agent can report.
      expect(data.drives).toHaveLength(2);
      expect(data.drives[0]).toMatchObject({ smart: null, tempC: null });
      expect(data.drives[1]).toMatchObject({ smart: null, tempC: null });
    }
  });

  it("returns DRIVES_UNAVAILABLE when the fetch throws", async () => {
    const get = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const res = await getDriveHealth.handler({}, ctxWithGet(get));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe("error");
      expect(res.error.code).toBe("DRIVES_UNAVAILABLE");
      expect(res.error.message).not.toContain("fetch failed");
    }
  });

  it("returns DRIVES_UNAVAILABLE on a non-2xx response", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    const res = await getDriveHealth.handler({}, ctxWithGet(get));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("DRIVES_UNAVAILABLE");
      expect(res.error.message).toContain("502");
    }
  });
});

describe("get_drive_health — tool metadata", () => {
  it("is named get_drive_health and is Tier-1 (no write, no confirm)", () => {
    expect(getDriveHealth.name).toBe("get_drive_health");
    expect(getDriveHealth.requiresWrite).toBe(false);
    expect(getDriveHealth.requiresConfirmation).toBe(false);
  });

  it("takes no arguments (empty additionalProperties:false schema)", () => {
    expect(getDriveHealth.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("tells the agent SMART monitoring is off by default and where to enable it", () => {
    expect(getDriveHealth.description).toContain("SMART");
    expect(getDriveHealth.description).toContain("DRIVE_SMART_ENABLED");
  });
});
