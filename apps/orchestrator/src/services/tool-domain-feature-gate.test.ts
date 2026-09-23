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
import type { ModuleId } from "@prisma/client";
import { TOOL_CATALOG } from "@droplet/tools-core";
import { GATEABLE_MODULE_IDS, GRANTABLE_TOOL_DOMAINS } from "./access-catalog.js";
import { computeEffectiveAccess, type EffectiveAccessInputs } from "./effective-access.service.js";
import {
  narrowToolNamesForPrincipal,
  resolveToolAccessScope,
  toolDispatchDenial,
} from "./tool-access.service.js";

const resolveMock = vi.hoisted(() => vi.fn());
vi.mock("./effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./effective-access.service.js")>()),
  resolveEffectiveAccess: resolveMock,
}));

const ALL_MODULES = new Set<ModuleId>(["chat", ...GATEABLE_MODULE_IDS]);
const ALL_TOOLS = TOOL_CATALOG.map((t) => t.name);
const toolsIn = (domain: string) => TOOL_CATALOG.filter((t) => t.domain === domain).map((t) => t.name);

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
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ accessRoleId: "r1", accessRole: { toolGrants } })) },
  } as never;
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

// The other five were a deliberate decision, not a claim: each is declared in
// FEATURE_UNGATED_TOOL_DOMAINS. What holds them is the tool grant, and they
// must not be withdrawn by switching off every module.
describe.each(["cloud", "business", "agent_runs", "system", "data"])(
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
