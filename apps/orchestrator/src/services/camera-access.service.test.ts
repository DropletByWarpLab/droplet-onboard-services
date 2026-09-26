/**
 * WARP-1962 — per-camera access.
 *
 * Role tiers answer "may this person watch recordings at all". These tests
 * pin the question they cannot answer: "may this person watch THE BEDROOM".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  cameraScopeOf,
  canAccessCamera,
  canSeeFaceFolder,
  inCameraScope,
  narrowCameraFilter,
  principalFromRequest,
  filterVisibleCameras,
  requireCameraAccess,
  setGrantsForUser,
  visibleCameraNames,
} from "./camera-access.service.js";
import { userDirectory, type DirectoryUser } from "../__tests__/helpers/user-directory.js";

type Grant = { camera: { name: string } };

/** Nextcloud-mirror rows: `username` and `nextcloudUsername` agree. */
const NC_MIRROR_USERS: DirectoryUser[] = [
  { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "family" },
  { id: "u-owner", username: "stefan", nextcloudUsername: "stefan", role: "owner" },
];

function prismaWith(grantsByUser: Record<string, string[]>, users = NC_MIRROR_USERS) {
  return {
    cameraAccessGrant: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }): Promise<Grant[]> =>
        (grantsByUser[where.userId] ?? []).map((name) => ({ camera: { name } })),
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async (args: unknown) => args),
    },
    camera: {
      findMany: vi.fn(async ({ where }: { where: { name: { in: string[] } } }) =>
        where.name.in
          .filter((n) => ["front_door", "driveway", "bedroom"].includes(n))
          .map((n) => ({ id: `id-${n}`, name: n })),
      ),
    },
    user: userDirectory(users),
    cameraNotificationPref: {
      deleteMany: vi.fn(async (args: unknown) => args),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  } as never;
}

const OWNER = { id: "u-owner", role: "owner" };
const ADMIN = { id: "u-admin", role: "admin" };
const SAM = { id: "u-sam", role: "family" };
const NOBODY = { id: "u-none", role: "family" };
const MCP = { id: "_service:mcp", role: "service" };

const PRISMA = () => prismaWith({ "u-sam": ["front_door", "driveway"] });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("who sees everything", () => {
  it("owner and admin bypass per-camera scoping entirely", async () => {
    // Their access must NOT come from the grant table — a row cannot lock
    // an owner out of the appliance they administer, and an empty table
    // must not brick the cameras page on a fresh install.
    expect(await visibleCameraNames(PRISMA(), OWNER)).toBe("all");
    expect(await visibleCameraNames(PRISMA(), ADMIN)).toBe("all");
  });

  it("does not consult the database for an unrestricted role", async () => {
    const prisma = PRISMA();
    await visibleCameraNames(prisma, OWNER);
    expect(
      (prisma as unknown as { cameraAccessGrant: { findMany: { mock: { calls: unknown[] } } } })
        .cameraAccessGrant.findMany.mock.calls,
    ).toHaveLength(0);
  });
});

describe("a family member sees only what they were granted", () => {
  it("resolves their granted cameras", async () => {
    const visible = await visibleCameraNames(PRISMA(), SAM);
    expect(visible).not.toBe("all");
    expect([...(visible as Set<string>)].sort()).toEqual(["driveway", "front_door"]);
  });

  it("can reach a granted camera and not an ungranted one", async () => {
    expect(await canAccessCamera(PRISMA(), SAM, "front_door")).toBe(true);
    // THE feature: same role, same tier, different camera.
    expect(await canAccessCamera(PRISMA(), SAM, "bedroom")).toBe(false);
  });

  it("sees nothing at all with no grants", async () => {
    // The default for a camera with no grants is owner/admin only, so
    // adding a camera never silently exposes it to the household.
    expect([...((await visibleCameraNames(PRISMA(), NOBODY)) as Set<string>)]).toEqual([]);
    expect(await canAccessCamera(PRISMA(), NOBODY, "front_door")).toBe(false);
  });

  it("is denied when there is no principal or no role", async () => {
    expect([...((await visibleCameraNames(PRISMA(), undefined)) as Set<string>)]).toEqual([]);
    expect([...((await visibleCameraNames(PRISMA(), { id: "x" })) as Set<string>)]).toEqual([]);
  });
});

