/**
 * WARP-2739 (ADR-049 §4.2) — `ErpDocument.status` has exactly one writer.
 *
 * ── Why this is a source scan and not a unit test ──────────────────────────
 *
 * The invariant is about code that DOES NOT EXIST YET. `/money` has no write
 * surface in this slice — no POST, no PATCH — so there is nothing to assert a
 * refusal against. The thing worth protecting is the shape of the writer that
 * arrives next: `moveDocumentStatus` writes the status and its timeline entry
 * inside one `$transaction`, and a PATCH that set `status` directly would
 * commit a state change with no record of it.
 *
 * That is not hypothetical. It is exactly the mistake `moveDealStage` was
 * built to prevent on the CRM side, and `updateDeal` routes stage changes
 * through `applyStageMove` for precisely this reason. The rule survived there
 * because it was written down; it survives here because a test fails.
 *
 * ── What counts as a violation ─────────────────────────────────────────────
 *
 * A Prisma write against `erpDocument` whose `data` mentions `status`. The
 * scan is deliberately blunt — it reads source text, not a type graph — so it
 * over-reports rather than under-reports, and the one sanctioned writer is
 * named by path rather than by pattern. A guard that allowed "any file whose
 * name contains status" would be satisfied by the file that broke it.
 *
 * 🔴 `vendorStatus` is NOT this column and must not trip the guard.
 * `land-money.ts` writes it on every landing tick, which is correct: the
 * vendor's own word is the vendor's to set, and the provenance CHECK keeps the
 * two columns on opposite sides of `origin`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { PACKAGE_ROOT, readPackageFile } from "./helpers/test-paths.js";

const SRC = path.join(PACKAGE_ROOT, "src");

/** The one file allowed to write the column, relative to `src`. */
const SANCTIONED_WRITER = path.join("services", "money", "document-status.ts");

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "__tests__"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    // Co-located tests are not production writers. `.test.ts` and `.pg.test.ts`
    // both end in `.test.ts`.
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Every `erpDocument.<write>({ ... })` call, as raw text.
 *
 * Brace-matched rather than regex-terminated: a `data:` object spanning ten
 * lines with nested objects in it is the ordinary shape here, and a
 * non-greedy `[\s\S]*?}` would stop at the first inner brace and miss the
 * field that matters.
 */
function writeCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /erpDocument\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, i + 1));
  }
  return calls;
}

/** `status:` as a FIELD, never `vendorStatus:` and never `extractStatus:`. */
function writesStatusField(call: string): boolean {
  return /(^|[^A-Za-z])status\s*:/.test(call);
}

describe("🔴 ErpDocument.status has one writer", () => {
  const files = sourceFiles(SRC);

  it("finds the source tree it means to scan", () => {
    // A guard that silently scanned nothing would pass forever. WARP-2654's
    // vacuity lesson: the assertion that the scan HAPPENED is part of the test.
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(SANCTIONED_WRITER))).toBe(true);
  });

  it("MUTATION: let a route write `status` directly — a state change with no timeline", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file);
      if (rel === SANCTIONED_WRITER) continue;
      const source = readFileSync(file, "utf8");
      for (const call of writeCalls(source)) {
        if (writesStatusField(call)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the sanctioned writer really does write it, inside a transaction", () => {
    // The other half of the vacuity check: if `document-status.ts` stopped
    // writing the column, the scan above would still be green while the
    // invariant meant nothing.
    const source = readPackageFile("src", "services", "money", "document-status.ts");
    expect(source).toContain("$transaction");
    expect(writeCalls(source).some(writesStatusField)).toBe(true);
    // And it writes the timeline entry beside it.
    expect(source).toContain("crmActivity.create");
  });

  it("does not mistake the vendor's own word for the box's lifecycle", () => {
    // `land-money.ts` writes `vendorStatus` on every tick and must stay legal.
    const landing = readPackageFile("src", "services", "erp-sync", "land-money.ts");
    expect(landing).toContain("vendorStatus:");
    expect(writeCalls(landing).some(writesStatusField)).toBe(false);
  });
});
