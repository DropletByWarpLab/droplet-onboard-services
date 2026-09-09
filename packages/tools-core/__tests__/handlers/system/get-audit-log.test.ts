/**
 * WARP-1450 — `get_audit_log` LLM tool.
 *
 * Role-gated (owner/admin only, WARP-845 ladder — same defense split as
 * list_threat_events, WARP-1443) general read over the tamper-evident
 * activity log via a SINGLE GET /api/activity call with optional
 * kind/actor/q filters. Tier-1 read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import getAuditLog from "../../../src/handlers/system/get-audit-log.js";
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

/** The exact enum GET /api/activity accepts (routes/activity.ts ACTIVITY_KINDS). */
const ACTIVITY_KINDS = [
  "chat",
  "tool_call",
  "file",
  "camera",
  "network",
  "smart_home",
  "email",
  "auth",
  "tool_run",
  "system",
  "voice",
] as const;

// GET /api/activity item rows (activity.ts list route shape).
const ITEMS = [
  {
    id: "12",
    at: "2026-07-20T11:45:00.000Z",
    severity: "info",
    sourceIcon: "wrench",
    what: "AI set the living-room thermostat to 21°C",
    sub: "set_thermostat",
    kind: "tool_call",
    refs: { tool: "set_thermostat", args: { room: "living-room", target_c: 21 } },
    actorType: "ai",
    actorId: null,
  },
  {
    id: "11",
    at: "2026-07-20T10:15:00.000Z",
    severity: "warn",
    sourceIcon: "shield-off",
    what: "Access denied",
    sub: "GET /api/activity",
    kind: "auth",
    refs: null,
    // v1 row: actor columns are unsigned so the route serves null (WARP-181).
    actorType: null,
    actorId: null,
  },
];