describe("the camera list agrees with what playback allows", () => {
  it("filters the list down to granted cameras", async () => {
    const all = [{ name: "front_door" }, { name: "driveway" }, { name: "bedroom" }];
    // A tile you cannot open is worse than no tile.
    expect((await filterVisibleCameras(PRISMA(), SAM, all)).map((c) => c.name)).toEqual([
      "front_door",
      "driveway",
    ]);
  });

  it("leaves an owner's list untouched", async () => {
    const all = [{ name: "front_door" }, { name: "bedroom" }];
    expect(await filterVisibleCameras(PRISMA(), OWNER, all)).toHaveLength(2);
  });
});

describe("the route guard", () => {
  function run(user: unknown, name: string, prisma = PRISMA()) {
    const req = { params: { name }, user, route: { path: "/cameras/:name" } } as never;
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })), json, locals: {} } as never;
    const next = vi.fn();
    return { promise: requireCameraAccess(prisma)(req, res, next), res, next, json };
  }

  it("lets a granted camera through", async () => {
    const { next } = run(SAM, "front_door");
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
  });

  it("answers 404 — not 403 — for a denied camera", async () => {
    // A 403 confirms the camera EXISTS. "There is a camera called bedroom
    // and you may not see it" is itself information about the household.
    const { res } = run(SAM, "bedroom");
    await vi.waitFor(() =>
      expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(404),
    );
  });

  it("fails CLOSED when the access check itself errors", async () => {
    const broken = {
      cameraAccessGrant: { findMany: vi.fn().mockRejectedValue(new Error("db down")) },
    } as never;
    const { res, next } = run(SAM, "front_door", broken);
    await vi.waitFor(() =>
      expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(503),
    );
    // A database blip must never become "everyone sees everything".
    expect(next).not.toHaveBeenCalled();
  });
});

describe("granting", () => {
  it("reports unknown camera names instead of dropping them", async () => {
    // A typo that silently grants nothing is indistinguishable from success.
    const result = await setGrantsForUser(PRISMA(), "u-sam", [
      "front_door",
      "frontdoor", // typo
    ]);
    expect(result.granted).toEqual(["front_door"]);
    expect(result.unknown).toEqual(["frontdoor"]);
  });

  it("replaces the whole set rather than appending", async () => {
    const prisma = PRISMA();
    await setGrantsForUser(prisma, "u-sam", ["driveway"]);
    // Set semantics: a client-side diff would race a second admin editing
    // the same person.
    expect(
      (prisma as unknown as { cameraAccessGrant: { deleteMany: ReturnType<typeof vi.fn> } })
        .cameraAccessGrant.deleteMany,
    ).toHaveBeenCalledWith({ where: { userId: "u-sam" } });
  });
});

describe("WARP-1975: the assistant is scoped to whoever is asking", () => {
  const mcp = (assertedUser: string | null) => ({
    id: "_service:mcp",
    role: "service",
    assertedUser,
  });

  it("scopes to the acting human's grants, not to everything", async () => {
    // WARP-1962 shipped this returning "all", so a family member blocked
    // from the bedroom in the dashboard could still ask the assistant.
    const visible = await visibleCameraNames(PRISMA(), mcp("sam"));
    expect(visible).not.toBe("all");
    expect([...(visible as Set<string>)].sort()).toEqual(["driveway", "front_door"]);
  });

  it("denies an ungranted camera asked for through a tool", async () => {
    expect(await canAccessCamera(PRISMA(), mcp("sam"), "front_door")).toBe(true);
    expect(await canAccessCamera(PRISMA(), mcp("sam"), "bedroom")).toBe(false);
  });

  it("still gives an owner asking through the assistant everything", async () => {
    // The ACTING human's own role decides, not the service principal's.
    expect(await visibleCameraNames(PRISMA(), mcp("stefan"))).toBe("all");
  });

  it("fails CLOSED when no user is asserted", async () => {
    // A tool that cannot say who is asking has not earned an answer.
    // Returning "all" here is precisely the WARP-1962 gap.
    expect([...((await visibleCameraNames(PRISMA(), mcp(null))) as Set<string>)]).toEqual([]);
  });

  it("fails CLOSED when the asserted user is not provisioned", async () => {
    expect(
      [...((await visibleCameraNames(PRISMA(), mcp("nobody"))) as Set<string>)],
    ).toEqual([]);
  });

  it("ignores the asserted header for a HUMAN principal", async () => {
    // Otherwise anyone could set X-Nextcloud-User and impersonate.
    const visible = await visibleCameraNames(PRISMA(), {
      ...SAM,
      assertedUser: "stefan",
    });
    expect(visible).not.toBe("all");
  });
});

