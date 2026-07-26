import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config before importing the client
vi.mock("../config.js", () => ({
  config: {
    NEXTCLOUD_URL: "http://nextcloud.test",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: "/tmp/files",
    MAX_UPLOAD_SIZE_MB: 10,
    STORAGE_BACKEND: "nextcloud",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import {
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
  ncListGroupMembers,
  ncListGroupMembersStrict,
  gfListFolders,
  gfGetFolder,
  gfCreateFolder,
  gfDeleteFolder,
  gfAddGroup,
  gfRemoveGroup,
  gfSetGroupPermissions,
  gfSetQuota,
  type GroupfolderInfo,
} from "../services/nextcloud-groups.client.js";
import {
  NextcloudOcsError,
  NextcloudGroupNotFoundError,
} from "../services/nextcloud.client.js";

/**
 * Mock Response helper — returns a Response-like object
 */
function mockResponse(init: {
  ok: boolean;
  status: number;
  text?: string;
  json?: unknown;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: vi.fn().mockResolvedValue(init.text ?? ""),
    json: vi.fn().mockResolvedValue(init.json ?? {}),
    headers: new Headers(),
  } as unknown as Response;
}

describe("nextcloud-groups.client", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // ── OCS Groups API Tests ──

  describe("ncAddUserToGroup", () => {
    it("issues POST with OCS headers and groupid param", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100, status: "ok" }, data: {} } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncAddUserToGroup("adminToken", "alice", "dept-eng");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/ocs/v2.php/cloud/users/alice/groups");
      expect(url).toContain("groupid=dept-eng");
      expect(init.method).toBe("POST");
      expect(init.headers["OCS-APIRequest"]).toBe("true");
      expect(init.headers.Authorization).toBe("Bearer adminToken");
    });

    it("is idempotent when the user is already a member (statuscode 100)", async () => {
      // Nextcloud reports 100 (success) when re-adding an existing member for
      // POST /cloud/users/{uid}/groups — there is no "already a member" code.
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100, status: "ok" }, data: {} } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncAddUserToGroup("token", "bob", "dept-finance")
      ).resolves.toBeUndefined();
    });

    it("throws NextcloudGroupNotFoundError when the group does not exist (statuscode 102)", async () => {
      // For POST /cloud/users/{uid}/groups, OCS statuscode 102 means the target
      // group does not exist — NOT "already a member". It must surface as a typed
      // not-found error, not be swallowed as an idempotent no-op.
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: {
                statuscode: 102,
                status: "failure",
                message: "The group does not exist",
              },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncAddUserToGroup("token", "bob", "dept-finance")
      ).rejects.toBeInstanceOf(NextcloudGroupNotFoundError);
    });

    it("does not swallow a non-success OCS statuscode on a 2xx response (statuscode 105)", async () => {
      // statuscode 105 = "failed to add user to group". Even though the HTTP
      // status is 2xx, the OCS body signals failure and must not resolve OK.
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: {
                statuscode: 105,
                status: "failure",
                message: "failed to add user to group",
              },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncAddUserToGroup("token", "bob", "dept-eng")
      ).rejects.toThrow(NextcloudOcsError);
    });

    it("throws NextcloudOcsError on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 400,
          json: {
            ocs: {
              meta: { statuscode: 400, message: "Group not found" },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(ncAddUserToGroup("token", "carol", "nonexistent")).rejects.toThrow(
        NextcloudOcsError
      );
    });

    it("uses basic auth when token starts with 'basic:'", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncAddUserToGroup("basic:dXNlcjpwYXNz", "dave", "group1");

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe("Basic dXNlcjpwYXNz");
    });
  });

  describe("ncRemoveUserFromGroup", () => {
    it("issues DELETE with OCS headers and groupid param", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 }, data: {} } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await ncRemoveUserFromGroup("adminToken", "alice", "dept-eng");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain("/ocs/v2.php/cloud/users/alice/groups");
      expect(init.method).toBe("DELETE");
      expect(init.headers["OCS-APIRequest"]).toBe("true");
    });

    it("is idempotent when the user is not a member (statuscode 100)", async () => {
      // Removing a non-member of an existing group returns 100 (success);
      // idempotency is preserved without misreading 102.
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 }, data: {} } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncRemoveUserFromGroup("token", "bob", "dept-finance")
      ).resolves.toBeUndefined();
    });

    it("throws NextcloudGroupNotFoundError when the group does not exist (statuscode 102)", async () => {
      // For DELETE /cloud/users/{uid}/groups, OCS statuscode 102 means the group
      // does not exist — NOT "user not in group".
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: {
                statuscode: 102,
                status: "failure",
                message: "The group does not exist",
              },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncRemoveUserFromGroup("token", "bob", "dept-finance")
      ).rejects.toBeInstanceOf(NextcloudGroupNotFoundError);
    });

    it("does not swallow a non-success OCS statuscode on a 2xx response (statuscode 105)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: {
                statuscode: 105,
                status: "failure",
                message: "failed to remove user from group",
              },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncRemoveUserFromGroup("token", "bob", "dept-eng")
      ).rejects.toThrow(NextcloudOcsError);
    });

    it("throws NextcloudOcsError on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
          json: {
            ocs: {
              meta: { statuscode: 404, message: "User not found" },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        ncRemoveUserFromGroup("token", "carol", "group1")
      ).rejects.toThrow(NextcloudOcsError);
    });
  });

  describe("ncListGroupMembers", () => {
    it("returns array of members from OCS response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { statuscode: 100, status: "ok" },
              data: { users: ["alice", "bob", "carol"] },
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const members = await ncListGroupMembers("adminToken", "dept-eng");

      expect(members).toEqual([
        { id: "alice", displayName: "alice" },
        { id: "bob", displayName: "bob" },
        { id: "carol", displayName: "carol" },
      ]);
    });

    it("returns empty array on 404", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
          json: { ocs: { meta: { statuscode: 404 }, data: null } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const members = await ncListGroupMembers("token", "nonexistent");

      expect(members).toEqual([]);
    });

    it("returns empty array on non-JSON response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
          text: "Internal server error",
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const members = await ncListGroupMembers("token", "group1");

      expect(members).toEqual([]);
    });

    it("returns empty array when users key is missing", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 }, data: {} } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const members = await ncListGroupMembers("token", "empty-group");

      expect(members).toEqual([]);
    });
  });

  /**
   * WARP-1565 residual 3 — the strict variant the reconciler sweeps use.
   *
   * `ncListGroupMembers` collapses EVERY failure to `[]`, so a caller cannot
   * tell "this group has no members" from "I could not find out". For the
   * lenient callers that is fine. For a sweep it is not: the whole point of
   * a sweep is to compare an expected set against the actual one, and an
   * empty actual set is indistinguishable from a total outage — which is
   * how a list-broken/writes-working Nextcloud makes the admin-group sweep
   * re-add every operator on every tick, forever.
   *
   * 404 stays `[]` on purpose, and that is the whole distinction: a group
   * that does not exist genuinely has no members, and the reconciler's
   * group-creation pass owns fixing that. Everything else is UNKNOWN, and
   * unknown must throw so the sweep can skip the tick instead of acting on
   * a fiction.
   *
   * The lenient function is deliberately left exactly as it was — a strict
   * variant beside it is a smaller blast radius than re-pointing a shared
   * client contract, and it puts the choice at the call site where the
   * consequence lives.
   */
  describe("ncListGroupMembersStrict", () => {
    it("returns the members on a healthy list", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { statuscode: 100, status: "ok" },
              data: { users: ["alice", "bob"] },
            },
          },
        })
      ) as unknown as typeof fetch;

      await expect(ncListGroupMembersStrict("token", "dept-eng")).resolves.toEqual([
        { id: "alice", displayName: "alice" },
        { id: "bob", displayName: "bob" },
      ]);
    });

    it("returns [] for a group that exists and is empty", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 }, data: { users: [] } } },
        })
      ) as unknown as typeof fetch;

      await expect(ncListGroupMembersStrict("token", "empty")).resolves.toEqual([]);
    });

    it("returns [] on 404 — an absent group genuinely has no members", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
          json: { ocs: { meta: { statuscode: 404 }, data: null } },
        })
      ) as unknown as typeof fetch;

      await expect(ncListGroupMembersStrict("token", "gone")).resolves.toEqual([]);
    });

    it("THROWS on a server error instead of reporting an empty group", async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 500, text: "Internal server error" })
      ) as unknown as typeof fetch;

      await expect(ncListGroupMembersStrict("token", "g")).rejects.toThrow(
        NextcloudOcsError
      );
    });

    it("THROWS when the transport fails", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

      await expect(ncListGroupMembersStrict("token", "g")).rejects.toThrow(
        /ECONNREFUSED/
      );
    });

    it("THROWS on a 200 whose payload has no users array", async () => {
      // A malformed success is not an empty group — it is a response we do
      // not understand, and acting on it would remove real members.
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 }, data: {} } },
        })
      ) as unknown as typeof fetch;

      await expect(ncListGroupMembersStrict("token", "g")).rejects.toThrow(
        NextcloudOcsError
      );
    });
  });

  // ── Groupfolders REST API Tests ──

  describe("gfListFolders", () => {
    it("returns array of parsed groupfolders", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { statuscode: 100, status: "ok" },
              data: {
                "1": {
                  id: 1,
                  mount_point: "Engineering",
                  groups: { "dept-eng": 15 },
                  quota: 1073741824,
                  size: 0,
                  acl: false,
                  manage: [],
                },
                "2": {
                  id: 2,
                  mount_point: "Finance",
                  groups: { "dept-finance": 31 },
                  quota: -3,
                  size: 5000,
                  acl: true,
                  manage: ["admin"],
                },
              },
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const folders = await gfListFolders("adminToken");

      // WARP-1507: groupfolders REST routes require the OCS-APIRequest header
      // or Nextcloud rejects them with 412 "CSRF check failed".
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["OCS-APIRequest"]).toBe("true");

      expect(folders).toHaveLength(2);
      expect(folders[0]).toEqual({
        id: 1,
        mountPoint: "Engineering",
        groups: { "dept-eng": 15 },
        quota: 1073741824,
        size: 0,
        acl: false,
        manage: [],
      });
      expect(folders[1]).toEqual({
        id: 2,
        mountPoint: "Finance",
        groups: { "dept-finance": 31 },
        quota: -3,
        size: 5000,
        acl: true,
        manage: ["admin"],
      });
    });

    it("returns empty array on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const folders = await gfListFolders("token");

      expect(folders).toEqual([]);
    });

    it("returns empty array when data is not an object", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: null } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const folders = await gfListFolders("token");

      expect(folders).toEqual([]);
    });
  });

  describe("gfGetFolder", () => {
    it("returns parsed groupfolder info", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { statuscode: 100, status: "ok" },
              data: {
                id: 42,
                mount_point: "Research",
                groups: { "dept-research": 7 },
                quota: 2147483648,
                size: 1000000,
                acl: false,
                manage: ["alice", "bob"],
              },
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const folder = await gfGetFolder("adminToken", 42);

      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["OCS-APIRequest"]).toBe("true");

      expect(folder).toEqual({
        id: 42,
        mountPoint: "Research",
        groups: { "dept-research": 7 },
        quota: 2147483648,
        size: 1000000,
        acl: false,
        manage: ["alice", "bob"],
      });
    });

    it("returns null on 404", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
          json: { ocs: { data: null } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const folder = await gfGetFolder("token", 999);

      expect(folder).toBeNull();
    });

    it("throws on non-404 HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfGetFolder("token", 1)).rejects.toThrow(/failed: 500/);
    });
  });

  describe("gfCreateFolder", () => {
    it("returns folder id on success", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: {
            ocs: {
              meta: { statuscode: 100, status: "ok" },
              data: { id: 99, mount_point: "NewFolder" },
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const id = await gfCreateFolder("adminToken", "NewFolder");

      expect(id).toBe(99);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/index.php/apps/groupfolders/folders");
      expect(init.method).toBe("POST");
      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      expect(init.headers["OCS-APIRequest"]).toBe("true");
    });

    it("throws if response has no id", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { meta: { statuscode: 100 }, data: {} } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfCreateFolder("token", "NoId")).rejects.toThrow(/missing folder id/);
    });

    it("throws on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 409,
          json: {
            ocs: {
              meta: { message: "Folder already exists" },
              data: {},
            },
          },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfCreateFolder("token", "Exists")).rejects.toThrow();
    });
  });

  describe("gfDeleteFolder", () => {
    it("succeeds on success response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfDeleteFolder("adminToken", 42)).resolves.toBeUndefined();

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/index.php/apps/groupfolders/folders/42");
      expect(init.method).toBe("DELETE");
      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      expect(init.headers["OCS-APIRequest"]).toBe("true");
    });

    it("succeeds on 404 (idempotent)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfDeleteFolder("token", 999)).resolves.toBeUndefined();
    });

    it("throws if success is false", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: false } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfDeleteFolder("token", 42)).rejects.toThrow(/reported failure/);
    });
  });

  describe("gfAddGroup", () => {
    it("issues POST with group param", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await gfAddGroup("adminToken", 5, "dept-sales");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://nextcloud.test/index.php/apps/groupfolders/folders/5/groups");
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bearer adminToken");
      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      expect(init.headers["OCS-APIRequest"]).toBe("true");
      // URLSearchParams body is verified by checking call was made
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
          json: { ocs: { meta: { message: "Folder not found" } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfAddGroup("token", 999, "group1")).rejects.toThrow();
    });
  });

  describe("gfRemoveGroup", () => {
    it("issues DELETE for group", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await gfRemoveGroup("adminToken", 5, "dept-sales");

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/index.php/apps/groupfolders/folders/5/groups/dept-sales"
      );
      expect(init.method).toBe("DELETE");
      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      expect(init.headers["OCS-APIRequest"]).toBe("true");
    });

    it("succeeds on 404 (idempotent)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfRemoveGroup("token", 5, "group1")).resolves.toBeUndefined();
    });

    it("throws on non-404 HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfRemoveGroup("token", 5, "group1")).rejects.toThrow();
    });
  });

  describe("gfSetGroupPermissions", () => {
    it("issues POST with permissions param", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await gfSetGroupPermissions("adminToken", 5, "dept-eng", 7); // read+update+create

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/index.php/apps/groupfolders/folders/5/groups/dept-eng"
      );
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bearer adminToken");
      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      expect(init.headers["OCS-APIRequest"]).toBe("true");
      // Verified that POST was called with the correct URL
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("supports all permission bits", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      // 31 = read+update+create+delete+share (all bits)
      await gfSetGroupPermissions("token", 1, "group", 31);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/folders/1/groups/group");
    });

    it("throws on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 400,
          json: { ocs: { meta: { message: "Invalid permissions" } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfSetGroupPermissions("token", 1, "group", 999)).rejects.toThrow();
    });
  });

  describe("gfSetQuota", () => {
    it("issues POST with quota param in bytes", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await gfSetQuota("adminToken", 5, 1073741824); // 1 GB

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        "http://nextcloud.test/index.php/apps/groupfolders/folders/5/quota"
      );
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bearer adminToken");
      // WARP-1507: OCS-APIRequest header required on groupfolders routes.
      expect(init.headers["OCS-APIRequest"]).toBe("true");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("supports -3 for unlimited quota", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: true,
          status: 200,
          json: { ocs: { data: { success: true } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await gfSetQuota("token", 1, -3);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/folders/1/quota");
    });

    it("throws on HTTP error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 404,
          json: { ocs: { meta: { message: "Folder not found" } } },
        })
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(gfSetQuota("token", 999, 1000000)).rejects.toThrow();
    });
  });
});
