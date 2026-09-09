/**
 * WARP-1443 — `list_threat_events` LLM tool.
 *
 * Role-gated (owner/admin only, WARP-845 ladder) read over the
 * activity log's `network` + `auth` kinds, curated to security-relevant
 * severities (warn/error) — including the WARP-268 egress-anomaly rows.
 * Tier-1 read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import listThreatEvents from "../../../src/handlers/network/list-threat-events.js";
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

// GET /api/activity item rows (activity.ts list route shape).
// The WARP-268 egress-anomaly row: kind network, severity warn,
// sub = the anomaly discriminator, refs = the collector payload.
const NETWORK_ITEMS = [
  {
    id: "9",
    at: "2026-07-20T11:00:00.000Z",
    severity: "warn",
    sourceIcon: "wifi",
    what: "Egress anomaly: nextcloud → tracker.example.com:443",
    sub: "unlisted_destination",
    kind: "network",
    refs: {
      kind: "unlisted_destination",
      service: "nextcloud",
      dst: "tracker.example.com",
      port: 443,
      source: "egress-audit-collector",
    },
    actorType: "system",
    actorId: null,
  },
  {
    id: "8",
    at: "2026-07-20T10:00:00.000Z",
    severity: "info", // routine row — must be curated OUT
    sourceIcon: "wifi",
    what: "Device joined the network",
    sub: "pixel-9",
    kind: "network",
    refs: null,
    actorType: "system",
    actorId: null,
  },
];

const AUTH_ITEMS = [
  {
    id: "7",
    at: "2026-07-20T11:30:00.000Z",
    severity: "error",
    sourceIcon: "shield-off",
    what: "Failed login for admin",
    sub: "POST /api/auth/login",
    kind: "auth",
    refs: { reason: "bad-password" },
    actorType: "anonymous",
    actorId: null,
  },
  {
    id: "6",
    at: "2026-07-20T09:00:00.000Z",
    severity: "warn",
    sourceIcon: "shield-off",
    what: "Access denied",
    sub: "GET /api/activity",
    kind: "auth",
    refs: { role: "guest" },
    actorType: "user",
    actorId: "u-1",
  },
];

/** Dispatches on params.kind so one mock serves both calls. */
function routedGet(opts?: {
  networkStatus?: number;
  authStatus?: number;
}): Mock {
  return vi
    .fn()
    .mockImplementation(
      async (_path: string, o?: { params?: Record<string, unknown> }) => {
        const kind = o?.params?.kind;
        if (kind === "network") {
          return new Response(
            JSON.stringify({ items: NETWORK_ITEMS, nextCursor: null }),
            { status: opts?.networkStatus ?? 200 },
          );
        }
        return new Response(
          JSON.stringify({ items: AUTH_ITEMS, nextCursor: null }),
          { status: opts?.authStatus ?? 200 },
        );
      },
    );
}

