/**
 * WARP-3538 — an in-memory Microsoft 365 world for the DB-less lanes: the
 * connections, the delta cursors and the two cloud-file tables, every one of
 * them EVALUATING the arguments it is called with.
 *
 * What the SharePoint switch, the sync status and their routes promise lives in
 * where-clauses (`userId` on every statement, `workload`, the provider) and in
 * one transaction. A stub that returned canned rows would prove only that the
 * code called Prisma; these tables filter, so a dropped predicate changes what a
 * test sees.
 *
 * `$transaction` is real enough to matter:
 *
 *   - it hands the callback a DIFFERENT handle (`tx`) than the client's;
 *   - it rolls every table back if the callback throws, as a database does;
 *   - every statement is recorded with the handle it went through and whether a
 *     transaction was open, so "in one transaction" is something a test can see.
 *
 * It reuses `matchesWhere` from `fake-table.ts` (equality with null, `in`,
 * `not`, comparisons, `OR`/`AND`), which THROWS on an operator it does not know:
 * a query this cannot evaluate is a loud failure, never a silent match.
 */
import { vi } from "vitest";

import { makeFakeCloudFileDb } from "./fake-cloud-files.js";
import { makeFakeTable, matchesWhere, type Row } from "./fake-table.js";

/** Which handle a statement went through. */
export type Via = "client" | "tx";

export interface RecordedCall {
  via: Via;
  /** `model.method`, e.g. `cloudFileItem.deleteMany`. */
  op: string;
  /** A transaction was open when it ran. */
  inTransaction: boolean;
}

export function makeFakeM365World(connectionRows: Row[] = []) {
  const connections: Row[] = connectionRows.map((r) => ({ ...r }));
  const cursors = makeFakeTable(() => ({
    state: "IDLE",
    lastSyncedAt: null,
    lastError: null,
    deltaLink: null,
    resumeLink: null,
  }));
  const cloud = makeFakeCloudFileDb();
  let inTransaction = false;
  const calls: RecordedCall[] = [];

  const connection = {
    findUnique: async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
      const hit = connections.find((r) => matchesWhere(r, where));
      if (!hit) return null;
      return select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, hit[k]])) : { ...hit };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = connections.filter((r) => matchesWhere(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };

  /** Every method of a delegate, recorded with the handle it was called through. */
  const through = <T extends Record<string, (...a: never[]) => unknown>>(via: Via, name: string, delegate: T): T =>
    Object.fromEntries(
      Object.entries(delegate).map(([method, fn]) => [
        method,
        (...args: never[]) => {
          calls.push({ via, op: `${name}.${method}`, inTransaction });
          return fn(...args);
        },
      ]),
    ) as T;

  const handle = (via: Via) => ({
    m365Connection: through(via, "m365Connection", connection),
    m365DeltaCursor: through(via, "m365DeltaCursor", cursors.delegate as never),
    cloudFileItem: through(via, "cloudFileItem", cloud.cloudFileItem as never),
    cloudFileSource: through(via, "cloudFileSource", cloud.cloudFileSource as never),
  });

  const tables = [connections, cursors.rows, cloud.items, cloud.sources];
  const tx = handle("tx");
  const $transaction = vi.fn(async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => {
    const before = tables.map((t) => t.map((r) => ({ ...r })));
    inTransaction = true;
    try {
      return await fn(tx);
    } catch (err) {
      // A real transaction leaves nothing behind when it fails.
      tables.forEach((t, i) => t.splice(0, t.length, ...before[i]!));
      throw err;
    } finally {
      inTransaction = false;
    }
  });
  const client = { ...handle("client"), $transaction };

  return {
    /** The client, shaped like the part of `PrismaClient` the M365 code reads. */
    prisma: client as never,
    /** The same, for a test that needs to replace a method. */
    client,
    $transaction,
    /** Every statement, with the handle it used. */
    calls,
    connections,
    connection: (userId: string) => connections.find((r) => r.userId === userId) ?? null,
    cursors,
    cloud,
    cursor: (userId: string, workload: string, resourceId: string, over: Row = {}) =>
      cursors.seed({ userId, workload, resourceId, ...over }),
    cursorKeys: (userId: string) =>
      cursors.rows.filter((r) => r.userId === userId).map((r) => `${r.workload}:${r.resourceId}`).sort(),
    library: (userId: string, sourceId: string, over: Row = {}) =>
      cloud.seedSource({ userId, provider: "M365", kind: "SHAREPOINT_LIBRARY", sourceId, nameEnc: "dcv1:x", ...over }),
    oneDrive: (userId: string, sourceId: string, over: Row = {}) =>
      cloud.seedSource({ userId, provider: "M365", kind: "ONEDRIVE", sourceId, nameEnc: "dcv1:x", ...over }),
    item: (userId: string, sourceId: string, externalId: string, over: Row = {}) =>
      cloud.seedItem({ userId, provider: "M365", sourceId, externalId, isFolder: false, nameEnc: "dcv1:x", ...over }),
    items: (userId: string) => cloud.items.filter((r) => r.userId === userId).map((r) => r.externalId as string).sort(),
    sources: (userId: string) => cloud.sources.filter((r) => r.userId === userId).map((r) => r.sourceId as string).sort(),
  };
}

export type FakeM365World = ReturnType<typeof makeFakeM365World>;
