/**
 * WARP-1580 — the ToolSpec runner must honour per-role tool narrowing, and a
 * scheduled spec must run as an attributed principal or not at all.
 *
 * This suite is the regression proof for a hole AROUND WARP-1529 (RBAC v2
 * T5). T5 put ONE narrowing predicate behind TWO enforcement points — the
 * chat catalog build and the agent loop's pre-dispatch re-check. The ToolSpec
 * runner reaches `mcp.callTool` through neither: `POST /api/tools/:slug/runs`
 * only clears the coarse ADR-004 `requireRole("owner","admin","family")`
 * floor, and the WARP-463 ticker dispatches with no principal at all.
 *
 * The two halves need different answers and this file keeps them apart:
 *
 *   1. INTERACTIVE — there IS a principal (`req.user`). The fix routes it
 *      through the same `resolveToolAccessScope` + `toolAllowedInScope`
 *      pair that dispatch uses. No second copy of the narrowing.
 *
 *   2. SCHEDULED — there is NO principal, so there is nothing to narrow
 *      against. The fix attributes the run to the spec's creator
 *      (`ToolSpec.ownerId`) and resolves THAT identity's CURRENT effective
 *      access at fire time. Unresolvable ⇒ the fire is refused, never
 *      widened.
 *
 * Fail-closed is the invariant under test throughout: "I couldn't check"
 * must never resolve to "full reach".
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

import { createToolsRouter } from "../routes/tools.js";
import { tickToolSchedules } from "../services/tool-schedule-ticker.service.js";
import { runToolSpec, type StepDispatcher } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";

// ── fixtures ───────────────────────────────────────────────────────
//
// Real registry names, deliberately: the whole point of T5's design is that
// `domain` + `requiresWrite` are read off tools-core and never hand-listed.
// `control_device` is the `smart-home` write tool; `list_files` is the
// `files` read tool the narrowed role DOES hold.
const FORBIDDEN_TOOL = "control_device";
const ALLOWED_TOOL = "list_files";
/**
 * WARP-1621 — a tool the §3 axis refuses but the ADR-004 TIER axis allows.
 *
 * `control_device` above is `requiresWrite`, so after WARP-1621 every refusal
 * in this file that uses it is decided by the tier axis, which is checked
 * FIRST. A read tool outside the granted domains is the only fixture that
 * isolates §3 — see the `role_grant` test below for why that matters.
 */
const ROLE_ONLY_FORBIDDEN_TOOL = "list_cameras";

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

function spec(over: Partial<SpecRow> = {}): SpecRow {
  return {
    id: "spec-1",
    slug: "nightly-recap",
    name: "Nightly recap",
    status: "live",
    ownerId: "user-narrowed",
    writes: false,
    reversible: true,
    steps: [step(0, FORBIDDEN_TOOL, { node_id: "n1", command: "turn_on" })],
    ...over,
  };
}

/**
 * One mock covering both surfaces — the route and the ticker walk the same
 * tables. Only the reads/writes those two paths actually make are modelled;
 * a missing method is a signal that a NEW read snuck in, which is exactly
 * what a security test wants to notice.
 */
function createPrismaMock(opts: {
  specs?: SpecRow[];
  schedules?: ScheduleRow[];
  users?: UserRow[];
  userReadThrows?: boolean;
} = {}) {
  const specs = new Map<string, SpecRow>((opts.specs ?? []).map((s) => [s.id, s]));
  const schedules = [...(opts.schedules ?? [])];
  const users = new Map<string, UserRow>((opts.users ?? []).map((u) => [u.id, u]));
  const runs: Array<{
    specId: string;
    triggeredBy: string | null;
    status: string;
    error: string | null;
    trace: unknown;
  }> = [];

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
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = schedules.find((s) => s.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (opts.userReadThrows) throw new Error("connection reset");
        return users.get(where.id) ?? null;
      }),
    },
  };
}

