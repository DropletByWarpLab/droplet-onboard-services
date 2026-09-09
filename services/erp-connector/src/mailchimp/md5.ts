/**
 * RFC 1321 MD5 — a provider-independent digest, for ONE non-security use.
 *
 * ## Why this file exists instead of `node:crypto`
 *
 * Mailchimp addresses a list member by the MD5 of their lowercased email
 * address: `GET /lists/{list_id}/members/{subscriber_hash}`. The digest is the
 * vendor's MANDATED IDENTIFIER SCHEME. It authenticates nothing, protects
 * nothing, and is not a secret — the same address always produces the same
 * hash, by design, because that is how the URL is addressed. There is no
 * alternative: the API exposes no other way to key a member.
 *
 * `node:crypto` cannot serve that use on a FIPS box. MD5 is not a FIPS 140-3
 * approved digest, so the OpenSSL FIPS provider does not implement it, and
 * constructing an MD5 hash throws before any request is made:
 *
 *     Error: error:0308010C:digital envelope routines::unsupported
 *       code: 'ERR_OSSL_EVP_UNSUPPORTED'
 *
 * That is not a hypothetical. `docs/fips.md` prescribes exactly that call as
 * the operator's proof that a FIPS box is genuinely enforcing — step 4 of
 * "Verifying a FIPS-on box", "The provider is genuinely enforcing (MD5 must
 * FAIL in both stacks)", which runs an MD5 construction inside the
 * orchestrator and treats a throw as the correct outcome. (The pasteable
 * one-liner lives there and is deliberately not repeated here: the FIPS
 * source lint matches the literal call form even inside a comment.) CI
 * asserts the same property from the other side: the
 * `fips-stack` job fails if "MD5 works at runtime" (docs/fips.md, "How CI
 * keeps this honest"). `DROPLET_FIPS_MODE` is a shipped per-customer knob and
 * `erp-connector` is built into the `orchestrator` image, which is one of the
 * six provider-carrying images that enforce it (docs/fips.md, "Scope — which
 * services enforce").
 *
 * So on a FIPS-enabled box the vendor's own addressing scheme is unreachable
 * through `node:crypto`, and every Mailchimp member lookup fails with what
 * reads like a crypto bug. Node exposes no per-call provider selection, so
 * loading the default provider alongside FIPS for this one call is not
 * available. A ~100-line arithmetic implementation is.
 *
 * This module touches no OpenSSL provider — it has NO imports at all — so it
 * behaves identically whether `DROPLET_FIPS_MODE` is on or off.
 *
 * ## What this is NOT for
 *
 * Never reach for this as a general-purpose digest. MD5 is cryptographically
 * broken and its presence here is registered as a FIPS exception
 * (`mailchimp-subscriber-hash`, see `docs/security/fips-exceptions.md`) on the
 * narrow grounds that it derives a vendor-mandated URL segment. Anything that
 * authenticates, signs, or protects uses a FIPS-approved algorithm from
 * `node:crypto` — see `docs/security/fips-allowed-algorithms.md`.
 *
 * ## Source
 *
 * R. Rivest, "The MD5 Message-Digest Algorithm", RFC 1321, April 1992 —
 * §3.4 (the four auxiliary functions and the round table T) and §3.5 (the
 * padding and length-append rules). Verified against the RFC's own §A.5
 * test-suite vectors and against `node:crypto` MD5 in `__tests__/`.
 */

/**
 * The 64-entry round table T from RFC 1321 §3.4.
 *
 * `T[i] = floor(2^32 * abs(sin(i + 1)))`, with `i + 1` taken in radians.
 * Held as an explicit table rather than computed from `Math.sin` so the
 * values are auditable against the RFC line by line, and so a platform's
 * `Math.sin` precision can never move the digest.
 */
