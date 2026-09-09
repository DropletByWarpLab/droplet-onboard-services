// WARP-2480 fixture — comment stripping is LINE-scoped, not file-scoped. A
// prose mention must not buy the real call site below it an exemption.
// Expected: exactly one violation, on the `legacyChecksum` line.
import { createHash } from "node:crypto";

/**
 * createHash("md5") is named here as prose and must be dropped.
 */
export function subscriberHash(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

export function legacyChecksum(value: string): string {
  return createHash("md5").update(value).digest("hex");
}
