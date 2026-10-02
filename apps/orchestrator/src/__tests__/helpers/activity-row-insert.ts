/**
 * WARP-3011 — the recorder writes `ActivityRow` with ONE raw INSERT
 * (`INSERT_ACTIVITY_ROW_SQL` in services/activity.service.ts), never
 * `tx.activityRow.create`: Prisma's Json write keeps 16 significant digits,
 * so `refs` is bound as the exact canonical text the signer signed.
 *
 * In-memory Prisma fakes that drive the REAL recorder route its
 * `$queryRawUnsafe` calls through here: `isActivityRowInsert` picks the
 * INSERT out from the lock and the tail read, and `activityRowFromInsert`
 * turns its positional parameters back into the row Postgres would hold —
 * `refs` parsed from the bound text, exactly as the jsonb column returns it.
 * The fake answers the INSERT with `[{ id }]` (it is `RETURNING "id"`).
 *
 * The append still requires its transaction handle to carry
 * `activityRow.create` (WARP-2977 P2b: part of the check that the handle is
 * Prisma's transaction client itself), so a fake hands it
 * `activityRowCreateTrap`: present, and failing the test if the recorder
 * ever writes through it again.
 */

/** The `activityRow` delegate of a fake the real recorder appends through. Never called by a correct append. */
export const activityRowCreateTrap = {
  async create(): Promise<never> {
    throw new Error(
      "WARP-3011: the activity recorder called activityRow.create — ActivityRow is written with the raw INSERT (INSERT_ACTIVITY_ROW_SQL), never Prisma's Json write",
    );
  },
};

export interface InsertedActivityRow {
  id: bigint;
  at: Date;
  severity: string;
  sourceIcon: string;
  what: string;
  sub: string | null;
  kind: string;
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
  actorType: string | null;
  actorId: string | null;
  schemaVersion: number;
}

export function isActivityRowInsert(query: string): boolean {
  return query.startsWith('INSERT INTO "ActivityRow"');
}

/** Position of each column in the INSERT's parameter list. */
const COLUMNS = [
  "at",
  "severity",
  "sourceIcon",
  "what",
  "sub",
  "kind",
  "refs",
  "signature",
  "prevSignatureHash",
  "actorType",
  "actorId",
  "schemaVersion",
] as const;

export function activityRowFromInsert(
  id: bigint,
  params: readonly unknown[],
): InsertedActivityRow {
  if (params.length !== COLUMNS.length) {
    throw new Error(
      `ActivityRow INSERT bound ${params.length} parameters, expected ${COLUMNS.length}`,
    );
  }
  const p = Object.fromEntries(COLUMNS.map((c, i) => [c, params[i]])) as Record<
    (typeof COLUMNS)[number],
    unknown
  >;
  return {
    id,
    // Bound as ISO-8601 text; timestamp(3) keeps it to the millisecond.
    at: new Date(p.at as string),
    severity: p.severity as string,
    sourceIcon: p.sourceIcon as string,
    what: p.what as string,
    sub: p.sub as string | null,
    kind: p.kind as string,
    refs:
      p.refs === null
        ? null
        : (JSON.parse(p.refs as string) as Record<string, unknown>),
    signature: p.signature as string,
    prevSignatureHash: p.prevSignatureHash as string,
    actorType: p.actorType as string | null,
    actorId: p.actorId as string | null,
    schemaVersion: p.schemaVersion as number,
  };
}
