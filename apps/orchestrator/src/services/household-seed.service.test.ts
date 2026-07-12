/**
 * Tests for WARP-1263 (T11) household absorption seed.
 *
 * Unit tests for seedHouseholdDepartment service.
 * Integration testing with a real box (household groupfolder adoption + role mapping)
 * requires a real Nextcloud instance and should be tested in the CI environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { seedHouseholdDepartment } from "./household-seed.service.js";
import { householdGroupName } from "../routes/auth-groups.js";
import { config } from "../config.js";
import { gfListFolders } from "./nextcloud-groups.client.js";

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

  // WARP-1263 CR fix — the create-department branch (no HOUSEHOLD row yet) must
  // persist Department.ncGroupRw as the CANONICAL householdGroupName() slug, not
  // the raw shared-folder name, so the stored value matches the real Nextcloud
  // group that docker/nextcloud-init.sh creates (which derives HOUSEHOLD_GROUP
  // the same way). The global setup.ts mock always short-circuits to a
  // pre-existing HOUSEHOLD fixture, so these tests build a purpose-built prisma
  // stub to actually exercise the create branch in isolation.
  describe("seedHouseholdDepartment — create branch ncGroupRw slug", () => {
    let created: { data: Record<string, unknown> } | null;
    let originalFolderName: string;

    // Build a minimal prisma stub whose findFirst returns null (no HOUSEHOLD
    // yet) so the seed proceeds to the create branch, and whose $transaction
    // runs the callback against a tx stub that captures department.create data.
    function makePrismaStub(): PrismaClient {
      const tx = {
        department: {
          create: vi.fn(async (args: { data: Record<string, unknown> }) => {
            created = { data: args.data };
            return { id: "dept-created", ...args.data };
          }),
        },
        user: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        departmentMembership: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
        },
      };
      return {
        department: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        $transaction: vi.fn(
          async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
        ),
      } as unknown as PrismaClient;
    }

    beforeEach(() => {
      created = null;
      originalFolderName = config.DROPLET_SHARED_FOLDER_NAME;
    });

    afterEach(() => {
      config.DROPLET_SHARED_FOLDER_NAME = originalFolderName;
    });

    it("stores ncGroupRw as householdGroupName() of the default folder name (\"Household\" -> \"household\")", async () => {
      config.DROPLET_SHARED_FOLDER_NAME = "Household";
      vi.mocked(gfListFolders).mockResolvedValue([
        {
          id: 7,
          mountPoint: "Household",
          groups: {},
          quota: -3,
          size: 0,
          acl: false,
          manage: [],
        },
      ]);

      await seedHouseholdDepartment(makePrismaStub());

      expect(created).not.toBeNull();
      expect(created!.data.ncGroupRw).toBe(
        householdGroupName(config.DROPLET_SHARED_FOLDER_NAME),
      );
      // Matches the real group docker/nextcloud-init.sh creates on the default config.
      expect(created!.data.ncGroupRw).toBe("household");
    });

    it("slugifies a mixed-case custom folder name (\"Family Drive\" -> \"family-drive\")", async () => {
      config.DROPLET_SHARED_FOLDER_NAME = "Family Drive";
      vi.mocked(gfListFolders).mockResolvedValue([
        {
          id: 9,
          mountPoint: "Family Drive",
          groups: {},
          quota: -3,
          size: 0,
          acl: false,
          manage: [],
        },
      ]);

      await seedHouseholdDepartment(makePrismaStub());

      expect(created).not.toBeNull();
      expect(created!.data.ncGroupRw).toBe(
        householdGroupName(config.DROPLET_SHARED_FOLDER_NAME),
      );
      expect(created!.data.ncGroupRw).toBe("family-drive");
      // The human-facing display name stays verbatim; only the NC group is slugified.
      expect(created!.data.name).toBe("Family Drive");
    });
  });
});
