/**
 * WARP-2897 (ADR-056 slice I-0) — `AccessRoleToolGrant` has exactly ONE writer.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * A tool grant is what lets a scoped person reach a domain. Until this ticket
 * the rows were written inline in two places in routes/access.ts (create and
 * PATCH), each doing its own validation — a zod enum over the COMPILED
 * domains. Slice I adds more writers: a promoted extension's proposed grants,
 * and an uninstall that removes an extension domain's rows. If each of those
 * wrote rows directly, the next one would be the one that skipped the
 * grantability check (erp, a domain nothing provides, a typo'd domain), and a
 * standing grant would reach something nobody reviewed.
 *
 * So every write goes through services/role-grant-writer.service.ts, which
 * owns the validation (`assertGrantableToolDomains`) and the row shapes.
 * This scan fails the moment any other production file writes the table —
 * directly, or NESTED through a parent write (`toolGrants: { create: … }` on
 * an `accessRole.create`/`update`), which Prisma accepts and a naive scan for
 * the delegate name would miss.
 *
 * ── What counts ────────────────────────────────────────────────────────────
 *
 * Source text, not a type graph: over-reports rather than under-reports, and
 * the sanctioned writer is named by PATH. Tests and fixtures are excluded
 * (the pg lane seeds rows directly, which is correct for a test).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { PACKAGE_ROOT } from "./helpers/test-paths.js";

const SRC = path.join(PACKAGE_ROOT, "src");

/** The one file allowed to write the table, relative to `src`. */
const SANCTIONED_WRITER = path.join("services", "role-grant-writer.service.ts");

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__", "__fixtures__"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/** A direct delegate write: `accessRoleToolGrant.createMany(`, `.upsert(`, … */
const DIRECT_WRITE =
  /accessRoleToolGrant\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany|delete|deleteMany)\s*\(/;

/** A nested relation write through the parent role: `toolGrants: { create: …`. */
const NESTED_WRITE =
  /toolGrants\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert|update|updateMany|delete|deleteMany|set|connect|disconnect)\s*:/;

function writesToolGrants(source: string): boolean {
  return DIRECT_WRITE.test(source) || NESTED_WRITE.test(source);
}

describe("tool-grant write path — the scanner itself", () => {
  // The regexes are the guard; a regex that matches nothing passes every tree.
  it.each([
    "await tx.accessRoleToolGrant.createMany({ data })",
    "await prisma.accessRoleToolGrant.create({ data: { roleId, domain, level } })",
    "tx.accessRoleToolGrant.upsert({ where, create, update })",
    "tx.accessRoleToolGrant\n  .deleteMany({ where: { domain } })",
    "tx.accessRoleToolGrant.update({ where, data })",
    "tx.accessRoleToolGrant.delete({ where })",
    "await tx.accessRole.create({ data: { name, toolGrants: { create: [{ domain, level }] } } })",
    "await tx.accessRole.update({ where, data: { toolGrants: { deleteMany: {} } } })",
  ])("catches: %s", (source) => {
    expect(writesToolGrants(source)).toBe(true);
  });

  it.each([
    "accessRole: { select: { toolGrants: { select: { domain: true, level: true } } } }",
    "const rows = await tx.accessRoleToolGrant.findMany({ where: { roleId } })",
    "include: { toolGrants: true }",
    "role.toolGrants.map((g) => g.domain)",
  ])("ignores reads: %s", (source) => {
    expect(writesToolGrants(source)).toBe(false);
  });
});

describe("tool-grant write path — the tree", () => {
  it("only services/role-grant-writer.service.ts writes AccessRoleToolGrant", () => {
    const writers = sourceFiles(SRC)
      .filter((file) => writesToolGrants(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(writers).toEqual([SANCTIONED_WRITER]);
  });
});
