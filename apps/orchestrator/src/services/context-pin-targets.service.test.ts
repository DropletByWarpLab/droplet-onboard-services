/**
 * WARP-2582 - a pin must not name a record its holder cannot read.
 *
 * The two axes tested here are the ones `/api/llm/*` does NOT get for free:
 * the workspace module toggle (`/api/llm` is gated on `chat`, not on `crm`)
 * and the per-person ADR-032 s3 tool-domain grant. Both are checked on EVERY
 * TURN rather than once at create, because a module can be switched off under
 * a live pin.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetEffectiveModuleIds = vi.fn();
vi.mock("./modules.service.js", () => ({
  getEffectiveModuleIds: (...a: unknown[]) => mockGetEffectiveModuleIds(...a),
}));
vi.mock("../config.js", () => ({ config: {} }));

import {
  checkBusinessPinTarget,
  resolveBusinessPinTargets,
  type PinTargetReadClient,
} from "./context-pin-targets.service.js";
import type { ToolAccessScope } from "./tool-access.service.js";

function db() {
  return {
    crmCompany: {
      findMany: vi.fn(async () => [{ id: "c1", name: "Northwind Dental", isArchived: false }]),
      findUnique: vi.fn(async () => ({ id: "c1" })),
    },
    crmDeal: {
      findMany: vi.fn(async () => [
        { id: "d1", title: "Chair replacement", isArchived: false, company: { name: "Northwind Dental" } },
      ]),
      findUnique: vi.fn(async () => ({ id: "d1" })),
    },
    pmProject: {
      findMany: vi.fn(async () => [
        { id: "pr1", name: "Fit-out", identifier: "FIT", isArchived: true },
      ]),
      findUnique: vi.fn(async () => null),
    },
    pmWorkItem: {
      findMany: vi.fn(async () => [
        { id: "w1", name: "Order chairs", sequenceId: 14, isArchived: false, project: { identifier: "FIT", name: "Fit-out" } },
      ]),
      findUnique: vi.fn(async () => ({ id: "w1" })),
    },
  };
}

const scopeWith = (...domains: string[]): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(),
  locks: false,
});

beforeEach(() => {
  mockGetEffectiveModuleIds.mockReset();
  mockGetEffectiveModuleIds.mockResolvedValue(new Set(["chat", "crm", "projects"]));
});

describe("resolveBusinessPinTargets", () => {
  it("costs ZERO queries when the session has no business pin", async () => {
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "a", kind: "folder", ref: "/share/x" }],
      { scope: null },
    );
    expect(out.size).toBe(0);
    // The claim that this is safe on the chat critical path rests on this.
    expect(mockGetEffectiveModuleIds).not.toHaveBeenCalled();
    expect(p.crmCompany.findMany).not.toHaveBeenCalled();
  });

  it("resolves each kind to a name the model can act on", async () => {
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [
        { id: "p1", kind: "customer", ref: "c1" },
        { id: "p2", kind: "deal", ref: "d1" },
        { id: "p3", kind: "project", ref: "pr1" },
        { id: "p4", kind: "work_item", ref: "w1" },
      ],
      { scope: null },
    );
    expect(out.get("p1")).toEqual({ state: "active", label: "Northwind Dental", sublabel: null });
    expect(out.get("p2")?.sublabel).toBe("Northwind Dental");
    expect(out.get("p3")?.state).toBe("archived");
    expect(out.get("p4")?.sublabel).toBe("FIT-14");
  });

  it("reports MISSING for a deleted target rather than dropping the pin", async () => {
    const p = db();
    p.crmCompany.findMany = vi.fn(async () => []);
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "gone" }],
      { scope: null },
    );
    expect(out.get("p1")?.state).toBe("missing");
  });

  it("AXIS 1 - a module turned OFF makes its pins unavailable and unnamed", async () => {
    mockGetEffectiveModuleIds.mockResolvedValue(new Set(["chat", "projects"]));
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "c1" }],
      { scope: null },
    );
    expect(out.get("p1")).toEqual({ state: "unavailable", label: null, sublabel: null });
    // Never even read - the name must not be fetched, let alone rendered.
    expect(p.crmCompany.findMany).not.toHaveBeenCalled();
  });

  it("AXIS 2 - a narrowed AccessRole loses the kinds its role does not grant", async () => {
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [
        { id: "p1", kind: "customer", ref: "c1" },
        { id: "p2", kind: "work_item", ref: "w1" },
      ],
      { scope: scopeWith("pm") },
    );
    expect(out.get("p1")?.state).toBe("unavailable");
    expect(out.get("p2")?.state).toBe("active");
  });

  it("a null scope narrows nothing (owner / no AccessRole - today's box)", async () => {
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "c1" }],
      { scope: null },
    );
    expect(out.get("p1")?.state).toBe("active");
  });

  it("fails CLOSED when the module read throws", async () => {
    mockGetEffectiveModuleIds.mockRejectedValue(new Error("db down"));
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "c1" }],
      { scope: null },
    );
    expect(out.get("p1")?.state).toBe("unavailable");
  });
});

describe("checkBusinessPinTarget", () => {
  it("accepts a readable record", async () => {
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "customer", "c1", {
        scope: null,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a kind whose module is off, naming the module", async () => {
    mockGetEffectiveModuleIds.mockResolvedValue(new Set(["chat"]));
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "project", "pr1", {
        scope: null,
      }),
    ).toEqual({ ok: false, reason: "module_disabled", module: "projects" });
  });

  it("refuses a ref that names no row", async () => {
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "project", "nope", {
        scope: null,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});
