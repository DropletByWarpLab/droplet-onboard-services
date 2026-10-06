import { describe, expect, it, vi } from "vitest";
import { assignNewTicket } from "./assignment.service.js";
import { grants } from "../../__tests__/helpers/support-routes.js";
function fixture(mode = "ROUND_ROBIN") {
  const rule: any = { id: "rule", projectId: "desk", mode, departmentId: null, memberIds: ["a", "inactive", "narrowed", "b"], lastAssignedUserId: null };
  const events: string[] = [];
  const tx: any = { $queryRaw: vi.fn(async () => { events.push("lock"); }),
    pmAssignmentRule: { findUnique: vi.fn(async () => { events.push("read"); return rule; }), update: vi.fn(async ({ data }) => Object.assign(rule, data)) },
    user: { findMany: vi.fn(async () => ["a", "narrowed", "b"].map((id) => ({ id, displayName: id }))) },
    pmWorkItemAssignee: { groupBy: vi.fn(async () => [{ userId: "a", _count: { workItemId: 4 } }, { userId: "b", _count: { workItemId: 1 } }]) },
  };
  const deps = { resolveAccess: async (id: string) => grants(id === "narrowed" ? [] : [["support", "act"]]) };
  return { rule, events, tx, deps };
}
describe("desk assignment cursor", () => {
  it("locks before reading and rotates past inactive or withdrawn-grant members", async () => {
    const f = fixture();
    expect(await assignNewTicket(f.tx, "desk", null, f.deps)).toEqual(["a"]);
    expect(await assignNewTicket(f.tx, "desk", null, f.deps)).toEqual(["b"]);
    expect(await assignNewTicket(f.tx, "desk", null, f.deps)).toEqual(["a"]);
    expect(f.events.slice(0, 2)).toEqual(["lock", "read"]);
    expect(f.tx.user.findMany.mock.calls[0][0].where).toMatchObject({ directoryStatus: "ACTIVE", role: { in: ["owner", "admin", "family"] }, id: { in: ["a", "inactive", "narrowed", "b"] } });
  });
  it("selects least-open and rotates ties using only this desk's open live tickets", async () => {
    const f = fixture("LEAST_OPEN"); expect(await assignNewTicket(f.tx, "desk", null, f.deps)).toEqual(["b"]);
    f.tx.pmWorkItemAssignee.groupBy.mockResolvedValue([]);
    expect(await assignNewTicket(f.tx, "desk", null, f.deps)).toEqual(["a"]);
    expect(f.tx.pmWorkItemAssignee.groupBy.mock.calls[0][0].where.workItem).toEqual({ projectId: "desk", isArchived: false, state: { group: { in: ["backlog", "unstarted", "started"] } } });
  });
  it("leaves manual and unmatched department tickets unassigned without moving the cursor", async () => {
    const f = fixture("MANUAL"); expect(await assignNewTicket(f.tx, "desk", null, f.deps)).toEqual([]);
    f.rule.mode = "ROUND_ROBIN"; f.rule.departmentId = "engineering";
    expect(await assignNewTicket(f.tx, "desk", "finance", f.deps)).toEqual([]);
    expect(f.tx.pmAssignmentRule.update).not.toHaveBeenCalled();
  });
  it("fails without advancing the cursor when access cannot be verified", async () => {
    const f = fixture(); await expect(assignNewTicket(f.tx, "desk", null, { resolveAccess: async () => { throw new Error("access offline"); } })).rejects.toThrow("access offline");
    expect(f.tx.pmAssignmentRule.update).not.toHaveBeenCalled();
  });
});
