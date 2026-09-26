/**
 * WARP-3193 ARCH-9 — the one Prisma unique-constraint check. Was copied into
 * eleven modules, all byte-for-byte the same test.
 *
 * Duck-typed on `code` rather than `instanceof PrismaClientKnownRequestError`
 * on purpose (as every copy was): tests and `$transaction` callers throw plain
 * objects carrying the code.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
