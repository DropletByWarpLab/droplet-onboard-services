/**
 * WARP-2980 (ADR-059 P5 §12 "Static pins") — two rules the code must keep
 * that no behavioural test would notice breaking:
 *
 *   1. No SQL time-zone conversion in any Security file. Slots are cut in
 *      TypeScript through the one converter (lib/zoned-time.ts); Postgres's
 *      tzdata and ICU's can differ, and `AT TIME ZONE` / `timezone(…)` would
 *      be a third converter that disagrees at a DST edge (D20).
 *   2. `SecurityBaselineCell` is written by services/security-baseline-build.ts
 *      ONLY. Cells are derived counts; a verdict, a suppression or a tool
 *      writing them would teach the baselines to ignore something (brief §4.4).
 *
 * Comments are stripped before matching, so a comment may name the rule.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PACKAGE_ROOT } from "./helpers/test-paths.js";

const SRC = join(PACKAGE_ROOT, "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") out.push(...tsFiles(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const rel = (f: string) => relative(PACKAGE_ROOT, f).split(sep).join("/");
const code = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Walking all of src/ reads a few thousand files; on a Windows dev box that alone can pass 10 s. */
const WALK_TIMEOUT_MS = 60_000;

const SQL_TZ = [/\bAT\s+TIME\s+ZONE\b/i, /(^|[^A-Za-z_])timezone\s*\(/i];
const CELL_WRITE = [
  /\bsecurityBaselineCell\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"SecurityBaselineCell"/i,
];

describe("static pins (WARP-2980)", () => {
  it("no Security service or lib file converts time in SQL", { timeout: WALK_TIMEOUT_MS }, () => {
    const files = [...tsFiles(join(SRC, "services")), ...tsFiles(join(SRC, "lib"))].filter((f) => /[\\/]security-[^\\/]+\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => SQL_TZ.some((re) => re.test(code(f)))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("SecurityBaselineCell is written only by security-baseline-build.ts", { timeout: WALK_TIMEOUT_MS }, () => {
    const writers = tsFiles(SRC)
      .filter((f) => /securityBaselineCell|SecurityBaselineCell/.test(readFileSync(f, "utf8")))
      .filter((f) => CELL_WRITE.some((re) => re.test(code(f))))
      .map(rel);
    expect(writers).toEqual(["src/services/security-baseline-build.ts"]);
  });

  // Guards the matchers: a pin that cannot fail proves nothing.
  it.each([
    ["SELECT x AT TIME ZONE 'UTC'", SQL_TZ],
    ["SELECT timezone('UTC', x)", SQL_TZ],
    ["await prisma.securityBaselineCell.deleteMany({})", CELL_WRITE],
    ['DELETE FROM "SecurityBaselineCell" WHERE 1=1', CELL_WRITE],
    ['INSERT INTO "SecurityBaselineCell" (x) VALUES (1)', CELL_WRITE],
  ])("the matcher catches %j", (text, res) => {
    expect(res.some((re) => re.test(text))).toBe(true);
  });

  it.each([["resolveSecurityTimezone(prisma)"], ["prisma.securityBaselineCell.findMany({})"], ["hours.timezone"]])(
    "the matcher lets %j through",
    (text) => {
      expect([...SQL_TZ, ...CELL_WRITE].some((re) => re.test(text))).toBe(false);
    },
  );
});
