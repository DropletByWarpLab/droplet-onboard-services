/**
 * WARP-1582 — where the session-claim read elision is allowed to be used.
 *
 * `resolveToolAccessScope(..., "session-claim")` trades one indexed read
 * for a bounded window in which a narrowing an admin has already applied
 * is not yet enforced. The window is closed by session revocation (every
 * path that assigns `User.accessRoleId` calls `revokeAllSessions`, and a
 * revoked sid 401s at the very next request) — but "closed by a mechanism
 * elsewhere" is a weaker guarantee than "cannot be stale", and it is not
 * the guarantee every consumer should get by default.
 *
 * So the allowance is enumerated HERE, statically, rather than left as a
 * comment for the next person to optimise past. A file-text gate in the
 * same discipline as rbac-census.guard.test.ts and
 * prisma-tx-seam-adoption.test.ts — no DB, no fixtures, default lane.
 *
 * ## The rule
 *
 * Exactly ONE production call site may pass "session-claim": the chat
 * turn in routes/llm.ts. That surface is:
 *
 *   - per-turn and latency-sensitive (the ticket's actual target);
 *   - layered — the coarse ADR-004 write filter in
 *     `narrowAllowedToolsForRole` runs off the request role, the
 *     WARP-642 replay guard runs, and tools-core's `requiresWrite` still
 *     applies, so the elided narrowing is one gate of several.
 *
 * routes/tools.ts (imperative ToolSpec run-now) is deliberately NOT on
 * the list. It executes a whole multi-step, possibly-writing sequence
 * unattended off a single request with no latency budget worth the
 * trade, and its scheduled twin already resolves against the database
 * with no claim at all (`resolveAttributedToolAccess`). Keeping run-now
 * on the database keeps the two ToolSpec entry points honest with each
 * other.
 *
 * Adding a surface here is a deliberate act. Read the trust argument at
 * the top of services/tool-access.service.ts first.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(process.cwd(), "src");

/** Production modules permitted to opt into the claim-trusted mode. */
const ALLOWED = ["routes/llm.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const isTest = (p: string) => p.endsWith(".test.ts");

const PRODUCTION = walk(SRC).filter(
  (p) => !isTest(p) && !rel(p).startsWith("__tests__/"),
);

describe("WARP-1582 — the claim-trusted tool scope is opt-in and enumerated", () => {
  it("only the enumerated surfaces pass 'session-claim'", () => {
    const users = PRODUCTION.filter((p) => {
      if (rel(p) === "services/tool-access.service.ts") return false; // the definition
      return /"session-claim"|'session-claim'/.test(readFileSync(p, "utf-8"));
    }).map(rel);

    expect(
      users.sort(),
      "a new surface opted into the WARP-1582 read elision. That is an " +
        "authorization-staleness trade, not a free speed-up — read the " +
        "trust argument in services/tool-access.service.ts, then add the " +
        "file here deliberately.",
    ).toEqual([...ALLOWED].sort());
  });

  it("the ToolSpec run-now surface still resolves against the database", () => {
    // Its scheduled twin (resolveAttributedToolAccess) has no claim to
    // trust at all. If run-now started trusting one, the same spec would
    // enforce differently depending on whether a human pressed Run.
    const tools = readFileSync(path.join(SRC, "routes", "tools.ts"), "utf-8");
    expect(tools).toContain("resolveToolAccessScope(");
    expect(tools).not.toContain("session-claim");
  });

  it("the resolver's trust parameter still DEFAULTS to the database", () => {
    // The elision must be something a call site asks for by name. If the
    // default ever flips, every existing consumer silently inherits the
    // staleness window — including ones written before it existed.
    const svc = readFileSync(
      path.join(SRC, "services", "tool-access.service.ts"),
      "utf-8",
    );
    expect(svc).toMatch(/trust:\s*ToolScopeTrust\s*=\s*"database"/);
  });
});
