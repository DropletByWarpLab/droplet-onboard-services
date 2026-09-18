/**
 * WARP-2887 — the `$6$` hash the host's `chpasswd -e` will accept.
 *
 * Every vector below was produced by `openssl passwd -6 -salt <salt> <pw>`
 * (OpenSSL 3.5.5), i.e. by an implementation that is not this file. A hash
 * that only agrees with itself proves nothing; one that agrees with the
 * shadow-format reference is the whole point.
 */
import { describe, it, expect } from "vitest";
import {
  generateSalt,
  sha512Crypt,
  SHA512_CRYPT_HASH_RE,
  SHA512_CRYPT_SALT_RE,
} from "../lib/sha512-crypt.js";

describe("sha512Crypt", () => {
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
  ])("matches openssl passwd -6 for %j / salt %j", (password, salt, expected) => {
    expect(sha512Crypt(password, salt)).toBe(expected);
  });

  it("emits exactly the grammar the host applier accepts", () => {
    const hash = sha512Crypt("any password at all");
    expect(hash).toMatch(SHA512_CRYPT_HASH_RE);
  });

  it("salts every hash differently by default", () => {
    const a = sha512Crypt("same");
    const b = sha512Crypt("same");
    expect(a).not.toBe(b);
    expect(a.split("$")[2]).toMatch(SHA512_CRYPT_SALT_RE);
    expect(a.split("$")[2]).toHaveLength(16);
  });

  it("refuses a salt outside the shadow alphabet", () => {
    // A `$` or newline in the salt would break the `$6$salt$hash` framing the
    // applier parses with an anchored regex.
    expect(() => sha512Crypt("x", "bad$salt")).toThrow(/salt/);
    expect(() => sha512Crypt("x", "toolongsaltvalue1")).toThrow(/salt/);
    expect(() => sha512Crypt("x", "")).toThrow(/salt/);
  });

  it("generateSalt stays inside the alphabet", () => {
    for (let i = 0; i < 50; i++) expect(generateSalt()).toMatch(/^[./0-9A-Za-z]{16}$/);
  });
});
