/**
 * WARP-2978 (ADR-059 P3 spec §6.1 step 3, R7) — the SecurityEvent writer
 * list, pinned.
 *
 * The incident engine's triage floor is gap-safe only because every
 * transaction that writes a SecurityEvent ends within 60 s: the floor moves to
 * a head read two minutes earlier, and a writer still open by then would have
 * its row skipped — silently and forever. So every writer is reviewed against
 * that bound, and this file is how a NEW writer gets noticed: it greps every
 * production `.ts` under `src/` for `securityEvent.create(` /
 * `securityEvent.createMany(` and pins the exact list. A new site fails here
 * until someone adds it below, with the reason its transaction is short.
 *
 * It also pins the other half of D11: nothing UPDATEs a SecurityEvent (the
 * database refuses it anyway — the `SecurityEvent_append_only` trigger).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { packagePath } from "./helpers/test-paths.js";

const SRC = packagePath("src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The source with comments blanked (same length), so a writer named in a comment does not count. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const PRODUCTION = walk(SRC)
  .map((full) => ({ full, rel: path.relative(SRC, full).split(path.sep).join("/") }))
  .filter(({ rel }) => !rel.endsWith(".test.ts") && !rel.split("/").includes("__tests__"));

function sites(re: RegExp): string[] {
  const out: string[] = [];
  for (const { full, rel } of PRODUCTION) {
    const src = code(full);
    for (const m of src.matchAll(re)) out.push(`${rel}:${src.slice(0, m.index).split("\n").length}`.replace(/:\d+$/, ""));
  }
  return out.sort();
}

/**
 * Every writer, and why its transaction is short. Paths, not line numbers,
 * so an edit elsewhere in the file does not churn this list.
 */
const WRITERS: ReadonlyArray<readonly [file: string, why: string]> = [
  [
    "services/security-events.service.ts",
    "recordSecurityEvent: an autocommit createMany (one statement); the threat mirror: an autocommit createMany of ≤ 500 rows",
  ],
  [
    "services/security-mode.service.ts",
    "insertModeChangedRow: inside a mode/hours READ COMMITTED interactive transaction (Prisma's default 5 s timeout)",
  ],
];

describe("SecurityEvent writers — the floor's 60 s bound is reviewed per writer (R7)", () => {
  it("the writer list is exactly the pinned one", () => {
    const found = [...new Set(sites(/\bsecurityEvent\s*\.\s*(?:create|createMany)\s*\(/g))];
    expect(found).toEqual(WRITERS.map(([file]) => file).sort());
  });

  it("nothing updates or upserts a SecurityEvent (D11 — the table is append-only)", () => {
    expect(sites(/\bsecurityEvent\s*\.\s*(?:update|updateMany|upsert)\s*\(/g)).toEqual([]);
    expect(sites(/UPDATE\s+"SecurityEvent"/g)).toEqual([]);
  });

  it("the scan can see a writer (a check that cannot fail proves nothing)", () => {
    expect(PRODUCTION.length).toBeGreaterThan(100);
    expect(sites(/\bsecurityEvent\s*\.\s*createMany\s*\(/g).length).toBeGreaterThanOrEqual(2);
  });
});
