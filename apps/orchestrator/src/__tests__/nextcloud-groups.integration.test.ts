/**
 * Integration tests for nextcloud-groups.client.ts
 *
 * These tests run against a real Nextcloud instance and are gated behind
 * the NC_INTEGRATION_URL environment variable. To run them locally:
 *
 *   NC_INTEGRATION_URL=http://localhost:8080 npm test -- nextcloud-groups.integration
 *
 * The tests assume admin credentials via NEXTCLOUD_ADMIN_USER and
 * NEXTCLOUD_ADMIN_PASSWORD environment variables.
 *
 * WARNING: These tests are DESTRUCTIVE. They create and delete groups and
 * groupfolders in the target Nextcloud instance. Use a disposable test container.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config.js";
import {
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
  ncListGroupMembers,
  gfListFolders,
  gfCreateFolder,
  gfDeleteFolder,
  gfAddGroup,
  gfRemoveGroup,
  gfSetGroupPermissions,
  gfSetQuota,
} from "../services/nextcloud-groups.client.js";
import { ncEnsureGroup, ncCreateUser } from "../services/nextcloud.client.js";

const NC_INTEGRATION_URL = process.env.NC_INTEGRATION_URL;
const shouldSkip = !NC_INTEGRATION_URL;

describe.skipIf(shouldSkip)("nextcloud-groups.client — integration", () => {
  const adminToken = Buffer.from(
    `${process.env.NEXTCLOUD_ADMIN_USER || "admin"}:${process.env.NEXTCLOUD_ADMIN_PASSWORD || "admin"}`
  ).toString("base64");
  const adminBasicToken = `basic:${adminToken}`;

  // Test fixtures
  const testGroupId = `test-group-${Date.now()}`;
  const testUser1 = `testuser1-${Date.now()}`;
  const testUser2 = `testuser2-${Date.now()}`;
  let testFolderId: number;

  beforeAll(async () => {
    // Create test group
    await ncEnsureGroup(testGroupId);

    // Create test users
    await ncCreateUser(adminBasicToken, testUser1, "password123", "Test User 1", []);
    await ncCreateUser(adminBasicToken, testUser2, "password123", "Test User 2", []);

    // Create test groupfolder
    testFolderId = await gfCreateFolder(adminBasicToken, `test-folder-${Date.now()}`);
  });

  afterAll(async () => {
    // Cleanup: delete groupfolder
    try {
      await gfDeleteFolder(adminBasicToken, testFolderId);
    } catch (err) {
      console.warn("Failed to cleanup groupfolder in afterAll:", err);
    }
  });

  describe("OCS Groups API", () => {
    it("adds a user to a group", async () => {
      await ncAddUserToGroup(adminBasicToken, testUser1, testGroupId);

      const members = await ncListGroupMembers(adminBasicToken, testGroupId);
      const memberIds = members.map((m) => m.id);
      expect(memberIds).toContain(testUser1);
    });

    it("adds a second user to the group", async () => {
      await ncAddUserToGroup(adminBasicToken, testUser2, testGroupId);

      const members = await ncListGroupMembers(adminBasicToken, testGroupId);
      expect(members).toHaveLength(2);
    });

    it("is idempotent when adding an existing member", async () => {
      // Add user again — should not throw
      await expect(
        ncAddUserToGroup(adminBasicToken, testUser1, testGroupId)
      ).resolves.not.toThrow();

      const members = await ncListGroupMembers(adminBasicToken, testGroupId);
      expect(members).toHaveLength(2); // still 2, not 3
    });

    it("removes a user from the group", async () => {
      await ncRemoveUserFromGroup(adminBasicToken, testUser1, testGroupId);

      const members = await ncListGroupMembers(adminBasicToken, testGroupId);
      const memberIds = members.map((m) => m.id);
      expect(memberIds).not.toContain(testUser1);
      expect(memberIds).toContain(testUser2);
    });

    it("is idempotent when removing a non-member", async () => {
      // Remove a user who's already gone — should not throw
      await expect(
        ncRemoveUserFromGroup(adminBasicToken, testUser1, testGroupId)
      ).resolves.not.toThrow();
    });

    it("lists group members", async () => {
      const members = await ncListGroupMembers(adminBasicToken, testGroupId);

      expect(Array.isArray(members)).toBe(true);
      expect(members.some((m) => m.id === testUser2)).toBe(true);
      expect(members.every((m) => typeof m.id === "string")).toBe(true);
    });
  });

  describe("Groupfolders REST API", () => {
    it("lists groupfolders", async () => {
      const folders = await gfListFolders(adminBasicToken);

      expect(Array.isArray(folders)).toBe(true);
      expect(folders.some((f) => f.id === testFolderId)).toBe(true);
    });

    it("adds a group to a folder", async () => {
      await gfAddGroup(adminBasicToken, testFolderId, testGroupId);

      const folders = await gfListFolders(adminBasicToken);
      const testFolder = folders.find((f) => f.id === testFolderId);
      expect(testFolder).toBeDefined();
      expect(testFolder?.groups[testGroupId]).toBeDefined();
    });

    it("sets group permissions on a folder", async () => {
      // Set permissions to 7 (read+update+create, no delete or share)
      await gfSetGroupPermissions(adminBasicToken, testFolderId, testGroupId, 7);

      const folders = await gfListFolders(adminBasicToken);
      const testFolder = folders.find((f) => f.id === testFolderId);
      expect(testFolder?.groups[testGroupId]).toBe(7);
    });

    it("sets folder quota", async () => {
      const quotaBytes = 536870912; // 512 MB

      await gfSetQuota(adminBasicToken, testFolderId, quotaBytes);

      const folders = await gfListFolders(adminBasicToken);
      const testFolder = folders.find((f) => f.id === testFolderId);
      expect(testFolder?.quota).toBe(quotaBytes);
    });

    it("removes a group from a folder", async () => {
      await gfRemoveGroup(adminBasicToken, testFolderId, testGroupId);

      const folders = await gfListFolders(adminBasicToken);
      const testFolder = folders.find((f) => f.id === testFolderId);
      expect(testFolder?.groups[testGroupId]).toBeUndefined();
    });

    it("is idempotent when removing a non-assigned group", async () => {
      // Group is already removed; removing again should not throw
      await expect(
        gfRemoveGroup(adminBasicToken, testFolderId, testGroupId)
      ).resolves.not.toThrow();
    });
  });
});
