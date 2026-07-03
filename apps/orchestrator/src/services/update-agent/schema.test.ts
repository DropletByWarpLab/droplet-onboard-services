/**
 * WARP-537 — DeviceUpdate model + DeviceUpdateStatus enum schema contract.
 *
 * Locks the generated Prisma client to the design's OTA audit-table
 * shape. `status` is the canonical state column (CLAUDE.md / WARP-218
 * pattern) — never derived from absent timestamps — and the enum is the
 * full advance-only lifecycle the later tickets walk:
 *
 *   pending ──► superseded            (WARP-538 poller: newer release)
 *   pending ──► verifying ──► applying ──► committed          (WARP-539)
 *                     │            └────► rolled_back          (WARP-539)
 *                     │                        └─► failed      (rollback
 *                     │                            also failed; the
 *                     │                            degraded_health verdict
 *                     │                            rides failureReason)
 *                     └──► rejected   (schema-downgrade & friends)
 */
import { describe, it, expect, vi } from "vitest";

vi.unmock("@prisma/client");

import { Prisma, DeviceUpdateStatus } from "@prisma/client";

describe("DeviceUpdate schema contract (WARP-537)", () => {
  it("DeviceUpdateStatus enum carries exactly the design lifecycle", () => {
    expect(Object.values(DeviceUpdateStatus).sort()).toEqual(
      [
        "pending",
        "superseded",
        "verifying",
        "applying",
        "committed",
        "rolled_back",
        "failed",
        "rejected",
      ].sort(),
    );
  });

  it("DeviceUpdate model exists in the generated client", () => {
    expect(Prisma.ModelName.DeviceUpdate).toBe("DeviceUpdate");
  });

  it("DeviceUpdate carries the audit fields the update agent writes", () => {
    const fields = Object.keys(Prisma.DeviceUpdateScalarFieldEnum);
    for (const required of [
      "id",
      "status",
      "channel",
      "releaseTag",
      "gitSha",
      "builtAt",
      "manifestSha256",
      "manifestJson",
      "failureReason",
      "createdAt",
      "updatedAt",
    ]) {
      expect(fields).toContain(required);
    }
  });
});
