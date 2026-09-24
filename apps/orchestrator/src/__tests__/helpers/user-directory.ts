/**
 * WARP-3061 — an in-memory `User` table with Prisma's lookup semantics, for
 * the places that resolve the person behind an `_service:mcp` call.
 *
 * Both lookups the resolvers have used are modelled, so one fixture drives the
 * old `findUnique({ where: { nextcloudUsername } })` and the current
 * `findMany({ where: { OR: [...] }, take })` identically:
 *
 *   - a `where` value matches a column only on strict equality, so a NULL
 *     `nextcloudUsername` (every SSO / SCIM row) never matches a string;
 *   - `findMany` returns each matching row ONCE, however many `OR` arms it
 *     satisfies, and honours `take`.
 */
import { vi } from "vitest";

export interface DirectoryUser {
  id: string;
  username: string;
  /** NULL for SSO- and SCIM-created rows, which never touch Nextcloud. */
  nextcloudUsername: string | null;
  role: string;
}

type Column = "id" | "username" | "nextcloudUsername";
type Where = Partial<Record<Column, string>>;

function matches(row: DirectoryUser, where: Where): boolean {
  const keys = Object.keys(where) as Column[];
  return keys.length > 0 && keys.every((k) => row[k] === where[k]);
}

function project(row: DirectoryUser, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k as keyof DirectoryUser]]),
  );
}

/** `source` is read on every call, so a fixture seeded after construction counts. */
export function userDirectory(source: DirectoryUser[] | (() => DirectoryUser[])) {
  const rowsNow = () => (typeof source === "function" ? source() : source);
  return {
    findUnique: vi.fn(
      async ({ where, select }: { where: Where; select?: Record<string, boolean> }) => {
        const row = rowsNow().find((r) => matches(r, where));
        return row ? project(row, select) : null;
      },
    ),
    findMany: vi.fn(
      async ({
        where,
        select,
        take,
      }: {
        where: { OR?: Where[] } & Where;
        select?: Record<string, boolean>;
        take?: number;
      }) => {
        const hit = rowsNow().filter((r) =>
          where.OR ? where.OR.some((arm) => matches(r, arm)) : matches(r, where),
        );
        return (take === undefined ? hit : hit.slice(0, take)).map((r) => project(r, select));
      },
    ),
  };
}