function mkUser(role: AuthUser["role"], id = `user-${role}`): AuthUser {
  return { id, username: "stefan", displayName: "Stefan", role };
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

/** A role holding `files` only — `smart-home` was never granted. */
const FILES_ONLY_USER: UserRow = {
  id: "user-narrowed",
  role: "family",
  directoryStatus: "ACTIVE",
  accessRoleId: "role-1",
  accessRole: { toolGrants: [{ domain: "files", level: "view" }] },
};

function filesOnlyAccess() {
  resolveEffectiveAccessMock.mockResolvedValue({
    tier: "family",
    toolDomains: ["files"],
    locks: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockResolvedValue(null);
  resolveEffectiveAccessMock.mockReset();
});

// ── 1. interactive: the principal exists, consult the resolver ─────

describe("WARP-1580 — interactive ToolSpec run honours per-role tool narrowing", () => {
  it("refuses run-now for a tool the caller's access role does not grant", async () => {
    filesOnlyAccess();
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({ specs: [spec()], users: [FILES_ONLY_USER] });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-narrowed"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    // THE BYPASS. Before the fix this is 200 and the smart-home write tool
    // has already been dispatched against a role that was never granted the
    // `smart-home` domain — the exact reach WARP-1529 removed from chat.
    expect(
      (dispatcher.call as ReturnType<typeof vi.fn>).mock.calls,
      "a role-forbidden tool must never reach the dispatcher via a spec",
    ).toEqual([]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_tool_for_role");
    expect(res.body.tool).toBe(FORBIDDEN_TOOL);
    // Refused before any run exists — no half-executed ToolRun row.
    expect(prisma.runs).toEqual([]);
  });

  /**
   * WARP-1621 put the ADR-004 write-tier axis UNDERNEATH the §3 axis, and the
   * shared pre-flight checks the tier FIRST. `control_device` is
   * `requiresWrite`, so every OTHER refusal in this block is now decided by
   * the tier — meaning that with only those tests, deleting the §3 branch from
   * `firstToolDeniedForPrincipal` leaves this whole suite green while the
   * narrowing it is named for is gone. Verified by mutation.
   *
   * This case is the one that still discriminates: a READ tool outside the
   * granted domains. The tier axis ALLOWS it, so a 403 can only have come from
   * §3 — and `axis` proves which gate answered.
   */
  it("refuses a READ tool outside the granted domains — §3, not the tier", async () => {
    // Self-verifying: were this ever to become a write tool, the test would
    // silently revert to pinning the tier axis — the exact failure mode above.
    expect(
      TOOL_CATALOG.find((t) => t.name === ROLE_ONLY_FORBIDDEN_TOOL)?.requiresWrite,
      `${ROLE_ONLY_FORBIDDEN_TOOL} must be a READ tool for this test to isolate §3`,
    ).toBe(false);

    filesOnlyAccess();
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ steps: [step(0, ROLE_ONLY_FORBIDDEN_TOOL, {})] })],
      users: [FILES_ONLY_USER],
    });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-narrowed"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_tool_for_role");
    expect(res.body.tool).toBe(ROLE_ONLY_FORBIDDEN_TOOL);
    expect(res.body.axis).toBe("role_grant");
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(prisma.runs).toEqual([]);
  });

  it("refuses a multi-step spec whole, never partially — step 0 is allowed", async () => {
    filesOnlyAccess();
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [
        spec({
          steps: [step(0, ALLOWED_TOOL, { path: "/" }), step(1, FORBIDDEN_TOOL)],
        }),
      ],
      users: [FILES_ONLY_USER],
    });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-narrowed"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(res.status).toBe(403);
    expect(dispatcher.call).not.toHaveBeenCalled();
  });

  it("still runs a spec entirely inside the role's granted domains", async () => {
    filesOnlyAccess();
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ steps: [step(0, ALLOWED_TOOL, { path: "/" })] })],
      users: [FILES_ONLY_USER],
    });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-narrowed"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenCalledWith(ALLOWED_TOOL, { path: "/" });
  });

  it("leaves the owner's reach untouched — §3 owner bypass, no DB read", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({ specs: [spec()], users: [FILES_ONLY_USER] });
    const app = buildApp(prisma, dispatcher, mkUser("owner"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenCalledWith(FORBIDDEN_TOOL, {
      node_id: "n1",
      command: "turn_on",
    });
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("applies NO §3 narrowing to a role-less caller — every box today", async () => {
    // The non-regression THIS ticket owns: a person nobody assigned an
    // AccessRole to must not be narrowed by the §3 axis, and must not even
    // reach the §3 resolver. T5 silently dropping tools from every user on
    // every deployed box would have been a capability regression.
    //
    // The tool here is a READ tool on purpose. WARP-1621 later found that the
    // separate ADR-004 WRITE-tier axis was missing from this route entirely,
    // so a role-less `family` caller could fire `control_device` — that gap,
    // and its fix, are pinned in tool-spec-write-tier.test.ts. The claim this
    // test makes is about the §3 axis only, which is all WARP-1580 changed.
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ steps: [step(0, ALLOWED_TOOL, { path: "/" })] })],
      users: [
        {
          id: "user-family",
          role: "family",
          directoryStatus: "ACTIVE",
          accessRoleId: null,
          accessRole: null,
        },
      ],
    });
    const app = buildApp(prisma, dispatcher, mkUser("family"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenCalledWith(ALLOWED_TOOL, { path: "/" });
    // The §3 resolver is not even consulted on the role-less path.
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the caller's scope cannot be read", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec()],
      users: [FILES_ONLY_USER],
      userReadThrows: true,
    });
    const app = buildApp(prisma, dispatcher, mkUser("family", "user-narrowed"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(res.status).toBe(403);
    expect(dispatcher.call).not.toHaveBeenCalled();
  });

  it("denies a lock operation the role may not perform, at dispatch", async () => {
    // `mayOperateLocks=false` with smart-home otherwise granted: the tool
    // NAME clears the pre-flight, so this can only be caught at dispatch —
    // the same args-dependent rule the agent loop enforces.
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["smart-home"],
      locks: false,
    });
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ steps: [step(0, FORBIDDEN_TOOL, { node_id: "n1", command: "unlock" })] })],
      users: [
        {
          id: "user-narrowed",
          role: "admin",
          directoryStatus: "ACTIVE",
          accessRoleId: "role-1",
          accessRole: { toolGrants: [{ domain: "smart-home", level: "use" }] },
        },
      ],
    });
    const app = buildApp(prisma, dispatcher, mkUser("admin", "user-narrowed"));

    const res = await request(app).post("/api/tools/nightly-recap/runs");

    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(res.status).toBe(207);
    expect(res.body.status).toBe("failed");
    expect(res.body.trace[0].error).toMatch(/lock/i);
    // Refused, not broken: `warn` + the shield icon, matching the ticker's
    // own skip gate so the two refusal paths read alike in the feed.
    const audited = recordActivityMock.mock.calls.map(([a]) => a);
    expect(
      audited.some(
        (a) =>
          a.severity === "warn" &&
          a.sourceIcon === "shield" &&
          a.refs?.reason === "LOCK_OPERATION_NOT_PERMITTED",
      ),
    ).toBe(true);
  });
});

