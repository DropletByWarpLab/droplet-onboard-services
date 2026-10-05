/**
 * WARP-3536 — who hears that a work item changed.
 *
 * The rule (Work Suite spec, WS-19): everyone who can READ the item, and nobody
 * else. The box must serve Projects, the person must hold it (the §3 resolver's
 * `features`, the same axis the tool list uses), and an external guest hears
 * only about the items assigned to them. In-memory Prisma here; the same rule
 * against real rows and the real resolver is `pm-live.pg.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import type { ModuleId } from "@prisma/client";
import { createPmLiveAudience, PM_LIVE_ROSTER_TTL_MS } from "./pm-live-audience.js";

interface UserRow {
  id: string;
  username: string;
  role: "owner" | "admin" | "family" | "guest" | "service";
  directoryStatus: "ACTIVE" | "DEACTIVATED";
}

const USERS: UserRow[] = [
  { id: "u-owner", username: "olga", role: "owner", directoryStatus: "ACTIVE" },
  { id: "u-admin", username: "adam", role: "admin", directoryStatus: "ACTIVE" },
  { id: "u-fam", username: "fiona", role: "family", directoryStatus: "ACTIVE" },
  { id: "u-narrow", username: "nina", role: "family", directoryStatus: "ACTIVE" }, // custom role without Projects
  { id: "u-gone", username: "gus", role: "family", directoryStatus: "DEACTIVATED" },
  { id: "u-guest-a", username: "gail", role: "guest", directoryStatus: "ACTIVE" },
  { id: "u-guest-b", username: "gary", role: "guest", directoryStatus: "ACTIVE" },
  { id: "u-svc", username: "mcp", role: "service", directoryStatus: "ACTIVE" },
];

/** Who holds Projects at the person axis. Everyone but the narrowed role. */
const HOLDS: Record<string, ReadonlySet<ModuleId>> = {
  "u-admin": new Set(["projects", "files"] as ModuleId[]),
  "u-fam": new Set(["projects"] as ModuleId[]),
  "u-narrow": new Set(["files"] as ModuleId[]),
  "u-gone": new Set(["projects"] as ModuleId[]),
};

const ASSIGNEES = [
  { workItemId: "wi-1", userId: "u-guest-a" },
  { workItemId: "wi-2", userId: "u-guest-b" },
  { workItemId: "wi-2", userId: "u-fam" },
];

function makePrisma(users: UserRow[] = USERS) {
  return {
    user: {
      findMany: vi.fn(
        async ({ where }: { where: { directoryStatus: string; role: { in: string[] } } }) =>
          users
            .filter((u) => u.directoryStatus === where.directoryStatus && where.role.in.includes(u.role))
            .map(({ id, username, role }) => ({ id, username, role })),
      ),
    },
    pmWorkItemAssignee: {
      findMany: vi.fn(
        async ({ where }: { where: { workItemId: string; userId: { in: string[] } } }) =>
          ASSIGNEES.filter((a) => a.workItemId === where.workItemId && where.userId.in.includes(a.userId)).map(
            (a) => ({ userId: a.userId }),
          ),
      ),
    },
  };
}

const box = (...ids: string[]) => async () => new Set(ids) as unknown as ReadonlySet<ModuleId>;

function make(over: Partial<Parameters<typeof createPmLiveAudience>[0]> = {}, prisma = makePrisma()) {
  const personModuleIds = vi.fn(async (id: string) => HOLDS[id] ?? null);
  const clock = { t: 1_000 };
  const audience = createPmLiveAudience({
    prisma: prisma as never,
    boxModuleIds: box("projects", "files"),
    personModuleIds,
    now: () => clock.t,
    logger: { warn: vi.fn(), debug: vi.fn() },
    ...over,
  });
  return { audience, prisma, personModuleIds, clock };
}

describe("who can read a project item", () => {
  it("is every active owner, admin and family member who holds Projects", async () => {
    const { audience } = make();
    const names = await audience.usernamesFor("wi-none");
    expect(names.sort()).toEqual(["adam", "fiona", "olga"]);
  });

  it("leaves out someone whose role was narrowed away from Projects", async () => {
    const { audience } = make();
    expect(await audience.usernamesFor("wi-none")).not.toContain("nina");
  });

  it("leaves out a deactivated person and the service principal", async () => {
    const { audience } = make();
    const names = await audience.usernamesFor("wi-none");
    expect(names).not.toContain("gus");
    expect(names).not.toContain("mcp");
  });

  it("is nobody at all while Projects is switched off on the box", async () => {
    const { audience, prisma } = make({ boxModuleIds: box("files") });
    expect(await audience.usernamesFor("wi-1")).toEqual([]);
    // Cheapest exit: the box says no, so nobody is even listed.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("gives an owner the box axis alone, with no per-person lookup", async () => {
    const { audience, personModuleIds } = make();
    await audience.usernamesFor("wi-none");
    expect(personModuleIds).not.toHaveBeenCalledWith("u-owner");
  });
});

