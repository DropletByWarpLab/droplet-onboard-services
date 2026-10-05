import { describe, it, expect } from "vitest";
import type { ModuleId } from "@prisma/client";
import { applyBusinessType, computeModuleStates, computeEffectiveIds, getModulesView, setModuleEnabled } from "./modules.service.js";
import { BUSINESS_TYPES, MODULES, type AvailabilityConfig } from "../modules/module-registry.js";

/** Config where every availability signal is satisfied. */
const ALL_AVAILABLE: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai:8000",
  FILE_INDEXER_URL: "http://fi:8090",
  NEXTCLOUD_URL: "http://nc:8080",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docs",
  SERVICE_TOKEN_EMAIL: "tok",
  SERVICE_TOKEN_VOICE: "tok",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8083",
  ROUTING_SERVICE_URL: "http://routing:8080",
  SWITCH_SERVICE_URL: "http://switch:8081",
};
/** A minimal box: empty tokens/flags (only the always-defaulted URLs set). */
const MINIMAL: AvailabilityConfig = {
  ...ALL_AVAILABLE,
  DOCS_ENABLED: "0", DOCS_INTERNAL_URL: "",
  SERVICE_TOKEN_EMAIL: "", SERVICE_TOKEN_VOICE: "", DROPLET_MATTER_SERVICE_URL: "",
};

const byId = (states: ReturnType<typeof computeModuleStates>) =>
  new Map(states.map((s) => [s.id, s]));

describe("effective-state resolution (pure)", () => {
  it("effective = available AND enabled", () => {
    const overrides = new Map<ModuleId, boolean>([["cameras", true], ["email", true]]);
    const s = byId(computeModuleStates(overrides, ALL_AVAILABLE));
    // cameras: available + enabled → effective
    expect(s.get("cameras")).toMatchObject({ available: true, enabled: true, effective: true });
    // email enabled but the token is set in ALL_AVAILABLE → effective
    expect(s.get("email")!.effective).toBe(true);
  });

  it("an enabled but UNAVAILABLE module is not effective (stored-on for when it deploys)", () => {
    const overrides = new Map<ModuleId, boolean>([["email", true], ["smart_home", true]]);
    const s = byId(computeModuleStates(overrides, MINIMAL)); // tokens/matter empty
    expect(s.get("email")).toMatchObject({ available: false, enabled: true, effective: false });
    expect(s.get("smart_home")).toMatchObject({ available: false, enabled: true, effective: false });
  });

  it("a disabled but available module is not effective", () => {
    const overrides = new Map<ModuleId, boolean>([["cameras", false]]);
    const s = byId(computeModuleStates(overrides, ALL_AVAILABLE));
    expect(s.get("cameras")).toMatchObject({ available: true, enabled: false, effective: false });
    expect(computeEffectiveIds(overrides, ALL_AVAILABLE).has("cameras")).toBe(false);
  });

  it("core `chat` is always enabled regardless of overrides; effective iff available", () => {
    const overrides = new Map<ModuleId, boolean>([["chat", false]]); // override ignored for core
    expect(byId(computeModuleStates(overrides, ALL_AVAILABLE)).get("chat")).toMatchObject({
      core: true, enabled: true, effective: true,
    });
    // no AI gateway → available false → not effective, still enabled
    expect(byId(computeModuleStates(overrides, { ...ALL_AVAILABLE, AI_GATEWAY_URL: "" })).get("chat"))
      .toMatchObject({ enabled: true, available: false, effective: false });
  });

  it("with no override, the registry defaultEnabled applies", () => {
    const s = byId(computeModuleStates(new Map(), ALL_AVAILABLE));
    // knowledge/files/calendar/network default on; email/projects/voice/cameras/switch default off
    expect(s.get("knowledge")!.enabled).toBe(true);
    expect(s.get("network")!.enabled).toBe(true);
    expect(s.get("email")!.enabled).toBe(false);
    expect(s.get("cameras")!.enabled).toBe(false);
  });

  it("computeEffectiveIds returns exactly the effective set", () => {
    const overrides = new Map<ModuleId, boolean>([
      ["cameras", true], ["email", true], ["voice", false],
    ]);
    const eff = computeEffectiveIds(overrides, ALL_AVAILABLE);
    expect(eff.has("chat")).toBe(true);      // core + available
    expect(eff.has("cameras")).toBe(true);   // on + available
    expect(eff.has("email")).toBe(true);     // on + available
    expect(eff.has("voice")).toBe(false);    // off
  });
});

