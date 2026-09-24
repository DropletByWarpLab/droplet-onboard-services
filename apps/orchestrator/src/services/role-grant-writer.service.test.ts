/**
 * WARP-2897 — the one AccessRoleToolGrant writer (role-grant-writer.service.ts).
 *
 * What it owns, and these specs pin:
 *   - grantability at write time over BOTH tool layers (isGrantableDomain):
 *     erp never, a compiled grantable domain always, a runtime-only domain
 *     only while some runtime tool carries it;
 *   - the "introduce vs keep" rule: a domain the role ALREADY holds may stay
 *     even when it has gone dead (an extension disabled) — dead grants are
 *     marked, never force-dropped — but a NEW grant on a domain nothing
 *     provides is refused with the domain named;
 *   - the row shapes (wholesale replace for create/PATCH).
 */
import { describe, it, expect, vi } from "vitest";
import {
  UngrantableToolDomainError,
  assertGrantableToolDomains,
  createToolGrantsTx,
  replaceToolGrantsTx,
  toolGrantStates,
} from "./role-grant-writer.service.js";
import { toolLayers } from "./tool-layers.service.js";

const ext = toolLayers([
  { name: "bookings__list_slots", domain: "ext-bookings", requiresWrite: false, source: "runtime:bookings" },
]);

/** A map-backed `accessRoleToolGrant` delegate. */
function fakeTx(seed: Array<{ roleId: string; domain: string; level: string }> = []) {
  const rows = [...seed];
  const tx = {
    rows,
    accessRoleToolGrant: {
      findMany: vi.fn(async ({ where: { roleId } }: { where: { roleId: string } }) =>
        rows.filter((r) => r.roleId === roleId).map((r) => ({ domain: r.domain })),
      ),
      deleteMany: vi.fn(async ({ where: { roleId } }: { where: { roleId: string } }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.roleId === roleId) rows.splice(i, 1);
        return { count: before - rows.length };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ roleId: string; domain: string; level: string }> }) => {
          rows.push(...data);
          return { count: data.length };
        },
      ),
    },
  };
  return tx;
}

describe("assertGrantableToolDomains", () => {
  it("accepts compiled grantable domains with no runtime layer", () => {
    expect(() =>
      assertGrantableToolDomains([{ domain: "files", level: "use" }], { layers: toolLayers() }),
    ).not.toThrow();
  });

  it("refuses erp, naming it — connector reach is the connectors axis", () => {
    expect(() =>
      assertGrantableToolDomains([{ domain: "erp", level: "view" }], { layers: ext }),
    ).toThrow(UngrantableToolDomainError);
    try {
      assertGrantableToolDomains([{ domain: "erp", level: "view" }], { layers: ext });
    } catch (err) {
      expect((err as UngrantableToolDomainError).domains).toEqual(["erp"]);
      expect((err as Error).message).toContain("erp");
    }
  });

  it("accepts a runtime-only domain while a runtime tool carries it, refuses it once gone", () => {
    const grants = [{ domain: "ext-bookings", level: "view" as const }];
    expect(() => assertGrantableToolDomains(grants, { layers: ext })).not.toThrow();
    expect(() => assertGrantableToolDomains(grants, { layers: toolLayers() })).toThrow(
      /ext-bookings/,
    );
  });

  it("refuses a typo'd domain nobody provides", () => {
    expect(() =>
      assertGrantableToolDomains([{ domain: "filez", level: "view" }], { layers: ext }),
    ).toThrow(/filez/);
  });

  /**
   * MUTATION: drop the `alreadyHeld` exemption -> the first expectation goes
   * red (a role holding a dead grant could no longer be edited at all,
   * because the dashboard re-emits untouched rows verbatim).
   */
  it("KEEPING a dead grant the role already holds is allowed; erp never is", () => {
    const grants = [{ domain: "ext-bookings", level: "view" as const }];
    expect(() =>
      assertGrantableToolDomains(grants, { layers: toolLayers(), alreadyHeld: ["ext-bookings"] }),
    ).not.toThrow();
    expect(() =>
      assertGrantableToolDomains([{ domain: "erp", level: "view" }], {
        layers: toolLayers(),
        alreadyHeld: ["erp"],
      }),
    ).toThrow(UngrantableToolDomainError);
  });
});

