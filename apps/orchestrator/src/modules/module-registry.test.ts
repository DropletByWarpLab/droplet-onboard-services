import { describe, it, expect } from "vitest";
import type { ModuleId } from "@prisma/client";
import {
  MODULES,
  MODULE_BY_ID,
  BUSINESS_TYPES,
  BUSINESS_TYPE_BY_ID,
  MODULE_REQUIRES,
  foreignOwnedPaths,
  foreignSubPrefixes,
  gateScopeFor,
  isModuleId,
  isBusinessType,
  normalizeGatePath,
  pathIsUnder,
  satisfiedModuleIds,
  type AvailabilityConfig,
} from "./module-registry.js";

/** A config where every availability signal is satisfied. */
export const ALL_AVAILABLE: AvailabilityConfig = {
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

/** A minimal box: only the always-defaulted URLs; empty tokens/flags. */
export const MINIMAL: AvailabilityConfig = {
  ...ALL_AVAILABLE,
  DOCS_ENABLED: "0",
  DOCS_INTERNAL_URL: "",
  SERVICE_TOKEN_EMAIL: "",
  SERVICE_TOKEN_VOICE: "",
  DROPLET_MATTER_SERVICE_URL: "",
};

describe("module registry — catalog integrity", () => {
  it("ids are unique and indexed", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODULES) expect(MODULE_BY_ID.get(m.id)).toBe(m);
  });

  it("exactly `chat` is core, and core is default-enabled", () => {
    const core = MODULES.filter((m) => m.core).map((m) => m.id);
    expect(core).toEqual(["chat"]);
    expect(MODULE_BY_ID.get("chat")!.defaultEnabled).toBe(true);
  });

  it("isModuleId matches the catalog", () => {
    expect(isModuleId("cameras")).toBe(true);
    expect(isModuleId("nope")).toBe(false);
  });
});

describe("route prefixes — must match a real router mount", () => {
  it("every non-core module's prefixes are under /api/", () => {
    // All orchestrator routers mount at "/api"; a prefix that doesn't start
    // with "/api/" can never match a request path, so the gate silently
    // no-ops (the module is un-gated). Guards findings on docs (was
    // "/files/docs") and any future drift.
    for (const m of MODULES) {
      if (m.core) continue;
      for (const p of m.routePrefixes) {
        expect(p.startsWith("/api/"), `${m.id} prefix ${p} is not under /api/`).toBe(true);
      }
    }
  });

  it("prefixes point at the routers they claim to gate", () => {
    // Canonical mounts verified against the live routers:
    //   knowledge → /api/files/knowledge/* (files-knowledge.ts)
    //   docs      → /api/files/docs/status (files.ts)
    //   calendar  → /api/calendar/* (calendar.ts) — NOT /api/pm/events
    //   smart_home→ /api/matter/* only (matter.ts); /api/devices is the
    //               device registry/pairing/push surface, never gated here.
    const prefixes = (id: string) => MODULE_BY_ID.get(id as never)!.routePrefixes;
    expect(prefixes("knowledge")).toEqual(["/api/files/knowledge"]);
    expect(prefixes("docs")).toEqual(["/api/files/docs"]);
    expect(prefixes("calendar")).toEqual(["/api/calendar"]);
    expect(prefixes("smart_home")).toEqual(["/api/matter"]);
    expect(prefixes("smart_home")).not.toContain("/api/devices");
  });
});