function okGet(items: unknown[] = ITEMS): Mock {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ items, nextCursor: null }), { status: 200 }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof getAuditLog.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("get_audit_log", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("role gate (WARP-845 / WARP-1450)", () => {
    it.each([undefined, "guest", "family", "service"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const get = vi.fn();
        const res = await getAuditLog.handler({}, ctxWith(get, role));
        expectError(res, "FORBIDDEN");
        if (!res.ok) {
          expect(res.error.message).toBe(
            "the audit log is visible to owners and admins only",
          );
        }
        expect(get).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin"] as const)("role %s passes", async (role) => {
      const get = okGet();
      const res = await getAuditLog.handler({}, ctxWith(get, role));
      expect(res.ok).toBe(true);
    });
  });

  it("makes ONE /api/activity call with only from + limit by default (no kind/actorType/q)", async () => {
    const get = okGet();
    const res = await getAuditLog.handler({}, ctxWith(get, "owner"));
    expect(get).toHaveBeenCalledTimes(1);
    // Exact params object — pins that absent filters are OMITTED, not sent
    // as undefined keys, and that the window is now − 24 h.
    expect(get).toHaveBeenCalledWith("/api/activity", {
      params: { from: "2026-07-19T12:00:00.000Z", limit: 50 },
      headers: { Accept: "application/json" },
    });
    expect(res.ok).toBe(true);
  });

  it("threads kind, actor→actorType, hours→from, q and limit through to the route", async () => {
    const get = okGet();
    const res = await getAuditLog.handler(
      { kind: "tool_call", actor: "ai", hours: 48, q: "thermostat", limit: 10 },
      ctxWith(get, "admin"),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/activity", {
      params: {
        kind: "tool_call",
        actorType: "ai",
        from: "2026-07-18T12:00:00.000Z",
        q: "thermostat",
        limit: 10,
      },
      headers: { Accept: "application/json" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { windowHours: number }).windowHours).toBe(48);
    }
  });

  it("maps rows to {at, kind, severity, summary, actorType?, refs?} with refs passed through unmodified", async () => {
    const get = okGet();
    const res = await getAuditLog.handler({}, ctxWith(get, "owner"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "get_audit_log",
        events: [
          {
            at: "2026-07-20T11:45:00.000Z",
            kind: "tool_call",
            severity: "info",
            summary: "AI set the living-room thermostat to 21°C",
            actorType: "ai",
            // refs passthrough (owner/admin audience — WARP-1450): the
            // collector payload reaches the agent byte-identical, nested
            // structure and all.
            refs: {
              tool: "set_thermostat",
              args: { room: "living-room", target_c: 21 },
            },
          },
          {
            at: "2026-07-20T10:15:00.000Z",
            kind: "auth",
            severity: "warn",
            summary: "Access denied",
            // null actorType / null refs → keys OMITTED, never null noise.
          },
        ],
        count: 2,
        windowHours: 24,
      });
      const second = (res.data as { events: Array<Record<string, unknown>> })
        .events[1]!;
      expect(second).not.toHaveProperty("actorType");
      expect(second).not.toHaveProperty("refs");
    }
  });

  it.each([
    ["unknown kind", { kind: "telemetry" }],
    ["non-string kind", { kind: 3 }],
    ["unknown actor", { actor: "anonymous" }],
    ["non-string actor", { actor: true }],
    ["hours below range", { hours: 0 }],
    ["hours above range", { hours: 721 }],
    ["non-integer hours", { hours: 1.5 }],
    ["non-numeric hours", { hours: "24" }],
    ["limit below range", { limit: 0 }],
    ["limit above range", { limit: 101 }],
    ["non-numeric limit", { limit: "50" }],
    ["empty q", { q: "" }],
    ["overlong q", { q: "x".repeat(201) }],
    ["non-string q", { q: 42 }],
  ])("rejects %s with INVALID_ARGS (no HTTP call)", async (_label, args) => {
    const get = vi.fn();
    const res = await getAuditLog.handler(
      args as Record<string, unknown>,
      ctxWith(get, "admin"),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("maps a non-OK response to ACTIVITY_UNAVAILABLE", async () => {
    const get = vi.fn().mockResolvedValue(new Response("nope", { status: 502 }));
    const res = await getAuditLog.handler({}, ctxWith(get, "admin"));
    expectError(res, "ACTIVITY_UNAVAILABLE");
    if (!res.ok) {
      expect(res.error.message).toContain("502");
    }
  });

  it("maps a thrown fetch error to ACTIVITY_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await getAuditLog.handler({}, ctxWith(get, "owner"));
    expectError(res, "ACTIVITY_UNAVAILABLE");
  });

  it("maps an unexpected payload shape to ACTIVITY_UNAVAILABLE", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ rows: [] }), { status: 200 }),
      );
    const res = await getAuditLog.handler({}, ctxWith(get, "admin"));
    expectError(res, "ACTIVITY_UNAVAILABLE");
  });
});

describe("get_audit_log — tool metadata", () => {
  it("is named get_audit_log and is Tier-1 (no write, no confirm)", () => {
    expect(getAuditLog.name).toBe("get_audit_log");
    expect(getAuditLog.requiresWrite).toBe(false);
    expect(getAuditLog.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema with the documented optional filters", () => {
    const schema = getAuditLog.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<
        string,
        {
          type?: string;
          enum?: readonly string[];
          minimum?: number;
          maximum?: number;
          maxLength?: number;
        }
      >;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "kind",
      "actor",
      "hours",
      "q",
      "limit",
    ]);
    // The kind enum mirrors routes/activity.ts ACTIVITY_KINDS verbatim.
    expect(schema.properties?.kind?.enum).toEqual(ACTIVITY_KINDS);
    expect(schema.properties?.actor?.enum).toEqual(["user", "ai", "system"]);
    expect(schema.properties?.hours).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 720,
    });
    expect(schema.properties?.q).toMatchObject({ type: "string", maxLength: 200 });
    expect(schema.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
  });
});
