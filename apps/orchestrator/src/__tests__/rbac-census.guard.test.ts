/**
 * WARP-1584 — the RBAC matrix must not be able to under-enforce quietly.
 *
 * rbac.test.ts is the file that decides, for ~82 guarded routes × 5 roles,
 * who may do what. It worker-crashed non-deterministically, and the failure
 * mode is worse than "a flaky suite": a crashed run had already reported
 *
 *     Tests  316 passed (496)
 *
 * — 316 of the file's 496 tests, all green, the other 180 simply never
 * asked. Nothing in the file itself noticed. Any consumer that reads
 * "0 failed" as "enforced" would have been wrong by a third of the matrix.
 *
 * The fix is layered, and this file guards the layers that live OUTSIDE
 * rbac.test.ts — deliberately a separate file, because a separate file gets
 * a separate worker: if rbac.test.ts's worker dies mid-run, its own
 * in-file census dies with it, but these assertions still report.
 *
 *   Layer 1 (diagnosability, vitest.config.ts): under the default `threads`
 *     pool a worker death exited 127 with ZERO output — no error, no test
 *     counts, no indication of which tests never ran. Under `forks` the
 *     same death is reported as an explicit "Worker exited unexpectedly"
 *     with the partial count. Pinned here so it cannot be quietly reverted.
 *   Layer 2 (census, in rbac.test.ts): every collected test must reach a
 *     terminal state, and the collected count must match the matrix.
 *     Catches the truncation shapes the process SURVIVES — a --bail, a
 *     block that failed to register, a collection cut short.
 *   Layer 3 (this file): the static bans below, which no name filter and
 *     no worker death can affect.
 *
 * The crash ITSELF is not fixed here, and the comments in rbac.test.ts are
 * explicit about what was measured: it does not reproduce under Node 20
 * (10/10 clean, and Node 20 is what CI runs), it reproduces ~1 run in 3 on
 * Node 24 at a uniformly random point, and it tracks supertest request
 * volume rather than anything in the matrix. Chasing it further belongs in
 * its own ticket. What must not wait is that a truncated run stops looking
 * like a green one — layer 2 cannot catch a hard worker death, since its
 * afterAll dies with the worker, which is exactly why layers 1 and 3 exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PACKAGE_ROOT } from "./helpers/test-paths.js";

// Anchored to this test file, not the runner's cwd (WARP-2654) — a census
// that reads a different tree's rbac.test.ts proves nothing about this one.
const ORCH = PACKAGE_ROOT;
const RBAC = path.join(ORCH, "src", "__tests__", "rbac.test.ts");
const VITEST_CONFIG = path.join(ORCH, "vitest.config.ts");

describe("WARP-1584 — the RBAC matrix cannot silently under-enforce", () => {
  it("no part of the matrix is disabled with .skip / .only / .todo", () => {
    // A worker can be filtered from OUTSIDE (`-t`), and a worker cannot see
    // that filter, so rbac.test.ts's own census must tolerate skipped
    // tests. That tolerance is only safe if nothing INSIDE the file can
    // skip itself — hence this static check, which a name filter cannot
    // affect. `.only` is equally disqualifying: it silences every sibling.
    const src = readFileSync(RBAC, "utf-8");
    const disabled = [
      ...src.matchAll(/\b(?:describe|it|test)\.(skip|only|todo|skipIf|runIf)\b/g),
    ].map((m) => m[0]);
    expect(
      disabled,
      "rbac.test.ts is the RBAC enforcement matrix — a disabled block there " +
        "is a silently unenforced route × role (WARP-1584).",
    ).toEqual([]);
  });

  it("rbac.test.ts still carries its completion census", () => {
    const src = readFileSync(RBAC, "utf-8");
    expect(
      src,
      "the census afterAll is the only thing that fails a truncated-but-" +
        "surviving run; deleting it restores the silent-partial hole.",
    ).toContain("WARP-1584 completion census");
    expect(src).toMatch(/afterAll\(/);
  });

  it("vitest pins the forks pool, so a dead worker is REPORTED not silent", () => {
    // Measured on this repo (Node 24): with the default `threads` pool a
    // crashed rbac run exited 127 printing nothing at all — no error, no
    // counts. With `forks` the same crash printed "Worker exited
    // unexpectedly" and "Tests 316 passed (496)". Same red build; the
    // difference is whether anyone can tell WHAT broke.
    const config = readFileSync(VITEST_CONFIG, "utf-8");
    expect(
      config,
      'apps/orchestrator/vitest.config.ts must pin pool: "forks" (WARP-1584).',
    ).toMatch(/pool:\s*["']forks["']/);
  });
});
