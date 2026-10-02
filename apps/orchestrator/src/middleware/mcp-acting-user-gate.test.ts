/**
 * WARP-2988 — the `_service:mcp` principal is narrowed on the CRM / PM routes by
 * the ACTING user's §3 tool scope: `business` must be in reach (CRM or
 * Projects), and a write needs `use`. Mounted through the real registry
 * prefixes (`mountMcpActingUserGates`), so a prefix the registry adds is
 * covered without editing this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import express, { type Express } from "express";
import { TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { MODULES } from "../modules/module-registry.js";
import {
  FEATURE_GATED_MODULES,
  MCP_ACTING_USER_GATED_DOMAINS,
  mountMcpActingUserGates,
} from "../modules/module-mounts.js";
import {
  actingUserAccessResolver,
  MCP_PRINCIPAL_ID,
  type ActingUserAccess,
  type ActingUserAccessResolver,
} from "./mcp-acting-user-gate.js";
import type { ToolAccessScope } from "../services/tool-access.service.js";
import type { EffectiveAccessResolver } from "./feature-gate.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import type { ModuleId } from "@prisma/client";
import { userDirectory, type DirectoryUser } from "../__tests__/helpers/user-directory.js";

const scope = (domains: string[], writeDomains: string[] = []): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(writeDomains),
  locks: false,
});
const ok = (s: ToolAccessScope | null): ActingUserAccess => ({
  scope: s,
  tier: "admin",
  unresolved: null,
  userId: "u-sam",
});

const resolveMock = vi.fn<ActingUserAccessResolver>();

/** The acting person's §9 features; both business modules held unless a case says otherwise. */
let heldFeatures: ModuleId[] = ["crm", "projects"];
/** The level they hold them at: a full member catalog (`manage`) unless a case narrows it (WARP-3365). */
let heldLevel: "view" | "act" | "manage" = "manage";
const featuresOf: EffectiveAccessResolver = async () =>
  ({ features: heldFeatures.map((moduleId) => ({ moduleId, level: heldLevel })) }) as unknown as EffectiveAccessResult;

function appAs(
  user: { id: string; role: string },
  resolve: ActingUserAccessResolver = resolveMock,
  features: EffectiveAccessResolver = featuresOf,
): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { ...user, username: user.id, displayName: user.id };
    next();
  });
  mountMcpActingUserGates(app, resolve, features);
  for (const path of ["/api/crm/companies", "/api/pm/work-items", "/api/mobile/pm/projects", "/api/files/x", "/api/team-chat/contacts", "/api/money/documents"]) {
    app.get(path, (_q, res) => { res.json({ hit: path }); });
    app.post(path, (_q, res) => { res.json({ hit: path }); });
  }
  return app;
}

const MCP = { id: MCP_PRINCIPAL_ID, role: "service" };

beforeEach(() => {
  resolveMock.mockReset();
  heldFeatures = ["crm", "projects"];
  heldLevel = "manage";
});

