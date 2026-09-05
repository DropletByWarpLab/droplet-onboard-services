/**
 * WARP-2177 — an in-memory `AgentRun` table for the worker's unit suites.
 *
 * Implements exactly the Prisma surface `agent-run-worker.service.ts` uses:
 * `agentRun.{create,findMany,findUnique,updateMany}`, `user.findUnique` and
 * an interactive `$transaction` that hands the same object back. The
 * `where` matcher understands the operators the worker actually writes —
 * equality, `null`, `{ in }`, `{ lt | lte }` on dates — and `data`
 * understands `{ increment }`. Anything else throws, so a new query shape
 * in the service fails loudly here instead of silently matching nothing.
 *
 * `failOn` is the crash seam: a predicate over `(op, args)` that, when it
 * returns true, makes that call reject — the DB "going away" mid-write is
 * how the suites simulate a worker dying between two checkpoints.
 */
import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

export interface AgentRunRow {
  id: string;
  userId: string;
  sessionId: string | null;
  goal: string;
  model: string;
  status: string;
  runAfter: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  deadlineAt: Date | null;
  attempts: number;
  maxIter: number;
  iteration: number;
  messages: unknown;
  trace: unknown;
  result: string | null;
  stopReason: string | null;
  error: string | null;
  /** WARP-2179 — the parked Tier-2 call. */
  pendingTool: string | null;
  pendingBindingHash: string | null;
  pendingArgs: unknown;
  pendingToolCallId: string | null;
  parkedAt: Date | null;
  pendingDecision: string | null;
  pendingDecidedAt: Date | null;
  pendingDecidedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MockOp = "create" | "findMany" | "findUnique" | "updateMany";

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const actual = row[key];
    if (cond === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (typeof cond === "object" && cond !== null) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) {
        if (!(c.in as unknown[]).includes(actual)) return false;
        continue;
      }
      if ("lt" in c || "lte" in c) {
        const a = actual instanceof Date ? actual.getTime() : Number.NaN;
        if (Number.isNaN(a)) return false;
        if ("lt" in c && !(a < (c.lt as Date).getTime())) return false;
        if ("lte" in c && !(a <= (c.lte as Date).getTime())) return false;
        continue;
      }
      throw new Error(`agent-run-prisma-mock: unsupported where operator on ${key}: ${JSON.stringify(cond)}`);
    }
    if (actual !== cond) return false;
  }
  return true;
}

function applyData(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    const ctor = value && typeof value === "object" ? (value as object).constructor?.name : undefined;
    if (ctor === "DbNull" || ctor === "JsonNull" || ctor === "AnyNull") {
      // Prisma's JSON-null sentinels (WARP-2484 mirrors them in setup.ts):
      // `Prisma.DbNull` on a nullable Json column is SQL NULL.
      row[key] = null;
    } else if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as object)) {
      row[key] = (row[key] as number) + ((value as { increment: number }).increment ?? 0);
    } else if (value && typeof value === "object" && !(value instanceof Date)) {
      // A Json column is SERIALISED on write. Storing the caller's array by
      // reference would let a still-running loop keep appending to a
      // "checkpoint" after it was taken — which is exactly the aliasing a
      // real database cannot have, and exactly what a crash/resume test must
      // not be fooled by.
      row[key] = JSON.parse(JSON.stringify(value));
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = new Date();
}

/** Prisma `orderBy` — an object or an array of them — as a comparator. */
function comparator(orderBy: unknown): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  const clauses = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return (a, b) => {
    for (const clause of clauses) {
      for (const [field, dir] of Object.entries(clause)) {
        const av = a[field];
        const bv = b[field];
        const an = av instanceof Date ? av.getTime() : (av as number | string);
        const bn = bv instanceof Date ? bv.getTime() : (bv as number | string);
        if (an === bn) continue;
        const less = an < bn ? -1 : 1;
        return dir === "desc" ? -less : less;
      }
    }
    return 0;
  };
}

