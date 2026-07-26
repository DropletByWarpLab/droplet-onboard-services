/**
 * WARP-1570 — the seam-adoption gate.
 *
 * Promoting the transaction seam to `helpers/prisma-tx-harness.ts` only
 * helps if suites actually inherit it. This is the enforcement: a
 * file-text regression gate in the same discipline as
 * access-role.schema.test.ts and pg-lane-image-parity.test.ts — no DB, no
 * fixtures, runs in the default vitest lane.
 *
 * ## The rule
 *
 * A test file must not hand-roll an opts-dropping `$transaction` stub
 *
 *     $transaction: async (fn) => fn(self)     // ← the options argument
 *                                              //   is silently discarded
 *
 * IF it drives production code that declares an isolation level. Those are
 * exactly the suites where the discarded argument is load-bearing: the
 * route asks for `Serializable`, the stub cannot see it, and a regression
 * that drops the option keeps the suite green. That is how five defect
 * classes shipped during epic WARP-1522.
 *
 * ## Why it is scoped, and not "every stub in the repo"
 *
 * There are ~60 inline `$transaction` stubs across this app. Most sit in
 * front of code that never passes an isolation level, where the dropped
 * argument is always `undefined` and the stub is honest. Failing those
 * would be churn, and churn is how a gate gets an allowlist bolted on and
 * then rots. This gate instead DERIVES its scope from production code —
 * add `SERIALIZABLE_TX` to a new call site and every suite covering that
 * module is pulled in automatically, with no list to maintain here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const HARNESS = "prisma-tx-harness";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ALL_TS = walk(SRC);
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const isTest = (p: string) => p.endsWith(".test.ts");

/**
 * Production modules that hand `$transaction` an isolation level — either
 * an inline `{ isolationLevel: ... }` or the shared `SERIALIZABLE_TX`
 * constant in argument position.
 */
function isolationDeclaringModules(): string[] {
  return ALL_TS.filter((p) => !isTest(p) && !rel(p).startsWith("__tests__/"))
    .filter((p) =>
      /(isolationLevel\s*:|SERIALIZABLE_TX\s*[,)])/.test(
        readFileSync(p, "utf-8"),
      ),
    )
    .sort();
}

/** Every relative `from "./x.js"` / `vi.mock("./x.js")` target, resolved. */
function resolvedImports(file: string): string[] {
  const src = readFileSync(file, "utf-8");
  const re = /from\s+["'](\.[^"']+)\.js["']|vi\.mock\(\s*["'](\.[^"']+)\.js["']/g;
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2];
    out.push(path.resolve(path.dirname(file), `${spec}.ts`));
  }
  return out;
}

/**
 * Does this file define its own `$transaction`, rather than inherit one?
 *
 * Deliberately a presence check, not an arity check. An earlier draft of
 * this gate parsed the stub's parameter list to spot the 1-param shape, and
 * its regex could not survive a nested paren in a parameter TYPE
 * (`fn: (tx: T) => Promise<unknown>`), so it misread a correct 2-param stub
 * as an offender. A gate that needs a TypeScript parser to be right is a
 * gate that will quietly go wrong. "Binds the options argument" is also the
 * weaker property anyway: it buys the options assertion and nothing else —
 * no rollback, no second concurrent transaction. Inheriting the seam buys
 * all three.
 */
function definesOwnTransactionStub(src: string): boolean {
  return /\$transaction\s*[:=]/.test(src) || /async\s+\$transaction\s*[<(]/.test(src);
}

describe("WARP-1570 — the shared transaction seam is actually inherited", () => {
  it("the shared harness exists where suites are told to import it from", () => {
    const harness = ALL_TS.map(rel).filter((p) => p.includes(HARNESS));
    expect(harness).toContain("__tests__/helpers/prisma-tx-harness.ts");
  });

  it("production still declares isolation levels somewhere (the gate is not vacuous)", () => {
    // If this list ever empties, the gate below passes trivially. That would
    // mean every explicit `SERIALIZABLE_TX` was deleted — a far bigger
    // problem than a test-harness one, and it must not be silent.
    expect(isolationDeclaringModules().length).toBeGreaterThan(0);
  });

  it("no suite covering an isolation-declaring module hand-rolls its own $transaction", () => {
    const iso = new Set(isolationDeclaringModules());
    const offenders: string[] = [];

    for (const file of ALL_TS.filter(isTest)) {
      const src = readFileSync(file, "utf-8");
      if (!definesOwnTransactionStub(src)) continue;
      if (src.includes(HARNESS)) continue; // inherits the seam

      const covered = resolvedImports(file).filter((t) => iso.has(t));
      if (covered.length === 0) continue;

      offenders.push(
        `${rel(file)} — hand-rolls $transaction, covers ${covered
          .map(rel)
          .join(", ")}`,
      );
    }

    expect(
      offenders,
      "These suites drive code that asks for a specific isolation level, but " +
        "hand-roll their own $transaction stub. The shape those stubs " +
        "converge on discards the options argument, never rolls back, and " +
        "runs transactions strictly serially — so dropping `SERIALIZABLE_TX` " +
        "from the route under test would not fail anything here. Import " +
        "createTransactionSeam from __tests__/helpers/prisma-tx-harness.js " +
        "instead (WARP-1570).\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
