/**
 * Tests for the WARP-637 claim-code seeding behavior wired into
 * prisma/seed.ts.
 *
 * The seeder reads `CLAIM_CODE` from the environment and calls
 * `seedClaimCode(prisma, code)` when it is set and non-empty; it is
 * skipped entirely when the variable is absent or blank.  These tests
 * mock `seedClaimCode` and drive the logic in isolation — no DB, no
 * running orchestrator.
 *
 * Complementary coverage: `setup-claim.service.test.ts` validates
 * `seedClaimCode` itself (hash correctness, idempotency, far-future
 * expiry).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.unmock("@prisma/client");

import { seedClaimCode } from "./setup-claim.service.js";

vi.mock("./setup-claim.service.js", () => ({
  seedClaimCode: vi.fn().mockResolvedValue(true),
}));

const mockSeedClaimCode = vi.mocked(seedClaimCode);

/** Minimal Prisma stand-in — the seeder only passes it through. */
function fakePrisma() {
  return {} as never;
}

/**
 * Inline the seeder's CLAIM_CODE logic so we can unit-test it without
 * importing `prisma/seed.ts` directly (which instantiates PrismaClient
 * at module load time and is excluded from vitest's `include` glob).
 *
 * Keep this in strict sync with the implementation in prisma/seed.ts:
 *
 *   const claimCode = (process.env.CLAIM_CODE ?? "").trim();
 *   if (claimCode) {
 *     const seeded = await seedClaimCode(prisma, claimCode);
 *     console.log("Claim code seeded from CLAIM_CODE (new=%s)", seeded);
 *   }
 */
async function runClaimCodeSeederStep(prisma: never): Promise<void> {
  const claimCode = (process.env.CLAIM_CODE ?? "").trim();
  if (claimCode) {
    await seedClaimCode(prisma, claimCode);
  }
}

describe("seeder claim-code step (WARP-637)", () => {
  beforeEach(() => {
    process.env.DEVICE_SECRET = "test-device-secret";
    delete process.env.CLAIM_CODE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.DEVICE_SECRET;
    delete process.env.CLAIM_CODE;
  });

  it("calls seedClaimCode with the trimmed env value when CLAIM_CODE is set", async () => {
    process.env.CLAIM_CODE = "DRPL-TEST-CODE";

    await runClaimCodeSeederStep(fakePrisma());

    expect(mockSeedClaimCode).toHaveBeenCalledOnce();
    expect(mockSeedClaimCode).toHaveBeenCalledWith(fakePrisma(), "DRPL-TEST-CODE");
  });

  it("trims surrounding whitespace from CLAIM_CODE before seeding", async () => {
    process.env.CLAIM_CODE = "  DRPL-TRIM-ME  ";

    await runClaimCodeSeederStep(fakePrisma());

    expect(mockSeedClaimCode).toHaveBeenCalledWith(fakePrisma(), "DRPL-TRIM-ME");
  });

  it("does NOT call seedClaimCode when CLAIM_CODE is unset", async () => {
    // CLAIM_CODE is deleted in beforeEach — not set here.
    await runClaimCodeSeederStep(fakePrisma());

    expect(mockSeedClaimCode).not.toHaveBeenCalled();
  });

  it("does NOT call seedClaimCode when CLAIM_CODE is an empty string", async () => {
    process.env.CLAIM_CODE = "";

    await runClaimCodeSeederStep(fakePrisma());

    expect(mockSeedClaimCode).not.toHaveBeenCalled();
  });

  it("does NOT call seedClaimCode when CLAIM_CODE is only whitespace", async () => {
    process.env.CLAIM_CODE = "   ";

    await runClaimCodeSeederStep(fakePrisma());

    expect(mockSeedClaimCode).not.toHaveBeenCalled();
  });
});
