/**
 * WARP-464 (C3) — pattern miner.
 *
 * Two layers covered:
 *   1. `detectPatterns(sequence)` — pure n-gram detector.
 *   2. `mineToolCallPatterns(prisma, now)` — end-to-end with mocked
 *      ActivityRow + ToolSpec collections.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectPatterns,
  mineToolCallPatterns,
} from "../services/pattern-miner.service.js";

interface ActivityRowMock {
  id: bigint;
  at: Date;
  refs: { name: string } | null;
}

function createPrismaMock(args: {
  rows?: ActivityRowMock[];
  existingSlugs?: string[];
} = {}) {
  const rows = args.rows ?? [];
  const existingSlugs = new Set(args.existingSlugs ?? []);
  const createdSpecs: Array<{
    slug: string;
    name: string;
    description: string | null;
    status: string;
    writes: boolean;
    reversible: boolean;
    stepCount: number;
  }> = [];
  return {
    createdSpecs,
    activityRow: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { kind: string; at: { gte: Date } };
          orderBy?: unknown;
          select?: unknown;
        }) =>
          rows
            .filter((r) => r.at >= where.at.gte)
            .sort((a, b) => a.at.getTime() - b.at.getTime()),
      ),
    },
    toolSpec: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { slug: { in: string[] } };
          select?: unknown;
        }) =>
          [...existingSlugs]
            .filter((s) => where.slug.in.includes(s))
            .map((slug, i) => ({
              id: `existing-${i}`,
              slug,
              description: "existing",
              status: "suggested",
            })),
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            slug: string;
            name: string;
            description: string | null;
            status: string;
            writes: boolean;
            reversible: boolean;
            steps: {
              create: Array<{ idx: number; kind: string; args: unknown }>;
            };
          };
        }) => {
          createdSpecs.push({
            slug: data.slug,
            name: data.name,
            description: data.description,
            status: data.status,
            writes: data.writes,
            reversible: data.reversible,
            stepCount: data.steps.create.length,
          });
          existingSlugs.add(data.slug);
          return { id: `new-${createdSpecs.length}` };
        },
      ),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Pure detector ───────────────────────────────────────────────
describe("WARP-464 — detectPatterns", () => {
  it("detects a 2-gram repeated 3+ times", () => {
    const seq = ["list_files", "read_file", "list_files", "read_file", "list_files", "read_file"];
    const patterns = detectPatterns(seq);
    const match = patterns.find(
      (p) => p.toolNames.join(",") === "list_files,read_file",
    );
    expect(match).toBeDefined();
    expect(match!.occurrences).toBeGreaterThanOrEqual(3);
  });

  it("returns empty array for too-short sequences", () => {
    expect(detectPatterns([])).toEqual([]);
    expect(detectPatterns(["list_files"])).toEqual([]);
  });

  it("ignores sub-threshold occurrences (< 3)", () => {
    const seq = ["a", "b", "a", "b"];
    expect(detectPatterns(seq).find((p) => p.toolNames.join(",") === "a,b")).toBeUndefined();
  });

  it("orders results by occurrence descending", () => {
    const seq = [
      "a", "b", "a", "b", "a", "b",          // a,b ×3
      "c", "d", "c", "d", "c", "d", "c", "d", // c,d ×4
    ];
    const patterns = detectPatterns(seq).filter((p) => p.toolNames.length === 2);
    expect(patterns[0].toolNames.join(",")).toBe("c,d");
    expect(patterns[1].toolNames.join(",")).toBe("a,b");
  });

  it("detects 3-grams alongside 2-grams", () => {
    const seq = ["a", "b", "c", "a", "b", "c", "a", "b", "c"];
    const patterns = detectPatterns(seq);
    expect(patterns.find((p) => p.toolNames.join(",") === "a,b,c")).toBeDefined();
  });

  it("respects MAX_NGRAM = 5 (no 6-grams)", () => {
    const seq: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      seq.push("a", "b", "c", "d", "e", "f");
    }
    const patterns = detectPatterns(seq);
    expect(patterns.every((p) => p.toolNames.length <= 5)).toBe(true);
  });
});

// ── End-to-end miner ─────────────────────────────────────────────
describe("WARP-464 — mineToolCallPatterns", () => {
  function rowsFor(names: readonly string[]): ActivityRowMock[] {
    const t0 = new Date("2026-05-25T08:00:00Z").getTime();
    return names.map((name, i) => ({
      id: BigInt(i + 1),
      at: new Date(t0 + i * 60_000),
      refs: { name },
    }));
  }

  it("writes a ToolSpec(status=suggested) for a repeated pattern", async () => {
    const seq = ["list_recent_files", "send_notification"];
    const repeated = [...seq, ...seq, ...seq]; // 3 occurrences
    const prisma = createPrismaMock({
      rows: rowsFor(repeated),
    });
    const result = await mineToolCallPatterns(
      prisma as any,
      new Date("2026-05-27T12:00:00Z"),
    );
    expect(result.inserted).toBeGreaterThan(0);
    expect(prisma.createdSpecs[0].status).toBe("suggested");
    expect(prisma.createdSpecs[0].name).toContain("list_recent_files");
    expect(prisma.createdSpecs[0].description).toContain("repeatedly");
    expect(prisma.createdSpecs[0].stepCount).toBe(2);
  });

  it("idempotent: a second run on the same window writes 0 new rows", async () => {
    const seq = ["a", "b"];
    const repeated = [...seq, ...seq, ...seq];
    const prisma = createPrismaMock({ rows: rowsFor(repeated) });
    const first = await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    expect(first.inserted).toBeGreaterThan(0);
    // Second pass: the slug now exists in `existingSlugs` (createPrismaMock
    // adds inserted slugs to that set in `create`).
    const second = await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it("skips rows older than the 7-day window", async () => {
    const oldRows = rowsFor(["a", "b", "a", "b", "a", "b"]).map((r) => ({
      ...r,
      at: new Date("2026-04-01T00:00:00Z"),
    }));
    const prisma = createPrismaMock({ rows: oldRows });
    const result = await mineToolCallPatterns(
      prisma as any,
      new Date("2026-05-27T12:00:00Z"),
    );
    expect(result.inspected).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it("ignores ActivityRow rows missing refs.name", async () => {
    const rows: ActivityRowMock[] = [
      { id: 1n, at: new Date("2026-05-25T08:00:00Z"), refs: null },
      { id: 2n, at: new Date("2026-05-25T08:01:00Z"), refs: { name: "list_files" } },
    ];
    const prisma = createPrismaMock({ rows });
    const result = await mineToolCallPatterns(
      prisma as any,
      new Date("2026-05-27T12:00:00Z"),
    );
    // 1 valid name → sequence too short for any 2-gram → no patterns.
    expect(result.inserted).toBe(0);
  });

  // WARP-2665 — the miner is a spec CREATION path, and it is the only one
  // that does not derive `writes` from the steps it is writing. Both routes
  // in tools.ts classify from `WRITE_TOOLS`; hardcoding `false` here mints a
  // row whose safety flag its own steps contradict. Promotion now repairs it
  // (tools.ts PATCH), but a row should not need repairing to be true, and
  // anything reading a `suggested` row before promotion — the Suggested
  // tab's safety chip, a future schedule-from-suggestion — reads the lie.
  it("derives writes:true when the mined sequence calls a requiresWrite tool", async () => {
    const seq = ["list_recent_files", "send_notification"];
    const prisma = createPrismaMock({ rows: rowsFor([...seq, ...seq, ...seq]) });
    await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    const withWriteTool = prisma.createdSpecs.filter((s) =>
      s.name.includes("send_notification"),
    );
    expect(withWriteTool.length).toBeGreaterThan(0);
    for (const spec of withWriteTool) expect(spec.writes).toBe(true);
  });

  it("leaves writes:false when every mined tool is read-only", async () => {
    const seq = ["list_recent_files", "search_files"];
    const prisma = createPrismaMock({ rows: rowsFor([...seq, ...seq, ...seq]) });
    await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    expect(prisma.createdSpecs.length).toBeGreaterThan(0);
    for (const spec of prisma.createdSpecs) expect(spec.writes).toBe(false);
  });

  // An unrecognised name cannot be classified, so it must not be treated as
  // read-only by default — but it also is not a WRITE_TOOLS member, so the
  // derivation reads false. Pinned so the posture is a decision, not an
  // accident: unknown names come from a tool that was REMOVED from the
  // registry, and a removed tool dispatches nothing.
  it("an unregistered tool name is not a write tool", async () => {
    const seq = ["no_such_tool_xyz", "another_ghost_tool"];
    const prisma = createPrismaMock({ rows: rowsFor([...seq, ...seq, ...seq]) });
    await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    expect(prisma.createdSpecs.length).toBeGreaterThan(0);
    for (const spec of prisma.createdSpecs) expect(spec.writes).toBe(false);
  });

  it("respects an already-promoted spec (any status) — won't re-suggest", async () => {
    const seq = ["a", "b"];
    const repeated = [...seq, ...seq, ...seq];
    const prisma = createPrismaMock({ rows: rowsFor(repeated) });
    // Pre-seed an existing spec at the same slug fingerprint by running once.
    await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    const beforeCount = prisma.createdSpecs.length;
    // Operator might have promoted it to draft / live — same slug still
    // matches, so a re-run is a no-op.
    const second = await mineToolCallPatterns(prisma as any, new Date("2026-05-27T12:00:00Z"));
    expect(prisma.createdSpecs.length).toBe(beforeCount);
    expect(second.inserted).toBe(0);
  });
});