function expectError(
  res: Awaited<ReturnType<typeof listThreatEvents.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("list_threat_events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("role gate (WARP-845 / WARP-1443)", () => {
    it.each([undefined, "guest", "family", "service"] as const)(
      "role %s → FORBIDDEN with NO HTTP call",
      async (role) => {
        const get = vi.fn();
        const res = await listThreatEvents.handler({}, ctxWith(get, role));
        expectError(res, "FORBIDDEN");
        if (!res.ok) {
          expect(res.error.message).toBe(
            "threat events are visible to owners and admins only",
          );
        }
        expect(get).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin"] as const)("role %s passes", async (role) => {
      const get = routedGet();
      const res = await listThreatEvents.handler({}, ctxWith(get, role));
      expect(res.ok).toBe(true);
    });
  });

  it("queries both kinds, curates to warn/error, merges sorted by time desc", async () => {
    const get = routedGet();
    const res = await listThreatEvents.handler({}, ctxWith(get, "admin"));

    // One /api/activity call per kind, exact path + params.
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "/api/activity", {
      params: { kind: "network", from: "2026-07-19T12:00:00.000Z", limit: 200 },
      headers: { Accept: "application/json" },
    });
    expect(get).toHaveBeenNthCalledWith(2, "/api/activity", {
      params: { kind: "auth", from: "2026-07-19T12:00:00.000Z", limit: 200 },
      headers: { Accept: "application/json" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "list_threat_events",
        events: [
          {
            at: "2026-07-20T11:30:00.000Z",
            kind: "auth",
            severity: "error",
            summary: "Failed login for admin",
            sub: "POST /api/auth/login",
            refs: { reason: "bad-password" },
          },
          {
            at: "2026-07-20T11:00:00.000Z",
            kind: "network",
            severity: "warn",
            summary: "Egress anomaly: nextcloud → tracker.example.com:443",
            sub: "unlisted_destination",
            refs: {
              kind: "unlisted_destination",
              service: "nextcloud",
              dst: "tracker.example.com",
              port: 443,
              source: "egress-audit-collector",
            },
          },
          {
            at: "2026-07-20T09:00:00.000Z",
            kind: "auth",
            severity: "warn",
            summary: "Access denied",
            sub: "GET /api/activity",
            refs: { role: "guest" },
          },
        ],
        count: 3,
        windowHours: 24,
      });
    }
  });

  it("honors hours in the from bound and windowHours", async () => {
    const get = routedGet();
    const res = await listThreatEvents.handler(
      { hours: 48 },
      ctxWith(get, "owner"),
    );
    expect(get).toHaveBeenNthCalledWith(1, "/api/activity", {
      params: { kind: "network", from: "2026-07-18T12:00:00.000Z", limit: 200 },
      headers: { Accept: "application/json" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { windowHours: number }).windowHours).toBe(48);
    }
  });

  it("slices to limit after the merge (newest kept)", async () => {
    const get = routedGet();
    const res = await listThreatEvents.handler(
      { limit: 2 },
      ctxWith(get, "admin"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { events: Array<{ at: string }>; count: number };
      expect(data.count).toBe(2);
      expect(data.events.map((e) => e.at)).toEqual([
        "2026-07-20T11:30:00.000Z",
        "2026-07-20T11:00:00.000Z",
      ]);
    }
  });

  it("maps a non-OK network-kind response to ACTIVITY_UNAVAILABLE", async () => {
    const get = routedGet({ networkStatus: 502 });
    const res = await listThreatEvents.handler({}, ctxWith(get, "admin"));
    expectError(res, "ACTIVITY_UNAVAILABLE");
  });

  it("maps a non-OK auth-kind response to ACTIVITY_UNAVAILABLE", async () => {
    const get = routedGet({ authStatus: 500 });
    const res = await listThreatEvents.handler({}, ctxWith(get, "admin"));
    expectError(res, "ACTIVITY_UNAVAILABLE");
  });

  it("maps a thrown fetch error to ACTIVITY_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await listThreatEvents.handler({}, ctxWith(get, "owner"));
    expectError(res, "ACTIVITY_UNAVAILABLE");
  });

  it.each([
    ["hours below range", { hours: 0 }],
    ["hours above range", { hours: 169 }],
    ["non-integer hours", { hours: 1.5 }],
    ["non-numeric hours", { hours: "24" }],
    ["limit below range", { limit: 0 }],
    ["limit above range", { limit: 101 }],
    ["non-numeric limit", { limit: "50" }],
  ])("rejects %s with INVALID_ARGS (no HTTP call)", async (_label, args) => {
    const get = vi.fn();
    const res = await listThreatEvents.handler(
      args as Record<string, unknown>,
      ctxWith(get, "admin"),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("list_threat_events — tool metadata", () => {
  it("is named list_threat_events and is Tier-1 (no write, no confirm)", () => {
    expect(listThreatEvents.name).toBe("list_threat_events");
    expect(listThreatEvents.requiresWrite).toBe(false);
    expect(listThreatEvents.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema with optional hours + limit", () => {
    const schema = listThreatEvents.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<
        string,
        { type?: string; minimum?: number; maximum?: number }
      >;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual(["hours", "limit"]);
    expect(schema.properties?.hours).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 168,
    });
    expect(schema.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
  });
});
