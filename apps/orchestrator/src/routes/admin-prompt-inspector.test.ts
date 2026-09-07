/**
 * WARP-2823 — the inspector endpoints, as they actually answer.
 *
 * The services have their own suites; this file is about the three things only
 * the route decides: who may call it, that reading somebody's prompt leaves a
 * trace, and that the trace does not copy the thing being read.
 *
 * That last one is the WARP-2785 shape in a new place. An audit row exists so
 * a privileged look can be reviewed later — and an audit row that carried the
 * prompt text would put durable memory facts and business context into a
 * second table with a different retention story, which is a leak dressed as
 * accountability.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const mocks = vi.hoisted(() => ({
  recordActivity: vi.fn(async () => undefined),
  inspectTools: vi.fn(),
  inspectPrompt: vi.fn(),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: mocks.recordActivity,
}));
vi.mock("../services/activity.service.js", () => ({
  actorFromRequest: () => ({ type: "user", id: "admin-1" }),
}));
vi.mock("../services/tool-inspect.service.js", () => ({
  inspectToolsForPerson: mocks.inspectTools,
}));
vi.mock("../services/prompt-inspect.service.js", () => ({
  inspectPromptForPerson: mocks.inspectPrompt,
}));

import { createAdminPromptInspectorRouter } from "./admin-prompt-inspector.js";

const prisma = {} as never;

function appAs(role: string | undefined) {
  const app = express();
  app.use((req, _res, next) => {
    if (role) (req as unknown as { user: { role: string; id: string } }).user = {
      role,
      id: "admin-1",
    };
    next();
  });
  app.use("/api", createAdminPromptInspectorRouter(prisma));
  return app;
}

const TOOLS_RESULT = {
  targetUserId: "u1",
  tier: "family",
  unresolved: null,
  noRoleNarrowing: false,
  counts: { registered: 139, advertised: 7, withheld: 132, byGate: {} },
  rows: [
    { name: "read_file", advertised: true },
    { name: "set_wifi_ssid", advertised: false },
  ],
};

const PROMPT_RESULT = {
  targetUserId: "u1",
  tier: "family",
  unresolved: null,
  blocks: [],
  assembled: "IDENTITY\n\nMEMORY: the safe combination is 1234",
  assembledChars: 44,
  erroredBlocks: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectTools.mockResolvedValue(TOOLS_RESULT);
  mocks.inspectPrompt.mockResolvedValue(PROMPT_RESULT);
});

// ── access ──────────────────────────────────────────────────────────────────

describe("🔴 only owner and admin may look at somebody else's assistant", () => {
  for (const [role, status] of [
    ["owner", 200],
    ["admin", 200],
    ["family", 403],
    ["guest", 403],
    ["service", 403],
    [undefined, 403],
  ] as const) {
    it(`${role ?? "no session"} → ${status} on both endpoints`, async () => {
      const app = appAs(role);
      expect((await request(app).get("/api/admin/tool-inspect/u1")).status).toBe(status);
      expect((await request(app).get("/api/admin/prompt-inspect/u1")).status).toBe(status);
    });
  }

  it("a denied caller reaches no service at all", async () => {
    // The guard has to be the whole answer: nothing downstream re-checks, and
    // a service that ran before the 403 would have already read the target's
    // brain and memory facts.
    await request(appAs("family")).get("/api/admin/prompt-inspect/u1");
    expect(mocks.inspectPrompt).not.toHaveBeenCalled();
    expect(mocks.inspectTools).not.toHaveBeenCalled();
  });
});

// ── whose reach, on which turn ──────────────────────────────────────────────

describe("🔴 the path parameter is the target, and the query models the turn", () => {
  it("passes the target id, not the caller's", async () => {
    await request(appAs("owner")).get("/api/admin/tool-inspect/someone-else");
    expect(mocks.inspectTools).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ targetUserId: "someone-else" }),
    );
  });

  it("carries message, offLan, interview and voice through", async () => {
    await request(appAs("owner")).get(
      "/api/admin/tool-inspect/u1?message=find+the+contract&offLan=1&interview=true&voice=1",
    );
    expect(mocks.inspectTools).toHaveBeenCalledWith(prisma, {
      targetUserId: "u1",
      message: "find the contract",
      offLan: true,
      interview: true,
      voice: true,
    });
  });

  it("treats an absent or non-truthy flag as false, and a missing message as empty", async () => {
    // `?offLan=0` reading as true would silently show every admin an off-LAN
    // turn and make the file tools look permanently withheld.
    await request(appAs("owner")).get("/api/admin/tool-inspect/u1?offLan=0");
    expect(mocks.inspectTools).toHaveBeenCalledWith(prisma, {
      targetUserId: "u1",
      message: "",
      offLan: false,
      interview: false,
      voice: false,
    });
  });

  it("🔴 hands the prompt composer the ADVERTISED tools, from the tool inspector", async () => {
    // Not a second derivation. `composeToolGuidance` must never name a tool
    // the person cannot call (WARP-642), and the advertised set is the only
    // list that satisfies that — deriving it twice is the drift this whole
    // slice exists to make visible.
    await request(appAs("owner")).get("/api/admin/prompt-inspect/u1");
    expect(mocks.inspectPrompt).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ allowedToolNames: ["read_file"] }),
    );
  });

  it("sends `undefined` for an owner, which is the builder's own encoding", async () => {
    // `buildBaseSystemPrompt` reads undefined as "privileged, every tool". An
    // owner arriving as a 139-name list would compose guidance by a different
    // path than the turn does.
    mocks.inspectTools.mockResolvedValue({
      ...TOOLS_RESULT,
      tier: "owner",
      noRoleNarrowing: true,
    });
    await request(appAs("owner")).get("/api/admin/prompt-inspect/u1");
    expect(mocks.inspectPrompt).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ allowedToolNames: undefined }),
    );
  });
});

// ── the audit row ───────────────────────────────────────────────────────────

describe("🔴 looking leaves a trace, and the trace carries no content", () => {
  it("records one row per inspect", async () => {
    await request(appAs("owner")).get("/api/admin/prompt-inspect/u1");
    expect(mocks.recordActivity).toHaveBeenCalledTimes(1);
    const row = mocks.recordActivity.mock.calls[0]![0] as {
      kind: string;
      severity: string;
      refs: Record<string, unknown>;
    };
    expect(row.kind).toBe("system");
    expect(row.severity).toBe("info");
    expect(row.refs.target).toBe("u1");
    expect(row.refs.by).toBe("admin-1");
  });

  it("🔴 never copies the prompt text into the row", async () => {
    // The assembled prompt carries durable memory facts and business context.
    // An audit row that copied them would put the very thing this endpoint
    // exists to inspect into a second table under a different retention rule.
    await request(appAs("owner")).get("/api/admin/prompt-inspect/u1");
    const serialized = JSON.stringify(mocks.recordActivity.mock.calls[0]![0]);
    expect(serialized).not.toContain("safe combination");
    expect(serialized).not.toContain("IDENTITY");
  });

  it("🔴 never copies a tool list into the row", async () => {
    await request(appAs("owner")).get("/api/admin/tool-inspect/u1");
    const serialized = JSON.stringify(mocks.recordActivity.mock.calls[0]![0]);
    expect(serialized).not.toContain("set_wifi_ssid");
    expect(serialized).not.toContain("read_file");
    // Counts, which are the point of the row, do survive.
    expect(serialized).toContain("139");
  });

  it("🔴 a failing audit write does not fail the read", async () => {
    // The precedent is routes/logs.ts: finalize first, record detached. An
    // admin diagnosing a box with a struggling database is exactly who needs
    // this page, and exactly who would lose it to a coupled write.
    mocks.recordActivity.mockRejectedValue(new Error("audit down"));
    const res = await request(appAs("owner")).get("/api/admin/prompt-inspect/u1");
    expect(res.status).toBe(200);
    expect(res.body.assembledChars).toBe(44);
  });

  it("names the failed-composer count in the row, without naming the composer's error", async () => {
    mocks.inspectPrompt.mockResolvedValue({ ...PROMPT_RESULT, erroredBlocks: ["persona"] });
    await request(appAs("owner")).get("/api/admin/prompt-inspect/u1");
    const row = mocks.recordActivity.mock.calls[0]![0] as {
      sub: string;
      refs: { erroredBlocks: number };
    };
    expect(row.refs.erroredBlocks).toBe(1);
    expect(row.sub).toContain("failed to compose");
  });
});
