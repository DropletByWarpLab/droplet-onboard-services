/**
 * WARP-1749 — the `model-id-migrate` CLI decision layer.
 *
 * The safety property under test is "report changes nothing": the default mode
 * must never reach a write path, and a typo must never be silently read as a
 * mode. Everything else here is composition and is injected.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { parseArgs, runModelIdMigrateCli, type CliDeps } from "./model-id-migrate.js";
import type { StoredModelId } from "../services/model-id-migration.service.js";

const PRISMA = {} as PrismaClient;

function deps(overrides: Partial<CliDeps> = {}, stored: StoredModelId[] = []): CliDeps {
  return {
    collect: vi.fn().mockResolvedValue(stored),
    applyForward: vi.fn().mockResolvedValue({ batchId: "batch-1", changed: 1 }),
    planBack: vi.fn().mockResolvedValue({ forwardBatchId: null, entries: [] }),
    applyBack: vi.fn().mockResolvedValue({ batchId: null, restored: 0, skippedDrifted: [] }),
    // Injected rather than stubbed through process.env: the CLI must not carry
    // its own copy of the INFERENCE_RUNTIME parsing (that lives in
    // services/inference-runtime.ts and is tested there).
    runtime: () => "ollama",
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  } as CliDeps;
}

const SESSION_ROW: StoredModelId = {
  site: "chat_session",
  rowKey: "s1",
  column: "model",
  value: "gpt-oss:20b",
};

describe("parseArgs", () => {
  it("defaults to the mode that cannot do harm", () => {
    expect(parseArgs([])).toMatchObject({ mode: "report", error: undefined });
  });

  it("rejects an unrecognised flag rather than falling back to report", () => {
    // The failure this prevents: `--aply` silently reporting, and an operator
    // walking away believing the box was migrated.
    expect(parseArgs(["--aply"]).error).toMatch(/unrecognised/);
  });

  it("rejects two modes at once", () => {
    expect(parseArgs(["--apply", "--rollback"]).error).toMatch(/mutually exclusive/);
  });

  it("takes a note value but not a following flag as one", () => {
    expect(parseArgs(["--apply", "--note", "soak"])).toMatchObject({
      mode: "apply",
      note: "soak",
    });
    expect(parseArgs(["--note", "--json"]).error).toMatch(/--note needs a value/);
  });

  it("accepts the same mode flag twice (harmless repetition)", () => {
    expect(parseArgs(["--apply", "--apply"]).error).toBeUndefined();
  });
});

describe("report mode", () => {
  it("never calls a write path", async () => {
    const d = deps({}, [SESSION_ROW]);
    const out = await runModelIdMigrateCli({ mode: "report", note: undefined, prisma: PRISMA, deps: d });
    expect(d.applyForward).not.toHaveBeenCalled();
    expect(d.applyBack).not.toHaveBeenCalled();
    expect(out.changed).toBe(0);
    expect(out.batchId).toBeNull();
    expect(out.lines.join("\n")).toContain("nothing was changed");
  });

  it("shows the planned rewrite without performing it", async () => {
    const out = await runModelIdMigrateCli({
      mode: "report",
      note: undefined,
      prisma: PRISMA,
      deps: deps({}, [SESSION_ROW]),
    });
    expect(out.plan!.changes).toHaveLength(1);
    expect(out.lines.join("\n")).toContain("gpt-oss:20b -> ai/gpt-oss");
  });

  it("warns when the runtime is not dmr (the wrong-order foot-gun)", async () => {
    const out = await runModelIdMigrateCli({
      mode: "report",
      note: undefined,
      prisma: PRISMA,
      deps: deps({ runtime: () => "ollama" }, [SESSION_ROW]),
    });
    expect(out.runtimeMismatch).toBe(true);
    expect(out.lines.join("\n")).toContain("INFERENCE_RUNTIME is not 'dmr'");
  });

  it("does not warn once the box is on dmr", async () => {
    const out = await runModelIdMigrateCli({
      mode: "report",
      note: undefined,
      prisma: PRISMA,
      deps: deps({ runtime: () => "dmr" }, [SESSION_ROW]),
    });
    expect(out.runtimeMismatch).toBe(false);
  });

  it("treats an unset INFERENCE_RUNTIME as ollama, never as dmr", async () => {
    const out = await runModelIdMigrateCli({
      mode: "report",
      note: undefined,
      prisma: PRISMA,
      deps: deps({}),
    });
    expect(out.lines[0]).toBe("Inference runtime: ollama");
  });

  it("surfaces blocked and unknown ids in the output", async () => {
    const out = await runModelIdMigrateCli({
      mode: "report",
      note: undefined,
      prisma: PRISMA,
      deps: deps({}, [
        { site: "chat_session", rowKey: "s1", column: "model", value: "llava:7b" },
        { site: "chat_session", rowKey: "s2", column: "model", value: "mystery:1b" },
      ]),
    });
    const text = out.lines.join("\n");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("llava:7b");
    expect(text).toContain("mystery:1b");
    expect(out.plan!.changes).toHaveLength(0);
  });

  it("collapses repeated values so a big chat table stays readable", async () => {
    const rows: StoredModelId[] = Array.from({ length: 50 }, (_, i) => ({
      site: "chat_message" as const,
      rowKey: `m${i}`,
      column: "model" as const,
      value: "mystery:1b",
    }));
    const out = await runModelIdMigrateCli({
      mode: "report",
      note: undefined,
      prisma: PRISMA,
      deps: deps({}, rows),
    });
    expect(out.lines.join("\n")).toContain('"mystery:1b" ×50');
  });
});

describe("apply mode", () => {
  it("passes the freshly-planned changes and the note through", async () => {
    const d = deps({}, [SESSION_ROW]);
    const out = await runModelIdMigrateCli({ mode: "apply", note: "soak", prisma: PRISMA, deps: d });
    expect(d.applyForward).toHaveBeenCalledWith(
      PRISMA,
      expect.objectContaining({ changes: expect.arrayContaining([expect.objectContaining({ after: "ai/gpt-oss" })]) }),
      "soak",
    );
    expect(out.batchId).toBe("batch-1");
    expect(out.lines.join("\n")).toContain("Undo with --rollback");
  });
});

describe("rollback mode", () => {
  it("no-ops loudly when there is no applied forward batch", async () => {
    const d = deps();
    const out = await runModelIdMigrateCli({ mode: "rollback", note: undefined, prisma: PRISMA, deps: d });
    expect(d.applyBack).not.toHaveBeenCalled();
    expect(out.lines.join("\n")).toContain("nothing to roll back");
  });

  it("warns that reverting ids while still on dmr leaves the box mismatched", async () => {
    const d = deps({
      runtime: () => "dmr",
      planBack: vi.fn().mockResolvedValue({ forwardBatchId: "b1", entries: [] }),
      applyBack: vi.fn().mockResolvedValue({ batchId: "b2", restored: 3, skippedDrifted: [] }),
    });
    const out = await runModelIdMigrateCli({ mode: "rollback", note: undefined, prisma: PRISMA, deps: d });
    expect(out.lines.join("\n")).toContain("Revert INFERENCE_RUNTIME to ollama");
    expect(out.changed).toBe(3);
  });

  it("reports rows it skipped because they drifted", async () => {
    const d = deps({
      planBack: vi.fn().mockResolvedValue({ forwardBatchId: "b1", entries: [] }),
      applyBack: vi.fn().mockResolvedValue({
        batchId: "b2",
        restored: 1,
        skippedDrifted: [
          { site: "chat_session", rowKey: "s1", column: "model", restoreTo: "x", expectCurrent: "ai/gpt-oss" },
        ],
      }),
    });
    const out = await runModelIdMigrateCli({ mode: "rollback", note: undefined, prisma: PRISMA, deps: d });
    expect(out.lines.join("\n")).toContain("SKIPPED 1 row(s) changed since the migration");
  });
});
