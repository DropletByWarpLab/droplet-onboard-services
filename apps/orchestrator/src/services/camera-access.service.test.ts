/**
 * WARP-1962 — per-camera access.
 *
 * Role tiers answer "may this person watch recordings at all". These tests
 * pin the question they cannot answer: "may this person watch THE BEDROOM".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canAccessCamera,
  principalFromRequest,
  filterVisibleCameras,
  requireCameraAccess,
  setGrantsForUser,
  visibleCameraNames,
} from "./camera-access.service.js";

type Grant = { camera: { name: string } };

function prismaWith(grantsByUser: Record<string, string[]>) {
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
    user: {
      findUnique: vi.fn(async ({ where }: { where: { nextcloudUsername: string } }) => {
        const dir: Record<string, { id: string; role: string }> = {
          sam: { id: "u-sam", role: "family" },
          stefan: { id: "u-owner", role: "owner" },
        };
        return dir[where.nextcloudUsername] ?? null;
      }),
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
    const req = { params: { name }, user } as never;
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })), json } as never;
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
  const mcp = (assertedNextcloudUser: string | null) => ({
    id: "_service:mcp",
    role: "service",
    assertedNextcloudUser,
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
      assertedNextcloudUser: "stefan",
    });
    expect(visible).not.toBe("all");
  });
});

describe("principalFromRequest", () => {
  it("lifts the asserted header off the request", () => {
    const p = principalFromRequest({
      user: { id: "_service:mcp", role: "service" },
      header: (n: string) => (n === "x-nextcloud-user" ? "  sam  " : undefined),
    });
    expect(p.assertedNextcloudUser).toBe("sam");
  });

  it("treats a blank header as absent", () => {
    const p = principalFromRequest({
      user: { id: "_service:mcp", role: "service" },
      header: () => "   ",
    });
    expect(p.assertedNextcloudUser).toBeNull();
  });
});
