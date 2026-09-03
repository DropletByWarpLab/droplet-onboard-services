/**
 * WARP-2670 — named step outputs.
 *
 * Before this, data flow between steps was one variable: `${prev}`, whole,
 * from the immediately preceding step. Step 3 could not see step 1, so any
 * routine needing two earlier results had to collapse into a single tool
 * call — the ceiling that makes a spec a pipeline rather than a procedure.
 *
 * Two properties this suite pins:
 *
 *   1. `${prev}` behaves EXACTLY as it did in C1, including resolving to
 *      `undefined` at step 0. Specs already stored on boxes were written
 *      against those semantics; making the old form strict would break
 *      running programs.
 *   2. `${steps.name}` is strict. It is new, so there is no history to
 *      preserve, and a silently-undefined argument reaching a tool is the
 *      failure mode this file's summarize contract already refuses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  runToolSpec,
  referencedStepNames,
  stepOutputName,
  type StepDispatcher,
  type Summarizer,
} from "../services/tool-spec-runner.service.js";
import { createToolsRouter } from "../routes/tools.js";
import type { AuthUser } from "../middleware/auth.js";

/** Minimal prisma double — the runner only creates a ToolRun row. */
function fakePrisma() {
  return {
    toolRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "run-1",
        ...data,
      })),
    },
  } as never;
}

const call = (
  idx: number,
  tool: string,
  args: Record<string, unknown> = {},
  as?: string,
) => ({
  id: `s${idx}`,
  idx,
  kind: "call",
  args: { tool, args, ...(as ? { as } : {}) },
});

/** A dispatcher that answers each call with the next scripted result. */
function scriptedDispatcher(results: unknown[]): StepDispatcher & {
  seen: Array<{ tool: string; args: Record<string, unknown> }>;
} {
  const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let i = 0;
  return {
    seen,
    call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      seen.push({ tool, args });
      return results[i++];
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── the runner ───────────────────────────────────────────────────
describe("WARP-2670 — a later step can read an earlier named result", () => {
  it("step 3 sees step 1 — the whole point", async () => {
    const d = scriptedDispatcher([{ id: 7 }, { unrelated: true }, null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files", {}, "files"),
        call(1, "network_summary"),
        call(2, "send_notification", { body: "${steps.files}" }),
      ],
    });
    expect(outcome.status).toBe("ok");
    // `${prev}` would have given step 2 the network summary; the name gives
    // it step 0's result instead.
    expect(d.seen[2].args.body).toEqual({ id: 7 });
  });

  it("reads a dotted path, and a numeric segment indexes an array", async () => {
    const d = scriptedDispatcher([
      { invoices: [{ id: "a", total: 40 }, { id: "b", total: 5000 }] },
      null,
    ]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files", {}, "inv"),
        call(1, "send_notification", {
          who: "${steps.inv.invoices.1.id}",
          amount: "${steps.inv.invoices.1.total}",
        }),
      ],
    });
    expect(outcome.status).toBe("ok");
    expect(d.seen[1].args).toMatchObject({ who: "b", amount: 5000 });
  });

  it("passes a null value through rather than calling it missing", async () => {
    const d = scriptedDispatcher([{ note: null }, null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files", {}, "r"),
        call(1, "send_notification", { body: "${steps.r.note}" }),
      ],
    });
    expect(outcome.status).toBe("ok");
    expect(d.seen[1].args.body).toBeNull();
  });

  it("records the published name in the trace", async () => {
    const d = scriptedDispatcher([{ ok: 1 }]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [call(0, "list_recent_files", {}, "files")],
    });
    expect(outcome.trace[0].as).toBe("files");
  });

  it("a summarize step can publish its prose under a name", async () => {
    const summarizer: Summarizer = { summarize: vi.fn(async () => "the prose") };
    const d = scriptedDispatcher([{ a: 1 }, null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      summarizer,
      steps: [
        call(0, "list_recent_files"),
        { id: "s1", idx: 1, kind: "summarize", args: { as: "brief" } },
        call(2, "send_notification", { body: "${steps.brief}" }),
      ],
    });
    expect(outcome.status).toBe("ok");
    expect(d.seen[1].args.body).toBe("the prose");
  });
});

