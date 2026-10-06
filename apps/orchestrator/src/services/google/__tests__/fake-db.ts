import type { PrismaClient } from "@prisma/client";
import { vi } from "vitest";

type Row = Record<string, any>;
export function fakeGoogleDb() {
  let connections: Row[] = [];
  let accounts: Row[] = [];
  let sources: Row[] = [];
  let events: Row[] = [];
  let users: Row[] = [{ id: "user-1", username: "sam", directoryStatus: "ACTIVE", deletionStatus: "NONE" }];
  let nextId = 1;
  function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === "OR") return (value as Row[]).some((choice) => matches(row, choice));
      if (key === "sourceId_externalUid") return matches(row, value as Row);
      if (key === "user") {
        const user = users.find((candidate) => candidate.id === row.userId);
        return !!user && matches(user, (value as Row).is);
      }
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("not" in value) return row[key] !== (value as Row).not;
        if ("in" in value) return (value as Row).in.includes(row[key]);
        return (value as Row).mode === "insensitive"
          ? String(row[key]).toLowerCase() === String((value as Row).equals).toLowerCase()
          : row[key] === (value as Row).equals;
      }
      return value instanceof Date && row[key] instanceof Date ? value.getTime() === row[key].getTime() : row[key] === value;
    });
  }
  const db = {
    connections: () => connections,
    accounts: () => accounts,
    users: () => users,
    sources: () => sources,
    events: () => events,
    seedAccount: (data: Row) => accounts.push({ id: `mail-${nextId++}`, ...data }),
    user: {
      findFirst: vi.fn(async ({ where }: Row) => users.find((row) => matches(row, where)) ?? null),
    },
    googleConnection: {
      findMany: vi.fn(async ({ where }: Row) => connections.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      findUnique: vi.fn(async ({ where }: Row) => {
        const row = connections.find((row) => matches(row, where));
        return row ? { ...row } : null;
      }),
      upsert: vi.fn(async ({ where, create, update }: Row) => {
        let row = connections.find((candidate) => matches(candidate, where));
        if (!row) {
          row = { id: `link-${nextId++}`, accountAddress: null, emailAccountId: null, calendarSourceId: null, tokenEnc: null,
            mailEnabled: true, calendarEnabled: false, calendarSyncState: "DISCONNECTED", ...create };
          connections.push(row!);
        } else Object.assign(row, update);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const found = connections.filter((row) => matches(row, where));
        found.forEach((row) => Object.assign(row, data));
        return { count: found.length };
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = connections.find((row) => matches(row, where));
        if (!row) throw new Error("P2025");
        Object.assign(row, data);
        return { ...row };
      }),
    },
    calendarSource: {
      findUnique: vi.fn(async ({ where }: Row) => {
        const row = sources.find((row) => matches(row, where));
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: Row) => {
        const row = { id: `source-${nextId++}`, lastSyncAt: null, lastSyncError: null, externalSyncRun: null, ...data };
        sources.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = sources.find((row) => matches(row, where));
        if (!row) throw new Error("P2025");
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const found = sources.filter((row) => matches(row, where));
        found.forEach((row) => Object.assign(row, data));
        return { count: found.length };
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const removed = sources.filter((row) => matches(row, where));
        sources = sources.filter((row) => !removed.includes(row));
        connections.forEach((row) => { if (removed.some((source) => source.id === row.calendarSourceId)) row.calendarSourceId = null; });
        return { count: removed.length };
      }),
    },
    calendarEvent: {
      findMany: vi.fn(async ({ where }: Row) => events.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      createMany: vi.fn(async ({ data, skipDuplicates }: Row) => {
        let count = 0;
        for (const values of data) {
          if (events.some((row) => row.sourceId === values.sourceId && row.externalUid === values.externalUid)) {
            if (skipDuplicates) continue;
            throw new Error("P2002");
          }
          events.push({ id: `event-${nextId++}`, ...values }); count += 1;
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = events.find((row) => matches(row, where));
        if (!row) throw new Error("P2025");
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const found = events.filter((row) => matches(row, where));
        found.forEach((row) => Object.assign(row, data));
        return { count: found.length };
      }),
      count: vi.fn(async ({ where }: Row) => events.filter((row) => matches(row, where)).length),
      upsert: vi.fn(async ({ where, create, update }: Row) => {
        let row = events.find((row) => matches(row, where));
        if (!row) { row = { id: `event-${nextId++}`, ...create }; events.push(row!); }
        else Object.assign(row, update);
        return { ...row };
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const removed = events.filter((row) => matches(row, where));
        events = events.filter((row) => !removed.includes(row));
        return { count: removed.length };
      }),
    },
    emailAccount: {
      findFirst: vi.fn(async ({ where }: Row) => {
        const row = accounts.find((row) => matches(row, where));
        return row ? { ...row } : null;
      }),
      findUnique: vi.fn(async ({ where }: Row) => {
        const row = accounts.find((row) => matches(row, where));
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: Row) => {
        if (accounts.some((row) => row.address === data.address)) throw new Error("P2002");
        const row = { id: `mail-${nextId++}`, ...data };
        accounts.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: Row) => {
        const row = accounts.find((row) => matches(row, where));
        if (!row) throw new Error("P2025");
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const found = accounts.filter((row) => matches(row, where));
        found.forEach((row) => Object.assign(row, data));
        return { count: found.length };
      }),
      deleteMany: vi.fn(async ({ where }: Row) => {
        const removed = accounts.filter((row) => matches(row, where));
        accounts = accounts.filter((row) => !removed.includes(row));
        // Mail removal must preserve a shared Calendar grant (ON DELETE SET NULL).
        connections.forEach((row) => { if (removed.some((account) => row.emailAccountId === account.id)) row.emailAccountId = null; });
        return { count: removed.length };
      }),
    },
    $transaction: vi.fn(async (operation: (tx: any) => Promise<any>) => {
      const prior = { connections: connections.map((row) => ({ ...row })), accounts: accounts.map((row) => ({ ...row })),
        sources: sources.map((row) => ({ ...row })), events: events.map((row) => ({ ...row })) };
      try { return await operation(db); } catch (err) {
        connections = prior.connections;
        accounts = prior.accounts;
        sources = prior.sources;
        events = prior.events;
        throw err;
      }
    }),
  };
  return { ...db, prisma: db as unknown as PrismaClient };
}
