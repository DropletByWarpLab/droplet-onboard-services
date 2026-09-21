/**
 * WARP-2895 (ADR-047 §4, ADR-056 §6.3) — `transform` and `when` steps.
 *
 *   1. A transform reads the named outputs its `inputs` reference, runs
 *      through the Transformer seam, and publishes its result under `as`.
 *   2. A `when` whose result is falsy ENDS the walk cleanly: status `ok`,
 *      the remaining steps never dispatch, and the trace says how many were
 *      skipped. Truthy continues.
 *   3. NEITHER KIND DISPATCHES A TOOL — the dispatcher is never called for
 *      one, `plannedToolNames` ignores them, and so the `writes` derivation
 *      cannot see them. This is the property ROUTINES brief §4.4 says to
 *      guard: the day "transform can call a tool" is added, this goes red
 *      and the safety gate's inference is revisited on purpose.
 * 4. No transformer configured → the step fails honestly, never passes its
 *      inputs through as if it had run.
 *   5. A transformer error (timeout, output cap, a refused import) is a
 *      failed step with the service's own message.
 *   6. A bad `${steps.x}` reference in `inputs` is a failed step, not a throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
    SANDBOX_URL: "http://sandbox:8030",
    SANDBOX_SERVICE_TOKEN: "",
    SANDBOX_TRANSFORM_TIMEOUT_MS: 10_000,
    SANDBOX_OUTPUT_CAP_BYTES: 262_144,
  },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import {
  TRANSFORM_PSEUDO_TOOL,
  WHEN_PSEUDO_TOOL,
  plannedToolNames,
  runToolSpec,
  type StepDispatcher,
  type Transformer,
} from "../services/tool-spec-runner.service.js";
import { writeToolsIn } from "../services/tool-access.service.js";

function fakePrisma() {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    client: {
      toolRun: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "run-1", ...data };
        }),
      },
    } as never,
  };
}

const callStep = (idx: number, tool: string, as?: string) => ({
  id: `s${idx}`,
  idx,
  kind: "call",
  args: { tool, args: {}, ...(as ? { as } : {}) },
});
const transformStep = (idx: number, code: string, inputs: Record<string, unknown> = {}, as?: string) => ({
  id: `s${idx}`,
  idx,
  kind: "transform",
  args: { code, inputs, ...(as ? { as } : {}) },
});
const whenStep = (idx: number, code: string, inputs: Record<string, unknown> = {}) => ({
  id: `s${idx}`,
  idx,
  kind: "when",
  args: { code, inputs },
});

function transformerReturning(fn: (code: string, inputs: Record<string, unknown>) => unknown): Transformer & {
  transform: ReturnType<typeof vi.fn>;
} {
  return { transform: vi.fn(async (code: string, inputs: Record<string, unknown>) => fn(code, inputs)) };
}

const run = (
  steps: Array<{ id: string; idx: number; kind: string; args: unknown }>,
  dispatcher: StepDispatcher,
  transformer?: Transformer | null,
) =>
  runToolSpec(fakePrisma().client, dispatcher, {
    specId: "spec-1",
    specName: "test",
    steps,
    triggeredBy: "test",
    ...(transformer !== undefined ? { transformer } : {}),
  });

beforeEach(() => vi.clearAllMocks());

describe("transform — a pure function over the run's named results", () => {
  it("reads ${steps.x} in its inputs, runs through the seam, and publishes `as`", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn(async () => [{ customer: "a", amount: 10 }]) };
    const transformer = transformerReturning((_code, inputs) => ({
      count: (inputs.invoices as unknown[]).length,
    }));
    const { outcome } = await run(
      [
        callStep(0, "list_files", "invoices"),
        transformStep(1, "output = {'count': len(inputs['invoices'])}", { invoices: "${steps.invoices}" }, "by_customer"),
        callStep(2, "list_recent_files"),
      ],
      dispatcher,
      transformer,
    );
    expect(outcome.status).toBe("ok");
    expect(transformer.transform).toHaveBeenCalledWith("output = {'count': len(inputs['invoices'])}", {
      invoices: [{ customer: "a", amount: 10 }],
    });
    expect(outcome.trace[1]).toMatchObject({
      idx: 1,
      tool: TRANSFORM_PSEUDO_TOOL,
      ok: true,
      result: { count: 1 },
      as: "by_customer",
    });
    // The walk went on.
    expect(outcome.trace).toHaveLength(3);
  });

  it("NEVER dispatches a tool, and is invisible to plannedToolNames and the writes derivation", async () => {
    // MUTATION: route a transform through `dispatcher.call` and this goes
    // red — and so does the safety gate's assumption that a transform
    // cannot write (ROUTINES brief §4.4).
    const dispatcher: StepDispatcher = { call: vi.fn(async () => "never") };
    const transformer = transformerReturning(() => 42);
    const steps = [transformStep(0, "output = 42", {}, "x"), whenStep(1, "output = True")];
    const { outcome } = await run(steps, dispatcher, transformer);
    expect(outcome.status).toBe("ok");
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(plannedToolNames(steps)).toEqual([]);
    expect(writeToolsIn(plannedToolNames([...steps, callStep(2, "send_notification")]))).toEqual(["send_notification"]);
  });

  it("fails honestly with no sandbox configured — inputs never pass through as a result", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn(async () => "r") };
    const { outcome } = await run([transformStep(0, "output = 1", { a: 1 }, "x"), callStep(1, "list_files")], dispatcher, null);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("step 0: transform step but no sandbox configured");
    expect(outcome.trace[0]).toMatchObject({ tool: TRANSFORM_PSEUDO_TOOL, ok: false });
    expect(dispatcher.call).not.toHaveBeenCalled();
  });

  it("relays the sandbox's own error as a failed step (output cap, timeout, refused import)", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn(async () => "r") };
    for (const message of ["output exceeded 1024 bytes", "transform exceeded 500 ms", "import os is not allowed in a transform step; allowed: json, math"]) {
      const transformer: Transformer = { transform: vi.fn(async () => { throw new Error(message); }) };
      const { outcome } = await run([transformStep(0, "x"), callStep(1, "list_files")], dispatcher, transformer);
      expect(outcome.status).toBe("failed");
      expect(outcome.error).toBe(`step 0 (transform): ${message}`);
    }
    expect(dispatcher.call).not.toHaveBeenCalled();
  });

  it("a bad ${steps.x} reference in inputs is a failed step, not a throw", async () => {
    const transformer = transformerReturning(() => 1);
    const { outcome } = await run([transformStep(0, "x", { a: "${steps.nothing}" })], { call: vi.fn() }, transformer);
    expect(outcome.status).toBe("failed");
    expect(outcome.trace[0]).toMatchObject({ tool: TRANSFORM_PSEUDO_TOOL, ok: false });
    expect(outcome.error).toMatch(/nothing/);
    expect(transformer.transform).not.toHaveBeenCalled();
  });
});

describe("when — guards continuation", () => {
  it("a falsy result ends the walk cleanly: status ok, later steps skipped, the trace says so", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn(async () => []) };
    const transformer = transformerReturning((_c, inputs) => (inputs.items as unknown[]).length > 0);
    const { outcome } = await run(
      [
        callStep(0, "list_files", "items"),
        whenStep(1, "output = len(inputs['items']) > 0", { items: "${steps.items}" }),
        callStep(2, "send_notification"),
        callStep(3, "list_recent_files"),
      ],
      dispatcher,
      transformer,
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.error).toBeNull();
    expect(outcome.trace).toHaveLength(2);
    expect(outcome.trace[1]).toMatchObject({ tool: WHEN_PSEUDO_TOOL, ok: true, result: false, skippedRemaining: 2 });
    // The gated write never ran.
    expect(dispatcher.call).toHaveBeenCalledTimes(1);
  });

  it("a truthy result continues", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn(async () => [1]) };
    const transformer = transformerReturning(() => true);
    const { outcome } = await run(
      [callStep(0, "list_files", "items"), whenStep(1, "output = True"), callStep(2, "list_recent_files")],
      dispatcher,
      transformer,
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.trace).toHaveLength(3);
    expect(outcome.trace[1]).toMatchObject({ tool: WHEN_PSEUDO_TOOL, result: true });
    expect(outcome.trace[1]).not.toHaveProperty("skippedRemaining");
    expect(dispatcher.call).toHaveBeenCalledTimes(2);
  });
});
