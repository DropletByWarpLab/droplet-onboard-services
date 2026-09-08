/**
 * An in-memory `erpDocument` table for the money tests (WARP-2581).
 *
 * WARP-2581's review moved the money summary's arithmetic OUT of JavaScript
 * and into Postgres (`groupBy` + `_sum`), and the page out of `.slice()` and
 * into `take`. A mock that simply returned canned aggregate rows would have
 * deleted every assertion that made those numbers trustworthy — two ledgers
 * are never added, an unreadable balance is counted but not summed, a settled
 * document is not listed — and left the suite green about nothing.
 *
 * So this models the SQL semantics the service now depends on, and only those:
 *
 *   • `SUM()` over a group with no non-NULL values is NULL, not zero.
 *   • `balance <> 0` is UNKNOWN for a NULL balance, so such a row is NOT
 *     matched by the `not` arm — which is exactly why the service spells the
 *     open predicate as `OR [balance IS NULL, balance <> 0]` rather than
 *     leaning on `not` alone.
 *   • `dueAt < now` never matches a NULL due date.
 *   • `ORDER BY ... ASC` puts NULLs LAST.
 *   • `GROUP BY` treats NULLs as equal, so one currency-less ledger is one
 *     group.
 *
 * 🔴 Any filter, aggregate or order this fake does not model THROWS. A fake
 * that silently ignored an unrecognised `where` key would turn the next
 * narrowing clause somebody adds into a test that cannot fail.
 */
// The REAL Decimal, deliberately: `src/__tests__/setup.ts` mocks
// `@prisma/client` wholesale and its `Prisma` namespace has no `Decimal`, so a
// fake built on the mock would do its arithmetic in something other than what
// production returns. The runtime subpath is not mocked, and the class it
// exports IS the one the generated client re-exports as `Prisma.Decimal`.
import { Decimal } from "@prisma/client/runtime/library";
import { vi } from "vitest";

/** A row as a test writes it: money as decimal strings, dates as `Date`. */
export interface FakeDocumentInput {
  id?: string;
  /** WARP-2739 — the six-value kind. `INVOICE` and `BILL` are what the old
   *  `RECEIVABLE` and `PAYABLE` became. */
  kind?: "QUOTE" | "ORDER" | "INVOICE" | "BILL" | "CREDIT_NOTE" | "RECEIPT";
  origin?: "LANDED" | "LOCAL";
  externalId?: string | null;
  externalSystem?: string | null;
  connectionId?: string | null;
  issuedAt?: Date | null;
  dueAt?: Date | null;
  counterpartyExternalId?: string | null;
  counterpartyName?: string | null;
  companyId?: string | null;
  /** Decimal STRING, or null for "the vendor sent nothing readable". */
  amount?: string | null;
  balance?: string | null;
  currency?: string | null;
  /** The vendor's own word, on a LANDED row. */
  vendorStatus?: string | null;
  /** The box's own lifecycle, on a LOCAL row. */
  status?:
    | "DRAFT"
    | "SENT"
    | "PART_PAID"
    | "PAID"
    | "VOID"
    | "WRITTEN_OFF"
    | "ISSUED"
    | "APPLIED"
    | null;
  vendorUpdatedAt?: Date | null;
  lastReadAt?: Date;
}

type StoredRow = Record<string, unknown> & {
  kind: string;
  dueAt: Date | null;
  externalId: string | null;
  balance: Decimal | null;
  lastReadAt: Date;
};

