/**
 * sha512-crypt.ts — WARP-2887. The `$6$` password hash Linux `/etc/shadow`
 * understands, computed in-process.
 *
 * Why this exists: the owner-set SSH login crosses the container → host
 * boundary through the WARP-1984 intent file, which is droplet-writable and
 * world-readable inside the state dir. A plaintext password must therefore
 * never be written there, so the orchestrator hashes it first and the root
 * applier hands the hash to `chpasswd -e` untouched. Node has no `crypt(3)`,
 * the runtime image's OpenSSL is the FIPS build (its `passwd -6` is not a
 * contract we want to depend on), and pulling a dependency for ~80 lines of
 * spec is the wrong trade for the one place a hash is minted.
 *
 * This is Ulrich Drepper's SHA-crypt (2008), SHA-512 variant — exactly what
 * glibc `crypt(3)` and `openssl passwd -6` produce, so the test vectors are
 * checked against those, not against this file's own output.
 *
 * ── ON THE CODEQL FINDING (js/insufficient-password-hash) ───────────────────
 * CodeQL flags any SHA-2 over password-derived data and asks for bcrypt /
 * scrypt / argon2. Those are the right answer when WE verify the password.
 * Here we never do: the consumer is the appliance's `chpasswd -e` → shadow →
 * PAM, and the ONLY formats that stack accepts are the crypt(3) ones. Of
 * those, `$6$` with a pinned high round count is the strongest that every
 * Ubuntu we ship verifies without a native library (yescrypt would need one).
 * So the algorithm is fixed by the consumer, and the knob we do control —
 * work factor — is pinned at SHA512_CRYPT_ROUNDS (20× the historical 5000
 * default; ~0.1 s per hash on the box, per login change, never per request).
 * The suppression below is deliberate and reviewed, not a rule waived.
 *
 * NOT a general password hasher. Do not reach for it for API credentials,
 * tokens or anything the orchestrator verifies itself — argon2 is already in
 * the tree for that. This is only the shadow-file format.
 */
import { createHash, randomBytes } from "node:crypto";

/** The round count every hash we mint carries. Pinned — same grammar on both
 *  sides of the boundary, so the host applier can match it exactly. */
export const SHA512_CRYPT_ROUNDS = 100_000;
/** The format's implicit default; a hash minted at this count carries no
 *  `rounds=` field (that is how `openssl passwd -6` output looks). */
const ROUNDS_DEFAULT = 5000;
const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 999_999_999;
const B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The salt alphabet the shadow format allows; 16 chars is the maximum used. */
export const SHA512_CRYPT_SALT_RE = /^[./0-9A-Za-z]{1,16}$/;

/**
 * The exact shape the host applier accepts: our pinned round count, then
 * salt, then 86 hash chars. One grammar on both sides of the boundary.
 */
export const SHA512_CRYPT_HASH_RE = /^\$6\$rounds=100000\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/;

function sha512(...parts: Buffer[]): Buffer {
  // The suppressions below are the shadow(5) `$6$` KDF at SHA512_CRYPT_ROUNDS;
  // the consumer (chpasswd/PAM) fixes the algorithm. See the header.
  const h = createHash("sha512"); // codeql[js/insufficient-password-hash]
  for (const p of parts) h.update(p); // codeql[js/insufficient-password-hash]
  return h.digest(); // codeql[js/insufficient-password-hash]
}

/** Repeat `block` until `len` bytes have been produced (the spec's fill). */
function fill(block: Buffer, len: number): Buffer {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += block.length) block.copy(out, i, 0, Math.min(block.length, len - i));
  return out;
}

/** Emit `n` base64 characters from a 24-bit group, least-significant first. */
function b64From24(b2: number, b1: number, b0: number, n: number): string {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let s = "";
  for (let i = 0; i < n; i++) {
    s += B64[w & 0x3f];
    w >>>= 6;
  }
  return s;
}

/** A fresh 16-character salt from the shadow alphabet. */
export function generateSalt(): string {
  const raw = randomBytes(16);
  let s = "";
  for (const byte of raw) s += B64[byte & 0x3f];
  return s;
}

/**
 * `sha512Crypt(password, salt, rounds)` → `$6$rounds=N$<salt>$<86 chars>`
 * (the `rounds=` field is omitted only at the format's 5000 default, matching
 * glibc and openssl byte for byte).
 *
 * Steps are numbered as in the specification so a reader can follow it
 * line by line; nothing here is clever.
 */
export function sha512Crypt(
  password: string,
  salt: string = generateSalt(),
  rounds: number = SHA512_CRYPT_ROUNDS,
): string {
  if (!SHA512_CRYPT_SALT_RE.test(salt)) {
    throw new Error("sha512-crypt: salt must be 1..16 chars of [./0-9A-Za-z]");
  }
  if (!Number.isInteger(rounds) || rounds < ROUNDS_MIN || rounds > ROUNDS_MAX) {
    throw new Error(`sha512-crypt: rounds must be an integer in ${ROUNDS_MIN}..${ROUNDS_MAX}`);
  }
  const pw = Buffer.from(password, "utf8");
  const sl = Buffer.from(salt, "utf8");

  // 4–8. Digest B = H(password, salt, password).
  const B = sha512(pw, sl, pw);

  // 1–3, 9–12. Digest A = H(password, salt, B[0..len(pw)], then one bit of
  // len(pw) at a time: B where the bit is set, password where it is clear).
  const aParts: Buffer[] = [pw, sl, fill(B, pw.length)];
  for (let i = pw.length; i > 0; i >>= 1) aParts.push(i & 1 ? B : pw);
  const A = sha512(...aParts);

  // 13–16. DP = H(password × len(pw)); P = DP filled to len(pw).
  const DP = sha512(...Array.from({ length: pw.length }, () => pw));
  const P = fill(DP, pw.length);

  // 17–20. DS = H(salt × (16 + A[0])); S = DS filled to len(salt).
  const DS = sha512(...Array.from({ length: 16 + A[0] }, () => sl));
  const S = fill(DS, sl.length);

  // 21. The rounds loop.
  let C = A;
  for (let i = 0; i < rounds; i++) {
    const parts: Buffer[] = [];
    parts.push(i & 1 ? P : C);
    if (i % 3 !== 0) parts.push(S);
    if (i % 7 !== 0) parts.push(P);
    parts.push(i & 1 ? C : P);
    C = sha512(...parts);
  }

  // 22. Encode with the spec's byte permutation.
  const order: Array<[number, number, number, number]> = [
    [0, 21, 42, 4], [22, 43, 1, 4], [44, 2, 23, 4], [3, 24, 45, 4], [25, 46, 4, 4],
    [47, 5, 26, 4], [6, 27, 48, 4], [28, 49, 7, 4], [50, 8, 29, 4], [9, 30, 51, 4],
    [31, 52, 10, 4], [53, 11, 32, 4], [12, 33, 54, 4], [34, 55, 13, 4], [56, 14, 35, 4],
    [15, 36, 57, 4], [37, 58, 16, 4], [59, 17, 38, 4], [18, 39, 60, 4], [40, 61, 19, 4],
    [62, 20, 41, 4],
  ];
  let enc = "";
  for (const [x, y, z, n] of order) enc += b64From24(C[x], C[y], C[z], n);
  enc += b64From24(0, 0, C[63], 2);

  const roundsField = rounds === ROUNDS_DEFAULT ? "" : `rounds=${rounds}$`;
  return `$6$${roundsField}${salt}$${enc}`;
}