describe("createToolGrantsTx / replaceToolGrantsTx", () => {
  it("create writes one row per grant and nothing when empty", async () => {
    const tx = fakeTx();
    await createToolGrantsTx(tx as never, "r1", [{ domain: "files", level: "use" }], {
      layers: toolLayers(),
    });
    expect(tx.rows).toEqual([{ roleId: "r1", domain: "files", level: "use" }]);
    const empty = fakeTx();
    await createToolGrantsTx(empty as never, "r1", [], { layers: toolLayers() });
    expect(empty.accessRoleToolGrant.createMany).not.toHaveBeenCalled();
  });

  it("create refuses an ungrantable domain BEFORE writing anything", async () => {
    const tx = fakeTx();
    await expect(
      createToolGrantsTx(
        tx as never,
        "r1",
        [
          { domain: "files", level: "use" },
          { domain: "ext-bookings", level: "view" },
        ],
        { layers: toolLayers() },
      ),
    ).rejects.toThrow(UngrantableToolDomainError);
    expect(tx.accessRoleToolGrant.createMany).not.toHaveBeenCalled();
  });

  it("replace swaps the role's rows wholesale and leaves other roles alone", async () => {
    const tx = fakeTx([
      { roleId: "r1", domain: "files", level: "use" },
      { roleId: "r2", domain: "files", level: "view" },
    ]);
    await replaceToolGrantsTx(tx as never, "r1", [{ domain: "cameras", level: "view" }], {
      layers: toolLayers(),
    });
    expect(tx.rows).toEqual([
      { roleId: "r2", domain: "files", level: "view" },
      { roleId: "r1", domain: "cameras", level: "view" },
    ]);
  });

  it("replace keeps a DEAD grant the role already holds (read inside the tx)", async () => {
    const tx = fakeTx([{ roleId: "r1", domain: "ext-bookings", level: "view" }]);
    await replaceToolGrantsTx(
      tx as never,
      "r1",
      [
        { domain: "ext-bookings", level: "view" },
        { domain: "files", level: "use" },
      ],
      { layers: toolLayers() },
    );
    expect(tx.rows.map((r) => r.domain).sort()).toEqual(["ext-bookings", "files"]);
  });

  it("replace refuses INTRODUCING a dead domain the role does not hold", async () => {
    const tx = fakeTx([{ roleId: "r1", domain: "files", level: "use" }]);
    await expect(
      replaceToolGrantsTx(tx as never, "r1", [{ domain: "ext-bookings", level: "view" }], {
        layers: toolLayers(),
      }),
    ).rejects.toThrow(/ext-bookings/);
    // Nothing was deleted either — the refusal precedes every write.
    expect(tx.rows).toEqual([{ roleId: "r1", domain: "files", level: "use" }]);
  });
});

describe("toolGrantStates — dead-grant marking", () => {
  it("a grant on a populated domain is live", () => {
    expect(toolGrantStates([{ domain: "files", level: "use" }], toolLayers())).toEqual([
      { domain: "files", level: "use", state: "live", deadReason: null },
    ]);
  });

  it("a declared-empty compiled domain is dead as empty_domain (crm/pm landing slots)", () => {
    expect(toolGrantStates([{ domain: "crm", level: "view" }], toolLayers())).toEqual([
      { domain: "crm", level: "view", state: "dead", deadReason: "empty_domain" },
    ]);
  });

  /**
   * MUTATION: compute state from the catalog layer only -> the attached
   * extension domain reads dead and this goes red.
   */
  it("a runtime-only domain is live while attached and dead as not_provided once gone", () => {
    const g = [{ domain: "ext-bookings", level: "view" as const }];
    expect(toolGrantStates(g, ext)[0]!.state).toBe("live");
    expect(toolGrantStates(g, toolLayers())[0]).toEqual({
      domain: "ext-bookings",
      level: "view",
      state: "dead",
      deadReason: "not_provided",
    });
  });
});
