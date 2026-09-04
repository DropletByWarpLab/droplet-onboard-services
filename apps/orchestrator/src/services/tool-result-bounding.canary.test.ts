/**
 * WARP-2203 — canaries. Two invariants that this branch's correctness rests on
 * and that nothing else in the repo would notice breaking.
 *
 * ## 1. `CURSOR_KEYS` has to cover the WHOLE registry
 *
 * The first version of this canary greped only
 * `packages/tools-core/src/handlers` — 74% of the wrong surface. 35 of the 137
 * registered tools have payload shapes owned by ORCHESTRATOR routes and
 * services, and `nextCursor` in `camera.service.ts` and `team-chat.ts` are real
 * cursors that grep never saw. So this walks both trees.
 *
 * A cursor key that `CURSOR_KEYS` does not know about is silently left beside a
 * shortened body — which is the exact defect WARP-2203 exists to remove. Every
 * cursor-shaped key in the producer surface must therefore be either IN
 * `CURSOR_KEYS` or on the reviewed not-a-cursor list below, with a reason.
 *
 * Matching is EXACT, never prefix: `data/date-math.ts` emits `next_weekday`,
 * which is a VALUE, and a prefix match would silently delete it.
 *
 * ## 2. The control-envelope cap must not cut anything today
 *
 * `CONTROL_ENVELOPE_CAP_CHARS` is a rail, not a transform. Dropping the loop's
 * control envelopes to 4000 would be a behaviour change to the WARP-642
 * self-correction message the moment the real registry's envelope crosses it.
 */
// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "@droplet/tools-core";
import { CURSOR_KEYS, CONTROL_ENVELOPE_CAP_CHARS } from "./tool-result-bounding.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/**
 * The producer surface: everything that can put a key on a tool-result wire
 * payload. tools-core owns 102 of the shapes; the orchestrator's routes and
 * services own the other 35.
 */
const PRODUCER_ROOTS = [
  join(REPO_ROOT, "packages", "tools-core", "src"),
  join(REPO_ROOT, "apps", "orchestrator", "src", "routes"),
  join(REPO_ROOT, "apps", "orchestrator", "src", "services"),
];

/**
 * A key that LOOKS like "call again from here". Deliberately wider than
 * `CURSOR_KEYS` — its whole job is to catch names nobody has classified yet.
 *
 * `next` alone (379 hits) is the Express middleware parameter and `nextcloud*`
 * (284 hits) is the file backend; neither can match, because the pattern
 * requires a `_` or an uppercase letter after `next`.
 */
const CURSOR_SHAPED =
  /^(next_[a-z0-9_]+|next[A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9_]*[Cc]ursor|cursor|continuation_?[Tt]oken|scroll_?[Ii]d|page_?[Tt]oken|resume_?[Tt]oken)$/;

/**
 * Cursor-SHAPED, but not a cursor. Every entry is a reviewed decision: adding
 * any of these to `CURSOR_KEYS` would delete a real value from a real payload.
 */
const NOT_A_CURSOR: Record<string, string> = {
  next_weekday: "data/date-math.ts — one of date_math's four OPERATION names, and the answer it returns",
  next_step: "routes/setup.ts — the wizard's next screen name, not a pagination token",
  nextFireAt: "routes/scenes.ts + scene-schedule-ticker — WHEN a job runs next, a timestamp",
  nextAttemptAt: "m365/delta-cursor.service.ts — retry backoff timestamp, despite the file name",
  erpSyncCursor:
    "erp-sync/cursor.service.ts — the Prisma DELEGATE for the ErpSyncCursor table on the " +
    "structural ErpCursorPrisma interface, not a paging token on any wire payload. The row it " +
    "reaches does hold a resume position (its `watermark` column), but that never crosses a " +
    "tool result: WARP-2218's poller is a cron job, not a tool. Adding it to CURSOR_KEYS would " +
    "preserve a key that is never in a payload in the first place.",
  nextSecrets:
    "saas-credential.service.ts — a LOCAL const, not a payload key: " +
    "`const nextSecrets: Record<string, string>`. declaredKeys() greps `identifier:` and so " +
    "cannot tell a TypeScript type annotation on a local from an object literal key. It holds " +
    "the credential map being assembled for sealSaasCredentials() and never reaches a wire " +
    "payload — it is the one thing in this file that must never be serialised anywhere.",
  nextConfig:
    "saas-credential.service.ts — the sibling local to nextSecrets, same annotation-not-a-key " +
    "reason: `const nextConfig: Record<string, string | number>`, the non-secret providerConfig " +
    "being assembled beside it.",
  nextRole: "routes/access.ts + people.ts — the RBAC role being transitioned TO",
  nextValue: "routes/settings.ts — the setting value being written",
  nextParam: "file-search.service.ts — a parsed query-string parameter",
  nextStorage: "routes/access.ts — the storage target being switched TO",
  nextModel: "routes/models.ts — the model id being switched TO",
  nextEnabled: "routes/settings.ts — the boolean feature state being switched TO",
};

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Every `identifier:` and `identifier?:` in the producer surface. */
function declaredKeys(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const root of PRODUCER_ROOTS) {
    for (const file of tsFilesUnder(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:^|[\s{,(])([A-Za-z][A-Za-z0-9_]*)\s*\??\s*:/g)) {
        const key = m[1];
        const where = hits.get(key);
        if (where) {
          if (!where.includes(file)) where.push(file);
        } else {
          hits.set(key, [file]);
        }
      }
    }
  }
  return hits;
}

