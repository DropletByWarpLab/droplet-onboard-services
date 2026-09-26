/**
 * WARP-3101 — who a calendar / reminder route acts for.
 *
 * A browser caller is themselves. `_service:mcp` is the person named in
 * `X-Nextcloud-User` (username on stdio, User.id over HTTP), resolved to ONE
 * active person, and named back by their USERNAME — the key those tables use.
 * That person must be allowed every tool the route serves.
 *
 * The end-to-end twin (real tools-core handlers, real routers) is
 * __tests__/calendar-reminder-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";

const { effectiveAccess } = vi.hoisted(() => ({
  effectiveAccess: vi.fn(async (_userId: string): Promise<unknown> => null),
}));
vi.mock("./effective-access.service.js", () => ({
  resolveEffectiveAccess: (userId: string) => effectiveAccess(userId),
}));

import { toolActingUser, sendToolActingUserDenial, type RouteTools } from "./tool-acting-user.service.js";
import { CALENDAR_TOOL_ROUTES } from "../routes/calendar.js";
import { REMINDER_TOOL_ROUTES } from "../routes/reminders.js";
import { userDirectory, type DirectoryUser } from "../__tests__/helpers/user-directory.js";

type FakeUser = DirectoryUser & { accessRoleId: string | null; accessRole: { toolGrants: Array<{ domain: string; level: string }> } | null };
const person = (over: Partial<FakeUser> & Pick<FakeUser, "id" | "username" | "role">): FakeUser => ({
  nextcloudUsername: null,
  accessRoleId: null,
  accessRole: null,
  ...over,
});

const ALICE = person({ id: "5b0c7a4e-1f2d-4c3b-9a8e-7d6f5e4c3b2a", username: "alice", role: "owner" });
const KID = person({ id: "0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b", username: "kid", role: "family" });

function prismaOf(users: FakeUser[]) {
  const user = userDirectory(users);
  return { prisma: { user } as unknown as PrismaClient, user };
}

function reqAs(user: { id: string; username: string; role: string } | undefined, header?: string): Request {
  return {
    user,
    header: (name: string) => (name.toLowerCase() === "x-nextcloud-user" ? header : undefined),
  } as unknown as Request;
}

const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const READ: RouteTools = ["list_events"];
const WRITE: RouteTools = ["create_event"];

beforeEach(() => {
  vi.clearAllMocks();
  effectiveAccess.mockImplementation(async () => null);
});

describe("toolActingUser — a person in the browser", () => {
  it("is themselves, whatever the header says, and nothing is looked up", async () => {
    const { prisma, user } = prismaOf([ALICE, KID]);
    const r = await toolActingUser(prisma, reqAs({ id: KID.id, username: "kid", role: "family" }, "alice"), WRITE);
    expect(r).toEqual({ ok: true, username: "kid" });
    expect(user.findMany).not.toHaveBeenCalled();
    expect(user.findUnique).not.toHaveBeenCalled();
  });

  it("another service principal is only itself, too", async () => {
    const { prisma, user } = prismaOf([ALICE]);
    const r = await toolActingUser(prisma, reqAs({ id: "_service:voice", username: "_service:voice", role: "service" }, "alice"), READ);
    expect(r).toEqual({ ok: true, username: "_service:voice" });
    expect(user.findMany).not.toHaveBeenCalled();
  });

  it("the MCP id without the service role is not the MCP principal", async () => {
    const { prisma } = prismaOf([ALICE]);
    const r = await toolActingUser(prisma, reqAs({ ...MCP, role: "owner" }, "alice"), READ);
    expect(r).toEqual({ ok: true, username: "_service:mcp" });
  });

  it("no username on the request is an invariant break, not a default", async () => {
    const { prisma } = prismaOf([ALICE]);
    await expect(toolActingUser(prisma, reqAs(undefined), READ)).rejects.toThrow("authenticated user required");
  });
});

describe("toolActingUser — the assistant (`_service:mcp`)", () => {
  it("names the person by their username, asserted by User.id (HTTP) or by username (stdio)", async () => {
    const { prisma } = prismaOf([ALICE, KID]);
    expect(await toolActingUser(prisma, reqAs(MCP, ALICE.id), WRITE)).toEqual({ ok: true, username: "alice" });
    expect(await toolActingUser(prisma, reqAs(MCP, "alice"), WRITE)).toEqual({ ok: true, username: "alice" });
    expect(await toolActingUser(prisma, reqAs(MCP, `  ${ALICE.id}  `), WRITE)).toEqual({ ok: true, username: "alice" });
  });

  it("names a renamed person by their CURRENT username, never the header value", async () => {
    const renamed = person({ id: "3c2b1a09-8f7e-4d6c-9b5a-493827160504", username: "samuel", nextcloudUsername: "sam", role: "owner" });
    const { prisma } = prismaOf([renamed]);
    expect(await toolActingUser(prisma, reqAs(MCP, "sam"), READ)).toEqual({ ok: true, username: "samuel" });
  });

  it("no header, or only whitespace → acting_user_required, and nothing is looked up", async () => {
    const { prisma, user } = prismaOf([ALICE]);
    for (const header of [undefined, "", "   "]) {
      expect(await toolActingUser(prisma, reqAs(MCP, header), READ), String(header)).toEqual({ ok: false, denied: "acting_user_required" });
    }
    expect(user.findMany).not.toHaveBeenCalled();
  });

  it("nobody, a deactivated person, or an ambiguous name → acting_user_required", async () => {
    const gone = person({ id: "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091", username: "gone", role: "owner", directoryStatus: "DEACTIVATED" });
    const shadow = person({ id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", username: "robert", nextcloudUsername: "alice", role: "owner" });
    const { prisma } = prismaOf([ALICE, gone, shadow]);
    for (const asserted of ["mallory", gone.id, "alice"]) {
      expect(await toolActingUser(prisma, reqAs(MCP, asserted), READ), asserted).toEqual({ ok: false, denied: "acting_user_required" });
    }
  });

  it("an unreadable access row → acting_user_required (fail closed)", async () => {
    const { prisma, user } = prismaOf([ALICE]);
    user.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await toolActingUser(prisma, reqAs(MCP, ALICE.id), READ)).toEqual({ ok: false, denied: "acting_user_required" });
  });

  it("a family member may use a read tool but not a write tool (ADR-004 write tier)", async () => {
    const { prisma } = prismaOf([KID]);
    expect(await toolActingUser(prisma, reqAs(MCP, KID.id), READ)).toEqual({ ok: true, username: "kid" });
    expect(await toolActingUser(prisma, reqAs(MCP, KID.id), WRITE)).toEqual({
      ok: false,
      denied: "forbidden_tool_for_role",
      tool: "create_event",
    });
  });

  it("an access role that does not reach the domain is refused (axis B)", async () => {
    const ops = person({
      id: "7c6b5a49-3827-4165-9f4e-3d2c1b0a9f8e",
      username: "ops",
      role: "admin",
      accessRoleId: "role-reminders-only",
      accessRole: { toolGrants: [{ domain: "reminders", level: "use" }] },
    });
    effectiveAccess.mockImplementation(async () => ({ tier: "admin", toolDomains: ["reminders"], locks: false }));
    const { prisma } = prismaOf([ops]);
    expect(await toolActingUser(prisma, reqAs(MCP, ops.id), ["create_reminder", "set_timer"])).toEqual({ ok: true, username: "ops" });
    expect(await toolActingUser(prisma, reqAs(MCP, ops.id), READ)).toEqual({
      ok: false,
      denied: "forbidden_tool_for_role",
      tool: "list_events",
    });
  });

  it("must be allowed EVERY tool the route serves — the first refused one is named", async () => {
    const { prisma } = prismaOf([KID]);
    expect(await toolActingUser(prisma, reqAs(MCP, KID.id), ["list_events", "create_event", "delete_event"])).toEqual({
      ok: false,
      denied: "forbidden_tool_for_role",
      tool: "create_event",
    });
  });
});

describe("sendToolActingUserDenial", () => {
  function res() {
    const r = { status: vi.fn(), json: vi.fn() };
    r.status.mockReturnValue(r);
    return r;
  }

  it("answers 403 with the reason, and names the tool on a refusal", () => {
    const a = res();
    sendToolActingUserDenial(a as unknown as Response, { ok: false, denied: "acting_user_required" });
    expect(a.status).toHaveBeenCalledWith(403);
    expect(a.json).toHaveBeenCalledWith({ error: "acting_user_required" });

    const b = res();
    sendToolActingUserDenial(b as unknown as Response, { ok: false, denied: "forbidden_tool_for_role", tool: "set_timer" });
    expect(b.status).toHaveBeenCalledWith(403);
    expect(b.json).toHaveBeenCalledWith({ error: "forbidden_tool_for_role", tool: "set_timer" });
  });
});

// ── The tools a route re-checks are the tools that call it ─────────────────

describe("WARP-3101 each route re-checks exactly the tools whose handlers call it", () => {
  const DECLARED: Record<string, RouteTools> = { ...CALENDAR_TOOL_ROUTES, ...REMINDER_TOOL_ROUTES };
  const CALLERS = new Map<string, string[]>();
  for (const e of TOOL_ROUTES) {
    for (const h of e.hops) {
      if (!/^\/api\/(calendar\/events|reminders)(\/|$)/.test(h.pathPattern)) continue;
      const key = `${h.method} ${h.pathPattern}`;
      CALLERS.set(key, [...(CALLERS.get(key) ?? []), e.tool]);
    }
  }

  it("every hop a tool makes to these routes is a declared route, and the route lists that tool", () => {
    // A tool missing from its route's list would be checked against a
    // DIFFERENT tool's reach; a route missing from the map would not resolve
    // the acting person at all.
    for (const [key, tools] of CALLERS) {
      expect(DECLARED[key], `${key} is called by ${tools.join(", ")} but declares no tools`).toBeDefined();
      expect([...DECLARED[key]!].sort(), key).toEqual([...tools].sort());
    }
    expect(Object.keys(DECLARED).sort()).toEqual([...CALLERS.keys()].sort());
  });

  it("every declared tool is a real tool (an unknown name reads as a read tool on axis A)", () => {
    const known = new Set(TOOL_CATALOG.map((t) => t.name));
    for (const tools of Object.values(DECLARED)) for (const t of tools) expect(known.has(t), t).toBe(true);
  });

  it("tools that share a route share their domain and their write flag, so checking every one is checking each", () => {
    const byName = new Map(TOOL_CATALOG.map((t) => [t.name, t]));
    for (const [key, tools] of Object.entries(DECLARED)) {
      const shapes = new Set(tools.map((t) => `${byName.get(t)!.domain}:${byName.get(t)!.requiresWrite}`));
      expect(shapes.size, key).toBe(1);
    }
  });
});
