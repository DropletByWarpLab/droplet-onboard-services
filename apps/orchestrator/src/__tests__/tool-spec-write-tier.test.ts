/**
 * WARP-1621 — the ADR-004 coarse write-tier gate is missing from the ToolSpec
 * run path. Found by the code review on PR #1255 (WARP-1580).
 *
 * THE HOLE. Chat narrows tools TWICE:
 *
 *   1. `requireRole` on the route  — the coarse floor.
 *   2. `narrowAllowedToolsForRole` (routes/llm.ts) — the ADR-004 tier gate:
 *      every `requiresWrite` tool is stripped for a non-privileged role
 *      before the model is even told the tool exists.
 *
 * `POST /api/tools/:slug/runs` only ever cleared (1). A `family` user could
 * press Run on a live spec calling `control_device` and it FIRED — while the
 * same request through chat would have had the tool stripped before the model
 * saw it. The WARP-463 ticker inherits the same gap: WARP-1580 made a
 * scheduled fire run as the spec's creator, so a family-owned spec fires with
 * a family principal.
 *
 * WARP-1580 did NOT close this, and correctly so. It narrowed AccessRole
 * HOLDERS through the §3 resolver; a user with `accessRoleId === null`
 * deliberately resolves to a null scope and never reaches that resolver. That
 * non-regression is pinned in tool-spec-access.test.ts and stands. What was
 * missing is the TIER gate underneath it — and every family user on every box
 * in the field has no AccessRole, because custom roles are new. So the hole is
 * not a corner case: it is the default configuration.
 *
 * THE COMPOSED RESULT under test here:
 *
 *     tier gate (ADR-004 coarse)  AND  per-role narrowing (WARP-1580 §3)
 *
 * A tool must clear BOTH. Neither is a superset of the other: the tier gate
 * catches role-less users the §3 resolver skips; the §3 axis catches a
 * privileged tier whose AccessRole was never granted the domain.
 *
 * The last describe block is the point of this file. A single-surface test
 * cannot express "chat and specs answer the same way" — which is exactly how
 * this survived a review, a merge and a deploy. It asserts the EQUIVALENCE
 * directly, over a matrix of principals and real registry tool names.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { TOOL_CATALOG } from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

const resolveEffectiveAccessMock = vi.hoisted(() => vi.fn());
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

// routes/llm.ts boots the MCP singleton at import; the equivalence block
// imports it for the REAL `narrowAllowedToolsForRole`, so stub the child.
const listTools = vi.hoisted(() => vi.fn());
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: { listTools, callTool: vi.fn() },
  ensureMcpStarted: vi.fn(),
  stopMcp: vi.fn(),
}));

import { createToolsRouter } from "../routes/tools.js";
import { narrowAllowedToolsForRole } from "../routes/llm.js";
import { tickToolSchedules } from "../services/tool-schedule-ticker.service.js";
import { resolveToolAccessScope } from "../services/tool-access.service.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";

// ── fixtures ───────────────────────────────────────────────────────
//
// Names come off the LIVE catalog, never hand-typed: `requiresWrite` is the
// authoritative flag on both sides of the equivalence, so a registry change
// must move both answers together or fail here.
const nameOf = (domain: string, write: boolean): string => {
  const entry = TOOL_CATALOG.find(
    (t) => t.domain === domain && t.requiresWrite === write,
  );
  if (!entry) throw new Error(`no ${write ? "write" : "read"} tool in ${domain}`);
  return entry.name;
};

/** `control_device` — the smart-home WRITE tool the hole let family fire. */
const SMART_HOME_WRITE = "control_device";
const FILES_READ = nameOf("files", false);
const FILES_WRITE = nameOf("files", true);
const CAMERAS_READ = nameOf("cameras", false);

interface StepRow {
  id: string;
  idx: number;
  kind: string;
  args: unknown;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  status: "live" | "draft" | "suggested";
  ownerId: string | null;
  writes: boolean;
  reversible: boolean;
  steps: StepRow[];
}
interface ScheduleRow {
  id: string;
  specId: string;
  rrule: string;
  nextFireAt: Date;
  enabled: boolean;
}
interface UserRow {
  id: string;
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  accessRoleId: string | null;
  accessRole: { toolGrants: Array<{ domain: string; level: "view" | "use" }> } | null;
}

