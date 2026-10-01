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
      { scope: null, tier: "family" },
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
      { scope: null, tier: "family" },
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
      { scope: null, tier: "family" },
    );
    expect(out.get("p1")?.state).toBe("missing");
  });

  it("AXIS 1 - a module turned OFF makes its pins unavailable and unnamed", async () => {
    mockGetEffectiveModuleIds.mockResolvedValue(new Set(["chat", "projects"]));
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "c1" }],
      { scope: null, tier: "family" },
    );
    expect(out.get("p1")).toEqual({ state: "unavailable", label: null, sublabel: null });
    // Never even read - the name must not be fetched, let alone rendered.
    expect(p.crmCompany.findMany).not.toHaveBeenCalled();
  });

  it("AXIS 2 - a narrowed AccessRole loses every business pin unless it grants `business`", async () => {
    // ADR-045 (WARP-2583) put all four kinds behind ONE tool domain, so the
    // s3 grant that matters is `business`. This case used to hand a role
    // `pm` alone and expect its work-item pin to survive, because
    // `pm_get_work_item` lived in `pm`; that tool is gone and `pm` / `crm`
    // are empty landing slots for a remote catalog. A role granted only
    // those has NO tool that can read the record, so it must not be shown
    // the record's name - be29bf51's effective-access test pins the same
    // fact from the grant side. Per-KIND narrowing is the module axis above.
    const pins = [
      { id: "p1", kind: "customer", ref: "c1" },
      { id: "p2", kind: "work_item", ref: "w1" },
    ];

    const p = db();
    const legacy = await resolveBusinessPinTargets(p as unknown as PinTargetReadClient, pins, {
      scope: scopeWith("pm", "crm"),
      tier: "family",
    });
    expect(legacy.get("p1")?.state).toBe("unavailable");
    expect(legacy.get("p2")?.state).toBe("unavailable");
    // Never even read - exactly as for a module that is off.
    expect(p.crmCompany.findMany).not.toHaveBeenCalled();
    expect(p.pmWorkItem.findMany).not.toHaveBeenCalled();

    const q = db();
    const granted = await resolveBusinessPinTargets(q as unknown as PinTargetReadClient, pins, {
      scope: scopeWith("business"),
      tier: "family",
    });
    expect(granted.get("p1")?.state).toBe("active");
    expect(granted.get("p2")?.state).toBe("active");
  });

  it("a null scope narrows nothing (owner / no AccessRole - today's box)", async () => {
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "c1" }],
      { scope: null, tier: "family" },
    );
    expect(out.get("p1")?.state).toBe("active");
  });

  it("fails CLOSED when the module read throws", async () => {
    mockGetEffectiveModuleIds.mockRejectedValue(new Error("db down"));
    const p = db();
    const out = await resolveBusinessPinTargets(
      p as unknown as PinTargetReadClient,
      [{ id: "p1", kind: "customer", ref: "c1" }],
      { scope: null, tier: "family" },
    );
    expect(out.get("p1")?.state).toBe("unavailable");
  });
});

describe("checkBusinessPinTarget", () => {
  it("accepts a readable record", async () => {
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "customer", "c1", {
        scope: null,
        tier: "family",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a kind whose module is off, naming the module", async () => {
    mockGetEffectiveModuleIds.mockResolvedValue(new Set(["chat"]));
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "project", "pr1", {
        scope: null,
        tier: "family",
      }),
    ).toEqual({ ok: false, reason: "module_disabled", module: "projects" });
  });

  it("refuses a ref that names no row", async () => {
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "project", "nope", {
        scope: null,
        tier: "family",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});

// WARP-3365 / WARP-3369 (Romain, 2026-09-30) - an external guest gets nothing
// of the company's customers or work. `/api/llm/*` is behind neither the crm /
// projects tier floor nor a tool scope for a role-less guest (their scope is
// `null`, which narrows nothing), so a guest who knew a record's uuid could pin
// it and read its NAME back in the pin list and in every prompt. The tier
// decides here, off the same catalog fact as the routes.
describe("the tier floor on business pins (WARP-3365, WARP-3369)", () => {
  const ALL_KINDS = [
    { id: "p1", kind: "customer", ref: "c1" },
    { id: "p2", kind: "deal", ref: "d1" },
    { id: "p3", kind: "project", ref: "pr1" },
    { id: "p4", kind: "work_item", ref: "w1" },
  ];

  it("an existing guest pin of every business kind stops resolving: unavailable, unnamed, and never read", async () => {
    const p = db();
    const out = await resolveBusinessPinTargets(p as unknown as PinTargetReadClient, ALL_KINDS, {
      scope: null, // a role-less guest: nothing narrows
      tier: "guest",
    });
    for (const pin of ALL_KINDS) {
      expect(out.get(pin.id), pin.kind).toEqual({ state: "unavailable", label: null, sublabel: null });
    }
    expect(p.crmCompany.findMany).not.toHaveBeenCalled();
    expect(p.crmDeal.findMany).not.toHaveBeenCalled();
    expect(p.pmProject.findMany).not.toHaveBeenCalled();
    expect(p.pmWorkItem.findMany).not.toHaveBeenCalled();
  });

  it("an unknown tier (no session role) is refused too, and a service principal is not a person", async () => {
    for (const tier of [undefined, "service"]) {
      const p = db();
      const out = await resolveBusinessPinTargets(p as unknown as PinTargetReadClient, ALL_KINDS, {
        scope: null,
        tier,
      });
      expect([...out.values()].map((t) => t.state), String(tier)).toEqual([
        "unavailable",
        "unavailable",
        "unavailable",
        "unavailable",
      ]);
    }
  });

  it("a member, an admin and an owner resolve as before", async () => {
    for (const tier of ["family", "admin", "owner"]) {
      const out = await resolveBusinessPinTargets(db() as unknown as PinTargetReadClient, ALL_KINDS, {
        scope: null,
        tier,
      });
      expect(out.get("p1")?.label, tier).toBe("Northwind Dental");
      expect(out.get("p4")?.sublabel, tier).toBe("FIT-14");
    }
  });

  it("creating a pin answers the SAME way for a guest whether or not the record exists", async () => {
    const existing = db();
    const gone = db();
    gone.crmCompany.findUnique = vi.fn(async () => null as never);
    gone.pmProject.findUnique = vi.fn(async () => null as never);
    for (const [kind, ref, module] of [
      ["customer", "c1", "crm"],
      ["deal", "d1", "crm"],
      ["project", "pr1", "projects"],
      ["work_item", "w1", "projects"],
    ] as const) {
      const a = await checkBusinessPinTarget(existing as unknown as PinTargetReadClient, kind, ref, {
        scope: null,
        tier: "guest",
      });
      const b = await checkBusinessPinTarget(gone as unknown as PinTargetReadClient, kind, "no-such-uuid", {
        scope: null,
        tier: "guest",
      });
      expect(a, kind).toEqual({ ok: false, reason: "module_disabled", module });
      expect(b, kind).toEqual(a);
    }
    // the record was never even looked up
    expect(existing.crmCompany.findUnique).not.toHaveBeenCalled();
    expect(existing.pmWorkItem.findUnique).not.toHaveBeenCalled();
    expect(gone.pmProject.findUnique).not.toHaveBeenCalled();
  });

  it("a member can still pin a record they can read (and gets 'not found' for one that is not there)", async () => {
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "customer", "c1", {
        scope: null,
        tier: "family",
      }),
    ).toEqual({ ok: true });
    expect(
      await checkBusinessPinTarget(db() as unknown as PinTargetReadClient, "project", "nope", {
        scope: null,
        tier: "family",
      }),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});
