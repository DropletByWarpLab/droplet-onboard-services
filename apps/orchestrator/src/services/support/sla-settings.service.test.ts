import { describe, expect, it, vi } from "vitest";
import { deleteMacro, getDeskSla, listMacros, previewMacro, saveDeskSla, saveMacro } from "./sla-settings.service.js";
import { getSlaReport } from "./sla-report.service.js";
import { escalationSchema } from "./sla-schemas.js";
import { grants } from "../../__tests__/helpers/support-routes.js";
const viewer = { id: "agent", role: "family" } as const;
const ticketId = "3fd5b450-a07a-4ad0-afab-5094b08b18cf";
function fixture() {
  const macro: any = { id: "m1", projectId: "desk", ownerId: "agent", name: "Greeting", visibility: "PERSONAL", bodyHtml: "<p>Hello {{requester.firstName}}, {{agent.name}} here for {{ticket.key}} at {{desk.name}}</p>", actions: {} };
  const row: any = { id: ticketId, projectId: "desk", sequenceId: 12, project: { kind: "SERVICE_DESK", name: "Help <desk>", identifier: "SUP" }, ticket: { requesterName: '<img/src=x/onerror="evil()"> Ana' }, labels: [] };
  const db: any = {
    pmProject: { findFirst: vi.fn(async () => ({ id: "desk", kind: "SERVICE_DESK", workspaceId: "home", isArchived: false })) },
    pmWorkItem: { findFirst: vi.fn(async () => row) },
    pmMacro: { findFirst: vi.fn(async () => macro), findUnique: vi.fn(async () => macro), findMany: vi.fn(async () => []), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn(async () => ({ count: 0 })) },
    pmSlaPolicy: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
    pmAssignmentRule: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
    pmBusinessCalendar: { findFirst: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ displayName: 'Agent "<script>"' })), findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn) => fn(db)),
  };
  return { db, macro, row };
}
describe("SLA escalation configuration", () => {
  const rule = (actions: Array<Record<string, unknown>>) => ({ on: "AT_RISK", metric: "any", actions });

  it("allows a single reassign action alongside raise-priority and notify actions", () => {
    expect(escalationSchema.safeParse([rule([
      { type: "raise_priority" },
      { type: "notify", userIds: ["agent-1", "agent-2"] },
      { type: "reassign", userId: "agent-3" },
    ])]).success).toBe(true);
  });

  it("rejects multiple reassign actions whether they target the same or different agents", () => {
    expect(escalationSchema.safeParse([rule([
      { type: "reassign", userId: "agent-1" },
      { type: "reassign", userId: "agent-1" },
    ])]).success).toBe(false);
    expect(escalationSchema.safeParse([rule([
      { type: "reassign", userId: "agent-1" },
      { type: "reassign", userId: "agent-2" },
    ])]).success).toBe(false);
  });
});
describe("Support SLA settings boundary", () => {
  it("does not expose SLA settings or macros for a native Project", async () => {
    const f = fixture(); f.db.pmProject.findFirst.mockResolvedValue(null);
    await expect(getDeskSla(f.db, "project")).rejects.toThrow("desk_not_found");
    await expect(listMacros(f.db, viewer, "project")).rejects.toThrow("desk_not_found");
    expect(f.db.pmSlaPolicy.findUnique).not.toHaveBeenCalled(); expect(f.db.pmMacro.findMany).not.toHaveBeenCalled();
  });
  it("binds a calendar to the desk workspace before either policy or assignment write", async () => {
    const f = fixture();
    await expect(saveDeskSla(f.db, "desk", { policy: { enabled: true, calendarId: "other-workspace", targets: {}, atRiskPercent: 75, escalation: [] }, assignment: { mode: "MANUAL", departmentId: null, memberIds: [] } })).rejects.toThrow("calendar_not_found");
    expect(f.db.pmBusinessCalendar.findFirst).toHaveBeenCalledWith({ where: { id: "other-workspace", workspaceId: "home" } });
    expect(f.db.pmSlaPolicy.upsert).not.toHaveBeenCalled(); expect(f.db.pmAssignmentRule.upsert).not.toHaveBeenCalled();
  });
  it("neither an admin nor another agent can edit another person's personal macro", async () => {
    const f = fixture(); f.macro.ownerId = "another";
    await expect(saveMacro(f.db, { id: "admin", role: "admin" }, "m1", { projectId: "desk", name: "X", bodyHtml: "<p>x</p>", actions: {}, visibility: "PERSONAL" })).rejects.toThrow("macro_not_found");
    expect(f.db.pmMacro.update).not.toHaveBeenCalled();
    f.db.pmMacro.findFirst.mockResolvedValue(null);
    await expect(deleteMacro(f.db, viewer, "m1")).rejects.toThrow("macro_not_found");
    expect(f.db.pmMacro.findFirst.mock.calls[0][0].where).toEqual({ id: "m1", OR: [{ ownerId: "agent" }] });
    expect(f.db.pmMacro.deleteMany).not.toHaveBeenCalled();
  });
  it("an agent cannot turn their own macro into a shared administrator macro", async () => {
    const f = fixture(); await expect(saveMacro(f.db, viewer, null, { projectId: "desk", name: "X", bodyHtml: "<p>x</p>", actions: {}, visibility: "SHARED" })).rejects.toThrow("macro_not_found");
    expect(f.db.pmMacro.create).not.toHaveBeenCalled();
  });
  it("shared macro changes require Support manage, including deletion and changing its visibility", async () => {
    const f = fixture(); f.macro.visibility = "SHARED";
    const admin = { id: "admin", role: "admin" } as const;
    const deps = { resolveAccess: async () => grants([["support", "act"]]) };
    await expect(saveMacro(f.db, admin, "m1", { projectId: "desk", name: "X", bodyHtml: "Hi", actions: {}, visibility: "PERSONAL" }, deps)).rejects.toThrow("macro_not_found");
    await expect(deleteMacro(f.db, admin, "m1", deps)).rejects.toThrow("macro_not_found");
    expect(f.db.pmMacro.update).not.toHaveBeenCalled(); expect(f.db.pmMacro.deleteMany).not.toHaveBeenCalled();
  });
  it("refuses an in-flight shared edit if another editor has made that macro personal", async () => {
    const f = fixture(); f.macro.visibility = "SHARED";
    f.db.pmMacro.findUnique.mockImplementation(async () => ({ ...f.macro }));
    f.db.pmMacro.update.mockImplementation(async ({ where, data }: { where: { visibility?: string }; data: Record<string, unknown> }) => {
      f.macro.visibility = "PERSONAL"; // A competing authorised update commits first.
      if (where.visibility !== f.macro.visibility) throw Object.assign(new Error("preimage changed"), { code: "P2025" });
      Object.assign(f.macro, data);
      return f.macro;
    });
    await expect(saveMacro(f.db, { id: "admin", role: "admin" }, "m1", { projectId: "desk", name: "Changed", bodyHtml: "New draft", actions: {}, visibility: "SHARED" }, { resolveAccess: async () => grants([["support", "manage"]]) })).rejects.toThrow("macro_not_found");
    expect(f.macro.name).toBe("Greeting"); expect(f.macro.visibility).toBe("PERSONAL");
    expect(f.db.pmMacro.update.mock.calls[0][0].where).toEqual({ id: "m1", ownerId: "agent", visibility: "SHARED" });
  });
  it("escapes substituted person/desk data and keeps preview read-only", async () => {
    const f = fixture(); const result = await previewMacro(f.db, viewer, ticketId, "m1");
    expect(result.bodyHtml).toContain('&lt;img/src=x/onerror="evil()"&gt;');
    expect(result.bodyHtml).toContain('Agent "&lt;script&gt;"');
    expect(result.bodyHtml).toContain("SUP-12 at Help &lt;desk&gt;");
    expect(result.bodyHtml).not.toMatch(/<img|<script/);
    expect(f.db.pmMacro.update).not.toHaveBeenCalled(); expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.pmMacro.findFirst.mock.calls[0][0].where.AND[1]).toEqual({ OR: [{ ownerId: "agent" }, { visibility: "SHARED" }] });
  });
  it("revalidates links after substitution so a requester cannot supply an executable URL scheme", async () => {
    const f = fixture();
    f.row.ticket.requesterName = "javascript:alert(1)";
    f.macro.bodyHtml = '<p><a href="{{requester.firstName}}">Read</a> <a href="https://support.example.test/help">Help</a></p>';
    const result = await previewMacro(f.db, viewer, ticketId, "m1");
    expect(result.bodyHtml).not.toContain("javascript:");
    expect(result.bodyHtml).toContain("<a>Read</a>");
    expect(result.bodyHtml).toContain('href="https://support.example.test/help"');
  });
  it("refuses unsupported variables and global desk-specific state actions on save", async () => {
    const f = fixture();
    await expect(saveMacro(f.db, viewer, null, { projectId: "desk", name: "Bad", bodyHtml: "{{requester.email}}", actions: {}, visibility: "PERSONAL" })).rejects.toThrow("invalid_sla_configuration");
    await expect(saveMacro(f.db, viewer, null, { projectId: null, name: "Bad", bodyHtml: "Hi", actions: { stateId: "desk-only" }, visibility: "PERSONAL" })).rejects.toThrow();
    expect(f.db.pmMacro.create).not.toHaveBeenCalled();
  });
  it("validates state and label ownership when saving, before storing a macro", async () => {
    const f = fixture(); f.db.pmState = { findFirst: vi.fn(async () => null) }; f.db.pmLabel = { count: vi.fn(async () => 0) };
    const input = { projectId: "desk", name: "Bad references", bodyHtml: "Hi", visibility: "PERSONAL" as const };
    await expect(saveMacro(f.db, viewer, null, { ...input, actions: { stateId: "project-state" } })).rejects.toThrow("invalid_state");
    await expect(saveMacro(f.db, viewer, null, { ...input, actions: { addLabelIds: ["other-desk-label"] } })).rejects.toThrow("invalid_label");
    expect(f.db.pmState.findFirst.mock.calls[0][0].where).toEqual({ id: "project-state", projectId: "desk" });
    expect(f.db.pmMacro.create).not.toHaveBeenCalled();
  });
});
describe("SLA cohort report", () => {
  it("validates honest calendar dates and the 366-day bound before querying", async () => {
    const f = fixture();
    for (const range of [{ from: "2026-02-30", to: "2026-03-01" }, { from: "2026-01-02", to: "2026-01-01" }, { from: "2025-01-01", to: "2026-01-02" }]) {
      await expect(getSlaReport(f.db, "desk", range)).rejects.toThrow("invalid_report_range");
    }
    expect(f.db.pmProject.findFirst).not.toHaveBeenCalled();
  });
  it("keeps the entire aggregate scoped to Support and excludes NONE/active tickets from attainment", async () => {
    const f = fixture(); f.db.pmTicket = { groupBy: vi.fn(async (args) => args.where.solvedAt ? [{ slaStatus: "MET", _count: { workItemId: 3 } }, { slaStatus: "BREACHED", _count: { workItemId: 1 } }] : [{ slaStatus: "MET", _count: { workItemId: 3 } }, { slaStatus: "BREACHED", _count: { workItemId: 4 } }, { slaStatus: "NONE", _count: { workItemId: 8 } }, { slaStatus: "ON_TRACK", _count: { workItemId: 2 } }]) };
    const result = await getSlaReport(f.db, "desk", { from: "2026-01-01", to: "2026-01-31" });
    expect(result).toMatchObject({ total: 17, met: 3, breached: 1, attainmentPercent: 75 });
    expect(f.db.pmTicket.groupBy.mock.calls[0][0].where.workItem).toMatchObject({ projectId: "desk", project: { kind: "SERVICE_DESK" }, isArchived: false });
  });
});