function step(idx: number, tool: string, args: Record<string, unknown> = {}): StepRow {
  return { id: `s-${idx}`, idx, kind: "call", args: { tool, args } };
}

/** `writes:false, reversible:true` so the route's confirm-gate never fires and
 *  the ONLY thing under test is the access decision. */
function spec(over: Partial<SpecRow> = {}): SpecRow {
  return {
    id: "spec-1",
    slug: "goodnight",
    name: "Goodnight",
    status: "live",
    ownerId: "user-family",
    writes: false,
    reversible: true,
    steps: [step(0, SMART_HOME_WRITE, { node_id: "n1", command: "turn_on" })],
    ...over,
  };
}

function createPrismaMock(
  opts: { specs?: SpecRow[]; schedules?: ScheduleRow[]; users?: UserRow[] } = {},
) {
  const specs = new Map<string, SpecRow>((opts.specs ?? []).map((s) => [s.id, s]));
  const schedules = [...(opts.schedules ?? [])];
  const users = new Map<string, UserRow>((opts.users ?? []).map((u) => [u.id, u]));
  const runs: Array<{ specId: string; status: string }> = [];

  return {
    runs,
    schedules,
    toolSpec: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        for (const s of specs.values()) {
          if (where.slug !== undefined && s.slug === where.slug) return s;
          if (where.id !== undefined && s.id === where.id) return s;
        }
        return null;
      }),
    },
    toolRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        runs.push(data as never);
        return { id: `run-${runs.length}` };
      }),
    },
    toolSchedule: {
      findMany: vi.fn(async ({ where }: { where: { nextFireAt: { lte: Date } } }) =>
        schedules.filter(
          (s) => s.enabled && s.nextFireAt.getTime() <= where.nextFireAt.lte.getTime(),
        ),
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = schedules.find((s) => s.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      ),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        users.get(where.id) ?? null,
      ),
    },
  };
}

function mkUser(role: AuthUser["role"], id: string): AuthUser {
  return { id, username: id, displayName: id, role };
}

function buildApp(
  prisma: ReturnType<typeof createPrismaMock>,
  dispatcher: StepDispatcher,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createToolsRouter(prisma as never, dispatcher));
  return app;
}

/** EVERY family user on EVERY box in the field: no AccessRole at all. */
const ROLELESS_FAMILY: UserRow = {
  id: "user-family",
  role: "family",
  directoryStatus: "ACTIVE",
  accessRoleId: null,
  accessRole: null,
};
const ROLELESS_ADMIN: UserRow = {
  id: "user-admin",
  role: "admin",
  directoryStatus: "ACTIVE",
  accessRoleId: null,
  accessRole: null,
};
const ROLELESS_OWNER: UserRow = {
  id: "user-owner",
  role: "owner",
  directoryStatus: "ACTIVE",
  accessRoleId: null,
  accessRole: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockResolvedValue(null);
  resolveEffectiveAccessMock.mockReset();
  listTools.mockReset();
  listTools.mockResolvedValue([]);
});

// ── 1. the hole, interactive ───────────────────────────────────────

