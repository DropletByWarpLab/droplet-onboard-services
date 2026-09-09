/**
 * WARP-2460 — the Mailchimp subscriber hash must survive `DROPLET_FIPS_MODE=1`.
 *
 * Mailchimp keys a list member by the MD5 of their lowercased email address, so
 * `subscriberHash()` has to produce an MD5 whatever the box's crypto posture is.
 * `node:crypto` cannot do that on a FIPS box: MD5 is not FIPS 140-3 approved, the
 * OpenSSL FIPS provider does not implement it, and constructing an MD5 hash
 * throws before a request is ever made:
 *
 *     Error: error:0308010C:digital envelope routines::unsupported
 *       code: 'ERR_OSSL_EVP_UNSUPPORTED'
 *
 * `docs/fips.md` prescribes that exact call as the operator's proof a FIPS box is
 * enforcing (step 4 of "Verifying a FIPS-on box" — the pasteable one-liner lives
 * there, not here, because the FIPS source lint matches the literal call form even
 * inside a comment), and the `fips-stack` CI job fails if MD5 *works* at runtime —
 * so the refusal is the designed behaviour, not a defect to route around.
 *
 * The fix is `src/mailchimp/md5.ts`, an arithmetic RFC 1321 implementation that
 * touches no OpenSSL provider. These tests exist to make sure it is a REAL MD5
 * and that nothing quietly reintroduces the `node:crypto` dependency.
 *
 * `node:crypto` MD5 appears below ONLY as the reference oracle the pure
 * implementation is differentially tested against. Comparing our implementation
 * to itself would be vacuous; the whole value of the parity tests is that the
 * other side is an independent, battle-tested MD5. These runs are never FIPS.
 *
 * Every test names the mutation that must turn it red.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { md5Hex, md5HexBytes } from "../src/mailchimp/md5.js";
import { subscriberHash } from "../src/mailchimp/connector.js";

const MAILCHIMP_DIR = join(fileURLToPath(new URL("../src/mailchimp/", import.meta.url)));

function mailchimpSource(file: string): string {
  return readFileSync(join(MAILCHIMP_DIR, file), "utf8");
}

/**
 * The same source with comments removed, so the "does this module CALL X"
 * assertions below cannot be satisfied or defeated by prose. Both files
 * discuss the `node:crypto` MD5 call at length in their docstrings —
 * explaining why they must not make it is the point — and a scan that could
 * not tell a sentence from a statement would be permanently red for the
 * wrong reason.
 */
function mailchimpCode(file: string): string {
  return mailchimpSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * RFC 1321 §A.5, "Test suite" — the seven vectors the RFC publishes so an
 * implementation can prove itself. Reproduced verbatim.
 */
const RFC_1321_TEST_SUITE: ReadonlyArray<readonly [string, string]> = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ],
  [
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    "57edf4a22be3c955ac49da2e2107b67a",
  ],
];

