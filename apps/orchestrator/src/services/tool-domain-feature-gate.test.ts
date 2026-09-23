/**
 * WARP-2742 — the six domains that used to bypass the feature intersection,
 * end to end through the real §3 composition (computeEffectiveAccess), the
 * real scope builder (resolveToolAccessScope), and both enforcement points:
 * the CATALOG (narrowToolNamesForPrincipal: what a chat turn advertises) and
 * DISPATCH (toolDispatchDenial: what llm-agent refuses when the model calls a
 * tool directly anyway).
 *
 * Only the DB read is faked: `resolveEffectiveAccess` returns the pure
 * composition over the inputs each case sets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { ModuleId } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";
import { GATEABLE_MODULE_IDS, GRANTABLE_TOOL_DOMAINS } from "./access-catalog.js";
import { computeEffectiveAccess, type EffectiveAccessInputs } from "./effective-access.service.js";
import {
  narrowToolNamesForPrincipal,
  resolveToolAccessScope,
  toolDispatchDenial,
} from "./tool-access.service.js";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(null) }));

const resolveMock = vi.hoisted(() => vi.fn());
vi.mock("./effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./effective-access.service.js")>()),
  resolveEffectiveAccess: resolveMock,
}));

import { actingUserAccessResolver, MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import { mountMcpActingUserGates } from "../modules/module-mounts.js";

const ALL_MODULES = new Set<ModuleId>(["chat", ...GATEABLE_MODULE_IDS]);
const ALL_TOOLS = TOOL_CATALOG.map((t) => t.name);
const toolsIn = (domain: string) => TOOL_CATALOG.filter((t) => t.domain === domain).map((t) => t.name);

let lastPrisma: never;

/** An Admin-based role holding EVERY feature at manage and EVERY grantable
 *  tool domain at `use` — the widest a role can be — minus what a case removes. */
async function scopeFor(opts: {
  workspaceOff?: ModuleId[];
  featureOff?: ModuleId[];
  toolGrantOff?: string[];
}) {
  const workspace = new Set(ALL_MODULES);
  for (const m of opts.workspaceOff ?? []) workspace.delete(m);
  const toolGrants = GRANTABLE_TOOL_DOMAINS.filter((d) => !(opts.toolGrantOff ?? []).includes(d)).map(
    (domain) => ({ domain, level: "use" as const }),
  );
  const inputs: EffectiveAccessInputs = {
    user: {
      id: "u1",
      role: "admin",
      accessRole: {
        mayOperateLocks: false,
        cloudModelsAllowed: false,
        storageQuotaBytes: null,
        maxUploadSizeMb: null,
        llmDailyMessageCap: null,
        featureGrants: GATEABLE_MODULE_IDS.filter((m) => !(opts.featureOff ?? []).includes(m)).map(
          (moduleId) => ({ moduleId, level: "manage" as const }),
        ),
        toolGrants,
        connectorGrants: [],
      },
    },
    exceptions: [],
    workspaceModuleIds: workspace,
    cloudEscapeEnabled: false,
    connections: [],
    usagePolicy: null,
    deptRights: [],
  };
  resolveMock.mockResolvedValue(computeEffectiveAccess(inputs));
  // Answers both reads the resolvers make: the Nextcloud-username lookup of
  // the MCP route gate, and the access-role row of the scope resolvers.
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: "u1",
        role: "admin",
        directoryStatus: "ACTIVE",
        accessRoleId: "r1",
        accessRole: { toolGrants },
      })),
    },
  } as never;
  lastPrisma = prisma;
  const scope = await resolveToolAccessScope(prisma, { id: "u1", role: "admin" });
  if (!scope) throw new Error("expected a narrowed scope for a role holder");
  return scope;
}

function expectReachable(scope: Awaited<ReturnType<typeof scopeFor>>, tools: string[], reachable: boolean) {
  const advertised = new Set(narrowToolNamesForPrincipal(ALL_TOOLS, "admin", scope));
  for (const name of tools) {
    expect(advertised.has(name), `${name} advertised on the turn`).toBe(reachable);
    expect(toolDispatchDenial(name, {}, scope) === null, `${name} dispatchable`).toBe(reachable);
  }
}