describe("WARP-1621 — run-now applies the ADR-004 write-tier gate", () => {
  it("refuses a requiresWrite tool for a family user with NO AccessRole", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({ specs: [spec()], users: [ROLELESS_FAMILY] });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-family"));

    const res = await request(app).post("/api/tools/goodnight/runs");

    // THE HOLE. Before this ticket: 200, and `control_device` has already
    // fired against a principal chat would never have shown the tool to.
    expect(
      (dispatcher.call as ReturnType<typeof vi.fn>).mock.calls,
      "a write tool must never reach the dispatcher for a non-privileged tier",
    ).toEqual([]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_tool_for_role");
    expect(res.body.tool).toBe(SMART_HOME_WRITE);
    // The AXIS is the operator-facing discriminator: this is the coarse tier
    // floor, NOT a missing per-role grant. Without it "why did my automation
    // stop" has two indistinguishable answers.
    expect(res.body.axis).toBe("write_tier");
    // Refused whole — no half-executed ToolRun row.
    expect(prisma.runs).toEqual([]);
    // And the §3 resolver is STILL not consulted on the role-less path
    // (WARP-1580's non-regression): the tier gate is a layer underneath it.
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("refuses a multi-step spec WHOLE — an in-reach read step 0 must not run", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [
        spec({
          steps: [step(0, FILES_READ, { path: "/" }), step(1, SMART_HOME_WRITE)],
        }),
      ],
      users: [ROLELESS_FAMILY],
    });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-family"));

    const res = await request(app).post("/api/tools/goodnight/runs");

    expect(res.status).toBe(403);
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(prisma.runs).toEqual([]);
  });

  it("still runs a READ-only spec for the same family user — reads are untouched", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ steps: [step(0, FILES_READ, { path: "/" })] })],
      users: [ROLELESS_FAMILY],
    });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-family"));

    const res = await request(app).post("/api/tools/goodnight/runs");

    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenCalledWith(FILES_READ, { path: "/" });
  });

  it("leaves owner and admin at full reach — the tier gate stops at privileged", async () => {
    for (const [role, row] of [
      ["owner", ROLELESS_OWNER],
      ["admin", ROLELESS_ADMIN],
    ] as const) {
      vi.clearAllMocks();
      const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
      const prisma = createPrismaMock({ specs: [spec()], users: [row] });
      const app = buildApp(prisma, dispatcher, mkUser(role, row.id));

      const res = await request(app).post("/api/tools/goodnight/runs");

      expect(res.status, `${role} must be unaffected`).toBe(200);
      expect(dispatcher.call).toHaveBeenCalledWith(SMART_HOME_WRITE, {
        node_id: "n1",
        command: "turn_on",
      });
    }
  });
});

// ── 2. the hole, scheduled ─────────────────────────────────────────

describe("WARP-1621 — the ticker applies the same write-tier gate", () => {
  const now = new Date("2026-07-26T09:30:00Z");
  // A FACTORY: `advanceOrDisable` mutates the row, so a shared const would
  // leave later tests looking at an already-advanced schedule.
  const dueSchedule = (): ScheduleRow => ({
    id: "sched-1",
    specId: "spec-1",
    rrule: "FREQ=DAILY;BYHOUR=9",
    nextFireAt: new Date("2026-07-26T09:00:00Z"),
    enabled: true,
  });

  it("skips a family-owned spec that calls a write tool", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-family" })],
      schedules: [dueSchedule()],
      users: [ROLELESS_FAMILY],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    // WARP-1580 made a scheduled fire run AS its creator, so a family-owned
    // spec fires with a family principal — and inherits the same gap.
    expect(
      (dispatcher.call as ReturnType<typeof vi.fn>).mock.calls,
      "a scheduled fire must not launder a write tool past the tier gate",
    ).toEqual([]);
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    // Skip-and-advance, matching every other gate on this path: a re-grant
    // (or a promotion to admin) resumes the cadence without operator surgery.
    expect(prisma.schedules[0].nextFireAt.getTime()).toBeGreaterThan(now.getTime());
    expect(prisma.schedules[0].enabled).toBe(true);
    // Auditable, with the axis, so the feed says WHY the automation stopped.
    const audited = recordActivityMock.mock.calls.map(([a]) => a);
    expect(
      audited.some(
        (a) =>
          a.severity === "warn" &&
          a.refs?.reason === "forbidden_tool_for_role" &&
          a.refs?.axis === "write_tier" &&
          a.refs?.tool === SMART_HOME_WRITE &&
          a.refs?.ownerId === "user-family",
      ),
    ).toBe(true);
  });

  it("still fires a family-owned READ-only spec", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [
        spec({ ownerId: "user-family", steps: [step(0, FILES_READ, { path: "/" })] }),
      ],
      schedules: [dueSchedule()],
      users: [ROLELESS_FAMILY],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    expect(result.fired).toBe(1);
    expect(dispatcher.call).toHaveBeenCalledWith(FILES_READ, { path: "/" });
  });

  it("still fires an admin-owned write spec — privileged tiers unaffected", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-admin" })],
      schedules: [dueSchedule()],
      users: [ROLELESS_ADMIN],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    expect(result.fired).toBe(1);
    expect(dispatcher.call).toHaveBeenCalledWith(SMART_HOME_WRITE, {
      node_id: "n1",
      command: "turn_on",
    });
  });
});

