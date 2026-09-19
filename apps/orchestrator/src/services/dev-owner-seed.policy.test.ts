/**
 * WARP-2844 — the dev-owner seed guards.
 *
 * These tests are the safety argument for a second writer of `role: "owner"`.
 * The ORDER assertions matter as much as the individual refusals: a guard that
 * is merely present but reachable only after a cheaper check has already
 * returned is not a guard. Each ordering test therefore satisfies every
 * condition EXCEPT the one under test, plus the condition it must outrank.
 */

import { describe, it, expect } from "vitest";
import {
  decideDevOwnerSeed,
  decideDevOwnerNextcloudRepair,
  type DevOwnerSeedInputs,
  type DevOwnerRepairInputs,
} from "./dev-owner-seed.policy.js";

const GOOD_PASSWORD = "Dev-Stack-Local-1";
const EMAIL = "dev@warp-lab.ai";

function inputs(over: Partial<DevOwnerSeedInputs> = {}): DevOwnerSeedInputs {
  return {
    nodeEnv: "development",
    email: EMAIL,
    password: GOOD_PASSWORD,
    existingOwnerCount: 0,
    takenUserIds: new Set<string>(),
    ...over,
  };
}

describe("decideDevOwnerSeed — the happy path", () => {
  it("seeds, and derives `dev` from the email's local part", () => {
    expect(decideDevOwnerSeed(inputs())).toEqual({ action: "seed", username: "dev" });
  });

  it.each(["development", "test", undefined, ""])(
    "runs when NODE_ENV is %o — only the literal 'production' refuses",
    (nodeEnv) => {
      expect(decideDevOwnerSeed(inputs({ nodeEnv })).action).toBe("seed");
    },
  );
});

describe("guard 1 — production", () => {
  it("refuses when NODE_ENV=production", () => {
    const d = decideDevOwnerSeed(inputs({ nodeEnv: "production" }));
    expect(d).toMatchObject({ action: "skip", code: "production" });
  });

  it("outranks every other guard — refuses production even when nothing else would have", () => {
    // No password, an existing owner AND a taken username: any of those would
    // also skip, but the code must name production.
    const d = decideDevOwnerSeed(
      inputs({
        nodeEnv: "production",
        password: undefined,
        existingOwnerCount: 3,
        takenUserIds: new Set(["dev"]),
      }),
    );
    expect(d).toMatchObject({ action: "skip", code: "production" });
  });
});

describe("guard 2 — no configured credential", () => {
  it.each([undefined, ""])("skips when the password is %o", (password) => {
    expect(decideDevOwnerSeed(inputs({ password }))).toMatchObject({
      action: "skip",
      code: "no_password",
    });
  });

  it("says so without mentioning owners — an unset password means nobody asked", () => {
    const d = decideDevOwnerSeed(inputs({ password: undefined, existingOwnerCount: 1 }));
    expect(d).toMatchObject({ action: "skip", code: "no_password" });
  });

  it("names the variable so the skip is actionable", () => {
    const d = decideDevOwnerSeed(inputs({ password: undefined }));
    expect(d.action === "skip" && d.reason).toContain("DROPLET_DEV_OWNER_PASSWORD");
  });
});

describe("guard 3 — the shipped password policy", () => {
  it("refuses a password that is too short", () => {
    expect(decideDevOwnerSeed(inputs({ password: "Ab-1" }))).toMatchObject({
      action: "skip",
      code: "weak_password",
    });
  });

  it("refuses a long password with too few character classes", () => {
    // 20 chars, lowercase only — passes length, fails classes.
    expect(decideDevOwnerSeed(inputs({ password: "abcdefghijklmnopqrst" }))).toMatchObject({
      action: "skip",
      code: "weak_password",
    });
  });

  it("outranks the owner-exists guard, so a weak password is reported as weak", () => {
    const d = decideDevOwnerSeed(inputs({ password: "short", existingOwnerCount: 1 }));
    expect(d).toMatchObject({ action: "skip", code: "weak_password" });
  });

  it("explains which rule failed", () => {
    const d = decideDevOwnerSeed(inputs({ password: "Ab-1" }));
    expect(d.action === "skip" && d.reason).toContain("12-128 characters");
  });
});

describe("guard 4 — never take over a box that already has an owner", () => {
  it("skips when an owner exists", () => {
    expect(decideDevOwnerSeed(inputs({ existingOwnerCount: 1 }))).toMatchObject({
      action: "skip",
      code: "owner_exists",
    });
  });

  it("skips for any positive count, not just exactly one", () => {
    expect(decideDevOwnerSeed(inputs({ existingOwnerCount: 7 }))).toMatchObject({
      action: "skip",
      code: "owner_exists",
    });
  });

  it("is what makes a re-run idempotent — the second pass finds the owner it made", () => {
    const first = decideDevOwnerSeed(inputs({ existingOwnerCount: 0 }));
    expect(first.action).toBe("seed");
    const second = decideDevOwnerSeed(inputs({ existingOwnerCount: 1 }));
    expect(second).toMatchObject({ action: "skip", code: "owner_exists" });
  });
});

