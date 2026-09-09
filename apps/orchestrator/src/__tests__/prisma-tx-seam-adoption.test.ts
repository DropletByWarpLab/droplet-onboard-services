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
import { packagePath } from "./helpers/test-paths.js";

// Anchored to this test file, not the runner's cwd (WARP-2654).
const SRC = packagePath("src");
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
 * The isolation constants, READ OUT OF `lib/prisma-tx.ts` rather than
 * listed here (WARP-1583).
 *
 * That file is the one home for the levels this app opens transactions at.
 * Naming them in this gate instead would mean a third constant — or the
 * second one, `REPEATABLE_READ_TX`, which is how this was found — enters
 * production while the gate silently keeps scanning for the first, and every
 * suite covering the new call sites drops out of scope with nothing red.
 * A gate that has to be remembered is a gate that rots.
 */
function isolationConstants(): string[] {
  const src = readFileSync(path.join(SRC, "lib", "prisma-tx.ts"), "utf-8");
  return [...src.matchAll(/export\s+const\s+(\w+_TX)\b/g)].map((m) => m[1]);
}

/**
 * Production modules that declare a transaction isolation level — an inline
 * `{ isolationLevel: ... }`, or any of the shared constants.
 *
 * The constants match ANYWHERE in the file, not just in argument position
 * (WARP-1583). Argument position is the narrower, more literal reading of
 * "opens a transaction at this level", but it drops a module that re-exports
 * a constant out of scope — and the suites covering THAT module are exactly
 * the ones this gate wants. Over-inclusion costs a suite the harness import
 * it should have anyway; under-inclusion costs a defect class.
 */
function isolationDeclaringModules(): string[] {
  const names = isolationConstants().join("|");
  const re = new RegExp(`(isolationLevel\\s*:|\\b(${names})\\b)`);
  return ALL_TS.filter((p) => !isTest(p) && !rel(p).startsWith("__tests__/"))
    .filter((p) => re.test(readFileSync(p, "utf-8")))
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
    // mean every explicit isolation level was deleted — a far bigger problem
    // than a test-harness one, and it must not be silent.
    expect(isolationConstants().length).toBeGreaterThan(0);
    expect(isolationDeclaringModules().length).toBeGreaterThan(0);
  });

  it("scope tracks EVERY isolation constant, not just the first one", () => {
    // WARP-1583. The gate was written against `SERIALIZABLE_TX` alone, so
    // when the read-side level arrived it saw nothing: the resolver moved its
    // whole read set into a transaction and every suite covering it stayed
    // out of scope, free to hand-roll an options-dropping stub. This asserts
    // the derivation, using the module that exposed the hole.
    const declaring = isolationDeclaringModules().map(rel);
    for (const name of isolationConstants()) {
      const users = ALL_TS.filter(
        (p) =>
          !isTest(p) &&
          !rel(p).startsWith("__tests__/") &&
          new RegExp(`\\b${name}\\b`).test(readFileSync(p, "utf-8")),
      ).map(rel);
      expect(users.length, `${name} has no production call site`).toBeGreaterThan(0);
      for (const u of users) {
        expect(declaring, `${u} uses ${name} but is out of the gate's scope`).toContain(u);
      }
    }
    expect(declaring).toContain("services/effective-access.service.ts");
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