const T: readonly number[] = [
  // Round 1
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  // Round 2
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  // Round 3
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  // Round 4
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/** Per-operation left-rotation amounts, RFC 1321 §3.4 (the `s` values). */
const SHIFT: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** The four chaining values, RFC 1321 §3.3. Little-endian on the wire. */
const INIT_A = 0x67452301;
const INIT_B = 0xefcdab89;
const INIT_C = 0x98badcfe;
const INIT_D = 0x10325476;

/** MD5 processes the message in 512-bit (64-byte) blocks. */
const BLOCK_BYTES = 64;

/**
 * The last 8 bytes of the padded message carry the original bit length, so a
 * block can hold at most 56 bytes of message-or-padding before the length
 * field must start a fresh block. RFC 1321 §3.2.
 */
const LENGTH_FIELD_BYTES = 8;

/** Rotate a 32-bit word left by `n` bits. */
function rotateLeft(word: number, n: number): number {
  return ((word << n) | (word >>> (32 - n))) >>> 0;
}

/** Sum 32-bit words with wraparound, as unsigned. */
function add32(a: number, b: number): number {
  return (a + b) >>> 0;
}

/**
 * Apply RFC 1321 §3.1–§3.2 padding.
 *
 * Append a single `0x80` byte, then the fewest `0x00` bytes that leave room
 * for an 8-byte little-endian ORIGINAL BIT LENGTH at the end of the final
 * block. Note the padding is ALWAYS applied — a message that is already a
 * multiple of 64 bytes still gains a whole extra block. Dropping that case is
 * the classic MD5 bug, and it only shows up at exact multiples of 64.
 */
function padMessage(message: Uint8Array): Uint8Array {
  const messageBytes = message.length;
  // Number of whole blocks once the 0x80 marker and the length field are
  // accounted for. The `+ 1` makes the "already a multiple of 64" case
  // allocate the extra block it requires.
  const blocks = Math.floor((messageBytes + LENGTH_FIELD_BYTES) / BLOCK_BYTES) + 1;
  const padded = new Uint8Array(blocks * BLOCK_BYTES);
  padded.set(message);
  padded[messageBytes] = 0x80;

  // Original length IN BITS, little-endian, split across two 32-bit halves so
  // messages above 512 MiB stay correct without BigInt.
  const bitLengthLow = (messageBytes << 3) >>> 0;
  const bitLengthHigh = Math.floor(messageBytes / 0x20000000) >>> 0;
  const lengthOffset = padded.length - LENGTH_FIELD_BYTES;
  for (let i = 0; i < 4; i += 1) {
    padded[lengthOffset + i] = (bitLengthLow >>> (8 * i)) & 0xff;
    padded[lengthOffset + 4 + i] = (bitLengthHigh >>> (8 * i)) & 0xff;
  }
  return padded;
}

/** Render four 32-bit chaining values as MD5's little-endian hex digest. */
function digestToHex(words: readonly number[]): string {
  let hex = "";
  for (const word of words) {
    for (let byte = 0; byte < 4; byte += 1) {
      hex += (((word >>> (8 * byte)) & 0xff) | 0x100).toString(16).slice(1);
    }
  }
  return hex;
}

/**
 * MD5 of raw bytes, as lowercase hex.
 *
 * Exported for tests that need to drive the digest with byte sequences that
 * are not valid UTF-8; production callers want {@link md5Hex}.
 */
export function md5HexBytes(message: Uint8Array): string {
  const padded = padMessage(message);
  let a = INIT_A;
  let b = INIT_B;
  let c = INIT_C;
  let d = INIT_D;

  const block = new Array<number>(16);
  for (let offset = 0; offset < padded.length; offset += BLOCK_BYTES) {
    // Decode the block as 16 little-endian 32-bit words (RFC 1321 §3.4).
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      block[i] =
        (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0;
    }

    const savedA = a;
    const savedB = b;
    const savedC = c;
    const savedD = d;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        // F(X,Y,Z) = XY v not(X) Z
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        // G(X,Y,Z) = XZ v Y not(Z)
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        // H(X,Y,Z) = X xor Y xor Z
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        // I(X,Y,Z) = Y xor (X v not(Z))
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const rotated = add32(
        b,
        rotateLeft(add32(add32(add32(a, f >>> 0), T[i]), block[g]), SHIFT[i]),
      );
      a = d;
      d = c;
      c = b;
      b = rotated;
    }

    a = add32(a, savedA);
    b = add32(b, savedB);
    c = add32(c, savedC);
    d = add32(d, savedD);
  }

  return digestToHex([a, b, c, d]);
}

/**
 * MD5 of a string, as lowercase hex. The string is encoded as UTF-8 first,
 * which is what `node:crypto`'s MD5 `update(str)` does by default, so the two
 * agree byte for byte on every input.
 */
export function md5Hex(input: string): string {
  return md5HexBytes(new TextEncoder().encode(input));
}
