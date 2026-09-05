/**
 * WARP-279 — compliance-parser unit tests.
 *
 * Drives the parser against the actual docs/compliance-progress.md so
 * any drift in its hand-edited shape is caught here. Also covers a few
 * synthetic edge cases (missing tables, malformed rows, totals row
 * skipped).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseComplianceMarkdown,
  readComplianceProgress,
} from "../services/claude-activity/compliance-parser.js";
import { repoPath } from "./helpers/test-paths.js";

describe("compliance-parser", () => {
  describe("parseComplianceMarkdown", () => {
    it("parses the live docs/compliance-progress.md", async () => {
      // The repo's own file is the canonical fixture, resolved from this
      // test file rather than the runner's cwd (WARP-2654).
      const live = await readComplianceProgress(
        repoPath("docs/compliance-progress.md"),
      );
      expect(live.parsed).toBe(true);

      // Workstream rollup has 9 named workstreams + the totals row (which
      // we skip).
      expect(live.workstreams.length).toBeGreaterThanOrEqual(9);
      const crypto = live.workstreams.find(
        (w) => w.workstream === "Cryptographic foundations",
      );
      expect(crypto).toBeDefined();
      expect(crypto?.total).toBe(8);

      // Sequential queue is exactly 50 tickets, WARP-229 → WARP-278 in
      // order.
      expect(live.queue).toHaveLength(50);
      expect(live.queue[0]?.ticket).toBe("WARP-229");
      expect(live.queue[0]?.index).toBe(1);
      expect(live.queue[49]?.ticket).toBe("WARP-278");
      expect(live.queue[49]?.index).toBe(50);
      // Every row's status is one of the small enum's values. As tickets
      // close they transition from "not_started" → "in_progress" → "done";
      // the test originally asserted all-not_started against the doc
      // snapshot, but that snapshot ages as compliance work lands.
      for (const row of live.queue) {
        expect(["not_started", "in_progress", "done", "blocked", "deferred"]).toContain(
          row.status,
        );
      }
      // At least one row should still be "not_started" — the chain has 50
      // tickets and hasn't been completed yet. (Belt-and-braces guard so
      // we'd notice if the parser silently mapped everything to "done".)
      expect(live.queue.some((row) => row.status === "not_started")).toBe(
        true,
      );

      // Audit + certification milestones: at least the SOC 2 ones.
      const milestones = live.milestones.map((m) => m.milestone);
      expect(
        milestones.some((m) => m.includes("SOC 2 Type I attestation")),
      ).toBe(true);
    });

    it("skips the **Total** workstream row", () => {
      const md = `## Workstream rollup

| Workstream | Tickets | Done | In progress | Not started |
|---|---|---|---|---|
| Crypto | 8 | 0 | 0 | 8 |
| Audit | 5 | 1 | 1 | 3 |
| **Total** | **13** | **1** | **1** | **11** |

`;
      const got = parseComplianceMarkdown(md);
      expect(got.workstreams).toHaveLength(2);
      expect(got.workstreams.map((w) => w.workstream)).toEqual([
        "Crypto",
        "Audit",
      ]);
    });

    it("classifies status emoji into the small enum", () => {
      const md = `## Sequential ticket queue

| # | Ticket | Title | Workstream | Status |
|---|---|---|---|---|
| 1 | [WARP-229](url) | Foo | Crypto | ✅ |
| 2 | [WARP-230](url) | Bar | Crypto | 🟡 |
| 3 | [WARP-231](url) | Baz | Crypto | ❌ |
| 4 | [WARP-232](url) | Quux | Crypto | 🔵 |

`;
      const { queue } = parseComplianceMarkdown(md);
      expect(queue.map((r) => [r.ticket, r.status])).toEqual([
        ["WARP-229", "done"],
        ["WARP-230", "in_progress"],
        ["WARP-231", "blocked"],
        ["WARP-232", "not_started"],
      ]);
    });

    it("returns empty arrays when sections are missing", () => {
      const got = parseComplianceMarkdown("# Random doc with no tables\n");
      expect(got.workstreams).toEqual([]);
      expect(got.queue).toEqual([]);
      expect(got.milestones).toEqual([]);
    });

    it("ignores malformed rows but keeps the well-formed ones", () => {
      const md = `## Workstream rollup

| Workstream | Tickets | Done | In progress | Not started |
|---|---|---|---|---|
| Crypto | 8 | 0 | 0 | 8 |
| GarbageRow without enough cells |
| Audit | not-a-number | 0 | 0 | 5 |
| Identity | 5 | 0 | 0 | 5 |

`;
      const got = parseComplianceMarkdown(md);
      // Crypto + Identity survive; the two malformed rows are skipped.
      expect(got.workstreams.map((w) => w.workstream)).toEqual([
        "Crypto",
        "Identity",
      ]);
    });
  });

  describe("readComplianceProgress", () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "warp-279-compliance-"));
      file = path.join(dir, "compliance-progress.md");
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("returns parsed=false on missing file without throwing", async () => {
      const got = await readComplianceProgress(
        path.join(dir, "does-not-exist.md"),
      );
      expect(got.parsed).toBe(false);
      expect(got.workstreams).toEqual([]);
      expect(got.queue).toEqual([]);
      expect(got.milestones).toEqual([]);
    });

    it("populates source_mtime_ms when the file exists", async () => {
      await writeFile(
        file,
        `# Compliance

## Workstream rollup

| Workstream | Tickets | Done | In progress | Not started |
|---|---|---|---|---|
| Crypto | 8 | 0 | 0 | 8 |

`,
        "utf8",
      );
      const got = await readComplianceProgress(file);
      expect(got.parsed).toBe(true);
      expect(got.workstreams).toHaveLength(1);
      expect(got.source_mtime_ms).toBeGreaterThan(0);
    });
  });
});
