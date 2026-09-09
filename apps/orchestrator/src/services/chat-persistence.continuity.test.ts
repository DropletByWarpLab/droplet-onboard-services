/**
 * WARP-1921 — `getConversationToolNames`, the cross-turn input to the
 * agent-budgets §3 continuity rule.
 *
 * Why it exists at all: `chatRequestSchema` declares only
 * `{role, content, tool_call_id}`, so zod strips `tool_calls` off every
 * replayed assistant message. Continuity therefore only ever worked within a
 * single turn's iterations — the gap the spec's §6 outcome named as the
 * prerequisite to shipping `TOOL_SELECTION_MODE`. This reads the persisted
 * trace instead, so it is authoritative and cannot be spoofed by a client.
 *
 * The Prisma mock below deliberately ENFORCES each filter the production
 * query declares (session.userId scoping, role, toolCalls non-null) rather
 * than returning a canned list. That is what makes these tests able to fail:
 * drop a filter in the service and the corresponding case goes red, instead
 * of the mock quietly papering over it.
 */
import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { ChatPersistenceService } from "./chat-persistence.service.js";

interface Row {
  sessionId: string;
  userId: string;
  role: string;
  toolCalls: unknown;
  createdAt: Date;
}

function makePrisma(rows: Row[]) {
  const findMany = vi.fn(
    async (args: {
      where: {
        sessionId: string;
        session?: { userId: string };
        role?: string;
        toolCalls?: unknown;
      };
      select?: unknown;
      orderBy?: unknown;
      take?: number;
    }) => {
      let out = rows.filter((r) => r.sessionId === args.where.sessionId);
      // Enforce ownership only if the query actually asked for it.
      if (args.where.session?.userId !== undefined) {
        out = out.filter((r) => r.userId === args.where.session!.userId);
      }
      if (args.where.role !== undefined) {
        out = out.filter((r) => r.role === args.where.role);
      }
      // Model Prisma's `{ not: DbNull }` JSON filter.
      const tc = args.where.toolCalls as { not?: unknown } | undefined;
      if (tc && "not" in tc && tc.not === Prisma.DbNull) {
        out = out.filter((r) => r.toolCalls !== null && r.toolCalls !== undefined);
      }
      out = out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof args.take === "number") out = out.slice(0, args.take);
      return out.map((r) => ({ toolCalls: r.toolCalls }));
    },
  );
  return { prisma: { chatMessage: { findMany } }, findMany };
}

const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);
const call = (name: string) => ({ id: `c-${name}`, name, args: {} });

describe("WARP-1921 — getConversationToolNames (cross-turn continuity)", () => {
  it("returns the distinct tool names used across earlier turns", async () => {
    const { prisma } = makePrisma([
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: [call("list_cameras")], createdAt: at(1) },
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: [call("list_camera_events"), call("list_cameras")], createdAt: at(2) },
    ]);
    const svc = new ChatPersistenceService(prisma as never);

    const names = await svc.getConversationToolNames("s1", "u1");
    expect(names.sort()).toEqual(["list_camera_events", "list_cameras"]);
  });

  it("does not leak another user's conversation", async () => {
    // A guessed conversation id must reveal nothing — same rule as
    // getConversationForUser. Drop the `session: { userId }` filter in the
    // service and this goes red.
    const { prisma } = makePrisma([
      { sessionId: "s1", userId: "someone-else", role: "assistant", toolCalls: [call("list_cameras")], createdAt: at(1) },
    ]);
    const svc = new ChatPersistenceService(prisma as never);

    expect(await svc.getConversationToolNames("s1", "u1")).toEqual([]);
  });

  it("ignores non-assistant rows", async () => {
    const { prisma } = makePrisma([
      { sessionId: "s1", userId: "u1", role: "user", toolCalls: [call("should_not_appear")], createdAt: at(1) },
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: [call("list_cameras")], createdAt: at(2) },
    ]);
    const svc = new ChatPersistenceService(prisma as never);

    expect(await svc.getConversationToolNames("s1", "u1")).toEqual(["list_cameras"]);
  });

  it("skips turns with no tool calls, and survives malformed payloads", async () => {
    // Persisted JSON is schemaless: an older row, a partial write, or a
    // hand-edited record must not throw inside a chat turn.
    const { prisma } = makePrisma([
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: null, createdAt: at(1) },
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: "not-an-array", createdAt: at(2) },
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: [null, { name: 42 }, { nope: true }, { name: "" }], createdAt: at(3) },
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: [call("list_clips")], createdAt: at(4) },
    ]);
    const svc = new ChatPersistenceService(prisma as never);

    expect(await svc.getConversationToolNames("s1", "u1")).toEqual(["list_clips"]);
  });

  it("bounds the read on a long thread and takes the most recent turns", async () => {
    const rows: Row[] = Array.from({ length: 80 }, (_, i) => ({
      sessionId: "s1",
      userId: "u1",
      role: "assistant",
      toolCalls: [call(`tool_${i}`)],
      createdAt: at(i),
    }));
    const { prisma, findMany } = makePrisma(rows);
    const svc = new ChatPersistenceService(prisma as never);

    const names = await svc.getConversationToolNames("s1", "u1");
    expect(findMany.mock.calls[0][0].take).toBe(50);
    expect(names).toHaveLength(50);
    // Newest-first: tool_79 is in, tool_0 fell off the end.
    expect(names).toContain("tool_79");
    expect(names).not.toContain("tool_0");
  });

  it("returns [] for a conversation with no history", async () => {
    const { prisma } = makePrisma([]);
    const svc = new ChatPersistenceService(prisma as never);
    expect(await svc.getConversationToolNames("nope", "u1")).toEqual([]);
  });
});