// ── 3. THE INVARIANT: chat and specs must answer identically ───────

describe("WARP-1621 — chat and ToolSpecs answer the same (user, tool) question", () => {
  /**
   * The equivalence that was missing. Chat's answer comes from the REAL
   * `narrowAllowedToolsForRole`; the spec answer comes from a REAL request
   * through `POST /api/tools/:slug/runs`. Both resolve their §3 scope through
   * the same `resolveToolAccessScope`, so the only way these can disagree is
   * a second copy of the narrowing — the exact drift that produced this hole.
   *
   * The matrix is restricted to roles the runs route ADMITS
   * (`requireRole("owner","admin","family")`). `guest` is refused by the
   * coarse route floor before any per-tool question is asked, which is a
   * deliberately STRICTER answer than chat's, not a drift.
   */
  const PRINCIPALS: Array<{
    label: string;
    role: AuthUser["role"];
    row: UserRow;
    /** null ⇒ `resolveEffectiveAccess` must never be called for this row. */
    effective: { tier: string; toolDomains: string[]; locks: boolean } | null;
  }> = [
    { label: "owner, no AccessRole", role: "owner", row: ROLELESS_OWNER, effective: null },
    { label: "admin, no AccessRole", role: "admin", row: ROLELESS_ADMIN, effective: null },
    {
      label: "family, no AccessRole (every box in the field)",
      role: "family",
      row: ROLELESS_FAMILY,
      effective: null,
    },
    {
      label: "family + AccessRole granting files:view",
      role: "family",
      row: {
        id: "user-family-files",
        role: "family",
        directoryStatus: "ACTIVE",
        accessRoleId: "role-files",
        accessRole: { toolGrants: [{ domain: "files", level: "view" }] },
      },
      effective: { tier: "family", toolDomains: ["files"], locks: false },
    },
    {
      label: "admin + AccessRole granting files:use",
      role: "admin",
      row: {
        id: "user-admin-files",
        role: "admin",
        directoryStatus: "ACTIVE",
        accessRoleId: "role-files-use",
        accessRole: { toolGrants: [{ domain: "files", level: "use" }] },
      },
      effective: { tier: "admin", toolDomains: ["files"], locks: false },
    },
  ];

  const TOOLS_UNDER_TEST = [FILES_READ, FILES_WRITE, SMART_HOME_WRITE, CAMERAS_READ];

  for (const principal of PRINCIPALS) {
    for (const tool of TOOLS_UNDER_TEST) {
      it(`${principal.label} × ${tool}`, async () => {
        if (principal.effective) {
          resolveEffectiveAccessMock.mockResolvedValue(principal.effective);
        }
        const user = mkUser(principal.role, principal.row.id);
        const dispatcher: StepDispatcher = {
          call: vi.fn().mockResolvedValue({ ok: true }),
        };
        const prisma = createPrismaMock({
          specs: [spec({ ownerId: principal.row.id, steps: [step(0, tool, {})] })],
          users: [principal.row],
        });

        // ── the SPEC answer: a real run-now request ──
        const app = buildApp(prisma, dispatcher, user);
        const res = await request(app).post("/api/tools/goodnight/runs");
        const specAllows = res.status === 200;
        expect(
          [200, 403],
          `unexpected status ${res.status}: ${JSON.stringify(res.body)}`,
        ).toContain(res.status);

        // ── the CHAT answer: the real catalog narrowing ──
        const scope = await resolveToolAccessScope(prisma as never, user);
        const narrowed = await narrowAllowedToolsForRole(user.role, [tool], false, scope);
        const chatAllows = (narrowed ?? []).includes(tool);

        expect(
          specAllows,
          `chat ${chatAllows ? "ALLOWS" : "REFUSES"} ${tool} for ${principal.label} ` +
            `but the ToolSpec surface ${specAllows ? "ALLOWS" : "REFUSES"} it`,
        ).toBe(chatAllows);

        // Belt-and-braces: the dispatcher agrees with the verdict, so an
        // "allowed" answer is a real dispatch and not a silently empty run.
        expect((dispatcher.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
          specAllows ? 1 : 0,
        );
      });
    }
  }
});
