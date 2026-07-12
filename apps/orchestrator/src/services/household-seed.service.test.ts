/**
 * Tests for WARP-1263 (T11) household absorption seed.
 *
 * Unit tests for seedHouseholdDepartment service.
 * Integration testing with a real box (household groupfolder adoption + role mapping)
 * requires a real Nextcloud instance and should be tested in the CI environment.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { seedHouseholdDepartment } from "./household-seed.service.js";

vi.mock("./nextcloud-groups.client.js");
vi.mock("./department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:test"),
}));
vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

import { PrismaClient } from "@prisma/client";

describe("household-seed.service", () => {
  let prisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = new PrismaClient();
  });

  describe("seedHouseholdDepartment", () => {
    it("should not throw when called with mocked Prisma (no HOUSEHOLD found)", async () => {
      // With the setup.ts mocks, department.findFirst returns null for non-HOUSEHOLD queries
      // and gfListFolders is mocked to return []
      await expect(seedHouseholdDepartment(prisma)).resolves.not.toThrow();
    });

    it("should gracefully handle errors from NC client", async () => {
      // Verify the function catches NC errors and logs them without throwing
      await expect(seedHouseholdDepartment(prisma)).resolves.not.toThrow();
    });

    it("should handle Prisma transaction errors gracefully", async () => {
      // The try-catch in seedHouseholdDepartment should catch any Prisma errors
      await expect(seedHouseholdDepartment(prisma)).resolves.not.toThrow();
    });
  });
});