/**
 * WARP-2484 — the JSON-null sentinel has to survive the `@prisma/client` mock.
 *
 * `getConversationToolNames` filters with Prisma's canonical "JSON column is
 * not SQL NULL" predicate, `{ not: Prisma.DbNull }`. While the shared mock at
 * `src/__tests__/setup.ts` exported no `DbNull`, `Prisma.DbNull` resolved to
 * `undefined` under test and the service issued `{ not: undefined }` — which
 * Prisma treats as no filter at all. Every suite therefore exercised a
 * DIFFERENT query from the one production runs, and the divergence was
 * invisible precisely because `undefined === undefined` made the identity
 * check inside `makePrisma` above vacuously true.
 *
 * These assertions are identity-based AND vacuity-guarded. The
 * `not.toBeUndefined()` line is the one that makes the mutation
 * `DbNull: undefined` in setup.ts turn this red; without it the mutation
 * stays green, which is the whole defect being fixed.
 */
describe("WARP-2484 — the toolCalls filter carries the real DbNull sentinel", () => {
  it("passes `{ not: Prisma.DbNull }` by identity, never `{ not: undefined }`", async () => {
    const { prisma, findMany } = makePrisma([
      { sessionId: "s1", userId: "u1", role: "assistant", toolCalls: [call("list_cameras")], createdAt: at(1) },
    ]);
    const svc = new ChatPersistenceService(prisma as never);

    await svc.getConversationToolNames("s1", "u1");

    const where = findMany.mock.calls[0][0].where as {
      toolCalls?: { not?: unknown };
    };

    // The clause must be present at all — dropping it is one regression.
    expect(where.toolCalls).toBeDefined();
    // …and its operand must be a real value. `{ not: undefined }` is not a
    // weaker filter, it is a different query: Prisma omits the clause.
    expect(where.toolCalls?.not).not.toBeUndefined();
    // Identity, not shape: DbNull, JsonNull and AnyNull are three distinct
    // sentinels that mean three different things to Prisma's JSON filters.
    expect(where.toolCalls?.not).toBe(Prisma.DbNull);
  });

  it("exposes DbNull, JsonNull and AnyNull as three distinct sentinels", () => {
    // A mock that aliased all three onto one object (or onto `undefined`)
    // would let `Prisma.JsonNull` silently stand in for `Prisma.DbNull` — the
    // write paths in activity.service.ts and routes/cameras.ts rely on the
    // two being told apart.
    for (const sentinel of [Prisma.DbNull, Prisma.JsonNull, Prisma.AnyNull]) {
      expect(sentinel).not.toBeUndefined();
      expect(sentinel).not.toBeNull();
    }
    expect(Prisma.DbNull).not.toBe(Prisma.JsonNull);
    expect(Prisma.DbNull).not.toBe(Prisma.AnyNull);
    expect(Prisma.JsonNull).not.toBe(Prisma.AnyNull);
  });
});
