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
 *   3. (WARP-2980 PR-B) The build never even NAMES expected activity, a
 *      pattern flag or a verdict: baselines stay pure counts.
 *   4. (WARP-2980 PR-B, spec D24, review item 7) Droplet's AI never creates,
 *      extends or widens expected activity and never gives a verdict (§4.9).
 *      The routes are role-gated (security-level-invariant.test.ts); this
 *      pins the OTHER path — tool handlers write through `ctx.prisma`
 *      directly — so no file under packages/tools-core/src or
 *      services/mcp-server/src names those routes, those tables or the
 *      verdict columns.
 *
 * Comments are stripped before matching, so a comment may name the rule.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PACKAGE_ROOT, REPO_ROOT } from "./helpers/test-paths.js";

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
/** Pin 3: what the build may never name. */
const BUILD_NEVER = [/SecuritySuppression|securitySuppression/, /SecurityPatternFlag|securityPatternFlag/, /verdict/i];
/** Pin 4: what no AI tool or MCP file may name. */
const AI_NEVER = [
  /\/security\/suppressions\b/,
  /\/verdict\b/,
  /\bsecuritySuppression\b/,
  /\bsecurityPatternFlag\b/,
  /\bverdictCodes\b/,
  /\bverdictById\b/,
];

/** Every .ts/.tsx/.js/.mjs source file under `dir` (tests included: a test must not script it either). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

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

  it("WARP-2980 PR-B: the build never names expected activity, a pattern flag or a verdict — baselines stay pure counts", () => {
    const build = code(join(SRC, "services", "security-baseline-build.ts"));
    expect(BUILD_NEVER.filter((re) => re.test(build)).map(String)).toEqual([]);
  });

  it("WARP-2980 PR-B (D24): no tool or MCP file names the expected-activity or verdict routes, those tables or the verdict columns", { timeout: WALK_TIMEOUT_MS }, () => {
    const files = [...sourceFiles(join(REPO_ROOT, "packages", "tools-core", "src")), ...sourceFiles(join(REPO_ROOT, "services", "mcp-server", "src"))];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => AI_NEVER.some((re) => re.test(readFileSync(f, "utf8")))).map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it.each([
    ['await fetch(`${base}/api/security/suppressions`, { method: "POST" })'],
    ["router.post('/security/incidents/:id/verdict')"],
    ["await ctx.prisma.securitySuppression.create({ data })"],
    ["await ctx.prisma.securityPatternFlag.updateMany({})"],
    ["data: { verdictCodes: [] }"],
    ["where: { verdictById: me }"],
  ])("the D24 matcher catches %j", (text) => {
    expect(AI_NEVER.some((re) => re.test(text))).toBe(true);
  });

  it.each([["security_explain_pattern"], ["/api/security/patterns/explain"], ["the verdicts of a jury"], ["SecuritySuppressionView"]])(
    "the D24 matcher lets %j through",
    (text) => {
      expect(AI_NEVER.some((re) => re.test(text))).toBe(false);
    },
  );

  it.each([["prisma.securitySuppression.findMany()"], ["type X = SecurityPatternFlag"], ["verdict: 'expected'"]])("the build matcher catches %j", (text) => {
    expect(BUILD_NEVER.some((re) => re.test(text))).toBe(true);
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