function pick(row: Record<string, unknown>, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

export interface AgentRunPrismaMockOptions {
  users?: Array<{ id: string; username: string; role: string }>;
  now?: () => Date;
}

export function createAgentRunPrismaMock(opts: AgentRunPrismaMockOptions = {}) {
  const rows: AgentRunRow[] = [];
  const users = new Map((opts.users ?? []).map((u) => [u.id, u]));
  const now = opts.now ?? (() => new Date());
  let seq = 0;
  /** Crash seam — see the module doc. */
  let failOn: ((op: MockOp, args: Record<string, unknown>) => boolean) | null = null;

  const guard = (op: MockOp, args: Record<string, unknown>) => {
    if (failOn && failOn(op, args)) throw new Error(`simulated DB failure on ${op}`);
  };

  const agentRun = {
    create: vi.fn(async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      guard("create", args);
      const row: AgentRunRow = {
        id: `run-${++seq}`,
        userId: args.data.userId as string,
        sessionId: (args.data.sessionId as string | null) ?? null,
        goal: args.data.goal as string,
        model: args.data.model as string,
        status: "queued",
        runAfter: (args.data.runAfter as Date | undefined) ?? now(),
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        startedAt: null,
        endedAt: null,
        deadlineAt: null,
        attempts: 0,
        maxIter: args.data.maxIter as number,
        iteration: 0,
        messages: null,
        trace: null,
        result: null,
        stopReason: null,
        error: null,
        pendingTool: null,
        pendingBindingHash: null,
        pendingArgs: null,
        pendingToolCallId: null,
        parkedAt: null,
        pendingDecision: null,
        pendingDecidedAt: null,
        pendingDecidedBy: null,
        createdAt: now(),
        updatedAt: now(),
      };
      rows.push(row);
      return pick(row as unknown as Record<string, unknown>, args.select);
    }),
    findMany: vi.fn(
      async (args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
        take?: number;
        orderBy?: unknown;
      }) => {
        guard("findMany", args);
        let out = rows.filter((r) => matches(r as unknown as Record<string, unknown>, args.where));
        out = [...out].sort(
          args.orderBy
            ? (a, b) => comparator(args.orderBy)(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>)
            : (a, b) => a.runAfter.getTime() - b.runAfter.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
        );
        if (args.take) out = out.slice(0, args.take);
        return out.map((r) => pick(r as unknown as Record<string, unknown>, args.select));
      },
    ),
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      guard("findUnique", args);
      const row = rows.find((r) => r.id === args.where.id);
      return row ? pick(row as unknown as Record<string, unknown>, args.select) : null;
    }),
    updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      guard("updateMany", args);
      let count = 0;
      for (const row of rows) {
        if (matches(row as unknown as Record<string, unknown>, args.where)) {
          applyData(row as unknown as Record<string, unknown>, args.data);
          count += 1;
        }
      }
      return { count };
    }),
  };

  const user = {
    findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const u = users.get(args.where.id);
      return u ? pick(u as unknown as Record<string, unknown>, args.select) : null;
    }),
    findFirst: vi.fn(async (args: { where: { username?: string }; select?: Record<string, boolean> }) => {
      const u = [...users.values()].find((x) => x.username === args.where.username);
      return u ? pick(u as unknown as Record<string, unknown>, args.select) : null;
    }),
  };

  /** WARP-2180 — recurring runs. */
  const schedules: Array<Record<string, unknown>> = [];
  let scheduleSeq = 0;
  const agentRunSchedule = {
    create: vi.fn(async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const row = {
        id: `sched-${++scheduleSeq}`,
        timezone: "UTC",
        enabled: true,
        lastFiredAt: null,
        createdAt: now(),
        updatedAt: now(),
        ...args.data,
      };
      schedules.push(row);
      return pick(row, args.select);
    }),
    findMany: vi.fn(async (args: { where: Record<string, unknown>; take?: number; orderBy?: unknown }) => {
      const out = schedules.filter((r) => matches(r, args.where)).sort(comparator(args.orderBy));
      return args.take ? out.slice(0, args.take) : out;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = schedules.find((r) => r.id === args.where.id);
      if (!row) throw new Error("no schedule");
      applyData(row, args.data);
      return row;
    }),
    deleteMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      let count = 0;
      for (let i = schedules.length - 1; i >= 0; i--) {
        if (matches(schedules[i]!, args.where)) {
          schedules.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    }),
  };

  const prisma = {
    agentRun,
    agentRunSchedule,
    user,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  return {
    /** Typed as the real client for the service, and as the mock for tests. */
    prisma: prisma as unknown as PrismaClient & typeof prisma,
    rows,
    schedules,
    row: (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error(`no row ${id}`);
      return r;
    },
    setFailOn(fn: typeof failOn) {
      failOn = fn;
    },
  };
}
