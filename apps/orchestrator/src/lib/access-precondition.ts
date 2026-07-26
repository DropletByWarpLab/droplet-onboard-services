/**
 * Route-level precondition failures raised from INSIDE a transaction — the
 * 404 / 409 outcomes that must be decided against transactionally-consistent
 * reads (T3 review B2).
 *
 * ## Why this is a THROW and not a returned outcome (WARP-1583)
 *
 * T3 shipped two mechanisms for one problem: `routes/access.ts` threw a
 * local `AccessPreconditionError`, `routes/people.ts` returned a
 * discriminated `{ kind }` union and mapped it after the transaction closed.
 * Both were locally reasonable. Having both meant the next author picked by
 * coin flip, and only one of them is safe by construction.
 *
 * The two shapes agree exactly as long as every precondition is discovered
 * BEFORE the transaction's first write — which is true of every path today,
 * and is why neither was a bug. They stop agreeing the moment one is not:
 * a returned outcome COMMITS whatever the transaction has already written,
 * so the route answers "nothing was applied" over a partially-applied
 * mutation. Unwinding rolls it back. Making the safe shape the only shape
 * means a precondition added later inherits the rollback instead of
 * depending on a future author noticing it must sit above the writes.
 *
 * It also collapses the route's catch to ONE shape: the guard rails
 * (`RoleMutationRefusedError`) already unwind with the same `status` +
 * `toJSON()` contract, so both are mapped by the same two lines.
 *
 * These are HTTP shapes, not guard rails — deliberately NOT folded into
 * `role-mutation-guard.service.ts`, whose refusals are the §4 rail
 * vocabulary with machine-readable codes per rail. What lives here is the
 * copy for preconditions BOTH access surfaces answer, so the two cannot
 * drift apart the way the person-mutation surfaces did (WARP-1523).
 */

/** Refusal decided inside a transaction; throwing rolls that transaction back. */
export class AccessPreconditionError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : "Precondition failed");
    this.name = "AccessPreconditionError";
    this.status = status;
    this.body = body;
  }

  /** The exact response body, mirroring `RoleMutationRefusedError.toJSON()`. */
  toJSON(): Record<string, unknown> {
    return this.body;
  }

  /** The requested access role does not exist. */
  static roleNotFound(): AccessPreconditionError {
    return new AccessPreconditionError(404, { error: "Role not found" });
  }

  /**
   * The role exists but is archived. ARCHIVE ≠ REVOKE (T3 review C2):
   * archiving stops a role being ASSIGNABLE without stripping access from
   * the people who already hold it, so both assign paths refuse here rather
   * than the resolver dropping grants elsewhere.
   */
  static roleArchived(): AccessPreconditionError {
    return new AccessPreconditionError(409, {
      error: "This role is archived — restore it before assigning people.",
      code: "ACCESS_ROLE_ARCHIVED",
    });
  }

  /**
   * No such person. `missing` is for the BULK path, which can usefully name
   * which ids missed; the single-target path passes nothing, because an
   * empty `missing: []` on a 404 would read as "nobody was missing".
   */
  static userNotFound(missing?: string[]): AccessPreconditionError {
    return new AccessPreconditionError(404, {
      error: "User not found",
      ...(missing ? { missing } : {}),
    });
  }
}

/**
 * Cross-module-safe recogniser. `instanceof` alone is enough within one
 * bundle, but this reads at the call site as the intent ("is this a
 * precondition refusal?") and survives a duplicated module identity.
 */
export function isAccessPreconditionError(
  err: unknown,
): err is AccessPreconditionError {
  return err instanceof AccessPreconditionError;
}
