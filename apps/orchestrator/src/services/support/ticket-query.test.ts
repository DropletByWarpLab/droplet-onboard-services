/**
 * WARP-3528 — the pure half of reading tickets, and the constants a desk is
 * seeded from. The predicates are asserted as objects here and proven against a
 * real Postgres in __tests__/support-desk.pg.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  INVALID_CURSOR,
  OPEN_GROUPS,
  afterCursor,
  clampLimit,
  decodeCursor,
  encodeCursor,
  isTerminalGroup,
  isUuid,
  listWhere,
  parseTicketKey,
  queueWhere,
  searchWhere,
  ticketBaseWhere,
} from "./ticket-query.js";
import {
  DESK_LABELS,
  DESK_STATES,
  SOLVED_RECENT_DAYS,
  SUPPORT_QUEUES,
  TICKET_TYPE_LABELS,
} from "./support.types.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");

describe("ticket keys", () => {
  it("parses a key in any case and refuses everything else", () => {
    expect(parseTicketKey("SUP-12")).toEqual({ identifier: "SUP", sequenceId: 12 });
    expect(parseTicketKey(" sup-12 ")).toEqual({ identifier: "SUP", sequenceId: 12 });
    expect(parseTicketKey("W28SA-1")).toEqual({ identifier: "W28SA", sequenceId: 1 });
    for (const bad of ["SUP", "SUP-", "-12", "SUP-0", "SUP-1x", "TOOLONGKEYXX-1", "SUP-12-3", ""]) {
      expect(parseTicketKey(bad), bad).toBeNull();
    }
  });

  it("tells a work item uuid from a key", () => {
    expect(isUuid("3f2c1b7e-9a4d-4c11-8f3e-0a1b2c3d4e5f")).toBe(true);
    expect(isUuid("SUP-12")).toBe(false);
  });
});

describe("queues read columns, never names", () => {
  it("names exactly the six queues the rail shows, in order", () => {
    expect([...SUPPORT_QUEUES]).toEqual(["unassigned", "mine", "open", "pending", "solved_recent", "all"]);
  });

  it("open and pending differ only by the SLA clock", () => {
    expect(queueWhere("open", "u1", NOW)).toEqual({
      state: { group: { in: [...OPEN_GROUPS] }, slaClock: "RUNNING" },
    });
    expect(queueWhere("pending", "u1", NOW)).toEqual({
      state: { group: { in: [...OPEN_GROUPS] }, slaClock: "PAUSED" },
    });
  });

  it("unassigned and mine are open work filtered by the assignee set", () => {
    expect(queueWhere("unassigned", "u1", NOW)).toEqual({
      state: { group: { in: [...OPEN_GROUPS] } },
      assignees: { none: {} },
    });
    expect(queueWhere("mine", "u1", NOW)).toEqual({
      state: { group: { in: [...OPEN_GROUPS] } },
      assignees: { some: { userId: "u1" } },
    });
  });

  it("solved_recent is the completed groups since the cut-off, from the ticket's own clock", () => {
    const where = queueWhere("solved_recent", "u1", NOW) as {
      state: { group: { in: string[] } };
      ticket: { is: { solvedAt: { gte: Date } } };
    };
    expect(where.state.group.in).toEqual(["completed", "cancelled"]);
    expect(where.ticket.is.solvedAt.gte.getTime()).toBe(
      NOW.getTime() - SOLVED_RECENT_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it("all adds nothing", () => {
    expect(queueWhere("all", "u1", NOW)).toEqual({});
  });

  it("never mentions a state NAME", () => {
    for (const q of SUPPORT_QUEUES) {
      expect(JSON.stringify(queueWhere(q, "u1", NOW))).not.toMatch(/"name"/);
    }
  });

  it("knows which groups end the work", () => {
    expect(isTerminalGroup("completed")).toBe(true);
    expect(isTerminalGroup("cancelled")).toBe(true);
    for (const g of OPEN_GROUPS) expect(isTerminalGroup(g)).toBe(false);
    expect(isTerminalGroup(null)).toBe(false);
  });
});

describe("the base filter keeps projects out", () => {
  it("requires a desk project, a live item and a ticket row", () => {
    expect(ticketBaseWhere()).toEqual({
      isArchived: false,
      ticket: { isNot: null },
      project: { kind: "SERVICE_DESK", isArchived: false },
    });
    expect(ticketBaseWhere("d1").project).toEqual({ kind: "SERVICE_DESK", isArchived: false, id: "d1" });
  });

  it("listWhere ANDs base, queue and the extra filters — default queue open", () => {
    const where = listWhere({ stateId: "s1", priority: "high", assigneeId: "u2", q: " dana " }, "u1", NOW);
    const parts = (where as { AND: unknown[] }).AND;
    expect(parts[0]).toEqual(ticketBaseWhere());
    expect(parts[1]).toEqual(queueWhere("open", "u1", NOW));
    expect(parts).toContainEqual({ stateId: "s1" });
    expect(parts).toContainEqual({ priority: "high" });
    expect(parts).toContainEqual({ assignees: { some: { userId: "u2" } } });
    expect(parts).toContainEqual(searchWhere(" dana "));
  });

  it("search adds the exact key arm only when the text is a key", () => {
    const withKey = (searchWhere("sup-3") as { OR: unknown[] }).OR;
    const without = (searchWhere("printer") as { OR: unknown[] }).OR;
    expect(withKey).toHaveLength(without.length + 1);
    expect(withKey).toContainEqual({
      sequenceId: 3,
      project: { identifier: { equals: "SUP", mode: "insensitive" } },
    });
  });
});

describe("paging", () => {
  it("round-trips a cursor and refuses garbage", () => {
    const row = { updatedAt: new Date("2026-10-04T10:00:00.123Z"), id: "abc" };
    const back = decodeCursor(encodeCursor(row));
    expect(back.id).toBe("abc");
    expect(back.updatedAt.getTime()).toBe(row.updatedAt.getTime());
    for (const bad of ["", "not-base64-json", Buffer.from("{}").toString("base64url"), Buffer.from('{"u":"x","i":"a"}').toString("base64url")]) {
      expect(() => decodeCursor(bad), bad).toThrow(INVALID_CURSOR);
    }
  });

  it("continues strictly after the cursor in (updatedAt desc, id desc) order", () => {
    const c = { updatedAt: new Date("2026-10-04T10:00:00.000Z"), id: "m" };
    expect(afterCursor(c)).toEqual({
      OR: [{ updatedAt: { lt: c.updatedAt } }, { updatedAt: c.updatedAt, id: { lt: "m" } }],
    });
  });

  it("clamps the limit to 1..200, default 50", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10_000)).toBe(200);
    expect(clampLimit(25.9)).toBe(25);
    expect(clampLimit(Number.NaN)).toBe(50);
  });
});

describe("what a new desk is seeded with (ADR-069 §5)", () => {
  it("has the six states, mapped onto the existing groups, with one default", () => {
    expect(DESK_STATES.map((s) => [s.name, s.group, s.slaClock, s.isDefault])).toEqual([
      ["New", "unstarted", "RUNNING", true],
      ["Open", "started", "RUNNING", false],
      ["Pending", "started", "PAUSED", false],
      ["On hold", "started", "PAUSED", false],
      ["Solved", "completed", "STOPPED", false],
      ["Closed", "completed", "STOPPED", false],
    ]);
    expect(DESK_STATES.filter((s) => s.isDefault)).toHaveLength(1);
    expect(DESK_STATES.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("seeds the four type labels, and flags exactly those as the type", () => {
    expect(DESK_LABELS.map((l) => l.name)).toEqual(["Question", "Incident", "Problem", "Task"]);
    expect([...TICKET_TYPE_LABELS]).toEqual(DESK_LABELS.map((l) => l.name));
  });
});
