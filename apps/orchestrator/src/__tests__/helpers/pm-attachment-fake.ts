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
      const c = cond as { in?: unknown[]; lt?: unknown; gt?: unknown };
      if (c.in) return c.in.includes(v);
      if (c.lt !== undefined) return (v as Date | string) < (c.lt as Date | string);
      if (c.gt !== undefined) return (v as Date | string) > (c.gt as Date | string);
    }
    return v === cond;
  });
}

export function makeAttachmentFake() {
  const db = {
    items: [{ id: "wi-1" }, { id: "wi-2" }] as Row[],
    comments: [
      { id: "c-1", workItemId: "wi-1" },
      { id: "c-2", workItemId: "wi-2" },
    ] as Row[],
    attachments: [] as Row[],
    activity: [] as Row[],
  };
  const hooks: { createError?: unknown; updateManyError?: unknown } = {};
  /** How many times the service asked for a row — "refused before it cost a row". */
  const stats = { creates: 0 };
  let seq = 0;

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    pmWorkItem: {
      findUnique: async ({ where }: { where: Row }) => db.items.find((i) => i.id === where.id) ?? null,
    },
    pmComment: {
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
