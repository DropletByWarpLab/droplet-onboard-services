/**
 * WARP-2896 — a re-stamped migration can never come back under its old stamp.
 *
 * The team re-stamps a branch migration immediately before merge so the
 * history applies in the order it was written. WARP-2896 is the case that
 * made this a guard: `20260920120000_warp_2896_workspace` moved to
 * `20260924010000_warp_2896_workspace` (#2247, 040ae3c90). The moved SQL is
 * idempotent; the OLD folder's SQL is not (a bare `CREATE TYPE`).
 *
 * The failure it guards against is silent everywhere except on a box. A
 * branch that forked before the re-stamp still carries the old folder, and
 * if it reaches stage with that folder intact (a squash or cherry-pick
 * instead of a merge of stage, a bad conflict resolution), the tree holds
 * BOTH folders. CI stays green, because a fresh DB runs the old folder
 * first and the idempotent new one as a no-op. A box that already ran the
 * new folder is different: it has no row for the old name, so the next
 * deploy runs the old SQL over objects that exist, fails with 42710 / P3018,
 * and migrate-and-start.sh refuses to start the app. The box goes dark.
 *
 * So the check is on the shape of the migrations directory itself, in the
 * DB-less lane every PR runs: no two folders may carry the same name after
 * their 14-digit stamp. That is what a resurrected re-stamp looks like, for
 * this migration and for every future one.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");
const STAMPED = /^(\d{14})_(.+)$/;

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((name) => statSync(path.join(MIGRATIONS_DIR, name)).isDirectory());
}

describe("migration folder names (WARP-2896)", () => {
  it("every migration folder is <14-digit stamp>_<name>", () => {
    const odd = migrationFolders().filter((name) => !STAMPED.test(name));
    expect(odd).toEqual([]);
  });

  it("no two migration folders share a name after the stamp — a re-stamped migration never comes back under its old stamp", () => {
    const byName = new Map<string, string[]>();
    for (const folder of migrationFolders()) {
      const m = STAMPED.exec(folder);
      if (!m) continue;
      byName.set(m[2]!, [...(byName.get(m[2]!) ?? []), folder]);
    }
    const duplicated = [...byName.values()].filter((folders) => folders.length > 1);
    expect(duplicated).toEqual([]);
  });

  it("the WARP-2896 workspace migration exists once, under its re-stamped name", () => {
    const folders = migrationFolders();
    expect(folders).toContain("20260924010000_warp_2896_workspace");
    expect(folders).not.toContain("20260920120000_warp_2896_workspace");
  });
});