describe("WARP-3061: the assistant resolves SSO / SCIM users too", () => {
  // SSO- and SCIM-created rows authenticate through the IdP only, so their
  // `nextcloudUsername` is NULL. The header names them by `User.username`
  // (stdio: chat, agent runs) or `User.id` (the HTTP transport).
  const MARIA: DirectoryUser = { id: "u-maria", username: "maria", nextcloudUsername: null, role: "family" };
  const OLIVIA: DirectoryUser = { id: "u-olivia", username: "olivia", nextcloudUsername: null, role: "owner" };
  const GRANTS = { "u-maria": ["front_door"] };

  /** The principal exactly as a camera route lifts it off an MCP request. */
  const askedAs = (asserted: string) =>
    principalFromRequest({
      user: { id: "_service:mcp", role: "service" },
      header: (n: string) => (n === "x-nextcloud-user" ? asserted : undefined),
    });

  const names = (scope: "all" | Set<string>) => (scope === "all" ? "all" : [...scope].sort());

  it("scopes an SSO family member, named by username, to their grant", async () => {
    const prisma = prismaWith(GRANTS, [MARIA]);
    expect(names(await visibleCameraNames(prisma, askedAs("maria")))).toEqual(["front_door"]);
  });

  it("scopes them the same when the HTTP transport names them by User.id", async () => {
    const prisma = prismaWith(GRANTS, [MARIA]);
    expect(names(await visibleCameraNames(prisma, askedAs("u-maria")))).toEqual(["front_door"]);
  });

  it("gives an SSO owner asking through the assistant everything", async () => {
    expect(await visibleCameraNames(prismaWith({}, [OLIVIA]), askedAs("olivia"))).toBe("all");
  });

  it("still resolves a Nextcloud-mirror row by nextcloudUsername after its username was edited", async () => {
    const renamed: DirectoryUser = { id: "u-sam", username: "samuel", nextcloudUsername: "sam", role: "family" };
    const prisma = prismaWith({ "u-sam": ["driveway"] }, [renamed]);
    expect(names(await visibleCameraNames(prisma, askedAs("sam")))).toEqual(["driveway"]);
  });

  it("resolves one row matched by two columns as that one person", async () => {
    // A Nextcloud-mirror row: `username` and `nextcloudUsername` both say "sam".
    expect(names(await visibleCameraNames(PRISMA(), askedAs("sam")))).toEqual(["driveway", "front_door"]);
  });

  it("denies when the value is one person's username and ANOTHER person's nextcloudUsername", async () => {
    // Nothing says which of them is asking. Picking one acts for the wrong
    // person with the wrong person's reach: before WARP-3061 this resolved
    // to the OWNER below and handed a family member every camera.
    const marianne: DirectoryUser = { id: "u-marianne", username: "marianne", nextcloudUsername: "maria", role: "owner" };
    const prisma = prismaWith(GRANTS, [MARIA, marianne]);
    expect(names(await visibleCameraNames(prisma, askedAs("maria")))).toEqual([]);
  });

  it("denies when the value is one person's User.id and ANOTHER person's username", async () => {
    const lookalike: DirectoryUser = { id: "u-other", username: "u-maria", nextcloudUsername: null, role: "family" };
    const prisma = prismaWith({ ...GRANTS, "u-other": ["driveway"] }, [MARIA, lookalike]);
    expect(names(await visibleCameraNames(prisma, askedAs("u-maria")))).toEqual([]);
  });

  it("denies a DEACTIVATED person named by username, grants and all", async () => {
    const gone: DirectoryUser = { ...MARIA, directoryStatus: "DEACTIVATED" };
    expect(names(await visibleCameraNames(prismaWith(GRANTS, [gone]), askedAs("maria")))).toEqual([]);
  });

  it("denies a DEACTIVATED owner named by User.id rather than handing over every camera", async () => {
    const gone: DirectoryUser = { ...OLIVIA, directoryStatus: "DEACTIVATED" };
    expect(names(await visibleCameraNames(prismaWith({}, [gone]), askedAs("u-olivia")))).toEqual([]);
  });

  it("denies a value that names nobody", async () => {
    expect(names(await visibleCameraNames(prismaWith(GRANTS, [MARIA]), askedAs("nobody")))).toEqual([]);
  });

  it("lets the route guard through to a granted camera and 404s the rest", async () => {
    const prisma = prismaWith(GRANTS, [MARIA]);
    const guard = (camera: string) => {
      const req = {
        params: { name: camera },
        user: { id: "_service:mcp", role: "service" },
        header: (n: string) => (n === "x-nextcloud-user" ? "maria" : undefined),
        route: { path: "/cameras/:name/snapshot" },
      } as never;
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const next = vi.fn();
      requireCameraAccess(prisma)(req, { status, json, locals: {} } as never, next);
      return { status, next };
    };

    const granted = guard("front_door");
    await vi.waitFor(() => expect(granted.next).toHaveBeenCalled());

    const other = guard("bedroom");
    await vi.waitFor(() => expect(other.status).toHaveBeenCalledWith(404));
    expect(other.next).not.toHaveBeenCalled();
  });
});

