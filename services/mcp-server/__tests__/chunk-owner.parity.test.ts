/**
 * WARP-2821 — the two corpus resolvers must not drift apart again.
 *
 * The defect this guards against was not a wrong line; it was TWO answers to
 * one question, in two processes, that nobody compared. The Files page
 * (`routes/files.ts` `deptSearchCorpora`) resolved a caller's searchable
 * corpora one way; the assistant (`chunk-owner.ts` `resolveChunkOwnerIds`)
 * resolved them another, and the difference — every shared and department
 * document — was invisible rather than loud.
 *
 * They CANNOT share code: the mcp-server is a standalone process and the
 * indexer that writes the sentinels is Python. So the coupling is asserted
 * against the other side's SOURCE instead. This test is deliberately literal:
 * if someone changes the sentinel spelling or the visibility rule over there,
 * it fails here and names the file that has to change with it.
 *
 * A source-text assertion is a weak guarantee about behaviour and a strong one
 * about attention, which is the failure mode that actually happened.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

const FILES_ROUTE = "apps/orchestrator/src/routes/files.ts";
const WATCHER = "services/file-indexer/watcher.py";
const CONFIG_PY = "services/file-indexer/config.py";
const OURS = "services/mcp-server/src/chunk-owner.ts";

describe("chunk-owner parity with the Files route (WARP-2821)", () => {
  it("spells the department sentinel exactly as the Files route does", () => {
    const theirs = read(FILES_ROUTE);
    const ours = read(OURS);
    // The one format string that has to agree in three languages.
    expect(theirs).toContain("`__dept_${departmentId}__`");
    expect(ours).toContain("`__dept_${departmentId}__`");
  });

  it("spells the department sentinel exactly as the INDEXER writes it", () => {
    // watcher.py:176 — f"__dept_{dept['id']}__". The producer of the value.
    const watcher = read(WATCHER);
    expect(watcher).toContain('f"__dept_{dept[\'id\']}__"');
  });

  it("uses the same legacy household sentinel as the indexer and the route", () => {
    expect(read(CONFIG_PY)).toContain('HOUSEHOLD_USER_ID = "__household__"');
    expect(read(FILES_ROUTE)).toContain('HOUSEHOLD_INDEX_USER = "__household__"');
    expect(read(OURS)).toContain('HOUSEHOLD_INDEX_USER = "__household__"');
  });

  it("keeps the Files route's owner/admin-sees-all-active rule", () => {
    // If this disappears from files.ts the rule moved, and the copy in
    // chunk-owner.ts is now the stale one.
    const theirs = read(FILES_ROUTE);
    expect(theirs).toContain('caller.role === "owner" || caller.role === "admin"');
    expect(theirs).toContain('where: { state: "active" }');
    expect(read(OURS)).toContain('row.role === "owner" || row.role === "admin"');
    expect(read(OURS)).toContain('where: { state: "active" }');
  });

  it("keeps the Files route's member-sees-their-own-active-departments rule", () => {
    const theirs = read(FILES_ROUTE);
    expect(theirs).toContain("departmentMembership.findMany");
    expect(theirs).toContain('department: { state: "active" }');
    const ours = read(OURS);
    expect(ours).toContain("departmentMembership.findMany");
    expect(ours).toContain('department: { state: "active" }');
  });

  it("keeps the HOUSEHOLD dual-sentinel on both sides", () => {
    // Dropping it on either side hides every document written by the other
    // watcher generation, with no error and no reindex to notice it.
    expect(read(FILES_ROUTE)).toContain('dept.kind === "HOUSEHOLD"');
    expect(read(OURS)).toContain('dept.kind === "HOUSEHOLD"');
  });
});
