/**
 * WARP-2887 — the `$6$` hash the host's `chpasswd -e` will accept.
 *
 * Every vector below was produced by an implementation that is not this
 * file: `openssl passwd -6 -salt <salt> <pw>` (OpenSSL 3.5.5) for the
 * default-rounds form, and glibc `crypt(3)` via Python on Ubuntu (WSL) for
 * the `rounds=` form — the latter is the exact code path the appliance's
 * PAM runs at login. A hash that only agrees with itself proves nothing.
 */
import { describe, it, expect } from "vitest";
import {
  generateSalt,
  sha512Crypt,
  SHA512_CRYPT_HASH_RE,
  SHA512_CRYPT_ROUNDS,
  SHA512_CRYPT_SALT_RE,
} from "../lib/sha512-crypt.js";

describe("sha512Crypt — default 5000 rounds (openssl passwd -6 vectors)", () => {
  it.each([
    // The specification's own example.
    ["Hello world!", "saltstring",
      "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"],
    // A full 16-char salt and a password longer than one digest block's fill.
    ["correct horse battery staple", "abcdefghijklmnop",
      "$6$abcdefghijklmnop$UY4jc6.rVibJ9tqDqiG0GMdZRHkv1j4sPRRH2eUSo3Kszltzbk30CmYcWPNRTD/KsYFHF7WTtNkAxF3dZ3zPE."],
    // The shortest interesting inputs: exercises the fill/bit loop edges.
    ["p", "xy",
      "$6$xy$R/pgTwXbhtQ2YChlkj/zYiHD4z5beHLK6CcMDMkdhzts99oAH2mJpBRuIo/BGoOpi2vw7bN4P.Gn04O3PZSyD."],
  ])("matches openssl for %j / salt %j", (password, salt, expected) => {
    expect(sha512Crypt(password, salt, 5000)).toBe(expected);
  });
});

describe("sha512Crypt — pinned rounds (glibc crypt(3) vectors)", () => {
  it.each([
    ["Hello world!", "saltstring", 100_000,
      "$6$rounds=100000$saltstring$9s1nPRwOKo4FeNBCK5BUtBm4SG17hIi1AdBjtdwEAoIS.4ckJW8FPR8goM6zZZeHEFTq2BK/BQz3f/G/Yjbkg/"],
    ["correct horse battery staple", "abcdefghijklmnop", 100_000,
      "$6$rounds=100000$abcdefghijklmnop$237b4Fqq64YNpA09/be0YRDDrONH67p8fe4qSYY8UxMhW7je1jh8c21qMmT2IaXGvbGXIRQabfQKyXUpkYkpg."],
    // The specification's rounds example (its 20-char salt is truncated to
    // 16 by the format; we pass the truncated salt and get the same hash).
    ["Hello world!", "saltstringsaltst", 10_000,
      "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v."],
  ])("matches glibc for %j / salt %j / rounds %d", (password, salt, rounds, expected) => {
    expect(sha512Crypt(password, salt, rounds)).toBe(expected);
  });

  it("mints at the pinned round count by default and in exactly the applier's grammar", () => {
    expect(SHA512_CRYPT_ROUNDS).toBe(100_000);
    const hash = sha512Crypt("any password at all");
    expect(hash).toMatch(SHA512_CRYPT_HASH_RE);
    expect(hash.startsWith("$6$rounds=100000$")).toBe(true);
  });

  it("the applier grammar refuses the weaker default-rounds form", () => {
    expect(sha512Crypt("x", "saltstring", 5000)).not.toMatch(SHA512_CRYPT_HASH_RE);
  });
});

describe("sha512Crypt — inputs", () => {
  it("salts every hash differently by default", () => {
    const a = sha512Crypt("same");
    const b = sha512Crypt("same");
    expect(a).not.toBe(b);
    expect(a.split("$")[3]).toMatch(SHA512_CRYPT_SALT_RE);
    expect(a.split("$")[3]).toHaveLength(16);
  });

  it("refuses a salt outside the shadow alphabet", () => {
    // A `$` or newline in the salt would break the `$6$rounds=N$salt$hash`
    // framing the applier parses with an anchored regex.
    expect(() => sha512Crypt("x", "bad$salt")).toThrow(/salt/);
    expect(() => sha512Crypt("x", "toolongsaltvalue1")).toThrow(/salt/);
    expect(() => sha512Crypt("x", "")).toThrow(/salt/);
  });

  it("refuses an out-of-range round count", () => {
    expect(() => sha512Crypt("x", "saltstring", 999)).toThrow(/rounds/);
    expect(() => sha512Crypt("x", "saltstring", 1.5)).toThrow(/rounds/);
  });

  it("generateSalt stays inside the alphabet", () => {
    for (let i = 0; i < 50; i++) expect(generateSalt()).toMatch(/^[./0-9A-Za-z]{16}$/);
  });
});
