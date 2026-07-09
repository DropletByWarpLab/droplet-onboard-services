import { describe, it, expect } from "vitest";
import {
  MODULES,
  MODULE_BY_ID,
  BUSINESS_TYPES,
  BUSINESS_TYPE_BY_ID,
  isModuleId,
  isBusinessType,
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