describe("username derivation", () => {
  it("reports a collision instead of silently seeding `dev-2`", () => {
    const d = decideDevOwnerSeed(inputs({ takenUserIds: new Set(["dev"]) }));
    expect(d).toMatchObject({ action: "skip", code: "username_taken" });
    expect(d.action === "skip" && d.reason).toContain("dev");
  });

  it("is not confused by a reserved base — admin@ lands on admin-2 for both probes", () => {
    // `admin` is in RESERVED_USERNAMES, so the derivation skips it on an empty
    // table too. That is a reservation, not a collision, and must still seed.
    const d = decideDevOwnerSeed(inputs({ email: "admin@warp-lab.ai" }));
    expect(d).toEqual({ action: "seed", username: "admin-2" });
  });

  it("ignores unrelated taken ids", () => {
    const d = decideDevOwnerSeed(inputs({ takenUserIds: new Set(["stefan", "romain"]) }));
    expect(d).toEqual({ action: "seed", username: "dev" });
  });
});

describe("decideDevOwnerNextcloudRepair — WARP-2845", () => {
  function repair(over: Partial<DevOwnerRepairInputs> = {}): DevOwnerRepairInputs {
    return {
      seedDecision: { action: "seed", username: "dev" },
      existingOwnerUsername: null,
      nodeEnv: "development",
      email: EMAIL,
      password: GOOD_PASSWORD,
      ...over,
    };
  }

  it("provisions on the normal path, right after the row is created", () => {
    expect(decideDevOwnerNextcloudRepair(repair())).toEqual({
      action: "provision",
      username: "dev",
    });
  });

  it("HEALS: owner_exists no longer means 'nothing to do' when the owner is ours", () => {
    // This is the whole bug. Before, guard 4 returned early and the missing
    // Nextcloud account stayed missing forever.
    const d = decideDevOwnerNextcloudRepair(
      repair({
        seedDecision: { action: "skip", code: "owner_exists", reason: "..." },
        existingOwnerUsername: "dev",
      }),
    );
    expect(d).toEqual({ action: "provision", username: "dev" });
  });

  it("REFUSES to touch an owner that is not ours", () => {
    // Creating an account for someone else, with a password from OUR env, is a
    // silent credential injection. Never.
    const d = decideDevOwnerNextcloudRepair(
      repair({
        seedDecision: { action: "skip", code: "owner_exists", reason: "..." },
        existingOwnerUsername: "stefan",
      }),
    );
    expect(d).toMatchObject({ action: "skip", code: "not_the_dev_owner" });
    expect(d.action === "skip" && d.reason).toContain("stefan");
  });

  it("refuses when the existing owner is unknown rather than assuming it is ours", () => {
    const d = decideDevOwnerNextcloudRepair(
      repair({
        seedDecision: { action: "skip", code: "owner_exists", reason: "..." },
        existingOwnerUsername: null,
      }),
    );
    expect(d).toMatchObject({ action: "skip", code: "not_the_dev_owner" });
  });

  it("never provisions in production, even on the heal path", () => {
    const d = decideDevOwnerNextcloudRepair(
      repair({
        nodeEnv: "production",
        seedDecision: { action: "skip", code: "owner_exists", reason: "..." },
        existingOwnerUsername: "dev",
      }),
    );
    expect(d).toMatchObject({ action: "skip", code: "production" });
  });

  it("skips without a password — there is nothing to create an account with", () => {
    const d = decideDevOwnerNextcloudRepair(
      repair({
        password: undefined,
        seedDecision: { action: "skip", code: "owner_exists", reason: "..." },
        existingOwnerUsername: "dev",
      }),
    );
    expect(d).toMatchObject({ action: "skip", code: "no_password" });
  });

  it.each(["weak_password", "username_taken"] as const)(
    "skips as not_seeded when the seed refused for %s — no row of ours exists",
    (code) => {
      const d = decideDevOwnerNextcloudRepair(
        repair({ seedDecision: { action: "skip", code, reason: "..." } }),
      );
      expect(d).toMatchObject({ action: "skip", code: "not_seeded" });
    },
  );

  it("matches a reserved-base owner too — admin@ heals admin-2, not 'admin'", () => {
    const d = decideDevOwnerNextcloudRepair(
      repair({
        email: "admin@warp-lab.ai",
        seedDecision: { action: "skip", code: "owner_exists", reason: "..." },
        existingOwnerUsername: "admin-2",
      }),
    );
    expect(d).toEqual({ action: "provision", username: "admin-2" });
  });
});