describe("pure-JS MD5 (RFC 1321)", () => {
  it("reproduces every vector in the RFC's own test suite", () => {
    // These are the RFC's published constants, so they pin the round table, the
    // shift schedule, the four auxiliary functions, the initial chaining values
    // and the little-endian output order all at once — none of which can be
    // wrong while all seven still match.
    // Mutation: flip one round constant in `T` (e.g. 0xd76aa478 → 0xd76aa479)
    // → red on every vector including "".
    for (const [input, expected] of RFC_1321_TEST_SUITE) {
      expect(md5Hex(input)).toBe(expected);
    }
  });

  it("agrees with node:crypto MD5 at every padding boundary from 0 to 200 bytes", () => {
    // The padding rule is where hand-rolled MD5 goes wrong, and it goes wrong
    // ONLY at specific lengths: 55/56/57 (the point the 8-byte length field no
    // longer fits beside the message) and 63/64/65 (a message that exactly
    // fills a block still owes a whole extra padding block). Sweeping every
    // length rather than sampling is what makes those cases unmissable.
    // Mutation: drop the `+ 1` in `padMessage`'s block count, or stop writing
    // the 0x80 marker → red at the 56-byte and 64-byte boundaries.
    const mismatches: number[] = [];
    for (let length = 0; length <= 200; length += 1) {
      const message = randomBytes(length);
      // fips:allowed: mailchimp-subscriber-hash — reference oracle, non-FIPS test run only.
      const reference = createHash("md5").update(message).digest("hex");
      if (md5HexBytes(new Uint8Array(message)) !== reference) {
        mismatches.push(length);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees with node:crypto MD5 on 1,000 random inputs", () => {
    // Differential test against an independent implementation. Lengths are
    // drawn across several blocks so multi-block chaining is exercised too.
    // Mutation: change the padding rule, drop the per-block chaining-value
    // add-back, or reorder the output words → red.
    const mismatches: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const message = randomBytes(Math.floor(Math.random() * 300));
      // fips:allowed: mailchimp-subscriber-hash — reference oracle, non-FIPS test run only.
      const reference = createHash("md5").update(message).digest("hex");
      const actual = md5HexBytes(new Uint8Array(message));
      if (actual !== reference) {
        mismatches.push(`len=${message.length} expected=${reference} actual=${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("encodes strings as UTF-8, the way node:crypto's update(string) does", () => {
    // A non-ASCII address would otherwise hash differently from the vendor's
    // view of it, producing the same silent 404 the lowercasing rule exists to
    // prevent.
    // Mutation: encode as latin1 / per-charCode bytes → red.
    for (const input of ["héllo@example.test", "日本語", "é", "\u{1F600}"]) {
      // fips:allowed: mailchimp-subscriber-hash — reference oracle, non-FIPS test run only.
      expect(md5Hex(input)).toBe(createHash("md5").update(input, "utf8").digest("hex"));
    }
  });
});

describe("subscriberHash is provider-independent", () => {
  it("computes the Mailchimp subscriber hash without node:crypto", () => {
    // The regression this ticket exists for. A node:crypto MD5 construction
    // throws ERR_OSSL_EVP_UNSUPPORTED under a FIPS provider, so a connector that
    // reaches for it leaves a FIPS customer unable to look up a single member
    // while list and campaign reads keep working — a half-working connector.
    // A behavioural test cannot see the difference on a non-FIPS runner (both
    // implementations return the same digest), so the guard is on the source.
    // Mutation: restore the node:crypto MD5 call in `subscriberHash` → red.
    const connector = mailchimpCode("connector.ts");
    expect(connector).not.toMatch(/createHash\s*\(\s*["']md5["']/);
    expect(connector).not.toMatch(/from\s+["']node:crypto["']/);
    expect(connector).toContain('from "./md5.js"');
  });

  it("keeps the digest module free of ANY import, so no provider can be reached", () => {
    // Provider-independence by construction rather than by inspection: a module
    // that imports nothing cannot route through OpenSSL however it is bundled.
    // Mutation: add `import { createHash } from "node:crypto"` to md5.ts → red.
    const code = mailchimpCode("md5.ts");
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\s*\(/);
  });

  it("still hashes the LOWERCASED address, and matches a real MD5 of it", () => {
    // The WARP-2379 precondition, re-asserted against the new implementation so
    // the swap cannot have quietly dropped it.
    // Mutation: drop `.toLowerCase()` in subscriberHash → red.
    const mixed = "Romain@Example.COM";
    expect(subscriberHash(mixed)).toBe(subscriberHash("romain@example.com"));
    // fips:allowed: mailchimp-subscriber-hash — reference oracle, non-FIPS test run only.
    expect(subscriberHash(mixed)).toBe(createHash("md5").update("romain@example.com").digest("hex"));
    expect(subscriberHash(mixed)).not.toBe(md5Hex(mixed));
  });

  it("trims surrounding whitespace before hashing", () => {
    // Mutation: drop `.trim()` → red.
    expect(subscriberHash("  romain@example.com  ")).toBe(subscriberHash("romain@example.com"));
  });
});
