/**
 * WARP-1962 — per-camera access.
 *
 * Role tiers answer "may this person watch recordings at all". These tests
 * pin the question they cannot answer: "may this person watch THE BEDROOM".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canAccessCamera,
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

describe("the MCP principal", () => {
  it("is not silently reduced to seeing nothing", async () => {
    // Tools dispatch on behalf of a human whose role was already checked
    // at the tool layer, and the principal holds no grants of its own.
    // ⚠ Consequence, stated rather than hidden: per-camera scoping does
    // NOT currently narrow the assistant. Threading the acting user
    // through tool dispatch is the follow-up.
    expect(await visibleCameraNames(PRISMA(), MCP)).toBe("all");
  });
});
