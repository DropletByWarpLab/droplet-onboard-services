// WARP-2480 fixture — a file that DOCUMENTS why it avoids MD5 and never calls
// it. Every mention below sits on a line whose first non-blank characters are
// a comment introducer, so `_strip_comment_only_lines` must drop them all from
// the candidate set BEFORE the escape-comment check.
//
// Expected: zero violations. Note that this file carries NO `fips:allowed:`
// escape — needing one to describe an algorithm you deliberately do not call
// is the defect WARP-2480 fixes.
//
// `//` prefix: createHash("md5") is refused by the OpenSSL FIPS provider.

/* `/*` prefix: createHash("md5") named on a block-comment opener. */

/**
 * `*` prefix (a JSDoc continuation line) — the shape that hard-failed the gate
 * while fixing WARP-2460:
 *
 * The vendor keys members by an MD5 digest, so `createHash("md5")` looks like
 * the obvious implementation, and it throws on a box running FIPS mode.
 */

/* A block comment that closes on its own line, so the next line starts with
 * the block terminator:
 */ // `*/` prefix: createHash("md5") named where the block terminator leads.

import { createHash } from "node:crypto";

/** Single-line JSDoc: createHash("md5") stays prose here too. */
export function subscriberHash(email: string): string {
  //   deeply indented `//` prefix: createHash("md5") would throw under FIPS
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