// ── WARP-1585 — declared module dependencies (`ModuleDef.requires`) ──
//
// The workspace axis of the same rule the resolver applies per person. Docs is
// not a standalone surface: it edits files that live in Files, so a box with
// Files switched off has nothing for Documents to open. The registry declares
// that edge once (`docs.requires = "files"`) and both axes read it, rather
// than the enforcement falling out of an Express prefix collision.
describe("declared module dependencies (WARP-1585)", () => {
  it("a module whose parent is not effective is not effective either", () => {
    const overrides = new Map<ModuleId, boolean>([["files", false], ["docs", true]]);
    const eff = computeEffectiveIds(overrides, ALL_AVAILABLE);
    expect(eff.has("files")).toBe(false);
    expect(eff.has("docs")).toBe(false);
    // …and `knowledge`, which declares no parent, is untouched by a Files
    // toggle: it reads the orchestrator's own chunk store behind the file
    // indexer, not Nextcloud.
    expect(eff.has("knowledge")).toBe(true);
  });

  it("reports the dependency on the state row rather than hiding it in `effective`", () => {
    // The operator-facing view has to be able to SAY why, not just show a
    // module that refuses to switch on. `enabled` keeps the operator's stored
    // intent so re-enabling Files restores Documents exactly as it was.
    const overrides = new Map<ModuleId, boolean>([["files", false], ["docs", true]]);
    const s = byId(computeModuleStates(overrides, ALL_AVAILABLE));
    expect(s.get("docs")).toMatchObject({
      available: true,
      enabled: true,
      effective: false,
      requires: "files",
      requiresUnmet: true,
    });
    expect(s.get("knowledge")!.requiresUnmet).toBe(false);
  });

  it("the parent coming back restores the child", () => {
    const overrides = new Map<ModuleId, boolean>([["files", true], ["docs", true]]);
    const eff = computeEffectiveIds(overrides, ALL_AVAILABLE);
    expect(eff.has("docs")).toBe(true);
  });

  it("an UNAVAILABLE parent also drops the child", () => {
    // files' availability is `isSet(NEXTCLOUD_URL)` — a box built without
    // Nextcloud has no document surface either.
    const overrides = new Map<ModuleId, boolean>([["files", true], ["docs", true]]);
    const eff = computeEffectiveIds(overrides, { ...ALL_AVAILABLE, NEXTCLOUD_URL: "" });
    expect(eff.has("files")).toBe(false);
    expect(eff.has("docs")).toBe(false);
  });
});

// ── WARP-3528 — Support: its own surface, off until switched on, on in every business preset ──
describe("support — the service desk module (WARP-3528)", () => {
  it("is off until someone turns it on, and available on a minimal box", () => {
    // MUTATION: `defaultEnabled: true` → a box that never opted in serves it.
    const row = byId(computeModuleStates(new Map(), MINIMAL)).get("support");
    expect(row).toMatchObject({ available: true, enabled: false, effective: false });
  });

  it("is effective with Projects switched OFF — there is no parent to be unmet (ADR-069 §1)", () => {
    // MUTATION: `requires: "projects"` → effective:false, requiresUnmet:true.
    const overrides = new Map<ModuleId, boolean>([["support", true], ["projects", false]]);
    const row = byId(computeModuleStates(overrides, MINIMAL)).get("support");
    expect(row).toMatchObject({ available: true, enabled: true, effective: true, requiresUnmet: false });
    expect(row).not.toHaveProperty("requires");
    expect(computeEffectiveIds(overrides, MINIMAL).has("support")).toBe(true);
    // …and Projects is untouched by Support's toggle in the other direction.
    expect(computeEffectiveIds(new Map<ModuleId, boolean>([["projects", true], ["support", false]]), MINIMAL).has("projects")).toBe(true);
  });

  describe("applyBusinessType", () => {
    /** A prisma stub that records the explicit rows a preset materializes. */
    function presetPrisma() {
      const writes: Array<{ moduleId: ModuleId; enabled: boolean }> = [];
      const tx = {
        moduleSetting: {
          upsert: async ({ where, update }: { where: { moduleId: ModuleId }; update: { enabled: boolean } }) => {
            writes.push({ moduleId: where.moduleId, enabled: update.enabled });
            return {};
          },
        },
        workspace: { upsert: async () => ({}) },
      };
      const prisma = {
        moduleSetting: { findMany: async () => [] },
        workspace: { findUnique: async () => null },
        $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      } as never;
      return { prisma, writes };
    }

    it.each(BUSINESS_TYPES.filter((b) => b.id !== "custom").map((b) => [b.id] as const))(
      "%s writes an explicit row for EVERY non-core module — Support on, the rest iff the preset lists them",
      async (type) => {
        const { prisma, writes } = presetPrisma();
        await applyBusinessType(prisma, ALL_AVAILABLE, type, "owner");
        const preset = BUSINESS_TYPES.find((b) => b.id === type)!;
        // nothing is inferred from a missing row: support has one, like every other non-core module
        expect(writes.map((w) => w.moduleId).sort()).toEqual(
          MODULES.filter((m) => !m.core).map((m) => m.id).sort(),
        );
        for (const w of writes) {
          expect(w.enabled, `${type} ${w.moduleId}`).toBe(preset.modules.includes(w.moduleId));
        }
        expect(writes.find((w) => w.moduleId === "support")).toEqual({ moduleId: "support", enabled: true });
      },
    );

    it("`custom` is a no-op on the toggles: Support stays exactly where the operator left it", async () => {
      const { prisma, writes } = presetPrisma();
      await applyBusinessType(prisma, ALL_AVAILABLE, "custom", "owner");
      expect(writes).toEqual([]);
    });
  });
});

