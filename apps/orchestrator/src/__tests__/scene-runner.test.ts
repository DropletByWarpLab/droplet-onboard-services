/**
 * feat/scene-schedules — executeScene shared runner.
 *
 * The idx-ordered action walk + partial-failure capture + the single
 * `smart_home` activity row were lifted out of the scenes.ts run-handler
 * so the run route AND the scene-schedule ticker share ONE path. This
 * test pins the behaviour the route test already covered (idx order, args
 * forwarding, partial-failure tolerance, activity severity) at the
 * service boundary, plus the `triggeredBy` provenance the ticker needs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { executeScene } from "../services/scene-runner.service.js";
import type { MatterDispatcher } from "../routes/scenes.js";

function scene(actions: Array<{ idx: number; deviceNodeId: string; command: string; args: unknown }>) {
  return {
    id: "scene-x",
    name: "Movie night",
    actions: actions.map((a, i) => ({ id: `a${i}`, sceneId: "scene-x", ...a })),
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("executeScene", () => {
  it("walks actions in idx order, forwards args, returns per-action results", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async (nodeId, command, args) => {
        calls.push([nodeId, command, args]);
        return { status: "ok" };
      }),
    };
    const result = await executeScene(
      {} as any,
      matter,
      scene([
        { idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        { idx: 1, deviceNodeId: "n2", command: "set_brightness", args: { brightness: 50 } },
      ]),
      { triggeredBy: "scheduler", activityActor: { type: "ai", id: null } },
    );
    expect(calls).toEqual([
      ["n1", "toggle", undefined],
      ["n2", "set_brightness", { brightness: 50 }],
    ]);
    expect(result.successCount).toBe(2);
    expect(result.actionCount).toBe(2);
    expect(result.results[0].ok).toBe(true);
  });

  it("is partial-failure tolerant: action 2 fails, action 3 still runs; severity warn", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async (nodeId) => {
        if (nodeId === "n2") throw new Error("Device n2 unreachable");
        return { status: "ok" };
      }),
    };
    const result = await executeScene(
      {} as any,
      matter,
      scene([
        { idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        { idx: 1, deviceNodeId: "n2", command: "toggle", args: null },
        { idx: 2, deviceNodeId: "n3", command: "toggle", args: null },
      ]),
      { triggeredBy: "scheduler", activityActor: { type: "ai", id: null } },
    );
    expect(result.successCount).toBe(2);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[1].error).toContain("unreachable");
    expect(result.results[2].ok).toBe(true);
    expect(recordActivityMock.mock.calls[0][0].severity).toBe("warn");
  });

  it("records ONE smart_home activity row carrying triggeredBy + actor", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async () => ({ status: "ok" })),
    };
    await executeScene(
      {} as any,
      matter,
      scene([{ idx: 0, deviceNodeId: "n1", command: "toggle", args: null }]),
      { triggeredBy: "scheduler", activityActor: { type: "ai", id: null } },
    );
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const row = recordActivityMock.mock.calls[0][0];
    expect(row.kind).toBe("smart_home");
    expect(row.what).toBe("Scene run");
    expect(row.severity).toBe("ok");
    expect(row.refs.triggeredBy).toBe("scheduler");
  });

  it("threads the actor through for an interactive run", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async () => ({ status: "ok" })),
    };
    await executeScene(
      {} as any,
      matter,
      scene([{ idx: 0, deviceNodeId: "n1", command: "toggle", args: null }]),
      {
        triggeredBy: "user",
        actor: "stefan",
        activityActor: { type: "user", id: "uuid-stefan" },
      },
    );
    expect(recordActivityMock.mock.calls[0][0].refs.actor).toBe("stefan");
    // WARP-181: the signed actor attribution rides along with the row.
    expect(recordActivityMock.mock.calls[0][0].actor).toEqual({
      type: "user",
      id: "uuid-stefan",
    });
  });
});
