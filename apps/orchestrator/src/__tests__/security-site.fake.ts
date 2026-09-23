/**
 * WARP-2977 P2b — an in-memory stand-in for the Prisma delegates the site
 * mode and opening hours use, shared by security-mode.service.test.ts and
 * security-site.routes.test.ts. Not a test file itself.
 *
 * It models only what the mocked lane can honestly model: CAS by `version`
 * (`updateMany` returns count 0 on a mismatch), `{increment}`, upserts, the
 * date-range filters the hours reader issues, `skipDuplicates` on dedupeKey,
 * and ROLLBACK — `$transaction` snapshots the tables and restores them when
 * the callback throws, so "a failed audit leaves nothing changed" is a real
 * assertion here. Concurrency and the CHECK constraints are the pg lane's
 * job (security-mode.pg.test.ts).
 *
 * `log` records every write (and each in-tx audit, via `noteAudit`) in order,
 * so a test can pin "the audit is LAST" and "no audit on a lost CAS".
 */
import { vi } from "vitest";

export interface FakeHours {
  id: string;
  state: "not_set" | "set";
  timezone: string | null;
  version: number;
  updatedById: string | null;
  updatedAt: Date;
}

export interface FakeMode {
  id: string;
  mode: "open" | "closed" | "away";
  modeSource: "schedule" | "manual";
  manualEnd: "none" | "next_opening" | "at_time" | "until_changed";
  manualUntil: Date | null;
  setById: string | null;
  setAt: Date;
  version: number;
  updatedAt: Date;
}

export interface FakeDay {
  weekday: number;
  kind: "closed" | "open_all_day" | "hours";
  opensMin: number | null;
  closesMin: number | null;
  updatedAt: Date;
}

export interface FakeException {
  date: string;
  kind: "closed" | "open_all_day" | "hours";
  opensMin: number | null;
  closesMin: number | null;
  note: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTables {
  hours: FakeHours | null;
  mode: FakeMode | null;
  days: FakeDay[];
  exceptions: FakeException[];
  events: Array<Record<string, unknown>>;
}

export interface FakeWorld extends FakeTables {
  users: Record<string, { displayName: string; username: string }>;
  workspaceTz: string | null;
  typicalDay: string;
  log: string[];
}

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

export function defaultHours(over: Partial<FakeHours> = {}): FakeHours {
  return { id: "singleton", state: "not_set", timezone: null, version: 0, updatedById: null, updatedAt: EPOCH, ...over };
}

export function defaultMode(over: Partial<FakeMode> = {}): FakeMode {
  return {
    id: "singleton",
    mode: "open",
    modeSource: "schedule",
    manualEnd: "none",
    manualUntil: null,
    setById: null,
    setAt: EPOCH,
    version: 0,
    updatedAt: EPOCH,
    ...over,
  };
}

/** Seven weekday rows from 'HH:MM-HH:MM' | 'closed' | 'all' strings, Monday first. */
export function weekRows(spec: readonly string[]): FakeDay[] {
  return spec.map((s, i) => {
    if (s === "closed") return { weekday: i + 1, kind: "closed", opensMin: null, closesMin: null, updatedAt: EPOCH };
    if (s === "all") return { weekday: i + 1, kind: "open_all_day", opensMin: null, closesMin: null, updatedAt: EPOCH };
    const [o, c] = s.split("-");
    const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    return { weekday: i + 1, kind: "hours", opensMin: m(o!), closesMin: m(c!), updatedAt: EPOCH };
  });
}

export function newWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    hours: null,
    mode: null,
    days: [],
    exceptions: [],
    events: [],
    users: {},
    workspaceTz: null,
    typicalDay: "",
    log: [],
    ...over,
  };
}

function apply<T extends object>(target: T, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === "object" && !(v instanceof Date) && "increment" in (v as object)) {
      (target as Record<string, unknown>)[k] = ((target as Record<string, number>)[k] ?? 0) + (v as { increment: number }).increment;
    } else {
      (target as Record<string, unknown>)[k] = v;
    }
  }
  (target as Record<string, unknown>).updatedAt = new Date();
}

function matches(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
}

function dateFilter(where: { date?: unknown } | undefined): (date: string) => boolean {
  const f = where?.date;
  if (f === undefined) return () => true;
  if (typeof f === "string") return (d) => d === f;
  const r = f as { gte?: string; lte?: string };
  return (d) => (r.gte === undefined || d >= r.gte) && (r.lte === undefined || d <= r.lte);
}

const copy = <T>(v: T): T => structuredClone(v);

