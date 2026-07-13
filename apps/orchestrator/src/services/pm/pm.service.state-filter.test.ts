import { describe, it, expect } from "vitest";
import { listWorkItems } from "./pm.service.js";

/**
 * WARP-888 (ADR-026) — `?state=` backwards-compat shim. The native PM surface
 * changed `?state=` from the Plane state name/slug (e.g. `in_progress`) to the
 * `PmState` UUID; older mobile clients sending a name silently got an empty
 * list. listWorkItems now accepts BOTH: a UUID passes straight through (no
 * PmState lookup — the dashboard path is unchanged), a name/slug resolves to
 * the matching state's id, and an unresolved value passes through as before.
 */

const STATE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makePrisma() {
  const calls = { pmStateFindMany: 0, capturedWhere: undefined as Record<string, unknown> | undefined };
  const prisma = {
    pmProject: { findUnique: async () => ({ id: "p1", identifier: "PRJ" }) },
    pmState: {
      findMany: async () => {
        calls.pmStateFindMany += 1;
        return [
          { id: STATE_UUID, name: "In Progress" },
          { id: "11111111-2222-3333-4444-555555555555", name: "Done" },
        ];
      },
    },
    pmWorkItem: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.capturedWhere = args.where;
        return [];
      },
    },
  } as never;
  return { prisma, calls };
}

describe("listWorkItems — ?state= slug/UUID compat (WARP-888)", () => {
  it("passes a UUID straight through without a PmState lookup", async () => {
    const { prisma, calls } = makePrisma();
    await listWorkItems(prisma, "p1", { stateId: STATE_UUID });
    expect(calls.capturedWhere?.stateId).toBe(STATE_UUID);
    expect(calls.pmStateFindMany).toBe(0); // common/dashboard path unaffected
  });

  it("resolves a legacy slug (in_progress) to the matching state id", async () => {
    const { prisma, calls } = makePrisma();
    await listWorkItems(prisma, "p1", { stateId: "in_progress" });
    expect(calls.capturedWhere?.stateId).toBe(STATE_UUID);
    expect(calls.pmStateFindMany).toBe(1);
  });

  it("resolves the exact state name case-insensitively", async () => {
    const { prisma, calls } = makePrisma();
    await listWorkItems(prisma, "p1", { stateId: "in progress" });
    expect(calls.capturedWhere?.stateId).toBe(STATE_UUID);
  });

  it("passes an unresolvable value through unchanged (empty result, as before)", async () => {
    const { prisma, calls } = makePrisma();
    await listWorkItems(prisma, "p1", { stateId: "no_such_state" });
    expect(calls.capturedWhere?.stateId).toBe("no_such_state");
  });

  it("applies no state filter when ?state= is absent", async () => {
    const { prisma, calls } = makePrisma();
    await listWorkItems(prisma, "p1", {});
    expect(calls.capturedWhere?.stateId).toBeUndefined();
    expect(calls.pmStateFindMany).toBe(0);
  });
});
