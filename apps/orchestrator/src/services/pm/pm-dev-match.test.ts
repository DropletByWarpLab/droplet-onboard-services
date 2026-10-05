import { describe, it, expect } from "vitest";
import { matchedSequences, developmentBranchName } from "./pm-dev-match.js";

describe("development key matching", () => {
  it("matches branch names, titles and body references case-insensitively and deduplicates", () => {
    expect(matchedSequences("ABC", ["feature/abc-123-login", "Fix ABC-123; related ABC-124.", "ABC-124\nABC-125"])).toEqual([123, 124, 125]);
  });

  it("matches the complete sequence instead of treating ABC-1234 as item 123", () => {
    expect(matchedSequences("ABC", ["ABC-1234"])).toEqual([1234]);
  });

  it.each(["XABC-123", "_ABC-123", "ABC-123suffix", "ABC-123_suffix", "ABC-0123", "ABC-0", "ABC-9007199254740992", "AB-123"])("refuses a noncanonical or embedded key: %s", (text) => {
    expect(matchedSequences("ABC", [text])).toEqual([]);
  });

  it("escapes identifiers and accepts punctuation and Unicode around an exact ASCII key", () => {
    expect(matchedSequences("A+B", ["AAB-1 A+B-2"])).toEqual([2]);
    expect(matchedSequences("ABC", ["(ABC-2), 中文 ABC-1;"])).toEqual([1, 2]);
  });

  it("produces a bounded shell-safe copyable branch name", () => {
    expect(developmentBranchName("ABC", 123, " Fix / login: now! ")).toBe("abc-123-fix-login-now");
    expect(developmentBranchName("ABC", 123, "中文")).toBe("abc-123");
    expect(developmentBranchName("ABC", 123, "a".repeat(1000))).toHaveLength(68);
  });
});