// ── 2. scheduled: no principal ⇒ attribute it, or refuse the fire ──

describe("WARP-1580 — scheduled ToolSpec runs resolve an attributed principal", () => {
  const now = new Date("2026-07-26T09:30:00Z");
  // A FACTORY, not a shared const: `advanceOrDisable` mutates the row, so a
  // shared fixture would silently make every test after the first one see an
  // already-advanced (not-due) schedule.
  const dueSchedule = (): ScheduleRow => ({
    id: "sched-1",
    specId: "spec-1",
    rrule: "FREQ=DAILY;BYHOUR=9",
    nextFireAt: new Date("2026-07-26T09:00:00Z"),
    enabled: true,
  });

  /** The `refs.reason` of the ticker's skip audit, so each fail-closed path
   *  is pinned to ITS OWN reason. Every unresolvable principal also yields a
   *  DENY_ALL scope, so without this the forbidden-tool branch alone would
   *  satisfy a bare `skipped === 1` and the `unresolved` branch could be
   *  deleted with every test still green. */
  const auditedReason = (): unknown =>
    recordActivityMock.mock.calls
      .map(([a]) => a)
      .find((a) => a.what === "Scheduled run skipped (access)")?.refs?.reason;

  it("refuses a fire whose attributed creator's role no longer grants the tool", async () => {
    filesOnlyAccess();
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-narrowed" })],
      schedules: [dueSchedule()],
      users: [FILES_ONLY_USER],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    // THE SECOND BYPASS. Before the fix the ticker dispatches with no
    // principal whatsoever, so narrowing the creator's role does nothing.
    expect(
      (dispatcher.call as ReturnType<typeof vi.fn>).mock.calls,
      "a scheduled fire must not reach the dispatcher with unnarrowed access",
    ).toEqual([]);
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    // The schedule still advances so a re-grant resumes the cadence.
    expect(prisma.schedules[0].nextFireAt.getTime()).toBeGreaterThan(now.getTime());
    expect(prisma.schedules[0].enabled).toBe(true);
    // ...and the refusal is auditable, not silent — with the reason and the
    // offending tool, so an operator can see WHY their automation stopped.
    const audited = recordActivityMock.mock.calls.map(([a]) => a);
    expect(
      audited.some(
        (a) =>
          a.severity === "warn" &&
          a.refs?.reason === "forbidden_tool_for_role" &&
          a.refs?.tool === FORBIDDEN_TOOL &&
          a.refs?.ownerId === "user-narrowed",
      ),
    ).toBe(true);
  });

  it("refuses a fire when the spec carries NO principal at all", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: null })],
      schedules: [dueSchedule()],
      users: [FILES_ONLY_USER],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    // The `unresolved` branch must be what refuses, and the audit must say
    // WHY. Without this the DENY_ALL scope alone would trip the forbidden-tool
    // branch and mis-report an unattributable fire as a permissions problem.
    expect(auditedReason()).toBe("no_principal");
  });

  it("refuses a fire when the attributed creator has been deactivated", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-gone" })],
      schedules: [dueSchedule()],
      users: [
        {
          id: "user-gone",
          role: "owner",
          directoryStatus: "DEACTIVATED",
          accessRoleId: null,
          accessRole: null,
        },
      ],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    // Deactivated beats the owner bypass: the identity is no longer allowed
    // to act at all, so nothing may act AS it.
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(auditedReason()).toBe("user_deactivated");
  });

  it("refuses a fire when the creator's row cannot be read (fail-closed)", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-narrowed" })],
      schedules: [dueSchedule()],
      users: [FILES_ONLY_USER],
      userReadThrows: true,
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    // An infra failure must NOT be audited as a permissions refusal — an
    // operator chasing "why did my automation stop" needs the real reason.
    expect(auditedReason()).toBe("read_failed");
  });

  it("fires normally when the attributed creator still holds the domain", async () => {
    filesOnlyAccess();
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-narrowed", steps: [step(0, ALLOWED_TOOL, { path: "/" })] })],
      schedules: [dueSchedule()],
      users: [FILES_ONLY_USER],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    expect(result.fired).toBe(1);
    expect(dispatcher.call).toHaveBeenCalledWith(ALLOWED_TOOL, { path: "/" });
  });

  it("denies a scheduled lock operation at dispatch, after `${prev}` resolves", async () => {
    // The pre-flight is NAME-only, so on the scheduled path too the §3 lock
    // rule can ONLY be decided at dispatch: step 1's `command` does not exist
    // until step 0 has returned. Without the runner re-checking under the
    // ATTRIBUTED scope, a schedule stays a laundering path for exactly the
    // hole the interactive test above closes — the ticker's own pre-flight
    // cannot see this, and `scope: null` here would pass every other test.
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files", "smart-home"],
      locks: false,
    });
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue("unlock") };
    const prisma = createPrismaMock({
      specs: [
        spec({
          ownerId: "user-narrowed",
          steps: [
            step(0, ALLOWED_TOOL, { path: "/" }),
            step(1, FORBIDDEN_TOOL, { node_id: "n1", command: "${prev}" }),
          ],
        }),
      ],
      schedules: [dueSchedule()],
      users: [
        {
          id: "user-narrowed",
          role: "admin",
          directoryStatus: "ACTIVE",
          accessRoleId: "role-1",
          accessRole: {
            toolGrants: [
              { domain: "files", level: "use" },
              { domain: "smart-home", level: "use" },
            ],
          },
        },
      ],
    });

    await tickToolSchedules(prisma as never, dispatcher, now);

    const calls = (dispatcher.call as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toEqual([[ALLOWED_TOOL, { path: "/" }]]);
    expect(
      calls.some(([name]) => name === FORBIDDEN_TOOL),
      "an unlock must not reach the dispatcher on a scheduled fire either",
    ).toBe(false);
    const audited = recordActivityMock.mock.calls.map(([a]) => a);
    expect(
      audited.some(
        (a) =>
          a.severity === "warn" &&
          a.sourceIcon === "shield" &&
          a.refs?.reason === "LOCK_OPERATION_NOT_PERMITTED",
      ),
    ).toBe(true);
  });

  it("fires an owner-authored spec at full reach — today's behaviour, unchanged", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock({
      specs: [spec({ ownerId: "user-owner" })],
      schedules: [dueSchedule()],
      users: [
        {
          id: "user-owner",
          role: "owner",
          directoryStatus: "ACTIVE",
          accessRoleId: null,
          accessRole: null,
        },
      ],
    });

    const result = await tickToolSchedules(prisma as never, dispatcher, now);

    expect(result.fired).toBe(1);
    expect(dispatcher.call).toHaveBeenCalledWith(FORBIDDEN_TOOL, {
      node_id: "n1",
      command: "turn_on",
    });
  });
});