describe("nested route prefixes — the WARP-1585 collision", () => {
  /** Every (outer module, inner prefix) pair where one module's prefix sits
   *  strictly INSIDE another module's prefix. */
  function nestedPairs(): Array<[ModuleId, string]> {
    const out: Array<[ModuleId, string]> = [];
    for (const outer of MODULES) {
      for (const op of outer.routePrefixes) {
        for (const inner of MODULES) {
          if (inner.id === outer.id) continue;
          for (const ip of inner.routePrefixes) {
            if (ip.startsWith(`${op}/`)) out.push([outer.id, ip]);
          }
        }
      }
    }
    return out.sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
  }

  it("the catalog's nesting is exactly the known files/knowledge/docs family", () => {
    // Express `app.use(prefix, handler)` is a PREFIX mount, so a gate at
    // `/api/files` also fires on `/api/files/knowledge/*` and
    // `/api/files/docs/*`. This pins the set so a new nested prefix can't be
    // added without someone reading `foreignSubPrefixes` and deciding.
    expect(nestedPairs()).toEqual([
      ["files", "/api/files/docs"],
      ["files", "/api/files/knowledge"],
    ]);
  });

  it("foreignSubPrefixes surfaces exactly the nested sibling namespaces", () => {
    expect(foreignSubPrefixes("files", "/api/files")).toEqual([
      "/api/files/docs",
      "/api/files/knowledge",
    ]);
    // A module IS allowed to own a prefix inside its own other prefix — only
    // FOREIGN nesting matters, because only that steals another module's gate.
    expect(foreignSubPrefixes("knowledge", "/api/files/knowledge")).toEqual([]);
    expect(foreignSubPrefixes("docs", "/api/files/docs")).toEqual([]);
    expect(foreignSubPrefixes("cameras", "/api/cameras")).toEqual([]);
  });

  it("every nested module declares the exact paths it owns", () => {
    // A prefix is not a safe ownership boundary when the ENCLOSING module
    // serves wildcard user paths (`/api/files/:filePath(*)/editor-session`):
    // a file under a folder called `knowledge` spells a sibling's namespace.
    // So a nested module must say which paths are actually its routes.
    // Without this, `gateScopeFor` leaves the whole sub-tree with the
    // enclosing module — fail-closed, but the sibling's toggle would go back
    // to enforcing nothing, which is the WARP-1585 bug. This is the test that
    // makes that loud instead of silent.
    for (const [, innerPrefix] of nestedPairs()) {
      const inner = MODULES.find((m) => m.routePrefixes.includes(innerPrefix))!;
      expect(inner.ownedPaths, `${inner.id} nests but declares no ownedPaths`).toBeDefined();
      expect(inner.ownedPaths!.length).toBeGreaterThan(0);
      for (const owned of inner.ownedPaths!) {
        expect(
          inner.routePrefixes.some((prefix) => pathIsUnder(owned, prefix)),
          `${inner.id} owns ${owned}, which is outside its own prefixes`,
        ).toBe(true);
      }
      // …and every one of its prefixes has at least one owned path, or that
      // prefix would have no gate at all. `gateScopeFor` falls back to gating
      // the whole prefix in that case; this is what makes it visible.
      for (const prefix of inner.routePrefixes) {
        expect(
          inner.ownedPaths!.some((owned) => pathIsUnder(owned, prefix)),
          `${inner.id} declares ownedPaths but none under its prefix ${prefix}`,
        ).toBe(true);
      }
    }
  });

  it("the declared owned paths are the sibling routers' real routes", () => {
    // Verified against the live routers: files-knowledge.ts registers exactly
    // `/files/knowledge/recent` + `/files/knowledge/search` (its header: "the
    // dashboard's /knowledge tabs target this namespace; nothing else
    // should"), and the docs module's only route is the doc-engine health
    // probe in files.ts. A new route in either namespace has to be added here
    // or it keeps the enclosing `files` gate.
    expect(MODULE_BY_ID.get("knowledge")!.ownedPaths).toEqual([
      "/api/files/knowledge/recent",
      "/api/files/knowledge/search",
    ]);
    expect(MODULE_BY_ID.get("docs")!.ownedPaths).toEqual(["/api/files/docs/status"]);
    // The enclosing module owns a sub-tree, not a path list.
    expect(MODULE_BY_ID.get("files")!.ownedPaths).toBeUndefined();
  });

  it("foreignOwnedPaths is the sibling ROUTES, never the sibling sub-trees", () => {
    expect(foreignOwnedPaths("files", "/api/files")).toEqual([
      "/api/files/docs/status",
      "/api/files/knowledge/recent",
      "/api/files/knowledge/search",
    ]);
    expect(foreignOwnedPaths("knowledge", "/api/files/knowledge")).toEqual([]);
    expect(foreignOwnedPaths("cameras", "/api/cameras")).toEqual([]);
  });

  it("gateScopeFor splits the /api/files namespace by path, not by prefix", () => {
    const filesScope = gateScopeFor(MODULE_BY_ID.get("files")!, "/api/files")!;
    const knowledgeScope = gateScopeFor(
      MODULE_BY_ID.get("knowledge")!,
      "/api/files/knowledge",
    )!;
    // The sibling's own routes: the sibling gates them, files does not.
    expect(filesScope("/api/files/knowledge/recent")).toBe(false);
    expect(knowledgeScope("/api/files/knowledge/recent")).toBe(true);
    // A Nextcloud file that happens to live under a folder called
    // `knowledge`: a FILES operation, gated by files, NOT by knowledge.
    const wildcard = "/api/files/knowledge/q3.docx/editor-session";
    expect(filesScope(wildcard)).toBe(true);
    expect(knowledgeScope(wildcard)).toBe(false);
    // Same for the docs namespace, and for plain files paths.
    expect(filesScope("/api/files/docs/q3.docx/comments")).toBe(true);
    expect(filesScope("/api/files/spaces")).toBe(true);
    // A module with no nesting either way needs no wrapper at all.
    expect(gateScopeFor(MODULE_BY_ID.get("cameras")!, "/api/cameras")).toBeNull();
  });

  it("normalizeGatePath agrees with Express's case/trailing-slash routing", () => {
    expect(normalizeGatePath("/api/files/knowledge/recent/")).toBe("/api/files/knowledge/recent");
    expect(normalizeGatePath("/API/Files/Knowledge/Recent")).toBe("/api/files/knowledge/recent");
    expect(normalizeGatePath("/")).toBe("/");
  });

  it("pathIsUnder honours Express's segment-boundary prefix semantics", () => {
    expect(pathIsUnder("/api/files/knowledge/recent", "/api/files/knowledge")).toBe(true);
    expect(pathIsUnder("/api/files/knowledge", "/api/files/knowledge")).toBe(true);
    expect(pathIsUnder("/api/files/knowledge/", "/api/files/knowledge")).toBe(true);
    // NOT a sub-path: `app.use` only matches on a segment boundary, so these
    // belong to `files` and must keep the files gate.
    expect(pathIsUnder("/api/files/knowledgebase", "/api/files/knowledge")).toBe(false);
    expect(pathIsUnder("/api/filesknowledge", "/api/files")).toBe(false);
    expect(pathIsUnder("/api/file", "/api/files")).toBe(false);
  });
});

