/**
 * WARP-1054 — `safeNext`, extracted from the login page so the login and
 * passkey-approval surfaces share ONE hardened resolver. These cases mirror the
 * open-redirect vectors documented in the function's comment block (and asserted
 * end-to-end in login.aurora.test.tsx); this is the direct unit contract.
 */
import { describe, it, expect } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("falls back to '/' for null/empty", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it.each([
    ["/", "/"],
    ["/files", "/files"],
    ["/setup?from=x", "/setup?from=x"],
    ["/chat?c=1#top", "/chat?c=1#top"],
  ])("passes a legit same-origin path through unchanged (%s)", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });

  it.each([
    ["absolute off-origin", "https://evil.example.com"],
    ["protocol-relative authority", "//evil.example.com"],
    ["backslash authority (normalizes to //)", "/\\evil.com"],
    ["tab-prefixed authority", "/\t/evil.com"],
    ["newline-prefixed authority", "/\n//evil.com"],
    ["dotdot to //authority", "/..//evil.com"],
    ["nested dotdot to //authority", "/x/..//evil.com"],
    ["dot-then-//authority", "/.//evil.com"],
    ["dotdot+backslash authority", "/../\\evil.com"],
    ["scheme-relative", "https:evil.com"],
  ])("blocks an off-origin / authority-leading redirect (%s) → '/'", (_label, input) => {
    const out = safeNext(input);
    expect(out).toBe("/");
  });

  it("never returns a value that resolves off a sentinel origin", () => {
    const vectors = [
      "//evil.com",
      "/\\evil.com",
      "/..//evil.com",
      "/x/..//evil.com",
      "/.//evil.com",
      "https://evil.com",
    ];
    for (const v of vectors) {
      const out = safeNext(v);
      expect(new URL(out, "http://x.invalid").origin).toBe("http://x.invalid");
    }
  });
});
