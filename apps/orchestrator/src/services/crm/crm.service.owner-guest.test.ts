/**
 * WARP-3365 (Romain, 2026-09-30) — an external guest cannot own a customer or a
 * deal. The owner is who a deal's won/lost notification goes to and who the
 * record is accountable to; a guest is someone outside the company, and is
 * admitted to no company record. The check is made before anything is written,
 * by looking the owner up by `User.id`: `undefined` (leave alone) and `null`
 * (clear) need no read, and an id that names no user is left to the caller as
 * before (the column is a free string, not a foreign key).
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  CRM_ERRORS,
  createCompany,
  createDeal,
  updateCompany,
  updateDeal,
} from "./crm.service.js";

const ROLES: Record<string, string> = { "u-gina": "guest", "u-marc": "family", "u-ada": "admin" };

function stub() {
  const user = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      ROLES[where.id] ? { role: ROLES[where.id] } : null,
    ),
  };
  const crmCompany = {
    create: vi.fn(async () => {
      throw new Error("reached the write");
    }),
    findUnique: vi.fn(async () => ({ id: "c1" })),
    update: vi.fn(async () => {
      throw new Error("reached the write");
    }),
  };
  const crmDeal = {
    create: vi.fn(async () => {
      throw new Error("reached the write");
    }),
    findUnique: vi.fn(async () => ({
      id: "d1",
      pipelineId: "p1",
      stageId: "s1",
      closedAt: null,
      stage: { id: "s1", name: "New", kind: "OPEN" },
    })),
  };
  return { user, crmCompany, crmDeal, $transaction: vi.fn() };
}

type Stub = ReturnType<typeof stub>;
const asPrisma = (s: Stub) => s as unknown as PrismaClient;

/** The message the call threw, or null when it did not throw. */
async function thrown(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("a guest cannot own a customer or a deal (WARP-3365)", () => {
  it("createCompany refuses a guest owner before anything is written", async () => {
    const s = stub();
    expect(await thrown(() => createCompany(asPrisma(s), { name: "Acme", ownerId: "u-gina" }, "u-ada"))).toBe(
      CRM_ERRORS.OWNER_IS_GUEST,
    );
    expect(s.user.findUnique).toHaveBeenCalledWith({ where: { id: "u-gina" }, select: { role: true } });
    expect(s.crmCompany.create).not.toHaveBeenCalled();
  });

  it("updateCompany refuses a guest owner, and does not write", async () => {
    const s = stub();
    expect(await thrown(() => updateCompany(asPrisma(s), "c1", { ownerId: "u-gina" }))).toBe(CRM_ERRORS.OWNER_IS_GUEST);
    expect(s.crmCompany.update).not.toHaveBeenCalled();
  });

  it("createDeal refuses a guest owner before the pipeline is even read", async () => {
    const s = stub();
    expect(await thrown(() => createDeal(asPrisma(s), { title: "Renewal", ownerId: "u-gina" }, "u-ada"))).toBe(
      CRM_ERRORS.OWNER_IS_GUEST,
    );
    expect(s.crmDeal.create).not.toHaveBeenCalled();
  });

  it("updateDeal refuses a guest owner before anything is moved or written", async () => {
    const s = stub();
    expect(await thrown(() => updateDeal(asPrisma(s), "d1", { ownerId: "u-gina" }, "u-ada"))).toBe(CRM_ERRORS.OWNER_IS_GUEST);
    expect(s.$transaction).not.toHaveBeenCalled();
  });

  it("a member or an admin may own one: the guest check is passed and the call goes on to write", async () => {
    for (const owner of ["u-marc", "u-ada"]) {
      const s = stub();
      expect(await thrown(() => createCompany(asPrisma(s), { name: "Acme", ownerId: owner }, "u-ada")), owner).toBe(
        "reached the write",
      );
      expect(s.crmCompany.create).toHaveBeenCalledTimes(1);
    }
  });

  it("no owner, clearing the owner, and leaving it alone cost no user read at all", async () => {
    const s = stub();
    await thrown(() => createCompany(asPrisma(s), { name: "Acme" }, "u-ada"));
    await thrown(() => createCompany(asPrisma(s), { name: "Acme", ownerId: null }, "u-ada"));
    await thrown(() => updateCompany(asPrisma(s), "c1", { name: "Renamed" }));
    await thrown(() => updateCompany(asPrisma(s), "c1", { ownerId: null }));
    expect(s.user.findUnique).not.toHaveBeenCalled();
  });

  it("an id that names no user is left to the caller, exactly as before", async () => {
    const s = stub();
    expect(await thrown(() => createCompany(asPrisma(s), { name: "Acme", ownerId: "someone-else" }, "u-ada"))).toBe(
      "reached the write",
    );
  });
});
