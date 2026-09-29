/**
 * WARP-3193 SEC-AUTH-2 — the ONE sign-in second-factor check.
 *
 * Extracted from the POST /auth/login gate (PR #375) so passkey and SSO
 * sign-ins run the SAME rule instead of skipping it: a user whose TOTP
 * credential is CONFIRMED (explicit `confirmedAt`, never IS-NULL inference
 * on the row's existence) must present a valid TOTP code or an unused
 * recovery code before any session is issued. A pending (unconfirmed)
 * enrollment does not gate sign-in.
 *
 * The caller owns the transport side (status code, throttling, audit row):
 * `failed` is answered with 401 `TOTP_REQUIRED`, the contract the dashboard
 * already handles for the password path.
 */
import type { PrismaClient } from "@prisma/client";
import { acceptTotpCode } from "./totp.service.js";
import { consumeRecoveryCode } from "./recovery.service.js";

export type LoginSecondFactorOutcome =
  /** No confirmed TOTP credential — nothing to check. */
  | "not_enrolled"
  /** A valid TOTP code (single-use step) or an unused recovery code. */
  | "passed"
  /** Enrolled, and the code is missing, wrong, replayed or already spent. */
  | "failed";

export interface LoginSecondFactorInput {
  totp?: unknown;
  recoveryCode?: unknown;
}

export async function checkLoginSecondFactor(
  prisma: Pick<PrismaClient, "totpCredential" | "recoveryCode">,
  userId: string,
  input: LoginSecondFactorInput,
): Promise<LoginSecondFactorOutcome> {
  const cred = await prisma.totpCredential.findUnique({ where: { userId } });
  if (!cred || !cred.confirmedAt) return "not_enrolled";

  const totpCode = typeof input.totp === "string" ? input.totp.trim() : "";
  const recoveryCode = typeof input.recoveryCode === "string" ? input.recoveryCode : "";

  if (totpCode) {
    // WARP-3193 SEC-AUTH-10 — single-use: the code's time step is claimed
    // atomically, so a replayed code fails the factor.
    return (await acceptTotpCode(prisma, cred, totpCode)) ? "passed" : "failed";
  }
  if (recoveryCode) {
    // WARP-3193 ARCH-3 — the shared single-use consume (atomic on
    // `usedAt: null`; a replay or a concurrent loser is not consumed).
    return (await consumeRecoveryCode(prisma, userId, recoveryCode)).consumed ? "passed" : "failed";
  }
  return "failed";
}