describe("module dependencies (WARP-1585)", () => {
  it("docs declares files as its parent; knowledge declares none", () => {
    // Documents has NO surface of its own (`navHrefs: []`): its substantive
    // act is minting an editor session for a Nextcloud path, which lives on
    // `/api/files/:filePath(*)/editor-session`. Knowledge, by contrast, reads
    // FileContentChunk rows out of the orchestrator's own Postgres (sources
    // `nextcloud` AND `brain`) behind FILE_INDEXER_URL — nothing on that path
    // touches Nextcloud, so it stands alone.
    expect(MODULE_BY_ID.get("docs")!.requires).toBe("files");
    expect(MODULE_BY_ID.get("knowledge")!.requires).toBeUndefined();
    expect(MODULE_REQUIRES.get("docs")).toBe("files");
    expect(MODULE_REQUIRES.has("knowledge")).toBe(false);
  });

  it("every declared parent is a real, non-core module and never self-referential", () => {
    for (const [child, parent] of MODULE_REQUIRES) {
      expect(isModuleId(parent)).toBe(true);
      expect(parent).not.toBe(child);
      expect(MODULE_BY_ID.get(parent)!.core).toBe(false);
    }
  });

  it("drops a child whose parent is absent, keeps it when the parent is held", () => {
    expect([...satisfiedModuleIds(new Set<ModuleId>(["docs", "knowledge"]))].sort()).toEqual([
      "knowledge",
    ]);
    expect(
      [...satisfiedModuleIds(new Set<ModuleId>(["docs", "files", "knowledge"]))].sort(),
    ).toEqual(["docs", "files", "knowledge"]);
    // No dependency edge → never narrowed.
    expect([...satisfiedModuleIds(new Set<ModuleId>(["knowledge"]))]).toEqual(["knowledge"]);
  });

  it("runs to a FIXED POINT — a chain collapses whatever the iteration order", () => {
    // Today's catalog has a single edge, but the closure must not depend on
    // that: a grandchild has to fall when the grandparent does.
    //
    // The set is iterated in INSERTION order, so the discriminating case is
    // the grandchild FIRST — visited while its parent is still present, and
    // only dropped on a later pass. A single-pass implementation passes the
    // parent-first ordering and silently over-grants on this one.
    const chain = new Map<ModuleId, ModuleId>([
      ["docs", "files"],
      ["knowledge", "docs"],
    ]);
    expect([...satisfiedModuleIds(new Set<ModuleId>(["knowledge", "docs"]), chain)]).toEqual([]);
    expect([...satisfiedModuleIds(new Set<ModuleId>(["docs", "knowledge"]), chain)]).toEqual([]);
    expect(
      [...satisfiedModuleIds(new Set<ModuleId>(["files", "docs", "knowledge"]), chain)].sort(),
    ).toEqual(["docs", "files", "knowledge"]);
  });

  it("terminates on a cyclic edge map instead of spinning", () => {
    // A cycle is a registry-authoring error, not a runtime input — but the
    // closure is a while-loop, so "what does it do with one" has to have an
    // answer. It terminates: each pass either removes a member or stops, and
    // a cycle whose members are all held is self-satisfying.
    const cycle = new Map<ModuleId, ModuleId>([
      ["docs", "knowledge"],
      ["knowledge", "docs"],
    ]);
    expect([...satisfiedModuleIds(new Set<ModuleId>(["docs", "knowledge"]), cycle)].sort()).toEqual([
      "docs",
      "knowledge",
    ]);
    // Break the cycle's membership and the whole ring falls.
    expect([...satisfiedModuleIds(new Set<ModuleId>(["docs"]), cycle)]).toEqual([]);
  });
});

