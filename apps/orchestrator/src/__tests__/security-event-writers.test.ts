/**
 * WARP-2978 (ADR-059 P3 spec §6.1 step 3, R7) — the SecurityEvent writers,
 * pinned CALL SITE by call site.
 *
 * The incident engine's triage floor is gap-safe only because every
 * transaction that writes a SecurityEvent ends within 60 s: the floor moves to
 * a head read two minutes earlier, and a writer still open by then would have
 * its row skipped — silently and forever. So every writer is reviewed against
 * that bound, and this file is how a NEW one gets noticed. It scans every
 * production `.ts` under `src/` for
 *   · a Prisma write — `securityEvent.create(` / `.createMany(` /
 *     `.createManyAndReturn(` — and pins each one as `<file>#<function>`: a
 *     second writer added to a file that already has one fails too (review
 *     #10), while an edit elsewhere in the file does not churn the list;
 *   · raw SQL — `INSERT INTO "SecurityEvent"` / `COPY "SecurityEvent"` —
 *     which must not exist at all.
 * A new site fails here until it is added below with the reason its
 * transaction is short.
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
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const PRODUCTION = walk(SRC)
  .map((full) => ({ full, rel: path.relative(SRC, full).split(path.sep).join("/") }))
  .filter(({ rel }) => !rel.endsWith(".test.ts") && !rel.split("/").includes("__tests__"))
  .map(({ full, rel }) => ({ rel, code: blankComments(readFileSync(full, "utf8")) }));

const PRISMA_WRITE = /\bsecurityEvent\s*\.\s*(?:create|createMany|createManyAndReturn)\s*\(/g;
const PRISMA_UPDATE = /\bsecurityEvent\s*\.\s*(?:update|updateMany|upsert)\s*\(/g;
const RAW_WRITE = /\b(?:INSERT\s+INTO|COPY)\s+(?:"?public"?\s*\.\s*)?"SecurityEvent"(?=[\s(])/gi;
const RAW_UPDATE = /\bUPDATE\s+(?:"?public"?\s*\.\s*)?"SecurityEvent"(?=\s)/gi;

/** The name of the function a position sits in: the nearest preceding declaration. */
function enclosingFunction(code: string, at: number): string {
  const decl = /(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)/g;
  let name = "<module>";
  for (const m of code.matchAll(decl)) {
    if (m.index! >= at) break;
    name = m[1] ?? m[2] ?? name;
  }
  return name;
}

/** Every match of `re` in `files`, as `<file>#<function>`, sorted. */
function sites(files: ReadonlyArray<{ rel: string; code: string }>, re: RegExp): string[] {
  const out: string[] = [];
  for (const { rel, code } of files) {
    for (const m of code.matchAll(re)) out.push(`${rel}#${enclosingFunction(code, m.index!)}`);
  }
  return out.sort();
}

/** Every writer, and why its transaction is short. */
const WRITERS: ReadonlyArray<readonly [site: string, why: string]> = [
  ["services/security-events.service.ts#recordSecurityEvent", "an autocommit createMany of one row (one statement)"],
  ["services/security-events.service.ts#mirrorThreatRows", "an autocommit createMany of ≤ 500 rows (one statement)"],
  [
    "services/security-mode.service.ts#insertModeChangedRow",
    "inside a mode/hours READ COMMITTED interactive transaction (Prisma's default 5 s timeout)",
  ],
];

describe("SecurityEvent writers — the floor's 60 s bound is reviewed per call site (R7)", () => {
  it("the Prisma writers are exactly the pinned call sites", () => {
    expect(sites(PRODUCTION, PRISMA_WRITE)).toEqual(WRITERS.map(([site]) => site).sort());
  });

  it("no raw SQL writes a SecurityEvent (review #10)", () => {
    expect(sites(PRODUCTION, RAW_WRITE)).toEqual([]);
  });

  it("nothing updates or upserts a SecurityEvent (D11 — the table is append-only)", () => {
    expect(sites(PRODUCTION, PRISMA_UPDATE)).toEqual([]);
    expect(sites(PRODUCTION, RAW_UPDATE)).toEqual([]);
  });

  it("the scan can see a writer (a check that cannot fail proves nothing)", () => {
    expect(PRODUCTION.length).toBeGreaterThan(100);
    const fixture = {
      rel: "services/fixture.ts",
      code: blankComments(`
        // prisma.securityEvent.create({}) in a comment does not count
        export async function recordSecurityEvent(p) { await p.securityEvent.createMany({ data: [] }); }
        async function second(p) { await p.securityEvent.create({ data: {} }); }
        const third = async (tx) => { await tx.securityEvent.createManyAndReturn({ data: [] }); };
        export async function raw(p) {
          await p.$executeRawUnsafe('INSERT INTO "SecurityEvent" ("source") VALUES ($1)', "x");
          await p.$executeRaw\`insert into public."SecurityEvent"(kind) values ('x')\`;
          await p.$executeRawUnsafe('INSERT INTO "SecurityEventTriage" ("eventId") VALUES (1)');
        }
      `),
    };
    expect(sites([fixture], PRISMA_WRITE)).toEqual([
      "services/fixture.ts#recordSecurityEvent",
      "services/fixture.ts#second",
      "services/fixture.ts#third",
    ]);
    // Two raw writes to SecurityEvent (either spelling); the triage table is not one.
    expect(sites([fixture], RAW_WRITE)).toEqual(["services/fixture.ts#raw", "services/fixture.ts#raw"]);
  });
});
