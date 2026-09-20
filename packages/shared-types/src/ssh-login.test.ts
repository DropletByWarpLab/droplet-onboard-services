/**
 * WARP-2887 — the one ruleset the dashboard, the orchestrator route/service
 * and (as a sed grammar) the host applier all agree on.
 */
import { describe, it, expect } from "vitest";
import {
  SSH_LOGIN_PASSWORD_MAX,
  SSH_LOGIN_PASSWORD_MIN,
  SSH_LOGIN_RESERVED,
  SSH_LOGIN_USERNAME_RE,
  isValidSshLoginPassword,
  isValidSshLoginUsername,
} from "./ssh-login";

describe("isValidSshLoginUsername", () => {
  it.each(["support", "ops", "sup-port", "sup_port", "a12", "a".repeat(32)])("accepts %j", (u) => {
    expect(isValidSshLoginUsername(u)).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(33)],
    ["uppercase", "Support"],
    ["leading digit", "1support"],
    ["leading dash", "-support"],
    ["a space", "sup port"],
    ["a shell metacharacter", "sup;port"],
    ["a dot", "sup.port"],
    ["empty", ""],
  ])("rejects %s", (_label, u) => {
    expect(isValidSshLoginUsername(u)).toBe(false);
  });

  it("rejects every reserved system account even though it matches the grammar", () => {
    for (const name of SSH_LOGIN_RESERVED) {
      expect(SSH_LOGIN_USERNAME_RE.test(name)).toBe(true);
      expect(isValidSshLoginUsername(name)).toBe(false);
    }
    expect(SSH_LOGIN_RESERVED.has("root")).toBe(true);
    expect(SSH_LOGIN_RESERVED.has("droplet")).toBe(true);
  });
});

describe("isValidSshLoginPassword", () => {
  it("accepts the bounds inclusively and anything printable in between", () => {
    expect(isValidSshLoginPassword("x".repeat(SSH_LOGIN_PASSWORD_MIN))).toBe(true);
    expect(isValidSshLoginPassword("x".repeat(SSH_LOGIN_PASSWORD_MAX))).toBe(true);
    expect(isValidSshLoginPassword("correct horse battery staple ✓ $6$")).toBe(true);
  });

  it.each([
    ["one under the minimum", "x".repeat(SSH_LOGIN_PASSWORD_MIN - 1)],
    ["one over the maximum", "x".repeat(SSH_LOGIN_PASSWORD_MAX + 1)],
    ["a newline", "correct horse\nbattery staple"],
    ["a carriage return", "correct horse\rbattery staple"],
  ])("rejects %s", (_label, p) => {
    expect(isValidSshLoginPassword(p)).toBe(false);
  });
});