beforeEach(() => resolveMock.mockReset());

describe("WARP-2742 — money is gated by the Money feature", () => {
  it("baseline: the widest role reaches money_list_open_documents", async () => {
    expectReachable(await scopeFor({}), ["money_list_open_documents"], true);
  });

  it("Money switched off box-wide: absent from the turn AND refused at dispatch", async () => {
    expectReachable(await scopeFor({ workspaceOff: ["money"] }), ["money_list_open_documents"], false);
  });

  it("the role lacks the Money feature: absent from the turn AND refused at dispatch", async () => {
    expectReachable(await scopeFor({ featureOff: ["money"] }), ["money_list_open_documents"], false);
  });
});

// WARP-2988 — `business` needs CRM OR Projects (claimed by both modules).
describe("WARP-2988 — business is gated by CRM or Projects", () => {
  const business = toolsIn("business");

  it("reachable with CRM only, and with Projects only", async () => {
    expectReachable(await scopeFor({ featureOff: ["projects"] }), business, true);
    expectReachable(await scopeFor({ featureOff: ["crm"] }), business, true);
    expectReachable(await scopeFor({ workspaceOff: ["projects"] }), business, true);
    expectReachable(await scopeFor({ workspaceOff: ["crm"] }), business, true);
  });

  it("the role holds neither feature: absent from the turn AND refused at dispatch", async () => {
    expectReachable(await scopeFor({ featureOff: ["crm", "projects"] }), business, false);
  });

  it("both modules switched off box-wide: absent from the turn AND refused at dispatch", async () => {
    expectReachable(await scopeFor({ workspaceOff: ["crm", "projects"] }), business, false);
  });
});

// WARP-2988 — the same OR, enforced on the MCP service path: `_service:mcp`
// reaching the CRM / PM routes on behalf of the person, through the REAL
// resolver chain (username → attributed scope → §3 composition).
describe("WARP-2988 — the MCP service path enforces the same OR", () => {
  async function mcpGet(path: string, method: "get" | "post" = "get") {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { user: unknown }).user = { id: MCP_PRINCIPAL_ID, role: "service" };
      next();
    });
    mountMcpActingUserGates(app, actingUserAccessResolver(lastPrisma));
    app[method](path, (_q, res) => { res.json({ ok: true }); });
    return (await request(app)[method](path).set("X-Nextcloud-User", "sam")).status;
  }

  it("neither feature: CRM and PM routes are refused to the assistant", async () => {
    await scopeFor({ featureOff: ["crm", "projects"] });
    expect(await mcpGet("/api/crm/companies")).toBe(404);
    expect(await mcpGet("/api/pm/work-items")).toBe(404);
  });

  it("either feature: the routes answer, writes included (`use` grant)", async () => {
    await scopeFor({ featureOff: ["crm"] });
    expect(await mcpGet("/api/crm/companies")).toBe(200);
    expect(await mcpGet("/api/pm/work-items", "post")).toBe(200);
    await scopeFor({ featureOff: ["projects"] });
    expect(await mcpGet("/api/pm/work-items")).toBe(200);
  });

  it("no business tool grant: refused even with both features", async () => {
    await scopeFor({ toolGrantOff: ["business"] });
    expect(await mcpGet("/api/crm/companies")).toBe(404);
  });
});

// The remaining four were a deliberate decision, not a claim: each is declared in
// FEATURE_UNGATED_TOOL_DOMAINS. What holds them is the tool grant, and they
// must not be withdrawn by switching off every module.
describe.each(["cloud", "agent_runs", "system", "data"])(
  "WARP-2742 — %s is declared feature-ungated",
  (domain) => {
    it("stays reachable with every module off (feature axis does not apply)", async () => {
      const scope = await scopeFor({ workspaceOff: [...GATEABLE_MODULE_IDS] });
      expectReachable(scope, toolsIn(domain), true);
    });

    it("is absent from the turn AND refused at dispatch without its tool grant", async () => {
      expectReachable(await scopeFor({ toolGrantOff: [domain] }), toolsIn(domain), false);
    });
  },
);