// ── WARP-1585 review — the toggle's answer and GET /api/modules' answer ──
describe("setModuleEnabled re-derives instead of answering locally", () => {
  /** A prisma stub over an in-memory ModuleSetting table. */
  function prismaWith(rows: Array<[ModuleId, boolean]>) {
    const table = new Map<ModuleId, boolean>(rows);
    return {
      moduleSetting: {
        findMany: async () =>
          [...table].map(([moduleId, enabled]) => ({ moduleId, enabled })),
        upsert: async ({ where, update }: { where: { moduleId: ModuleId }; update: { enabled: boolean } }) => {
          table.set(where.moduleId, update.enabled);
          return { moduleId: where.moduleId, enabled: update.enabled };
        },
      },
    } as never;
  }

  it("switching Documents on with Files off returns effective:false, not a lie", () => {
    // `available && enabled` was a correct local answer while a module's
    // effectiveness depended only on itself. With a declared dependency it
    // reports a module the box will not serve as ON, so the row the panel
    // renders after a toggle disagrees with the row GET /api/modules returns
    // one refresh later.
    return setModuleEnabled(
      prismaWith([["files", false]]),
      ALL_AVAILABLE,
      "docs",
      true,
      "owner",
    ).then((row) => {
      expect(row).toMatchObject({
        id: "docs",
        available: true,
        enabled: true,       // the operator's stored intent is kept
        effective: false,    // …and the box still won't serve it
        requires: "files",
        requiresUnmet: true,
      });
    });
  });

  it("the same toggle with Files on is effective", async () => {
    const row = await setModuleEnabled(
      prismaWith([["files", true]]),
      ALL_AVAILABLE,
      "docs",
      true,
      "owner",
    );
    expect(row).toMatchObject({ id: "docs", effective: true, requiresUnmet: false });
  });

  it("switching the PARENT off is reflected in the parent's own row", async () => {
    const row = await setModuleEnabled(
      prismaWith([["files", true], ["docs", true]]),
      ALL_AVAILABLE,
      "files",
      false,
      "owner",
    );
    expect(row).toMatchObject({ id: "files", enabled: false, effective: false });
  });
});

// ── the operator's list: every module has a row, available or not ──
describe("getModulesView lists every module, so an unavailable one still reads 'Not installed'", () => {
  /** Enough prisma for the read path: the stored toggles and the workspace singleton. */
  const prismaWith = (rows: Array<[ModuleId, boolean]> = []) =>
    ({
      moduleSetting: { findMany: async () => rows.map(([moduleId, enabled]) => ({ moduleId, enabled })) },
      workspace: { findUnique: async () => null },
    }) as never;
  const ids = (view: { modules: Array<{ id: string }> }) => view.modules.map((m) => m.id);

  it("an unavailable module keeps its row, so the operator still reads 'Not installed'", async () => {
    // email and smart_home are unavailable here (no service token / Matter URL).
    const noEmail: AvailabilityConfig = { ...ALL_AVAILABLE, SERVICE_TOKEN_EMAIL: "", DROPLET_MATTER_SERVICE_URL: "" };
    const view = await getModulesView(prismaWith(), noEmail);
    expect(view.modules.find((m) => m.id === "email")).toMatchObject({ available: false });
    expect(view.modules.find((m) => m.id === "smart_home")).toMatchObject({ available: false });
    // Nothing is dropped: the view is the whole registry.
    expect(ids(view).sort()).toEqual(MODULES.map((m) => m.id).sort());
  });

  it("the same answer comes back from applying a business type", async () => {
    const prisma = {
      moduleSetting: { findMany: async () => [], upsert: async () => ({}) },
      workspace: { findUnique: async () => null, upsert: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ moduleSetting: { upsert: async () => ({}) }, workspace: { upsert: async () => ({}) } }),
    } as never;
    expect(ids(await applyBusinessType(prisma, ALL_AVAILABLE, "custom", "owner")).sort()).toEqual(
      MODULES.map((m) => m.id).sort(),
    );
  });
});
