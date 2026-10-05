/**
 * WARP-1505 — an in-memory Prisma fake for the PM attachment lifecycle, shared by
 * the service suite and the route suite.
 *
 * It implements the one thing the service's correctness hangs on — a conditional
 * `updateMany` — and the `where` subset it uses (equality, `{in}`, `{lt}`,
 * `{gt}`). Anything the service starts calling that this lacks fails loudly with
 * "x is not a function", which is the point: a fake that quietly returned
 * undefined would let a regression through. Database-level invariants (CHECK,
 * cascades) are NOT faked — they are in pm-attachment.pg.test.ts.
 */

type Row = Record<string, unknown>;

/** `where` subset the service uses: equality, `{in}`, `{lt}`, `{gt}`. */
export function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; lt?: unknown; gt?: unknown; startsWith?: string };
      if (c.startsWith !== undefined && (typeof v !== "string" || !v.startsWith(c.startsWith))) return false;
      if (c.in) return c.in.includes(v);
      if (c.lt !== undefined) return (v as Date | string) < (c.lt as Date | string);
      if (c.gt !== undefined) return (v as Date | string) > (c.gt as Date | string);
      if (c.startsWith !== undefined) return true;
    }
    return v === cond;
  });
}

export function makeAttachmentFake() {
  const item = (id: string, sequenceId: number): Row => ({
    id, projectId: "p-1", sequenceId, name: `Item ${sequenceId}`,
    descriptionHtml: null, stateId: null, state: null, priority: "none",
    parentId: null, cycleId: null, department: null, assignees: [], labels: [],
    startDate: null, dueDate: null, sortOrder: sequenceId, completedAt: null,
    createdById: null, _count: { comments: 0, children: 0 },
    createdAt: new Date("2026-10-04T10:00:00Z"), updatedAt: new Date("2026-10-04T10:00:00Z"),
  });
  const db = {
    items: [item("wi-1", 1), item("wi-2", 2)],
    projects: [{ id: "p-1", identifier: "INBOX", department: null }] as Row[],
    // c-1 is alice's, c-bob bob's (both on wi-1), c-ai has no author (the assistant's);
    // c-2 is bob's on ANOTHER item.
    comments: [
      { isDeleted: false, id: "c-1", workItemId: "wi-1", authorId: "u-alice" },
      { isDeleted: false, id: "c-bob", workItemId: "wi-1", authorId: "u-bob" },
      { isDeleted: false, id: "c-ai", workItemId: "wi-1", authorId: null },
      { isDeleted: false, id: "c-2", workItemId: "wi-2", authorId: "u-bob" },
    ] as Row[],
    attachments: [] as Row[],
    activity: [] as Row[],
    flags: [] as Row[],
  };
  const hooks: { createError?: unknown; updateManyError?: unknown; itemReadError?: unknown } = {};
  /** How many times the service asked for a row — "refused before it cost a row". */
  const stats = { creates: 0, itemReads: 0, attachmentLists: 0 };
  let seq = 0;

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    systemFlag: {
      createMany: async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const row of data) {
          if (!db.flags.some((f) => f.key === row.key)) { db.flags.push(row); count += 1; }
        }
        return { count };
      },
      findUnique: async ({ where }: { where: Row }) => db.flags.find((f) => f.key === where.key) ?? null,
      findMany: async ({ where, take }: { where: Row; take: number }) =>
        db.flags.filter((f) => matches(f, where)).sort((a, b) => String(a.key).localeCompare(String(b.key))).slice(0, take),
      deleteMany: async ({ where }: { where: Row }) => {
        const before = db.flags.length;
        db.flags = db.flags.filter((f) => !matches(f, where));
        return { count: before - db.flags.length };
      },
    },
    pmWorkItem: {
      findUnique: async ({ where }: { where: Row }) => {
        stats.itemReads += 1;
        if (hooks.itemReadError) throw hooks.itemReadError;
        return db.items.find((i) => i.id === where.id) ?? null;
      },
    },
    pmProject: {
      findUnique: async ({ where }: { where: Row }) => db.projects.find((p) => p.id === where.id) ?? null,
    },
    pmComment: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = db.comments.filter((c) => matches(c, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
      findFirst: async ({ where }: { where: Row }) => db.comments.find((c) => matches(c, where)) ?? null,
    },
    pmActivity: {
      create: async ({ data }: { data: Row }) => {
        db.activity.push({ id: `act-${++seq}`, ...data });
        return data;
      },
    },
    pmAttachment: {
      create: async ({ data }: { data: Row }) => {
        stats.creates += 1;
        if (hooks.createError) throw hooks.createError;
        const row: Row = {
          id: `att-${++seq}`,
          commentId: null,
          createdAt: new Date(),
          uploadedById: null,
          ...data,
        };
        db.attachments.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }: { where: Row; orderBy?: Row | Row[]; take?: number }) => {
        stats.attachmentLists += 1;
        let rows = db.attachments.filter((a) => matches(a, where));
        const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        for (const o of [...order].reverse()) {
          const [field, dir] = Object.entries(o)[0] as [string, "asc" | "desc"];
          rows = [...rows].sort((a, b) => {
            const av = a[field] as number | string | Date;
            const bv = b[field] as number | string | Date;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === "desc" ? -cmp : cmp;
          });
        }
        return take === undefined ? rows : rows.slice(0, take);
      },
      findFirst: async ({ where }: { where: Row }) => db.attachments.find((a) => matches(a, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => db.attachments.find((a) => a.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const row = db.attachments.find((a) => a.id === where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (hooks.updateManyError) throw hooks.updateManyError;
        const hit = db.attachments.filter((a) => matches(a, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = db.attachments.length;
        db.attachments = db.attachments.filter((a) => !matches(a, where));
        return { count: before - db.attachments.length };
      },
    },
  };
  return { prisma: prisma as never, db, hooks, stats };
}
