/**
 * WARP-1996 — seeding the `daily-report` spec.
 *
 * Two properties: it is idempotent, and re-running it NEVER overwrites an
 * existing spec. The second is the one with teeth — a re-seed that clobbered
 * operator-edited steps would silently undo their work on every boot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";
import {
  DAILY_REPORT_SLUG,
  seedDailyReportSpec,
} from "../services/daily-report-spec.service.js";

/** The shape `seedDailyReportSpec` passes to `toolSpec.create`. */
interface CreateArg {
  data: {
    status: string;
    writes: boolean;
    steps: { create: Array<{ idx: number; kind: string; args: { tool?: string } }> };
  };
}

function fakePrisma(existing: { id: string } | null) {
  const create = vi.fn(async (a: CreateArg) => a);
  return {
    create,
    client: {
      toolSpec: {
        findUnique: vi.fn(async () => existing),
        create,
      },
    } as never,
  };
}

/** Narrow the recorded call once, so each assertion stays readable. */
function createArg(create: { mock: { calls: unknown[][] } }): CreateArg {
  return create.mock.calls[0][0] as CreateArg;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("seedDailyReportSpec", () => {
  it("creates the spec when it is absent", async () => {
    const p = fakePrisma(null);
    const out = await seedDailyReportSpec(p.client);
    expect(out).toEqual({ created: true, slug: DAILY_REPORT_SLUG });
    expect(p.create).toHaveBeenCalledTimes(1);
  });

  it("leaves an EXISTING spec completely untouched", async () => {
    // The failure this pins: a boot-time re-seed silently reverting steps an
    // operator changed.
    const p = fakePrisma({ id: "spec-1" });
    const out = await seedDailyReportSpec(p.client);
    expect(out).toEqual({ created: false, slug: DAILY_REPORT_SLUG });
    expect(p.create).not.toHaveBeenCalled();
  });

  it("ships live — a draft would leave the Reports tile unable to run anything", async () => {
    const p = fakePrisma(null);
    await seedDailyReportSpec(p.client);
    expect(createArg(p.create).data.status).toBe("live");
  });

  it("is read-only — nothing in it writes, so it can run unattended", async () => {
    const p = fakePrisma(null);
    await seedDailyReportSpec(p.client);
    expect(createArg(p.create).data.writes).toBe(false);
  });

  it("ends with the summarize step — the prose is the last result", async () => {
    const p = fakePrisma(null);
    await seedDailyReportSpec(p.client);
    const steps = createArg(p.create).data.steps.create;
    expect(steps[steps.length - 1].kind).toBe("summarize");
    // Exactly one; a second would overwrite the first's prose as `prev`.
    expect(steps.filter((s) => s.kind === "summarize")).toHaveLength(1);
  });

  it("names only tools that are actually REGISTERED", async () => {
    // A name that isn't in the catalog would pass seeding and then fail the
    // §3 pre-flight at run time — a broken report on a box nobody touched.
    const p = fakePrisma(null);
    await seedDailyReportSpec(p.client);
    const known = new Set(TOOL_CATALOG.map((t: { name: string }) => t.name));
    const called = createArg(p.create).data.steps.create
      .filter((s) => s.kind === "call")
      .map((s) => s.args.tool as string);
    expect(called.length).toBeGreaterThan(0);
    for (const tool of called) expect(known.has(tool)).toBe(true);
  });

  it("numbers its steps from zero, in order", async () => {
    const p = fakePrisma(null);
    await seedDailyReportSpec(p.client);
    const idx = createArg(p.create).data.steps.create.map((s) => s.idx);
    expect(idx).toEqual(idx.map((_, i) => i));
  });
});