describe("mcp acting-user gate — who it applies to", () => {
  it("never touches a human, whatever header they send", async () => {
    const res = await request(appAs({ id: "u-1", role: "family" }))
      .get("/api/crm/companies")
      .set("X-Nextcloud-User", "someone");
    expect(res.status).toBe(200);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("passes an mcp call that names nobody (internal stdio, pre-flighted upstream)", async () => {
    const res = await request(appAs(MCP)).get("/api/crm/companies");
    expect(res.status).toBe(200);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("is not mounted on a module that does not claim `business`", async () => {
    resolveMock.mockResolvedValue(ok(scope([])));
    const res = await request(appAs(MCP)).get("/api/files/x").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(200);
  });
});

describe("mcp acting-user gate — the acting user's scope decides", () => {
  it("owner / no custom role (null scope) passes, reads and writes", async () => {
    resolveMock.mockResolvedValue(ok(null));
    const app = appAs(MCP);
    expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it("business in reach: reads pass; a write needs `use`", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business"])));
    const app = appAs(MCP);
    expect((await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
    const write = await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(write.status).toBe(404);
    resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));
    expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it.each([
    ["/api/crm/companies", "crm"],
    ["/api/pm/work-items", "projects"],
    ["/api/mobile/pm/projects", "projects"],
  ])("business NOT in reach: %s is 404 module_disabled (%s)", async (path, module) => {
    resolveMock.mockResolvedValue(ok(scope(["files", "crm", "pm"], ["files"])));
    const res = await request(appAs(MCP)).get(path).set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module });
  });

  it("fails closed on an unresolved acting user and on a resolver throw", async () => {
    resolveMock.mockResolvedValue({ scope: scope([]), tier: null, unresolved: "user_missing", userId: null });
    expect((await request(appAs(MCP)).get("/api/crm/companies").set("X-Nextcloud-User", "ghost")).status).toBe(404);
    // A plain throwing resolver, not a spy: vitest reports a spy's thrown
    // error as the test's failure even when the code under test catches it.
    const throwing: ActingUserAccessResolver = async () => {
      throw new Error("db down");
    };
    const res = await request(appAs(MCP, throwing)).get("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(404);
  });
});

// WARP-3162 — the method stands in for "a write" only where the domain has a
// read tool. Both team_chat tools send, and both read the roster by GET first,
// so every team_chat hop is a write tool's: a `view` grant (which reaches
// neither tool in chat) must not clear the GET either.
describe("mcp acting-user gate — a domain with no read tool needs `use` on every method", () => {
  it("team_chat `view`: the roster GET and the writes are 404 module_disabled (team_chat)", async () => {
    resolveMock.mockResolvedValue(ok(scope(["team_chat"])));
    const app = appAs(MCP);
    const read = await request(app).get("/api/team-chat/contacts").set("X-Nextcloud-User", "sam");
    expect(read.status).toBe(404);
    expect(read.body).toEqual({ error: "module_disabled", module: "team_chat" });
    expect((await request(app).post("/api/team-chat/contacts").set("X-Nextcloud-User", "sam")).status).toBe(404);
  });

  it("team_chat `use`: the roster GET and the writes pass", async () => {
    resolveMock.mockResolvedValue(ok(scope(["team_chat"], ["team_chat"])));
    const app = appAs(MCP);
    expect((await request(app).get("/api/team-chat/contacts").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).post("/api/team-chat/contacts").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it("a domain that has read tools still reads on `view` (business)", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business", "team_chat"])));
    const app = appAs(MCP);
    expect((await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/team-chat/contacts").set("X-Nextcloud-User", "sam")).status).toBe(404);
  });

  it("of the gated domains, only team_chat has no read tool", () => {
    const writeOnly = MCP_ACTING_USER_GATED_DOMAINS.filter((d) =>
      TOOL_CATALOG.filter((t) => t.domain === d).every((t) => t.requiresWrite),
    );
    expect(writeOnly).toEqual(["team_chat"]);
  });
});

// WARP-3162 — routes/team-chat.ts (like routes/email.ts) acts for
// X-Droplet-User; the gate resolves X-Nextcloud-User. The mcp-server sets both
// from ctx.userId, so a disagreement is never a real tool call.
describe("mcp acting-user gate — X-Droplet-User must name the person the gate cleared", () => {
  it("equal headers pass", async () => {
    resolveMock.mockResolvedValue(ok(null));
    const res = await request(appAs(MCP))
      .post("/api/team-chat/contacts")
      .set("X-Nextcloud-User", "sam")
      .set("X-Droplet-User", "sam");
    expect(res.status).toBe(200);
  });

  it("a different X-Droplet-User is refused, before the resolver runs", async () => {
    resolveMock.mockResolvedValue(ok(null));
    const res = await request(appAs(MCP))
      .post("/api/team-chat/contacts")
      .set("X-Nextcloud-User", "sam")
      .set("X-Droplet-User", "fran");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "team_chat" });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("an X-Droplet-User with no X-Nextcloud-User is refused (it would otherwise pass as naming nobody)", async () => {
    const res = await request(appAs(MCP)).post("/api/team-chat/contacts").set("X-Droplet-User", "fran");
    expect(res.status).toBe(404);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("a human's mismatched headers are ignored — the gate never applies to them", async () => {
    const res = await request(appAs({ id: "u-1", role: "admin" }))
      .post("/api/team-chat/contacts")
      .set("X-Nextcloud-User", "sam")
      .set("X-Droplet-User", "fran");
    expect(res.status).toBe(200);
  });
});

// Stefan's review of #2298: `business` passes on CRM OR Projects, but the data
// under a prefix belongs to ONE module, and a person who cannot open that
// module in the browser must not read it through the assistant either.
// Browser parity (Romain: "the assistant never reaches more than the person
// could in the browser"): the feature check runs exactly where
// `mountModuleGates` puts `requireFeatureAccess` for a human —
// FEATURE_GATED_MODULES — and nowhere else.
describe("mcp acting-user gate — the feature check mirrors the browser's", () => {
  it("Projects only: PM routes answer, CRM routes are 404 module_disabled (crm)", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));
    heldFeatures = ["projects"];
    const app = appAs(MCP);
    expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/mobile/pm/projects").set("X-Nextcloud-User", "sam")).status).toBe(200);
    const crm = await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(crm.status).toBe(404);
    expect(crm.body).toEqual({ error: "module_disabled", module: "crm" });
  });

  it("CRM only: CRM AND PM routes answer — projects is not feature-gated in the browser", async () => {
    // Stefan's re-review: a per-module `projects` check here refused the
    // `/api/pm/projects` enrichment of `business_find({entity:"customer"})`
    // and failed the whole call for a CRM-only person who CAN open /api/pm
    // in the browser. MUTATION: pass `features` for every module in
    // mountMcpActingUserGates -> the PM calls are 404.
    resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));
    heldFeatures = ["crm"];
    const app = appAs(MCP);
    expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).post("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/mobile/pm/projects").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it("the feature check runs on exactly the business modules the browser feature-gates", () => {
    const business = MODULES.filter((m) => m.toolDomains.includes("business")).map((m) => m.id);
    expect(business.filter((id) => FEATURE_GATED_MODULES.has(id))).toEqual(["crm"]);
  });

  it("applies to a null tool scope too (the owner bypass is question 1 only)", async () => {
    resolveMock.mockResolvedValue(ok(null));
    heldFeatures = ["projects"];
    expect((await request(appAs(MCP)).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(404);
  });

  it("no local row (resolver null) passes, as requireFeatureAccess does; a throw fails closed", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business"])));
    expect(
      (await request(appAs(MCP, resolveMock, async () => null)).get("/api/crm/companies").set("X-Nextcloud-User", "sam"))
        .status,
    ).toBe(200);
    const throwing: EffectiveAccessResolver = async () => {
      throw new Error("db down");
    };
    expect(
      (await request(appAs(MCP, resolveMock, throwing)).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status,
    ).toBe(404);
  });
});

// WARP-3365 / WARP-3369 (Romain, 2026-09-30) — an external guest gets nothing
// of the company's customers or work, and asking the assistant is not a way
// round it. A role-less guest has a null tool scope (question 1 passes) and
// `projects` is not feature-gated (question 2 is not asked), so the acting
// person's TIER is the check that refuses them, off the same catalog fact as
// the browser's `requireModuleTierFloor`.
describe("mcp acting-user gate — the tier floor (WARP-3365, WARP-3369)", () => {
  const acting = (tier: string, s: ToolAccessScope | null = null): ActingUserAccess => ({
    scope: s,
    tier,
    unresolved: null,
    userId: "u-sam",
  });

  it("an external guest with no custom role is 404 module_disabled on CRM and on PM, whatever the resolver says they hold", async () => {
    resolveMock.mockResolvedValue(acting("guest"));
    heldFeatures = ["crm", "projects"];
    const app = appAs(MCP);
    for (const [path, module] of [
      ["/api/crm/companies", "crm"],
      ["/api/pm/work-items", "projects"],
      ["/api/mobile/pm/projects", "projects"],
    ] as const) {
      const read = await request(app).get(path).set("X-Nextcloud-User", "sam");
      expect(read.status, `GET ${path}`).toBe(404);
      expect(read.body, `GET ${path}`).toEqual({ error: "module_disabled", module });
      const write = await request(app).post(path).set("X-Nextcloud-User", "sam");
      expect(write.status, `POST ${path}`).toBe(404);
    }
  });

  it("a guest whose role grants the business tool domain is refused all the same", async () => {
    resolveMock.mockResolvedValue(acting("guest", scope(["business"], [])));
    heldFeatures = ["crm", "projects"];
    expect((await request(appAs(MCP)).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(404);
  });

  it("a member, an admin and an owner are not refused by the floor", async () => {
    heldFeatures = ["crm", "projects"];
    for (const tier of ["family", "admin", "owner"]) {
      resolveMock.mockResolvedValue(acting(tier, scope(["business"], ["business"])));
      const app = appAs(MCP);
      expect((await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status, tier).toBe(200);
      expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status, tier).toBe(200);
    }
  });

  it("the floor is scoped to the modules the catalog refuses: a guest on Messages and Files is not refused by it", async () => {
    resolveMock.mockResolvedValue(acting("guest"));
    const app = appAs(MCP);
    expect((await request(app).get("/api/team-chat/contacts").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/files/x").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });
});

// WARP-3365 review — the LEVEL, not just the module. A role holding
// `crm: view` could not write in the browser once routes/crm.ts named the level
// on every write, but the assistant passed on "holds the module": the same
// person could create and move customers through the tools.
describe("mcp acting-user gate — the acting person's LEVEL (WARP-3365)", () => {
  const asMember = () => resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));

  it("crm: view reads through the assistant and cannot write through it", async () => {
    asMember();
    heldLevel = "view";
    const app = appAs(MCP);
    expect((await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
    const write = await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(write.status).toBe(404);
    expect(write.body).toEqual({ error: "module_disabled", module: "crm" });
  });

  it("crm: act and crm: manage write through the assistant", async () => {
    for (const level of ["act", "manage"] as const) {
      asMember();
      heldLevel = level;
      const app = appAs(MCP);
      expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status, level).toBe(200);
    }
  });

  it("the owner's full catalog (manage) is unchanged", async () => {
    resolveMock.mockResolvedValue(ok(null));
    heldLevel = "manage";
    expect((await request(appAs(MCP)).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });
});

// WARP-3365 review — `money_list_open_documents` reaches /api/money/documents as
// `_service:mcp`. The route admits that principal on its own account, so who it
// ACTS FOR is asked one layer up, like the other business domains.
describe("mcp acting-user gate — money: who the service principal acts for (WARP-3365)", () => {
  const acting = (tier: string, s: ToolAccessScope | null): ActingUserAccess => ({
    scope: s,
    tier,
    unresolved: null,
    userId: "u-sam",
  });

  it("an external guest (a null scope) asking the assistant for the receivables is 404 module_disabled", async () => {
    resolveMock.mockResolvedValue(acting("guest", null));
    heldFeatures = ["money"];
    const res = await request(appAs(MCP)).get("/api/money/documents").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "money" });
  });

  it("a member who holds Money and the money tool domain reads; one who lacks either does not", async () => {
    heldFeatures = ["money"];
    heldLevel = "view";
    resolveMock.mockResolvedValue(acting("family", scope(["money"])));
    expect((await request(appAs(MCP)).get("/api/money/documents").set("X-Nextcloud-User", "sam")).status).toBe(200);
    // the role leaves the money tool domain out of their §3 scope
    resolveMock.mockResolvedValue(acting("family", scope(["business"])));
    expect((await request(appAs(MCP)).get("/api/money/documents").set("X-Nextcloud-User", "sam")).status).toBe(404);
    // the person does not hold the Money feature
    heldFeatures = ["crm"];
    resolveMock.mockResolvedValue(acting("family", scope(["money"])));
    expect((await request(appAs(MCP)).get("/api/money/documents").set("X-Nextcloud-User", "sam")).status).toBe(404);
  });

  it("an admin and an owner with no custom role (null scope) read", async () => {
    heldFeatures = ["money"];
    heldLevel = "manage";
    for (const tier of ["admin", "owner"]) {
      resolveMock.mockResolvedValue(acting(tier, null));
      expect((await request(appAs(MCP)).get("/api/money/documents").set("X-Nextcloud-User", "sam")).status, tier).toBe(200);
    }
  });

  it("a human's own request is not this gate's business (the route's role floor and the prefix's tier floor answer)", async () => {
    const res = await request(appAs({ id: "u-1", role: "guest" })).get("/api/money/documents").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(200);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});

describe("actingUserAccessResolver — fail closed on identity", () => {
  // A Prisma double that HONOURS `where`, with the account shape that broke:
  // SSO / SCIM users have no `nextcloudUsername`.
  const SSO_USER = {
    id: "3f1c2a9e-0000-4000-8000-000000000001",
    username: "sam",
    nextcloudUsername: null,
    role: "owner",
    directoryStatus: "ACTIVE",
    accessRoleId: null,
    accessRole: null,
  };
  type Row = typeof SSO_USER;
  // `findUnique` serves the tool-access read by id; `findMany` is
  // resolveAssertedUser's `OR [username, nextcloudUsername, id] take 2`
  // (WARP-3098), with Prisma's semantics.
  const prismaWithUsers = (rows: Row[] = [SSO_USER]) =>
    ({
      user: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => Object.entries(where).every(([col, val]) => (r as Record<string, unknown>)[col] === val)) ??
          null,
        ),
        findMany: userDirectory(rows as DirectoryUser[]).findMany,
      },
    }) as never;

  it("stdio names the acting user by username — an SSO user with no nextcloudUsername resolves", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers())("sam");
    expect(access).toMatchObject({ unresolved: null, scope: null, userId: SSO_USER.id });
  });

  it("the HTTP transport names them by User.id (claims.sub) — that resolves too", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers())(SSO_USER.id);
    expect(access).toMatchObject({ unresolved: null, userId: SSO_USER.id });
  });

  it("a name matching neither column is `user_missing`", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers())("ghost");
    expect(access).toMatchObject({ unresolved: "user_missing", userId: null });
  });

  it("a value that is one person's User.id AND another's username is `user_ambiguous` — never the first match (WARP-3098)", async () => {
    // The old lookup tried username first, so this value resolved to the
    // look-alike and scoped the call with the look-alike's reach.
    const lookalike: Row = { ...SSO_USER, id: "3f1c2a9e-0000-4000-8000-000000000002", username: SSO_USER.id, role: "family" };
    const access = await actingUserAccessResolver(prismaWithUsers([SSO_USER, lookalike]))(SSO_USER.id);
    expect(access).toMatchObject({ unresolved: "user_ambiguous", userId: null });
  });

  it("a deactivated person is `user_deactivated`", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers([{ ...SSO_USER, directoryStatus: "DEACTIVATED" }]))("sam");
    expect(access).toMatchObject({ unresolved: "user_deactivated", userId: null });
  });

  it("an unknown Nextcloud username resolves to unresolved `user_missing`", async () => {
    const prisma = { user: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) } } as never;
    const access = await actingUserAccessResolver(prisma)("ghost");
    expect(access.unresolved).toBe("user_missing");
  });

  it("a lookup error resolves to unresolved `read_failed`", async () => {
    const fail = async () => {
      throw new Error("db");
    };
    const prisma = { user: { findUnique: fail, findMany: fail } } as never;
    const access = await actingUserAccessResolver(prisma)("sam");
    expect(access.unresolved).toBe("read_failed");
  });

  it("the gate answers an ambiguous acting user 404 module_disabled, and the route never runs (WARP-3098)", async () => {
    const lookalike: Row = { ...SSO_USER, id: "3f1c2a9e-0000-4000-8000-000000000002", username: SSO_USER.id };
    const app = appAs(MCP, actingUserAccessResolver(prismaWithUsers([SSO_USER, lookalike])));
    const res = await request(app).get("/api/crm/companies").set("X-Nextcloud-User", SSO_USER.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "crm" });
    // ...while the same person named unambiguously passes.
    const clean = appAs(MCP, actingUserAccessResolver(prismaWithUsers()));
    expect((await request(clean).get("/api/crm/companies").set("X-Nextcloud-User", SSO_USER.id)).status).toBe(200);
  });
});

describe("mcp acting-user gate — app.ts wiring", () => {
  it("app.ts mounts it with the real resolver, after the module gates and before the CRM / PM routers", () => {
    const src = readFileSync(join(__dirname, "..", "app.ts"), "utf8");
    const gates = src.indexOf("mountModuleGates(app, moduleGate)");
    const acting = src.indexOf("mountMcpActingUserGates(app, actingUserAccessResolver(prisma))");
    const routers = [
      'app.use("/api", createPmNativeRouter(prisma))',
      'app.use("/api", createCrmRouter(prisma))',
      "app.use(createPmMobileRouter(prisma))",
    ].map((r) => [r, src.indexOf(r)] as const);
    expect(gates).toBeGreaterThan(-1);
    expect(acting).toBeGreaterThan(gates);
    for (const [r, i] of routers) {
      expect(i, r).toBeGreaterThan(-1);
      expect(acting, r).toBeLessThan(i);
    }
  });
});

// The gate refuses by route prefix, not by tool name, so it is only sound if
// every tool hop under a gated module's prefixes belongs to the gated domain —
// otherwise it would silently kill another domain's tool — and if reads are
// GET and writes are not, since the write check keys off the method. The one
// exception is a domain with no read tool (WARP-3162): the gate asks `use` of
// every method there, so a write tool's GET is checked as the write it serves.
const OUTSIDE_GATED_PREFIXES: Record<string, string[]> = {
  business: ["business_find GET /api/brain/digests", "business_find GET /api/brain/findings"],
  // WARP-3145: every email hop is under /api/email.
  email: [],
  // WARP-3162: every team_chat hop is under /api/team-chat.
  team_chat: [],
  // WARP-3365 review: the one money hop is GET /api/money/documents.
  money: [],
};

describe("mcp acting-user gate — which domains it narrows", () => {
  // Pinned by name: the suite below iterates the list, so a domain dropped
  // from it would take its own checks with it and nothing would go red.
  it("narrows exactly business, email, money and team_chat", () => {
    expect([...MCP_ACTING_USER_GATED_DOMAINS].sort()).toEqual(["business", "email", "money", "team_chat"]);
  });
});

describe("mcp acting-user gate — the route manifest agrees with it", () => {
  const catalog = new Map(TOOL_CATALOG.map((t) => [t.name, t]));
  for (const domain of MCP_ACTING_USER_GATED_DOMAINS) {
    const prefixes = MODULES.filter((m) => m.toolDomains.includes(domain)).flatMap((m) => m.routePrefixes);
    const under = (p: string) => prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
    const hops = TOOL_ROUTES.flatMap((e) => e.hops.map((h) => ({ tool: e.tool, ...h }))).filter((h) =>
      under(h.pathPattern),
    );

    it(`${domain}: there are tool hops under ${prefixes.join(", ")}`, () => {
      expect(hops.length).toBeGreaterThan(0);
    });

    // The other direction: a ${domain} hop OUTSIDE the gated prefixes is not
    // narrowed by this gate. Each one is named in module-mounts.ts beside
    // MCP_ACTING_USER_GATED_DOMAINS; a new one must be added there first.
    it(`${domain}: its hops outside the gated prefixes are exactly the documented ones`, () => {
      const outside = TOOL_ROUTES.filter((e) => catalog.get(e.tool)?.domain === domain)
        .flatMap((e) => e.hops.map((h) => `${e.tool} ${h.method.toUpperCase()} ${h.pathPattern}`))
        .filter((h) => !under(h.split(" ")[2]!))
        .sort();
      expect(outside).toEqual(OUTSIDE_GATED_PREFIXES[domain]);
    });

    it(`${domain}: every such hop is a ${domain} tool, reads GET and writes non-GET (or the domain has no read tool)`, () => {
      const everyToolWrites = TOOL_CATALOG.filter((t) => t.domain === domain).every((t) => t.requiresWrite);
      for (const h of hops) {
        const entry = catalog.get(h.tool);
        const label = `${h.tool} ${h.method} ${h.pathPattern}`;
        expect(entry?.domain, label).toBe(domain);
        // A read tool's non-GET hop would need `use` and kill the tool for a
        // `view` grant; a write tool's GET would clear on `view` — unless the
        // gate asks `use` of every method in this domain.
        if (!entry!.requiresWrite) expect(h.method, label).toBe("get");
        else if (!everyToolWrites) expect(h.method, label).not.toBe("get");
      }
    });
  }
});