describe("principalFromRequest", () => {
  it("lifts the asserted header off the request", () => {
    const p = principalFromRequest({
      user: { id: "_service:mcp", role: "service" },
      header: (n: string) => (n === "x-nextcloud-user" ? "  sam  " : undefined),
    });
    expect(p.assertedUser).toBe("sam");
  });

  it("treats a blank header as absent", () => {
    const p = principalFromRequest({
      user: { id: "_service:mcp", role: "service" },
      header: () => "   ",
    });
    expect(p.assertedUser).toBeNull();
  });
});

describe("WARP-2982: the guard covers routes that name no camera", () => {
  const EVENTS: Record<string, string> = { "ev-front": "front_door", "ev-bed": "bedroom" };
  const REVIEWS: Record<string, string> = { "rv-front": "front_door", "rv-bed": "bedroom" };
  const resolvers = {
    eventCamera: vi.fn(async (id: string) => EVENTS[id] ?? null),
    reviewCamera: vi.fn(async (id: string) => REVIEWS[id] ?? null),
  };

  function run(
    user: unknown,
    params: Record<string, string>,
    routePath: string,
    opts: { resolvers?: typeof resolvers | Record<string, never>; prisma?: unknown } = {},
  ) {
    const req = { params, user, route: { path: routePath } } as never;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { status, json, locals: {} as Record<string, unknown> };
    const next = vi.fn();
    requireCameraAccess(
      (opts.prisma ?? PRISMA()) as never,
      (opts.resolvers ?? resolvers) as never,
    )(req, res as never, next);
    return { res, status, next };
  }

  it("leaves the resolved scope for a cross-camera handler to narrow with", async () => {
    const { res, next } = run(SAM, {}, "/cameras/events");
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect([...(cameraScopeOf(res as never) as Set<string>)].sort()).toEqual([
      "driveway",
      "front_door",
    ]);
  });

  it("resolves an event id to its camera and 404s one on an ungranted camera", async () => {
    const ok = run(SAM, { eventId: "ev-front" }, "/cameras/events/:eventId/thumbnail");
    await vi.waitFor(() => expect(ok.next).toHaveBeenCalled());

    const denied = run(SAM, { eventId: "ev-bed" }, "/cameras/events/:eventId/thumbnail");
    await vi.waitFor(() => expect(denied.status).toHaveBeenCalledWith(404));
    expect(denied.next).not.toHaveBeenCalled();
  });

  it("answers an unknown event id exactly like a forbidden one", async () => {
    const { status, next } = run(SAM, { eventId: "ev-nope" }, "/cameras/events/:eventId/snapshot");
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(404));
    expect(next).not.toHaveBeenCalled();
  });

  it("resolves a review id to its camera", async () => {
    const ok = run(SAM, { reviewId: "rv-front" }, "/cameras/reviews/:reviewId/preview");
    await vi.waitFor(() => expect(ok.next).toHaveBeenCalled());
    const denied = run(SAM, { reviewId: "rv-bed" }, "/cameras/reviews/:reviewId/preview");
    await vi.waitFor(() => expect(denied.status).toHaveBeenCalledWith(404));
  });

  it("does not look the event up for an owner — no extra Frigate hop", async () => {
    const { next } = run(OWNER, { eventId: "ev-bed" }, "/cameras/events/:eventId/thumbnail");
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(resolvers.eventCamera).not.toHaveBeenCalled();
  });

  it("reads :name as a camera only on /cameras/:name routes", async () => {
    // /cameras/faces/:name names a PERSON; treating it as a camera would
    // 404 every face route for a scoped user.
    const { next } = run(
      SAM,
      { name: "bedroom", eventId: "ev-front" },
      "/cameras/faces/:name/from-event/:eventId",
    );
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
  });

  it("fails CLOSED when an id route has no resolver wired", async () => {
    const { status, next } = run(
      SAM,
      { eventId: "ev-front" },
      "/cameras/events/:eventId/thumbnail",
      { resolvers: {} },
    );
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(503));
    expect(next).not.toHaveBeenCalled();
  });

  it("refuses to hand a handler a scope the guard never resolved", () => {
    expect(() => cameraScopeOf({ locals: {} } as never)).toThrow(/cameraAccessGuard/);
  });
});

