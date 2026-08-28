// WARP-2480 fixture — a REAL call site with no escape comment. Comment
// stripping must not reach it: the mention that matters is on a code line.
// Expected: one violation.
import { createHash } from "node:crypto";

export function subscriberHash(email: string): string {
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}