describe("WARP-2203 canary — CURSOR_KEYS covers the whole producer surface", () => {
  const keys = declaredKeys();

  it("greps a surface that actually contains the orchestrator-owned shapes", () => {
    // Guards the canary against silently narrowing back to tools-core only:
    // `nextCursor` lives ONLY in the orchestrator half.
    expect(keys.has("nextCursor")).toBe(true);
    expect(keys.has("next_chunk")).toBe(true);
    expect(keys.has("next_offset")).toBe(true);
    expect(keys.size).toBeGreaterThan(500);
  });

  it("classifies every cursor-shaped key as either a cursor or a reviewed non-cursor", () => {
    const unclassified: string[] = [];
    for (const [key, files] of keys) {
      if (!CURSOR_SHAPED.test(key)) continue;
      if (CURSOR_KEYS.has(key)) continue;
      if (key in NOT_A_CURSOR) continue;
      unclassified.push(`${key}  (${files[0].replace(REPO_ROOT, "").replace(/\\/g, "/")})`);
    }
    // A new paging tool that names its cursor something nobody thought of is
    // exactly how a cursor survives beside a shortened body again.
    expect(unclassified).toEqual([]);
  });

  it("keeps the not-a-cursor list honest — every entry must still be reachable", () => {
    // A stale exemption is a hole: it lets a name that LATER becomes a real
    // cursor pass the canary. Anything no longer in the tree must be deleted
    // from the list, not left behind "just in case".
    const stale = Object.keys(NOT_A_CURSOR).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  it("never matches a cursor key by prefix", () => {
    // `next_weekday` is the live counter-example: `data/date-math.ts` returns
    // it as the ANSWER. A `startsWith("next_")` rule deletes it.
    expect(CURSOR_KEYS.has("next_weekday")).toBe(false);
    expect(CURSOR_KEYS.has("next_step")).toBe(false);
    for (const k of CURSOR_KEYS) expect(typeof k).toBe("string");
  });
});

describe("WARP-2203 canary — the control-envelope cap cuts nothing today", () => {
  it("fits the WARP-642 recovery message for the ENTIRE registry", () => {
    // Worst case: every registered tool advertised, and a model-authored tool
    // name at the full 64-char sanitized length.
    const names = [...TOOLS.keys()];
    expect(names.length).toBeGreaterThan(100);
    const envelope = JSON.stringify({
      status: "error",
      error: {
        code: "UNKNOWN_TOOL",
        message:
          `Unknown tool: '${"x".repeat(64)}'. ` +
          `Call one of the available tools instead: ${names.join(", ")}.`,
      },
    });
    expect(envelope.length).toBeLessThan(CONTROL_ENVELOPE_CAP_CHARS);
    // Headroom, stated. When this fails the answer is NOT to raise the cap
    // silently: it is a WARP-642 behaviour change and needs re-exercising.
    expect(CONTROL_ENVELOPE_CAP_CHARS - envelope.length).toBeGreaterThan(500);
  });
});