// ── 3. the runner itself: the layer both callers sit on ────────────

describe("WARP-1580 — runToolSpec refuses a forbidden spec under its own scope", () => {
  // Both production callers pre-flight with the SAME
  // firstForbiddenToolName(plannedToolNames(...)) before they get here, so
  // this block never fires for them — it is the fail-closed floor for the
  // NEXT caller. Untested, that floor is indistinguishable from dead code and
  // can be deleted or broken without a single test going red; pinned here so
  // it stays a real layer.

  /** files granted, smart-home never granted — deliberately NOT DENY_ALL, so
   *  step 0 is genuinely in reach and only the WHOLE-spec pre-flight can stop
   *  it. Under DENY_ALL the per-step gate produces an indistinguishable
   *  outcome and this test would pass with the pre-flight deleted. */
  const filesOnlyScope = {
    domains: new Set(["files"]),
    writeDomains: new Set(["files"]),
    locks: false,
  };

  it("refuses the spec WHOLE — an in-reach step 0 must not run either", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock();

    const { outcome } = await runToolSpec(prisma as never, dispatcher, {
      specId: "spec-1",
      specName: "Nightly recap",
      steps: [
        step(0, ALLOWED_TOOL, { path: "/" }),
        step(1, FORBIDDEN_TOOL, { node_id: "n1" }),
      ],
      triggeredBy: "scheduler",
      scope: filesOnlyScope,
    });

    // THE discriminator. The per-step gate alone would let step 0 dispatch and
    // only refuse at step 1 — a half-applied automation the caller cannot
    // undo. Only the pre-flight makes this zero.
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.denialCode).toBe("FORBIDDEN_TOOL_FOR_ROLE");
    // The trace names the OFFENDING step, not the innocent one it stopped at.
    expect(outcome.trace).toHaveLength(1);
    expect(outcome.trace[0].tool).toBe(FORBIDDEN_TOOL);
    expect(outcome.trace[0].idx).toBe(1);
    // The refusal is persisted and audited as a refusal, not a breakage.
    expect(prisma.runs).toHaveLength(1);
    expect(prisma.runs[0].status).toBe("failed");
    const audited = recordActivityMock.mock.calls.map(([a]) => a);
    expect(
      audited.some(
        (a) =>
          a.severity === "warn" &&
          a.sourceIcon === "shield" &&
          a.refs?.reason === "FORBIDDEN_TOOL_FOR_ROLE",
      ),
    ).toBe(true);
  });

  it("runs untouched when no scope narrows it — omitted scope is not DENY", async () => {
    const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const prisma = createPrismaMock();

    const { outcome } = await runToolSpec(prisma as never, dispatcher, {
      specId: "spec-1",
      specName: "Nightly recap",
      steps: [step(0, FORBIDDEN_TOOL, { node_id: "n1", command: "unlock" })],
      triggeredBy: "scheduler",
    });

    expect(outcome.status).toBe("ok");
    expect(dispatcher.call).toHaveBeenCalledWith(FORBIDDEN_TOOL, {
      node_id: "n1",
      command: "unlock",
    });
  });
});
