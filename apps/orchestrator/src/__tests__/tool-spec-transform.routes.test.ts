/**
 * WARP-2895 — the ToolSpec routes accept `transform` / `when` steps.
 *
 *   - a transform step is stored as `{ code, inputs, as? }`; `writes` is
 *     derived from the CALL steps only (a transform names no tool);
 *   - a `${steps.x}` reference inside `inputs` is checked at authoring time
 *     like a call step's args;
 *   - a transform with no code is refused; a transform is never subject to
 *     the unknown-tool check (there is no tool to check);
 *   - run-now hands the walker the injected transformer and the result of
 *     the transform reaches the run's trace.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createToolsRouter } from "../routes/tools.js";
import type { StepDispatcher, Transformer, Summarizer } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };

interface StepRow {
  id: string;
  specId: string;
  idx: number;
  kind: string;
  args: unknown;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: "live" | "draft" | "suggested";
  ownerId: string | null;
  share: string | null;
  safety: number;
  writes: boolean;
  reversible: boolean;
  createdAt: Date;
  updatedAt: Date;
  steps: StepRow[];
}

function createPrismaMock(seed: SpecRow[] = []) {
  const specs = new Map(seed.map((s) => [s.slug, s]));
  const runs: Array<{ trace: unknown; status: string }> = [];
  let n = 1;
  return {
    specs,
    runs,
    user: { findUnique: vi.fn(async () => ({ accessRoleId: null, accessRole: null })) },
    toolSpec: {
      findMany: vi.fn(async () => Array.from(specs.values()).map((s) => ({ ...s, _count: { steps: s.steps.length, runs: 0 } }))),
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) => specs.get(where.slug) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> & { steps: { create: Array<Omit<StepRow, "id" | "specId">> } } }) => {
        const id = `spec-${n++}`;
        const row: SpecRow = {
          id,
          slug: data.slug as string,
          name: data.name as string,
          category: null,
          description: null,
          version: 1,
          status: "draft",
          ownerId: (data.ownerId as string | null) ?? null,
          share: null,
          safety: 1,
          writes: data.writes as boolean,
          reversible: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          steps: data.steps.create.map((s, i) => ({ id: `s${n}-${i}`, specId: id, ...s })),
        };
        specs.set(row.slug, row);
        return row;
      }),
    },
    toolRun: {
      create: vi.fn(async ({ data }: { data: { trace: unknown; status: string } }) => {
        runs.push({ trace: data.trace, status: data.status });
        return { id: `run-${n++}`, ...data, startedAt: new Date() };
      }),
    },
  };
}

const dispatcher: StepDispatcher = { call: vi.fn(async () => [{ name: "a.pdf" }, { name: "b.pdf" }]) };
const summarizer: Summarizer = { summarize: vi.fn(async () => "two files") };

function buildApp(prisma: ReturnType<typeof createPrismaMock>, transformer: Transformer) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  app.use("/api", createToolsRouter(prisma as never, dispatcher, summarizer, transformer));
  return app;
}

const transformer: Transformer & { transform: ReturnType<typeof vi.fn> } = {
  transform: vi.fn(async (_code: string, inputs: Record<string, unknown>) => (inputs.files as unknown[]).length),
};

describe("POST /api/tools with transform / when steps", () => {
  it("accepts a transform step as a draft, derives writes from the CALL steps only, and stores code + inputs", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, transformer))
      .post("/api/tools")
      .send({
        slug: "by-customer",
        name: "By customer",
        steps: [
          { tool: "list_files", as: "files" },
          { kind: "transform", code: "output = len(inputs['files'])", inputs: { files: "${steps.files}" }, as: "n" },
          { kind: "when", code: "output = inputs['n'] > 0", inputs: { n: "${steps.n}" } },
          { kind: "summarize" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.writes).toBe(false);
    const created = prisma.toolSpec.create.mock.calls[0]![0].data as {
      steps: { create: Array<{ kind: string; args: Record<string, unknown> }> };
    };
    expect(created.steps.create[1]).toEqual({
      idx: 1,
      kind: "transform",
      args: { code: "output = len(inputs['files'])", inputs: { files: "${steps.files}" }, as: "n" },
    });
    expect(created.steps.create[2]).toEqual({
      idx: 2,
      kind: "when",
      args: { code: "output = inputs['n'] > 0", inputs: { n: "${steps.n}" } },
    });
  });

  it("refuses a transform whose inputs reference a name no earlier step publishes", async () => {
    const res = await request(buildApp(createPrismaMock(), transformer))
      .post("/api/tools")
      .send({ slug: "dangling", name: "Dangling", steps: [{ kind: "transform", code: "output = 1", inputs: { x: "${steps.nothing}" } }] });
    expect(res.status).toBe(400);
    expect(res.body.reference).toBe("nothing");
  });

  it("refuses a transform with no code; a transform alone is a valid (tool-less) draft", async () => {
    const app = buildApp(createPrismaMock(), transformer);
    expect((await request(app).post("/api/tools").send({ slug: "nocode", name: "x", steps: [{ kind: "transform", code: "" }] })).status).toBe(400);
    expect((await request(app).post("/api/tools").send({ slug: "codeonly", name: "x", steps: [{ kind: "transform", code: "output = 1" }] })).status).toBe(201);
  });
});

describe("POST /api/tools/:slug/runs with a transform step", () => {
  it("runs the transform through the injected seam and the result reaches the trace", async () => {
    const spec: SpecRow = {
      id: "spec-live",
      slug: "count-files",
      name: "Count files",
      category: null,
      description: null,
      version: 1,
      status: "live",
      ownerId: "u-owner",
      share: null,
      safety: 1,
      writes: false,
      reversible: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps: [
        { id: "s0", specId: "spec-live", idx: 0, kind: "call", args: { tool: "list_files", args: {}, as: "files" } },
        { id: "s1", specId: "spec-live", idx: 1, kind: "transform", args: { code: "output = len(inputs['files'])", inputs: { files: "${steps.files}" }, as: "n" } },
      ],
    };
    const prisma = createPrismaMock([spec]);
    const res = await request(buildApp(prisma, transformer)).post("/api/tools/count-files/runs");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(transformer.transform).toHaveBeenCalledWith("output = len(inputs['files'])", { files: [{ name: "a.pdf" }, { name: "b.pdf" }] });
    expect(res.body.trace[1]).toMatchObject({ idx: 1, tool: "(transform)", ok: true, result: 2, as: "n" });
  });
});