describe("business-type presets", () => {
  it("every preset references valid, non-core module ids", () => {
    for (const bt of BUSINESS_TYPES) {
      for (const id of bt.modules) {
        expect(isModuleId(id)).toBe(true);
        expect(MODULE_BY_ID.get(id)!.core, `${bt.id} lists core module ${id}`).toBe(false);
      }
      // no duplicates within a preset
      expect(new Set(bt.modules).size).toBe(bt.modules.length);
    }
  });

  it("custom preset is an explicit no-op (empty set)", () => {
    expect(BUSINESS_TYPE_BY_ID.get("custom")!.modules).toEqual([]);
  });

  it("isBusinessType matches the catalog", () => {
    expect(isBusinessType("clinic")).toBe(true);
    expect(isBusinessType("bakery")).toBe(false);
  });
});

describe("availability signals", () => {
  const avail = (id: string, cfg: AvailabilityConfig) => MODULE_BY_ID.get(id as never)!.available(cfg);

  it("native modules are always available", () => {
    for (const id of ["calendar", "projects"]) {
      expect(avail(id, MINIMAL)).toBe(true);
    }
  });

  it("token/flag-gated modules go unavailable when their signal is empty", () => {
    expect(avail("docs", MINIMAL)).toBe(false); // DOCS_ENABLED=0 / URL empty
    expect(avail("email", MINIMAL)).toBe(false); // token empty
    expect(avail("voice", MINIMAL)).toBe(false); // token empty
    expect(avail("smart_home", MINIMAL)).toBe(false); // matter URL empty
    // …and available when satisfied
    expect(avail("docs", ALL_AVAILABLE)).toBe(true);
    expect(avail("email", ALL_AVAILABLE)).toBe(true);
    expect(avail("smart_home", ALL_AVAILABLE)).toBe(true);
  });

  it("docs requires BOTH the flag and the internal URL", () => {
    expect(avail("docs", { ...ALL_AVAILABLE, DOCS_ENABLED: "1", DOCS_INTERNAL_URL: "" })).toBe(false);
    expect(avail("docs", { ...ALL_AVAILABLE, DOCS_ENABLED: "0", DOCS_INTERNAL_URL: "http://d" })).toBe(false);
  });
});
