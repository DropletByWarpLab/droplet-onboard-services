/**
 * WARP-2844 — the guards around the dev stack's seeded owner account.
 *
 * `role: "owner"` is written by exactly ONE line in the shipped product:
 * `routes/auth.ts` inside `POST /auth/setup`, behind the N1 owner-exists
 * guard and the WARP-165 physical-presence claim gate. `prisma/seed.dev.ts`
 * is the second writer, and that is the entire risk in this feature — a seed
 * script that mints an owner is a backdoor unless it can prove it is running
 * somewhere a backdoor cannot matter.
 *
 * So the decision lives here, pure and separately tested, rather than inline
 * in a script nothing can import. The seed's only job is to gather the inputs
 * honestly and obey the answer.
 *
 * Four independent refusals, checked in this order:
 *
 *   1. production      — refuse outright. Do NOT rely on the seed only being
 *                        wired into docker/dev/entrypoint-orchestrator.sh:
 *                        that is a deployment fact, and deployment facts
 *                        change. This one is in the code.
 *   2. no_password     — the credential comes from the environment and has NO
 *                        default. Unset means "nobody asked for this", not
 *                        "use a well-known password". A hardcoded owner
 *                        credential in a tracked file is the thing this
 *                        module exists to make impossible.
 *   3. weak_password   — validated against the SHIPPED policy, not a local
 *                        rule. An account seeded below the product's own bar
 *                        could not later change its own password.
 *   4. owner_exists    — mirrors the N1 guard. The seed must never take over
 *                        a box that already has an owner, and must never
 *                        rewrite an existing owner's hash.
 *
 * `username_taken` is the fifth answer and is not a safety guard — it is the
 * honest outcome when the derived id collides with a non-owner account.
 */

import { deriveUserId, validatePassword, type PasswordRuleId } from "@droplet/auth-policy";

export type DevOwnerSkipCode =
  | "production"
  | "no_password"
  | "weak_password"
  | "owner_exists"
  | "username_taken";

export type DevOwnerSeedDecision =
  | { action: "seed"; username: string }
  | { action: "skip"; code: DevOwnerSkipCode; reason: string };

export interface DevOwnerSeedInputs {
  /** `process.env.NODE_ENV` verbatim — undefined is NOT production. */
  nodeEnv: string | undefined;
  /** Login email for the seeded account. */
  email: string;
  /** `process.env.DROPLET_DEV_OWNER_PASSWORD` verbatim. No default anywhere. */
  password: string | undefined;
  /** `prisma.user.count({ where: { role: "owner" } })`. */
  existingOwnerCount: number;
  /**
   * Every `username` AND `nextcloudUsername` already in the table — both are
   * @unique, so a candidate colliding with either cannot be created.
   */
  takenUserIds: ReadonlySet<string>;
}

/** Rendered into the skip log so a developer knows which rule they missed. */
function describeFailedRules(failed: PasswordRuleId[]): string {
  const parts = failed.map((id) =>
    id === "length" ? "12-128 characters" : "at least 3 of lower/upper/digit/symbol",
  );
  return parts.join(" and ");
}

export function decideDevOwnerSeed(inputs: DevOwnerSeedInputs): DevOwnerSeedDecision {
  // 1. Never in production, whatever else is true.
  if (inputs.nodeEnv === "production") {
    return {
      action: "skip",
      code: "production",
      reason: "NODE_ENV=production — the dev owner seed never runs on a real deployment",
    };
  }

  // 2. No credential configured means the feature was not requested.
  const password = inputs.password ?? "";
  if (password.length === 0) {
    return {
      action: "skip",
      code: "no_password",
      reason:
        "DROPLET_DEV_OWNER_PASSWORD is not set — set it in .env to seed a dev owner " +
        "(there is deliberately no default)",
    };
  }

  // 3. Hold the seeded account to the product's own password policy.
  const { ok, failed } = validatePassword(password);
  if (!ok) {
    return {
      action: "skip",
      code: "weak_password",
      reason: `DROPLET_DEV_OWNER_PASSWORD does not meet the shipped policy: needs ${describeFailedRules(failed)}`,
    };
  }

  // 4. Never take over a box that already has an owner.
  if (inputs.existingOwnerCount > 0) {
    return {
      action: "skip",
      code: "owner_exists",
      reason:
        `an owner already exists (${inputs.existingOwnerCount}) — leaving it untouched; ` +
        "drop the stack volumes if you want a fresh one",
    };
  }

  // 5. Derive the id the same way POST /auth/setup does, then report a
  //    collision rather than silently seeding `dev-2`, which would leave the
  //    developer signing in as an account the docs do not describe.
  const username = deriveUserId(inputs.email, (candidate) => inputs.takenUserIds.has(candidate));
  // The id this email would get on an empty table. Compared rather than
  // assumed equal to the local-part, because `deriveUserId` also skips
  // RESERVED_USERNAMES — so for admin@… both calls legitimately land on
  // `admin-2` and that is not a collision.
  const idIfNothingTaken = deriveUserId(inputs.email, () => false);
  if (username !== idIfNothingTaken) {
    return {
      action: "skip",
      code: "username_taken",
      reason: `the derived username '${idIfNothingTaken}' is already taken by another account`,
    };
  }

  return { action: "seed", username };
}