describe("WARP-2670 — a reference the run cannot satisfy fails the step", () => {
  it("fails on an unknown name and halts the walk", async () => {
    const d = scriptedDispatcher([{ a: 1 }, null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files"),
        call(1, "send_notification", { body: "${steps.nope}" }),
        call(2, "network_summary"),
      ],
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain('no earlier step is named "nope"');
    // Step 2 was never attempted — one dispatch only.
    expect(d.seen).toHaveLength(1);
    expect(outcome.trace).toHaveLength(2);
    expect(outcome.trace[1].ok).toBe(false);
  });

  it("fails on a path the result does not have, naming where it gave up", async () => {
    const d = scriptedDispatcher([{ present: 1 }, null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files", {}, "r"),
        call(1, "send_notification", { body: "${steps.r.absent.deeper}" }),
      ],
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain('has no value at "absent"');
    expect(d.seen).toHaveLength(1);
  });

  it("fails on an out-of-range array index", async () => {
    const d = scriptedDispatcher([{ rows: [1] }, null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files", {}, "r"),
        call(1, "send_notification", { body: "${steps.r.rows.5}" }),
      ],
    });
    expect(outcome.status).toBe("failed");
    expect(d.seen).toHaveLength(1);
  });
});

describe("WARP-2670 — ${prev} is untouched", () => {
  it("still passes the whole previous result", async () => {
    const d = scriptedDispatcher([{ count: 9 }, null]);
    await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files"),
        call(1, "send_notification", { body: "${prev}" }),
      ],
    });
    expect(d.seen[1].args.body).toEqual({ count: 9 });
  });

  it("still resolves to undefined at step 0 instead of failing", async () => {
    // Back-compat, deliberately. Stored specs were written against these
    // semantics; only the NEW ${steps.x} form is strict.
    const d = scriptedDispatcher([null]);
    const { outcome } = await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [call(0, "send_notification", { body: "${prev}" })],
    });
    expect(outcome.status).toBe("ok");
    expect(d.seen[0].args.body).toBeUndefined();
  });

  it("leaves a string that merely contains a reference alone", async () => {
    // Structural substitution only — no partial interpolation, so an object
    // can never be stringified into the middle of a sentence.
    const d = scriptedDispatcher([{ a: 1 }, null]);
    await runToolSpec(fakePrisma(), d, {
      specId: "s",
      specName: "n",
      triggeredBy: null,
      steps: [
        call(0, "list_recent_files", {}, "r"),
        call(1, "send_notification", { body: "total: ${steps.r.a}" }),
      ],
    });
    expect(d.seen[1].args.body).toBe("total: ${steps.r.a}");
  });
});

describe("WARP-2670 — helpers", () => {
  it("referencedStepNames finds names nested in objects and arrays", () => {
    const found = referencedStepNames({
      a: "${steps.one}",
      b: [{ c: "${steps.two}" }, "plain"],
      d: "${prev}",
    });
    expect([...found].sort()).toEqual(["one", "two"]);
  });

  it("stepOutputName reads the name out of stored args", () => {
    expect(stepOutputName({ args: { tool: "x", args: {}, as: "n" } })).toBe("n");
    expect(stepOutputName({ args: { tool: "x", args: {} } })).toBeNull();
    expect(stepOutputName({ args: null })).toBeNull();
  });
});

// ── authoring ────────────────────────────────────────────────────
function buildApp(prisma: unknown) {
  const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({}) };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = {
      id: "user-owner",
      username: "stefan",
      displayName: "stefan",
      role: "owner",
    };
    next();
  });
  app.use("/api", createToolsRouter(prisma as never, dispatcher));
  return app;
}

function createOnlyPrisma() {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    client: {
      toolSpec: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return {
            id: "spec-1",
            version: 1,
            status: "draft",
            createdAt: new Date(),
            updatedAt: new Date(),
            category: null,
            description: null,
            share: null,
            ...data,
            steps: (
              data.steps as { create: Array<Record<string, unknown>> }
            ).create.map((s, i) => ({ id: `s${i}`, specId: "spec-1", ...s })),
          };
        }),
      },
    },
  };
}

describe("WARP-2670 — the reference graph is checked at authoring time", () => {
  const post = (steps: unknown[]) => {
    const p = createOnlyPrisma();
    return {
      p,
      res: request(buildApp(p.client))
        .post("/api/tools")
        .send({ slug: "s-lug", name: "N", steps }),
    };
  };

  it("accepts a valid graph and persists the name in the stored args", async () => {
    const { p, res } = post([
      { tool: "list_recent_files", as: "files" },
      { tool: "network_summary", args: { of: "${steps.files}" } },
    ]);
    const r = await res;
    expect(r.status).toBe(201);
    const created = p.rows[0].steps as { create: Array<{ args: Record<string, unknown> }> };
    expect(created.create[0].args.as).toBe("files");
  });

  it("refuses a FORWARD reference — the producing step comes later", async () => {
    const { res } = post([
      { tool: "network_summary", args: { of: "${steps.files}" } },
      { tool: "list_recent_files", as: "files" },
    ]);
    const r = await res;
    expect(r.status).toBe(400);
    expect(r.body.reference).toBe("files");
    expect(r.body.step).toBe(0);
  });

  it("refuses a step referring to ITSELF", async () => {
    const { res } = post([
      { tool: "network_summary", as: "me", args: { of: "${steps.me}" } },
    ]);
    const r = await res;
    expect(r.status).toBe(400);
    // Asserted on the SPECIFIC reason: a step's own name must not be visible
    // to its own args. Checking only the status would let this pass on the
    // duplicate-name error instead, which is a different bug.
    expect(r.body.error).toContain("no earlier step publishes");
    expect(r.body.reference).toBe("me");
  });

  it("refuses an unknown name", async () => {
    const { res } = post([{ tool: "network_summary", args: { of: "${steps.ghost}" } }]);
    const r = await res;
    expect(r.status).toBe(400);
    expect(r.body.reference).toBe("ghost");
  });

  it("refuses two steps publishing the same name", async () => {
    const { res } = post([
      { tool: "list_recent_files", as: "dup" },
      { tool: "network_summary", as: "dup" },
    ]);
    const r = await res;
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Two steps publish");
  });

  it("refuses a name that is not lowercase snake", async () => {
    const { res } = post([{ tool: "list_recent_files", as: "Bad-Name" }]);
    expect((await res).status).toBe(400);
  });

  it("does not check PATHS — those depend on what the tool returns at run time", async () => {
    const { res } = post([
      { tool: "list_recent_files", as: "files" },
      { tool: "network_summary", args: { of: "${steps.files.anything.at.all}" } },
    ]);
    expect((await res).status).toBe(201);
  });
});