describe("external guests", () => {
  it("hear only about an item assigned to them", async () => {
    const { audience } = make();
    expect((await audience.usernamesFor("wi-1")).sort()).toEqual(["adam", "fiona", "gail", "olga"]);
    expect((await audience.usernamesFor("wi-2")).sort()).toEqual(["adam", "fiona", "gary", "olga"]);
    // An item nobody shared with a guest tells no guest anything.
    const none = await audience.usernamesFor("wi-none");
    expect(none).not.toContain("gail");
    expect(none).not.toContain("gary");
  });

  it("uses the deletion-time guest snapshot, intersected with active guests now", async () => {
    const { audience } = make();
    expect((await audience.usernamesForDeleted(["u-guest-a", "u-gone", "u-not-assigned"])).sort()).toEqual([
      "adam",
      "fiona",
      "gail",
      "olga",
    ]);
    // Gary is assigned to another work item, but not to this deleted item.
    expect(await audience.usernamesForDeleted(["u-guest-a"])).not.toContain("gary");
  });

  it("rechecks revoked grants and deactivated guests before deletion delivery, within the live roster TTL", async () => {
    const users = USERS.map((user) => ({ ...user }));
    const { audience } = make({}, makePrisma(users));
    expect(await audience.usernamesFor("wi-1")).toContain("fiona");
    expect(await audience.usernamesFor("wi-1")).toContain("gail");
    HOLDS["u-fam"] = new Set(["files"] as ModuleId[]);
    users.find((user) => user.id === "u-guest-a")!.directoryStatus = "DEACTIVATED";
    try {
      const names = await audience.usernamesForDeleted(["u-guest-a"]);
      expect(names).not.toContain("fiona");
      expect(names).not.toContain("gail");
      expect(names.sort()).toEqual(["adam", "olga"]);
    } finally {
      HOLDS["u-fam"] = new Set(["projects"] as ModuleId[]);
    }
  });

  it("rechecks the box module before deletion delivery instead of using a warm live roster", async () => {
    let enabled = true;
    const { audience } = make({ boxModuleIds: async () => new Set(enabled ? ["projects"] : []) });
    expect(await audience.usernamesFor("wi-1")).toContain("olga");
    enabled = false;
    expect(await audience.usernamesForDeleted(["u-guest-a"])).toEqual([]);
  });

  it("are not looked up at all when the box has no guests", async () => {
    const prisma = makePrisma(USERS.filter((u) => u.role !== "guest"));
    const { audience } = make({}, prisma);
    await audience.usernamesFor("wi-1");
    expect(prisma.pmWorkItemAssignee.findMany).not.toHaveBeenCalled();
  });

  it("are looked up with ONE query per item, not one per guest", async () => {
    const { audience, prisma } = make();
    await audience.usernamesFor("wi-2");
    expect(prisma.pmWorkItemAssignee.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pmWorkItemAssignee.findMany.mock.calls[0]![0].where.userId.in.sort()).toEqual([
      "u-guest-a",
      "u-guest-b",
    ]);
  });
});

describe("topics are keyed by username, so a username must be a safe topic level", () => {
  it.each(["a/b", "a+b", "a#b", "", "a\u0000b"])("skips %j", async (bad) => {
    const prisma = makePrisma([
      { id: "u-ok", username: "ok", role: "family", directoryStatus: "ACTIVE" },
      { id: "u-bad", username: bad, role: "family", directoryStatus: "ACTIVE" },
    ]);
    const { audience } = make(
      { personModuleIds: async () => new Set(["projects"] as ModuleId[]) as ReadonlySet<ModuleId> },
      prisma,
    );
    expect(await audience.usernamesFor("wi-none")).toEqual(["ok"]);
  });
});

describe("the roster is resolved in batch and cached", () => {
  it("lists people once and resolves each person once per TTL, however many items ask", async () => {
    const { audience, prisma, personModuleIds } = make();
    await audience.usernamesFor("wi-1");
    await audience.usernamesFor("wi-2");
    await audience.usernamesFor("wi-3");

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    // admin, fiona, nina — the owner needs no lookup, guests are not resolved.
    expect(personModuleIds).toHaveBeenCalledTimes(3);
  });

  it("looks again once the TTL has passed, so a revoked grant stops being heard", async () => {
    const { audience, clock } = make();
    expect(await audience.usernamesFor("wi-none")).toContain("fiona");

    HOLDS["u-fam"] = new Set(["files"] as ModuleId[]); // Fiona's Projects grant is revoked
    try {
      expect(await audience.usernamesFor("wi-none")).toContain("fiona"); // inside the TTL
      clock.t += PM_LIVE_ROSTER_TTL_MS;
      expect(await audience.usernamesFor("wi-none")).not.toContain("fiona");
    } finally {
      HOLDS["u-fam"] = new Set(["projects"] as ModuleId[]);
    }
  });

  it("shares one refresh between callers that arrive while it is running", async () => {
    const { audience, prisma } = make();
    await Promise.all([audience.usernamesFor("wi-1"), audience.usernamesFor("wi-2"), audience.usernamesFor("wi-3")]);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("a person who cannot be resolved", () => {
  it("is left out, fail closed, and does not take everybody else with them", async () => {
    const warn = vi.fn();
    const { audience } = make({
      personModuleIds: async (id: string) => {
        if (id === "u-fam") throw new Error("resolver exploded");
        return HOLDS[id] ?? null;
      },
      logger: { warn, debug: vi.fn() },
    });
    const names = await audience.usernamesFor("wi-none");
    expect(names.sort()).toEqual(["adam", "olga"]);
    expect(warn).toHaveBeenCalledTimes(1); // once per refresh, naming nobody's data
  });

  it("is left out when the resolver finds no such person (null)", async () => {
    const { audience } = make({ personModuleIds: async () => null });
    // Only the owner, who needs no per-person answer, remains.
    expect(await audience.usernamesFor("wi-none")).toEqual(["olga"]);
  });
});

describe("a failure to read the roster is the caller's to retry", () => {
  it("rethrows, and the next call tries again instead of caching the failure", async () => {
    const prisma = makePrisma();
    prisma.user.findMany.mockRejectedValueOnce(new Error("db down"));
    const { audience } = make({}, prisma);

    await expect(audience.usernamesFor("wi-1")).rejects.toThrow("db down");
    expect((await audience.usernamesFor("wi-1")).sort()).toEqual(["adam", "fiona", "gail", "olga"]);
  });
});