/* ────────────────────────────────────────────────────────────────────────────
 * WARP-2845 — the Nextcloud REPAIR decision.
 *
 * The seed writes the local `User` row first and provisions Nextcloud second,
 * best-effort. That ordering is deliberate — the dashboard authenticates
 * against the local row alone (ADR-013), so a Nextcloud that is slow to
 * install must not cost the developer their login.
 *
 * But best-effort plus guard 4 was a trap. The dev compose's orchestrator
 * `depends_on` covers db and cache only, and Nextcloud's first-boot install is
 * far slower than Postgres + migrate + seed — so on a fresh `up` the OCS call
 * usually fires before Nextcloud can answer it. The failure was swallowed, the
 * row survived pointing at an account that was never created, and on every
 * later boot `owner_exists` skipped seeding entirely. Nothing else in the repo
 * heals it: nextcloud-bootstrap.sh only ever provisions the hardcoded `stefan`,
 * and no auth path back-fills a missing account. The only recovery was dropping
 * the DB volume — destroying the stack to undo a startup race.
 *
 * So `owner_exists` must stop meaning "there is nothing left to do". It means
 * the ROW is done. This decides the other half.
 *
 * Deliberately NOT the WARP-989 rollback that `POST /auth/setup` performs. The
 * economics are inverted: on an appliance a half-created owner is a permanent
 * lockout, so discarding the row is right. Here the row is a WORKING LOGIN and
 * only /files is degraded — rolling it back would throw away the good half and
 * leave the developer with no account until they restarted. Healing keeps both.
 * ──────────────────────────────────────────────────────────────────────────── */

export type DevOwnerRepairSkipCode =
  | "production"
  | "no_password"
  | "not_seeded"
  | "not_the_dev_owner";

export type DevOwnerRepairDecision =
  | { action: "provision"; username: string }
  | { action: "skip"; code: DevOwnerRepairSkipCode; reason: string };

export interface DevOwnerRepairInputs {
  /** The result of `decideDevOwnerSeed` for this same run. */
  seedDecision: DevOwnerSeedDecision;
  /** `User.username` of the row that already holds role=owner, if any. */
  existingOwnerUsername: string | null;
  nodeEnv: string | undefined;
  email: string;
  password: string | undefined;
}

export function decideDevOwnerNextcloudRepair(
  inputs: DevOwnerRepairInputs,
): DevOwnerRepairDecision {
  if (inputs.nodeEnv === "production") {
    return { action: "skip", code: "production", reason: "NODE_ENV=production" };
  }

  // Provisioning needs the plaintext; without it there is nothing to create an
  // account WITH, even when a row is sitting there unhealed.
  if (!inputs.password) {
    return {
      action: "skip",
      code: "no_password",
      reason: "DROPLET_DEV_OWNER_PASSWORD is not set, so no Nextcloud account can be created",
    };
  }

  // Normal path: we just created the row, so provision its account.
  if (inputs.seedDecision.action === "seed") {
    return { action: "provision", username: inputs.seedDecision.username };
  }

  // Repair path: a row already exists. Only heal it when it is OUR dev owner.
  if (inputs.seedDecision.code === "owner_exists") {
    const expected = deriveUserId(inputs.email, () => false);
    if (inputs.existingOwnerUsername === expected) {
      return { action: "provision", username: expected };
    }
    // 🔴 The box's owner is somebody else — a human who walked the wizard, or
    // a differently-configured seed. Creating a Nextcloud account for them,
    // with a password from OUR env, would be a silent credential injection
    // into an account this script does not own. Never.
    return {
      action: "skip",
      code: "not_the_dev_owner",
      reason:
        `the existing owner is '${inputs.existingOwnerUsername ?? "unknown"}', not '${expected}' — ` +
        "leaving its Nextcloud account alone",
    };
  }

  // Every other skip (weak password, username taken) means no row of ours
  // exists to repair.
  return {
    action: "skip",
    code: "not_seeded",
    reason: `no dev owner row to repair (${inputs.seedDecision.code})`,
  };
}