/** One document, with the columns a test rarely cares about already filled. */
export function fakeDocument(over: FakeDocumentInput = {}): FakeDocumentInput {
  return {
    id: "doc-1",
    kind: "INVOICE",
    origin: "LANDED",
    externalId: "INV-1001",
    externalSystem: "quickbooks-online",
    connectionId: "conn-1",
    issuedAt: new Date("2026-08-01T00:00:00Z"),
    dueAt: new Date("2026-09-30T00:00:00Z"),
    counterpartyExternalId: "cust-7",
    counterpartyName: "Northgate Dental",
    companyId: null,
    amount: "4210.55",
    balance: "1200.00",
    currency: null,
    // 🔴 The VENDOR's word. `status` stays null on a landed row — the provenance
    // CHECK refuses it otherwise, and a default that filled both columns would
    // let a test pass against a row Postgres would reject.
    vendorStatus: "Open",
    status: null,
    vendorUpdatedAt: null,
    lastReadAt: new Date("2026-09-01T11:00:00Z"),
    ...over,
  };
}

function store(input: FakeDocumentInput): StoredRow {
  const decimal = (value: string | null | undefined): Decimal | null =>
    value === null || value === undefined ? null : new Decimal(value);
  return {
    ...input,
    amount: decimal(input.amount),
    balance: decimal(input.balance),
  } as unknown as StoredRow;
}

function unsupported(what: string): never {
  throw new Error(`fake erpDocument table: unsupported ${what}`);
}

function matches(row: StoredRow, where: Record<string, unknown> | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;

    if (key === "OR") {
      const arms = cond as Array<Record<string, unknown>>;
      if (!arms.some((arm) => matches(row, arm))) return false;
      continue;
    }

    if (key === "NOT") {
      // Prisma reads sibling fields inside NOT as a conjunction, so the whole
      // sub-object is one predicate and the row is excluded only when ALL of
      // it holds. Delegating to `matches` keeps that reading honest — a hand
      // written `row.origin === … && row.status === …` here would drift the
      // moment the service narrows on something else.
      if (matches(row, cond as Record<string, unknown>)) return false;
      continue;
    }

    if (key === "origin" || key === "status") {
      // Plain equality; both are enum columns. `status` is NULL on every
      // landed row (the provenance CHECK puts the vendor's word in
      // `vendorStatus`), and `null !== "DRAFT"` is the answer that keeps the
      // vendor ledger out of the LOCAL-draft exclusion.
      if (cond !== null && typeof cond !== "string") unsupported(`${key} filter ${JSON.stringify(cond)}`);
      if ((row as unknown as Record<string, unknown>)[key] !== cond) return false;
      continue;
    }

    if (key === "kind") {
      // WARP-2739 — a direction is a SET of kinds, so `{ in: [...] }` is the
      // ordinary shape here and a bare equality is no longer produced by the
      // service at all. Both are supported: a fake that accepted only the
      // shape in use would turn the next narrowing into `unsupported filter`
      // rather than a real answer.
      const inList = (cond as { in?: unknown }).in;
      if (Array.isArray(inList)) {
        if (!inList.includes(row.kind)) return false;
        continue;
      }
      if (row.kind !== cond) return false;
      continue;
    }

    if (key === "balance") {
      if (cond === null) {
        if (row.balance !== null) return false;
        continue;
      }
      const not = (cond as { not?: unknown }).not;
      if (not === undefined) unsupported(`balance filter ${JSON.stringify(cond)}`);
      // `balance <> 0` is UNKNOWN — and therefore false — for a NULL balance.
      if (row.balance === null) return false;
      if (row.balance.equals(new Decimal(not as number))) return false;
      continue;
    }

    if (key === "dueAt") {
      const lt = (cond as { lt?: Date }).lt;
      if (lt === undefined) unsupported(`dueAt filter ${JSON.stringify(cond)}`);
      // A comparison against NULL never holds.
      if (row.dueAt === null) return false;
      if (row.dueAt.getTime() >= lt.getTime()) return false;
      continue;
    }

    unsupported(`filter ${key}`);
  }
  return true;
}

