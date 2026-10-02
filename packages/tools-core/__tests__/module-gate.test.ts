/**
 * WARP-2972 — the ONE predicate that decides whether a tool is withheld by a
 * module toggle, shared by the orchestrator (chat pool, /api/llm/tools) and the
 * mcp-server (tools/list, tools/call). Both sides import it; neither has its
 * own copy of the rule.
 */
import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, TOOL_DOMAINS } from "../src/catalog.js";
import {
  FAIL_CLOSED_MODULE_VERDICT,
  MODULE_OWNED_TOOL_DOMAINS,
  isToolWithheldByModule,
  namesForGuidance,
  parseModuleVerdict,
  serializeModuleVerdict,
  withholdModuleTools,
  type ModuleVerdict,
} from "../src/module-gate.js";

const verdict = (...domains: string[]): ModuleVerdict => ({ withheldDomains: new Set(domains) });
const toolIn = (domain: string) => TOOL_CATALOG.find((t) => t.domain === domain)!.name;

describe("isToolWithheldByModule", () => {
  it("withholds a tool whose domain is in the verdict", () => {
    expect(isToolWithheldByModule(toolIn("cameras"), verdict("cameras"))).toBe(true);
  });

  it("keeps a tool whose domain is not in the verdict", () => {
    expect(isToolWithheldByModule(toolIn("network"), verdict("cameras"))).toBe(false);
  });

  it("keeps a tool with no catalog entry (a remote server's tool has no domain here)", () => {
    expect(isToolWithheldByModule("remote_thing", FAIL_CLOSED_MODULE_VERDICT)).toBe(false);
  });

  it("keeps an unclaimed domain even under the fail-closed verdict", () => {
    for (const domain of ["system", "data", "agent_runs", "routines", "workspace", "erp", "cloud"]) {
      expect(MODULE_OWNED_TOOL_DOMAINS.has(domain), domain).toBe(false);
      expect(isToolWithheldByModule(toolIn(domain), FAIL_CLOSED_MODULE_VERDICT), domain).toBe(false);
    }
  });
});

describe("FAIL_CLOSED_MODULE_VERDICT", () => {
  it("withholds every tool of every module-owned domain", () => {
    for (const t of TOOL_CATALOG) {
      expect(isToolWithheldByModule(t.name, FAIL_CLOSED_MODULE_VERDICT), t.name).toBe(
        MODULE_OWNED_TOOL_DOMAINS.has(t.domain),
      );
    }
  });

  it("only names domains the catalog knows", () => {
    for (const d of MODULE_OWNED_TOOL_DOMAINS) expect(TOOL_DOMAINS as string[], d).toContain(d);
  });
});

describe("withholdModuleTools", () => {
  const tools = [{ name: toolIn("cameras") }, { name: toolIn("network") }, { name: "remote_thing" }];

  it("drops withheld tools and keeps order", () => {
    expect(withholdModuleTools(tools, verdict("cameras")).map((t) => t.name)).toEqual([
      toolIn("network"),
      "remote_thing",
    ]);
  });

  it("returns the list untouched when nothing is withheld", () => {
    expect(withholdModuleTools(tools, verdict())).toEqual(tools);
  });
});

describe("namesForGuidance", () => {
  it("stays undefined (privileged: every tool) when nothing is withheld", () => {
    expect(namesForGuidance(undefined, verdict())).toBeUndefined();
  });

  it("materialises the registry minus the withheld domains for a privileged caller", () => {
    const names = namesForGuidance(undefined, verdict("cameras"))!;
    expect(names).not.toContain(toolIn("cameras"));
    expect(names).toContain(toolIn("network"));
  });

  it("filters an explicit list", () => {
    expect(namesForGuidance([toolIn("cameras"), toolIn("network")], verdict("cameras"))).toEqual([
      toolIn("network"),
    ]);
  });
});

describe("wire format", () => {
  it("round-trips", () => {
    const v = verdict("cameras", "email");
    const parsed = parseModuleVerdict(serializeModuleVerdict(v));
    expect([...parsed!.withheldDomains].sort()).toEqual(["cameras", "email"]);
  });

  it("serialises sorted, so the body is stable", () => {
    expect(serializeModuleVerdict(verdict("email", "cameras"))).toEqual({
      withheldDomains: ["cameras", "email"],
    });
  });

  it.each([null, undefined, "x", 3, [], {}, { withheldDomains: "cameras" }, { withheldDomains: [1] }])(
    "rejects a malformed body %j",
    (body) => {
      expect(parseModuleVerdict(body)).toBeNull();
    },
  );
});
