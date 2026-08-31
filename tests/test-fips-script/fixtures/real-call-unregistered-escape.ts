// WARP-2480 fixture — a REAL call site whose escape names a reason-id that is
// not registered in docs/security/fips-exceptions.md. Comment stripping must
// leave this behaviour exactly as it was. Expected: one violation.
import { createHash } from "node:crypto";

export function subscriberHash(email: string): string {
  // fips:allowed: not-a-registered-reason-id
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}