/** `ORDER BY dueAt ASC, externalId ASC` — the only order the service asks for. */
function sortRows(rows: StoredRow[], orderBy: unknown): StoredRow[] {
  const expected = JSON.stringify([{ dueAt: "asc" }, { externalId: "asc" }]);
  if (JSON.stringify(orderBy) !== expected) unsupported(`orderBy ${JSON.stringify(orderBy)}`);
  return [...rows].sort((a, b) => {
    // Postgres sorts NULLs LAST on an ASC ordering.
    if (a.dueAt === null && b.dueAt !== null) return 1;
    if (b.dueAt === null && a.dueAt !== null) return -1;
    const byDue =
      a.dueAt === null || b.dueAt === null ? 0 : a.dueAt.getTime() - b.dueAt.getTime();
    if (byDue !== 0) return byDue;
    // WARP-2739 — a LOCAL row has no `externalId`. Postgres sorts NULLs LAST on
    // an ASC ordering, and `""` sorts FIRST, so coalescing to the empty string
    // would put local documents at the top of a page the database puts them at
    // the bottom of. Only reached as the tie-break, after the due date.
    if (a.externalId === null && b.externalId !== null) return 1;
    if (b.externalId === null && a.externalId !== null) return -1;
    if (a.externalId === null || b.externalId === null) return 0;
    return a.externalId.localeCompare(b.externalId);
  });
}

/**
 * The return type is INFERRED, not declared. Spelling the three delegates as
 * `ReturnType<typeof vi.fn>` widens them to `Mock<any[], unknown>`, which this
 * vitest's typed `vi.fn(impl)` does not assign to — the same mismatch already
 * red across several suites here.
 */
export function fakeErpDocumentTable(inputs: readonly FakeDocumentInput[]) {
  const rows = inputs.map(store);

  const findMany = vi.fn(
    async (args: { where?: Record<string, unknown>; orderBy?: unknown; take?: number }) => {
      const matched = sortRows(
        rows.filter((row) => matches(row, args?.where)),
        args?.orderBy,
      );
      return args?.take === undefined ? matched : matched.slice(0, args.take);
    },
  );

  const groupBy = vi.fn(
    async (args: {
      by: string[];
      where?: Record<string, unknown>;
      _count?: { _all?: boolean };
      _sum?: { balance?: boolean };
    }) => {
      if (args._count?._all !== true) unsupported(`_count ${JSON.stringify(args._count)}`);
      if (args._sum?.balance !== true) unsupported(`_sum ${JSON.stringify(args._sum)}`);

      const groups = new Map<string, { key: Record<string, unknown>; rows: StoredRow[] }>();
      for (const row of rows.filter((candidate) => matches(candidate, args.where))) {
        const key = Object.fromEntries(args.by.map((column) => [column, row[column] ?? null]));
        // GROUP BY treats NULLs as equal, so the serialised key does too.
        const id = JSON.stringify(args.by.map((column) => row[column] ?? null));
        const group = groups.get(id) ?? { key, rows: [] };
        group.rows.push(row);
        groups.set(id, group);
      }

      return [...groups.values()].map(({ key, rows: grouped }) => {
        const readable = grouped.filter((row) => row.balance !== null);
        return {
          ...key,
          _count: { _all: grouped.length },
          // SUM() over an all-NULL group is NULL, not zero.
          _sum: {
            balance: readable.length
              ? readable.reduce(
                  (total, row) => total.plus(row.balance as Decimal),
                  new Decimal(0),
                )
              : null,
          },
        };
      });
    },
  );

  const aggregate = vi.fn(
    async (args: { _max?: { lastReadAt?: boolean }; _min?: { lastReadAt?: boolean } }) => {
      if (args._max?.lastReadAt !== true || args._min?.lastReadAt !== true) {
        unsupported(`aggregate ${JSON.stringify(args)}`);
      }
      const times = rows.map((row) => row.lastReadAt.getTime());
      return {
        _max: { lastReadAt: times.length ? new Date(Math.max(...times)) : null },
        _min: { lastReadAt: times.length ? new Date(Math.min(...times)) : null },
      };
    },
  );

  return { findMany, groupBy, aggregate };
}

export type FakeErpDocumentTable = ReturnType<typeof fakeErpDocumentTable>;