/** A PrismaClient-shaped fake over `w`. Cast it to PrismaClient at the call site. */
export function fakePrisma(w: FakeWorld) {
  const delegates = {
    securitySiteHours: {
      upsert: vi.fn(async (a: { create: Partial<FakeHours>; update: Record<string, unknown> }) => {
        if (!w.hours) {
          w.hours = defaultHours(a.create);
          w.log.push("hours.create");
        } else if (Object.keys(a.update).length > 0) {
          apply(w.hours, a.update);
          w.log.push("hours.update");
        }
        return copy(w.hours);
      }),
      createMany: vi.fn(async (a: { data: Array<Partial<FakeHours>>; skipDuplicates?: boolean }) => {
        if (w.hours) {
          if (!a.skipDuplicates) throw Object.assign(new Error("unique"), { code: "P2002" });
          return { count: 0 };
        }
        w.hours = defaultHours(a.data[0]);
        w.log.push("hours.create");
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => (w.hours ? copy(w.hours) : null)),
      findUniqueOrThrow: vi.fn(async () => {
        if (!w.hours) throw new Error("no hours row");
        return copy(w.hours);
      }),
      updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!w.hours || !matches(w.hours, a.where)) return { count: 0 };
        apply(w.hours, a.data);
        w.log.push("hours.cas");
        return { count: 1 };
      }),
    },
    securityModeState: {
      upsert: vi.fn(async (a: { create: Partial<FakeMode>; update: Record<string, unknown> }) => {
        if (!w.mode) {
          w.mode = defaultMode({ ...a.create, setAt: new Date() });
          w.log.push("mode.create");
        } else if (Object.keys(a.update).length > 0) {
          apply(w.mode, a.update);
          w.log.push("mode.bump");
        }
        return copy(w.mode);
      }),
      createMany: vi.fn(async (a: { data: Array<Partial<FakeMode>>; skipDuplicates?: boolean }) => {
        if (w.mode) {
          if (!a.skipDuplicates) throw Object.assign(new Error("unique"), { code: "P2002" });
          return { count: 0 };
        }
        w.mode = defaultMode({ ...a.data[0], setAt: new Date() });
        w.log.push("mode.create");
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => (w.mode ? copy(w.mode) : null)),
      findUniqueOrThrow: vi.fn(async () => {
        if (!w.mode) throw new Error("no mode row");
        return copy(w.mode);
      }),
      updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!w.mode || !matches(w.mode, a.where)) return { count: 0 };
        apply(w.mode, a.data);
        w.log.push("mode.cas");
        return { count: 1 };
      }),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => {
        if (!w.mode) throw new Error("no mode row");
        apply(w.mode, a.data);
        w.log.push("mode.update");
        return copy(w.mode);
      }),
    },
    securitySchedule: {
      findMany: vi.fn(async () => copy([...w.days].sort((a, b) => a.weekday - b.weekday))),
      deleteMany: vi.fn(async () => {
        const count = w.days.length;
        w.days = [];
        w.log.push("days.delete");
        return { count };
      }),
      createMany: vi.fn(async (a: { data: Array<Omit<FakeDay, "updatedAt">> }) => {
        for (const d of a.data) w.days.push({ ...d, updatedAt: new Date() });
        w.log.push("days.create");
        return { count: a.data.length };
      }),
    },
    securityScheduleException: {
      findMany: vi.fn(async (a?: { where?: { date?: unknown } }) =>
        copy(w.exceptions.filter((e) => dateFilter(a?.where)(e.date)).sort((x, y) => (x.date < y.date ? -1 : 1))),
      ),
      findUnique: vi.fn(async (a: { where: { date: string } }) => {
        const e = w.exceptions.find((x) => x.date === a.where.date);
        return e ? copy(e) : null;
      }),
      count: vi.fn(async (a?: { where?: { date?: unknown } }) => w.exceptions.filter((e) => dateFilter(a?.where)(e.date)).length),
      upsert: vi.fn(async (a: { where: { date: string }; create: Partial<FakeException>; update: Record<string, unknown> }) => {
        const e = w.exceptions.find((x) => x.date === a.where.date);
        if (e) apply(e, a.update);
        else {
          w.exceptions.push({
            date: a.where.date,
            kind: "closed",
            opensMin: null,
            closesMin: null,
            note: "",
            createdById: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...a.create,
          } as FakeException);
        }
        w.log.push("exception.upsert");
        return copy(w.exceptions.find((x) => x.date === a.where.date)!);
      }),
      deleteMany: vi.fn(async (a?: { where?: { date?: unknown } }) => {
        const keep = w.exceptions.filter((e) => !dateFilter(a?.where)(e.date));
        const count = w.exceptions.length - keep.length;
        w.exceptions = keep;
        w.log.push("exception.delete");
        return { count };
      }),
    },
    securityEvent: {
      createMany: vi.fn(async (a: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of a.data) {
          if (w.events.some((e) => e.dedupeKey === row.dedupeKey)) {
            if (!a.skipDuplicates) throw Object.assign(new Error("unique"), { code: "P2002" });
            continue;
          }
          w.events.push({ ...row });
          count++;
        }
        w.log.push("event.create");
        return { count };
      }),
    },
    user: {
      findUnique: vi.fn(async (a: { where: { id: string } }) => {
        const u = w.users[a.where.id];
        return u ? { id: a.where.id, ...u } : null;
      }),
    },
    workspace: { findUnique: vi.fn(async () => (w.workspaceTz === undefined ? null : { tz: w.workspaceTz })) },
    businessProfile: { findUnique: vi.fn(async () => ({ typicalDay: w.typicalDay })) },
  };
  const $transaction = vi.fn(async (fn: (tx: typeof delegates) => Promise<unknown>, opts?: unknown) => {
    void opts;
    const snap = copy({ hours: w.hours, mode: w.mode, days: w.days, exceptions: w.exceptions, events: w.events });
    const logLength = w.log.length;
    try {
      return await fn(delegates);
    } catch (err) {
      Object.assign(w, snap);
      w.log.push(`rollback(${w.log.length - logLength})`);
      throw err;
    }
  });
  return { ...delegates, $transaction };
}

export type FakePrisma = ReturnType<typeof fakePrisma>;
