/**
 * WARP-1450 — `get_update_status` LLM tool.
 *
 * Role-gated (owner/admin only, WARP-845 ladder) read over the
 * orchestrator's `GET /api/updates/status` (routes/updates.ts): the
 * committed release, the pending/in-flight DeviceUpdate row, the last
 * terminal verdict, the WARP-538 settings, and apply availability —
 * with every DeviceUpdateStatus mapped to a human-readable phase.
 * Tier-1 read; the companion to apply_update.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getUpdateStatus from "../../../src/handlers/system/get-update-status.js";
import type { Role, ToolContext } from "../../../src/types.js";

function ctxWith(
  orchestratorGet: Mock,
  role?: Role,
): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    ...(role !== undefined ? { role } : {}),
    signal: new AbortController().signal,
  };
}

// DeviceUpdate row slices exactly as GET /api/updates/status serializes
// them (ROW_SELECT in routes/updates.ts — never manifestJson).
const CURRENT_ROW = {
  id: "du-current",
  status: "committed",
  channel: "stable",
  releaseTag: "v1.4.1",
  gitSha: "aaaaaaaaaaaabbbbbbbbbbbbccccccccccccdddd",
  builtAt: "2026-07-01T00:00:00.000Z",
  failureReason: null,
  createdAt: "2026-07-01T01:00:00.000Z",
  updatedAt: "2026-07-01T02:00:00.000Z",
};

const PENDING_ROW = {
  id: "du-pending",
  status: "pending",
  channel: "stable",
  releaseTag: "v1.4.2",
  gitSha: "1111222233334444555566667777888899990000",
  builtAt: "2026-07-18T00:00:00.000Z",
  failureReason: null,
  createdAt: "2026-07-19T09:00:00.000Z",
  updatedAt: "2026-07-19T09:00:00.000Z",
};

const SETTINGS = { channel: "stable", applyWindowCron: "0 3 * * *", autoApply: true };

function statusResponse(payload: unknown, status = 200): Mock {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), { status }),
  );
}

function fullPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    current: CURRENT_ROW,
    pending: PENDING_ROW,
    lastVerdict: CURRENT_ROW,
    degraded: false,
    settings: SETTINGS,
    applyAvailable: true,
    ...overrides,
  };
}

function expectError(
  res: Awaited<ReturnType<typeof getUpdateStatus.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("get_update_status", () => {
  describe("role gate (WARP-845 / WARP-1450)", () => {
    it.each([undefined, "guest", "family", "service"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const get = vi.fn();
        const res = await getUpdateStatus.handler({}, ctxWith(get, role));
        expectError(res, "FORBIDDEN");
        expect(get).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin"] as const)("role %s passes", async (role) => {
      const get = statusResponse(fullPayload());
      const res = await getUpdateStatus.handler({}, ctxWith(get, role));
      expect(res.ok).toBe(true);
    });
  });

  it("passes the status payload through, bound to the real route fields", async () => {
    const get = statusResponse(fullPayload());
    const res = await getUpdateStatus.handler({}, ctxWith(get, "admin"));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/updates/status", {
      headers: { Accept: "application/json" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "get_update_status",
        current: {
          version: "v1.4.1",
          releaseTag: "v1.4.1",
          gitSha: CURRENT_ROW.gitSha,
          builtAt: "2026-07-01T00:00:00.000Z",
          committedAt: "2026-07-01T02:00:00.000Z",
        },
        pending: {
          version: "v1.4.2",
          releaseTag: "v1.4.2",
          gitSha: PENDING_ROW.gitSha,
          builtAt: "2026-07-18T00:00:00.000Z",
          status: "pending",
          phase: "pending — a verified update is ready to apply",
          verifiedAt: "2026-07-19T09:00:00.000Z",
        },
        phase: "pending — a verified update is ready to apply",
        lastVerdict: {
          version: "v1.4.1",
          status: "committed",
          phase: "committed — the update was applied and the system is healthy",
          failureReason: null,
          at: "2026-07-01T02:00:00.000Z",
        },
        degraded: false,
        applyAvailable: true,
        settings: {
          channel: "stable",
          autoApply: true,
          applyWindowCron: "0 3 * * *",
        },
      });
    }
  });

  it("falls back to the short gitSha as version when releaseTag is null", async () => {
    const get = statusResponse(
      fullPayload({
        pending: { ...PENDING_ROW, releaseTag: null },
        current: null,
        lastVerdict: null,
      }),
    );
    const res = await getUpdateStatus.handler({}, ctxWith(get, "owner"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { pending: { version: string } };
      expect(data.pending.version).toBe(PENDING_ROW.gitSha.slice(0, 10));
    }
  });

  describe("phase mapping (DeviceUpdateStatus → human phase)", () => {
    it("maps an in-flight applying row to a services-are-restarting phase", async () => {
      const get = statusResponse(
        fullPayload({ pending: { ...PENDING_ROW, status: "applying" } }),
      );
      const res = await getUpdateStatus.handler({}, ctxWith(get, "admin"));
      expect(res.ok).toBe(true);
      if (res.ok) {
        const data = res.data as { phase: string; pending: { phase: string } };
        expect(data.phase).toBe(
          "applying — services are restarting; the assistant may be briefly unavailable",
        );
        expect(data.pending.phase).toBe(data.phase);
      }
    });

    it("maps a committed lastVerdict to an applied-and-healthy phase", async () => {
      const get = statusResponse(fullPayload({ pending: null }));
      const res = await getUpdateStatus.handler({}, ctxWith(get, "admin"));
      expect(res.ok).toBe(true);
      if (res.ok) {
        const data = res.data as {
          phase: string;
          lastVerdict: { phase: string };
        };
        expect(data.lastVerdict.phase).toBe(
          "committed — the update was applied and the system is healthy",
        );
        // No in-flight row → the overall phase is idle.
        expect(data.phase).toBe("idle — no update is being verified or applied");
      }
    });

    it("maps a rolled_back lastVerdict to a previous-version-restored phase", async () => {
      const get = statusResponse(
        fullPayload({
          pending: null,
          lastVerdict: {
            ...CURRENT_ROW,
            id: "du-rb",
            status: "rolled_back",
            failureReason: "health_gate",
          },
        }),
      );
      const res = await getUpdateStatus.handler({}, ctxWith(get, "owner"));
      expect(res.ok).toBe(true);
      if (res.ok) {
        const data = res.data as {
          lastVerdict: { phase: string; failureReason: string };
        };
        expect(data.lastVerdict.phase).toBe(
          "rolled back — the update failed and the previous version was restored",
        );
        expect(data.lastVerdict.failureReason).toBe("health_gate");
      }
    });
  });

  it("says a never-OTA'd box runs its factory image (current null)", async () => {
    const get = statusResponse(
      fullPayload({ current: null, pending: null, lastVerdict: null }),
    );
    const res = await getUpdateStatus.handler({}, ctxWith(get, "admin"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as {
        current: unknown;
        currentNote: string;
        pending: unknown;
        lastVerdict: unknown;
      };
      expect(data.current).toBeNull();
      expect(data.currentNote).toMatch(/factory image/);
      expect(data.pending).toBeNull();
      expect(data.lastVerdict).toBeNull();
    }
  });

  it("passes degraded:true through (rollback did not restore health)", async () => {
    const get = statusResponse(fullPayload({ degraded: true }));
    const res = await getUpdateStatus.handler({}, ctxWith(get, "owner"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { degraded: boolean }).degraded).toBe(true);
    }
  });

  describe("non-OK mapping", () => {
    it.each([403, 451] as const)("%s → FORBIDDEN", async (status) => {
      const get = statusResponse({}, status);
      const res = await getUpdateStatus.handler({}, ctxWith(get, "admin"));
      expectError(res, "FORBIDDEN");
    });

    it.each([500, 502] as const)("%s → STATUS_UNAVAILABLE", async (status) => {
      const get = statusResponse({}, status);
      const res = await getUpdateStatus.handler({}, ctxWith(get, "admin"));
      expectError(res, "STATUS_UNAVAILABLE");
    });

    it("thrown fetch → STATUS_UNAVAILABLE", async () => {
      const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const res = await getUpdateStatus.handler({}, ctxWith(get, "owner"));
      expectError(res, "STATUS_UNAVAILABLE");
    });
  });
});

describe("get_update_status — tool metadata", () => {
  it("is named get_update_status and is Tier-1 (no write, no confirm)", () => {
    expect(getUpdateStatus.name).toBe("get_update_status");
    expect(getUpdateStatus.requiresWrite).toBe(false);
    expect(getUpdateStatus.requiresConfirmation).toBe(false);
  });

  it("takes no arguments (empty additionalProperties:false schema)", () => {
    const schema = getUpdateStatus.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
  });

  it("describes itself as the companion to apply_update", () => {
    expect(getUpdateStatus.description).toContain("apply_update");
  });
});
