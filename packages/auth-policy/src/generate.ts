/**
 * WARP-1049 — cryptographically-random temporary password generator.
 *
 * Shared here (not in a component) because the value it produces MUST satisfy
 * the same `validatePassword` policy that gates every credential surface —
 * keeping the generator next to the policy makes that contract testable and
 * pins it against drift (the `generate.test.ts` runs validatePassword over
 * hundreds of draws).
 *
 * Guarantees, by construction:
 *   - length ≥ PASSWORD_MIN (so the length rule always passes),
 *   - one char from EACH of the four classes (lower/upper/digit/symbol), so the
 *     "≥3 of 4 classes" rule can never miss even on an unlucky draw,
 *   - drawn from Web Crypto `getRandomValues` with rejection sampling (no
 *     modulo bias), never Math.random,
 *   - excludes visually ambiguous glyphs (0/O, 1/l/I) so an operator can read a
 *     handed-off password aloud / retype it without transcription errors.
 */
import { PASSWORD_MIN } from "./password.js";

// Ambiguity-pruned alphabets. No 0/O, 1/l/I. The symbol set is limited to
// characters that survive a copy-paste and a spoken hand-off without shell /
// URL escaping surprises.
const LOWER = "abcdefghijkmnopqrstuvwxyz"; // no l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
const DIGIT = "23456789"; // no 0, 1
const SYMBOL = "!@#$%^&*?-_+=";
const ALL = LOWER + UPPER + DIGIT + SYMBOL;

/** Length of the generated password. Comfortably above the policy floor so a
 *  temp credential carries real entropy while staying easy to hand off. */
const LENGTH = Math.max(PASSWORD_MIN + 4, 16);

function getCrypto(): Crypto {
  // Browser + Node ≥ 15 expose `globalThis.crypto` with getRandomValues.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error(
      "Web Crypto getRandomValues is unavailable; refusing to generate a temp password without a CSPRNG",
    );
  }
  return c;
}

/**
 * Uniformly pick one character from `alphabet` using rejection sampling on a
 * random byte, so no modulo bias favours the first `256 % len` characters.
 */
function pick(alphabet: string): string {
  const cryptoObj = getCrypto();
  const len = alphabet.length;
  // Largest multiple of `len` that fits in a byte; reject bytes at or above it.
  const limit = 256 - (256 % len);
  const buf = new Uint8Array(1);
  // Loop is bounded in expectation (limit ≥ 128 for every alphabet here, so
  // rejection probability < 0.5 per draw); not an unbounded scheduler loop.
  for (;;) {
    cryptoObj.getRandomValues(buf);
    if (buf[0] < limit) return alphabet[buf[0] % len];
  }
}

/** Fisher–Yates shuffle driven by the CSPRNG (so the guaranteed one-per-class
 *  seed characters aren't stuck at fixed positions). */
function shuffle(chars: string[]): string[] {
  const cryptoObj = getCrypto();
  const buf = new Uint8Array(1);
  for (let i = chars.length - 1; i > 0; i--) {
    // Unbiased index in [0, i] via rejection sampling.
    const bound = i + 1;
    const limit = 256 - (256 % bound);
    let j: number;
    do {
      cryptoObj.getRandomValues(buf);
    } while (buf[0] >= limit);
    j = buf[0] % bound;
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

/**
 * Generate a policy-compliant, cryptographically-random temporary password.
 * Guaranteed to pass `validatePassword`.
 */
export function generateTempPassword(): string {
  // Seed one guaranteed char per class, then fill the remainder from the full
  // alphabet, then shuffle so the class order isn't predictable.
  const chars: string[] = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < LENGTH) chars.push(pick(ALL));
  return shuffle(chars).join("");
}
