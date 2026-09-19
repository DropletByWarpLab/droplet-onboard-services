/**
 * WARP-2845 — provisioning the dev owner's Nextcloud account.
 *
 * These tests exist because of ONE property: OCS answers HTTP 200 on a
 * logical failure and puts the truth in `ocs.meta.statuscode`. Every
 * assertion here is about refusing to call something a success because the
 * transport said 200 — the seed's first version decided on `resp.ok` alone
 * and would happily log "Nextcloud account provisioned" for an account that
 * was never created, leaving /files 401ing with nothing in the log to
 * explain it.
 *
 * The client helpers (`ncEnsureGroup`, `ncCreateUser`) already parse the OCS
 * body and throw. So the contract under test is: this module reports what
 * THEY report, and never invents a success of its own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./nextcloud.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nextcloud.client.js")>();
  return {
    ...actual,
    ncEnsureGroup: vi.fn(),
    ncCreateUser: vi.fn(),
  };
});

import {
  ncEnsureGroup,
  ncCreateUser,
  NextcloudOcsError,
  NextcloudUserExistsError,
} from "./nextcloud.client.js";
import {
  provisionDevOwnerNextcloudAccount,
  householdGroupSlug,
} from "./dev-owner-nextcloud.js";

const ensureGroup = vi.mocked(ncEnsureGroup);
const createUser = vi.mocked(ncCreateUser);

const ENV_KEYS = ["NEXTCLOUD_URL", "NEXTCLOUD_ADMIN_USER", "NEXTCLOUD_ADMIN_PASSWORD"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.NEXTCLOUD_URL = "http://nextcloud:80";
  process.env.NEXTCLOUD_ADMIN_USER = "admin";
  process.env.NEXTCLOUD_ADMIN_PASSWORD = "dropletdev";
  ensureGroup.mockResolvedValue(undefined);
  createUser.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("provisionDevOwnerNextcloudAccount — the happy path", () => {
  it("provisions, and reports the groups it actually asked for", async () => {
    const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");
    expect(outcome).toEqual({
      status: "provisioned",
      groups: ["admin", "droplet-admins", "household"],
    });
  });

  it("ensures every group BEFORE creating the user — OCS refuses a create naming a missing group", async () => {
    const order: string[] = [];
    ensureGroup.mockImplementation(async (g: string) => {
      order.push(`ensure:${g}`);
    });
    createUser.mockImplementation(async () => {
      order.push("create");
    });

    await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");

    expect(order).toEqual([
      "ensure:admin",
      "ensure:droplet-admins",
      "ensure:household",
      "create",
    ]);
  });

  it("passes the admin credentials as a Basic token the client understands", async () => {
    await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");
    const [token, username, password, displayName, groups] = createUser.mock.calls[0]!;
    // `resolveAuthHeader` sends Basic for a `basic:` prefix and Bearer for
    // anything else — a bare base64 blob would go out as a Bearer token and
    // 401 every call.
    expect(token).toBe(`basic:${Buffer.from("admin:dropletdev").toString("base64")}`);
    expect(username).toBe("dev");
    expect(password).toBe("Dev-Stack-Local-1");
    expect(displayName).toBe("Droplet Dev");
    expect(groups).toEqual(["admin", "droplet-admins", "household"]);
  });
});

describe("the OCS-200-with-a-failure-body class", () => {
  it("does NOT report success when the create fails logically", async () => {
    // The whole finding: `resp.ok` was true, so the old code logged
    // "provisioned" for an account that does not exist.
    createUser.mockRejectedValue(new NextcloudOcsError("OCS error creating user: Invalid group", 102));

    const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");

    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("Invalid group") });
  });

  it("reports an already-existing account as already_present, not as a failure", async () => {
    // OCS 102 on create is the healthy-restart case: the seed runs on every
    // boot, so this must not print a scary line on a stack that is fine.
    createUser.mockRejectedValue(new NextcloudUserExistsError("User already exists"));

    const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");

    expect(outcome).toEqual({ status: "already_present" });
  });

  it("surfaces a network-level failure with its message rather than swallowing it", async () => {
    createUser.mockRejectedValue(new Error("fetch failed"));
    const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");
    expect(outcome).toMatchObject({ status: "failed", reason: expect.stringContaining("fetch failed") });
  });
});

describe("the group-ensure loop no longer swallows a real failure", () => {
  it("NAMES the group that could not be ensured", async () => {
    // Before: `.catch(() => undefined)` made a genuine failure
    // indistinguishable from "already exists", and the create then failed for
    // a reason nothing in the log connected to the group.
    ensureGroup.mockImplementation(async (g: string) => {
      if (g === "droplet-admins") throw new NextcloudOcsError("OCS error creating group: forbidden", 997);
    });

    const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");

    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ reason: expect.stringContaining("droplet-admins") });
    expect(outcome).toMatchObject({ reason: expect.stringContaining("forbidden") });
  });

  it("does not attempt the create once a group is known to be missing", async () => {
    ensureGroup.mockRejectedValue(new NextcloudOcsError("OCS error creating group: forbidden", 997));
    await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("treats an already-existing group as success — ncEnsureGroup resolves on OCS 102", async () => {
    // `ncEnsureGroup` maps 102 to a plain return; the loop must not invent a
    // failure out of the common case.
    ensureGroup.mockResolvedValue(undefined);
    const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");
    expect(outcome.status).toBe("provisioned");
  });
});

describe("environment preconditions", () => {
  it.each(["NEXTCLOUD_URL", "NEXTCLOUD_ADMIN_USER", "NEXTCLOUD_ADMIN_PASSWORD"] as const)(
    "skips — and never calls OCS — when %s is unset",
    async (key) => {
      delete process.env[key];
      const outcome = await provisionDevOwnerNextcloudAccount("dev", "Dev-Stack-Local-1", "Droplet Dev");
      expect(outcome.status).toBe("skipped");
      expect(ensureGroup).not.toHaveBeenCalled();
      expect(createUser).not.toHaveBeenCalled();
    },
  );
});

describe("householdGroupSlug", () => {
  it.each([
    ["Household", "household"],
    ["Shared Files", "shared-files"],
    ["  Team  ", "team"],
    ["!!!", "household"],
    ["", "household"],
    [undefined, "household"],
  ])("slugifies %o to %s", (input, expected) => {
    expect(householdGroupSlug(input as string | undefined)).toBe(expected);
  });
});
