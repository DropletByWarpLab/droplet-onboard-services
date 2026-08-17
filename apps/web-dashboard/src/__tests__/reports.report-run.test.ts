/**
 * WARP-1996 — pulling the narrative out of a tool-spec run.
 *
 * The report has no column of its own: it is the `summarize` step's result
 * inside the run trace. That makes `reportFromRun` the seam where a
 * half-finished run either becomes a report or correctly becomes nothing —
 * and "correctly becomes nothing" is the one that matters, because a partial
 * paragraph on screen reads as a finished report.
 */
import { describe, it, expect } from "vitest";
import { SUMMARIZE_PSEUDO_TOOL, reportFromRun, type ToolRunRow } from "@/app/reports/api";

const run = (over: Partial<ToolRunRow> = {}): ToolRunRow => ({
  id: "run-1",
  startedAt: "2026-08-14T09:38:00.000Z",
  endedAt: "2026-08-14T09:41:00.000Z",
  status: "ok",
  error: null,
  trace: [
    { idx: 0, tool: "get_system_health", ok: true, result: { status: "ok" } },
    { idx: 1, tool: "list_recent_files", ok: true, result: { count: 9 } },
    { idx: 2, tool: SUMMARIZE_PSEUDO_TOOL, ok: true, result: "Nine files landed." },
  ],
  ...over,
});

describe("reportFromRun", () => {
  it("takes the prose from the summarize step's result", () => {
    expect(reportFromRun(run())?.prose).toBe("Nine files landed.");
  });

  it("derives the source chips from the tools that actually ran", () => {
    // Derived, not hardcoded — a spec change updates the chips with no edit
    // to the tile.
    expect(reportFromRun(run())?.sources).toEqual(["get_system_health", "list_recent_files"]);
  });

  it("does not count the summarize step as one of its own sources", () => {
    expect(reportFromRun(run())?.sources).not.toContain(SUMMARIZE_PSEUDO_TOOL);
  });

  it("returns null when the summarize step FAILED — no partial report", () => {
    // The failure this pins: rendering the earlier steps as though a report
    // had been written.
    const r = run({
      status: "failed",
      trace: [
        { idx: 0, tool: "get_system_health", ok: true, result: {} },
        { idx: 1, tool: SUMMARIZE_PSEUDO_TOOL, ok: false, error: "model unreachable" },
      ],
    });
    expect(reportFromRun(r)).toBeNull();
  });

  it("returns null when the summarize step failed BUT left partial prose behind", () => {
    // The sharper version of the case above, and the one that actually
    // exercises the `ok` filter: a generation that produced text and then
    // errored leaves a `result` AND `ok: false`. Reading the text would put
    // half a paragraph on screen looking like a finished report.
    const r = run({
      status: "failed",
      trace: [
        {
          idx: 0,
          tool: SUMMARIZE_PSEUDO_TOOL,
          ok: false,
          result: "Nine files landed in Oper",
          error: "stream aborted",
        },
      ],
    });
    expect(reportFromRun(r)).toBeNull();
  });

  it("returns null when there is no summarize step at all", () => {
    const r = run({ trace: [{ idx: 0, tool: "get_system_health", ok: true, result: {} }] });
    expect(reportFromRun(r)).toBeNull();
  });

  it("returns null for empty or whitespace prose", () => {
    // An empty narrative would render as a report with nothing to say, which
    // is indistinguishable from a quiet day.
    for (const result of ["", "   ", "\n\n"]) {
      expect(reportFromRun(run({ trace: [{ idx: 0, tool: SUMMARIZE_PSEUDO_TOOL, ok: true, result }] }))).toBeNull();
    }
  });

  it("returns null when the result is not a string", () => {
    const r = run({ trace: [{ idx: 0, tool: SUMMARIZE_PSEUDO_TOOL, ok: true, result: { oops: 1 } }] });
    expect(reportFromRun(r)).toBeNull();
  });

  it("tolerates a null trace", () => {
    expect(reportFromRun(run({ trace: null }))).toBeNull();
  });

  it("stamps the report at the run's END, falling back to its start", () => {
    // The end is when the prose actually existed.
    expect(reportFromRun(run())?.at).toBe("2026-08-14T09:41:00.000Z");
    expect(reportFromRun(run({ endedAt: null }))?.at).toBe("2026-08-14T09:38:00.000Z");
  });

  it("still yields a report from a 207 run whose EARLIER step failed", () => {
    // A tool that couldn't be read is a fact the narrative reports; it does
    // not invalidate the narrative.
    const r = run({
      status: "failed",
      trace: [
        { idx: 0, tool: "erp_get_ar_summary", ok: false, error: "ERP_NOT_CONNECTED" },
        { idx: 1, tool: SUMMARIZE_PSEUDO_TOOL, ok: true, result: "No accounting system is connected." },
      ],
    });
    const out = reportFromRun(r);
    expect(out?.prose).toBe("No accounting system is connected.");
    expect(out?.sources).toEqual(["erp_get_ar_summary"]);
  });
});