describe("WARP-2982: narrowing a camera filter to the scope", () => {
  it("passes an owner's filter through untouched", () => {
    expect(narrowCameraFilter("all", undefined)).toBeUndefined();
    expect(narrowCameraFilter("all", ["bedroom"])).toEqual(["bedroom"]);
  });

  it("turns 'no filter' into exactly the granted cameras", () => {
    expect(narrowCameraFilter(new Set(["front_door"]), undefined)).toEqual(["front_door"]);
  });

  it("drops requested cameras outside the scope, down to an empty list", () => {
    const scope = new Set(["front_door"]);
    expect(narrowCameraFilter(scope, ["front_door", "bedroom"])).toEqual(["front_door"]);
    // [] is "nothing" — the Frigate client answers it without querying.
    expect(narrowCameraFilter(scope, ["bedroom"])).toEqual([]);
  });

  it("scopes membership", () => {
    expect(inCameraScope("all", "bedroom")).toBe(true);
    expect(inCameraScope(new Set(["front_door"]), "bedroom")).toBe(false);
  });
});

describe("WARP-3013: Frigate's `train` face folder", () => {
  it("is visible only to an all-camera scope", () => {
    expect(canSeeFaceFolder("all", "train")).toBe(true);
    expect(canSeeFaceFolder(new Set(["front_door", "bedroom"]), "train")).toBe(false);
    expect(canSeeFaceFolder(new Set(), "train")).toBe(false);
  });

  it("leaves the curated roster household-wide", () => {
    expect(canSeeFaceFolder(new Set(), "Alice")).toBe(true);
    // Folder names are case-sensitive on the box's filesystem: `Train` is a
    // person someone named, not Frigate's crop folder.
    expect(canSeeFaceFolder(new Set(), "Train")).toBe(true);
  });
});

describe("WARP-2982: revoking a camera stops its push notifications", () => {
  it("deletes the person's prefs on cameras they no longer hold", async () => {
    const prisma = PRISMA();
    await setGrantsForUser(prisma, "u-sam", ["driveway"]);
    expect(
      (prisma as unknown as { cameraNotificationPref: { deleteMany: ReturnType<typeof vi.fn> } })
        .cameraNotificationPref.deleteMany,
    ).toHaveBeenCalledWith({ where: { userId: "u-sam", cameraId: { notIn: ["id-driveway"] } } });
  });

  it("leaves an owner's prefs alone — owners draw no access from grants", async () => {
    const prisma = PRISMA();
    await setGrantsForUser(prisma, "u-owner", []);
    expect(
      (prisma as unknown as { cameraNotificationPref: { deleteMany: ReturnType<typeof vi.fn> } })
        .cameraNotificationPref.deleteMany,
    ).not.toHaveBeenCalled();
  });
});
