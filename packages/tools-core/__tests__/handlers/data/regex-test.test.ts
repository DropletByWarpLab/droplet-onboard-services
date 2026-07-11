/**
 * WARP-901 — `regex_test` (bounded regex test/extract). Tier-1 read, no
 * ToolContext dependencies.
 *
 * The critical case here is the pathological-pattern test: a classic
 * catastrophic-backtracking pattern (`^(a+)+$` against a run of "a"s plus a
 * trailing non-matching character) would hang a naive `RegExp.test()` call
 * for a very long time. The handler must return a bounded `REGEX_TIMEOUT`
 * error instead of hanging the test (or the agent loop).
 */
import { describe, it, expect } from "vitest";
import regexTest from "../../../src/handlers/data/regex-test.js";
import type { ToolContext } from "../../../src/types.js";

const ctx = {} as unknown as ToolContext;

describe("regex_test — basic test mode", () => {
  it("returns matched:true when the pattern matches", async () => {
    const res = await regexTest.handler({ pattern: "^foo", input: "foobar" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { matched: boolean }).matched).toBe(true);
  });

  it("returns matched:false when the pattern does not match", async () => {
    const res = await regexTest.handler({ pattern: "^foo", input: "barfoo" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { matched: boolean }).matched).toBe(false);
  });

  it("respects the i flag", async () => {
    const res = await regexTest.handler({ pattern: "^FOO", input: "foobar", flags: "i" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.data as { matched: boolean }).matched).toBe(true);
  });
});

describe("regex_test — extract mode", () => {
  it("extracts every match with the g flag, bounded by maxMatches", async () => {
    const res = await regexTest.handler(
      { pattern: "\\d+", input: "a1 b22 c333 d4444", flags: "g", mode: "extract", maxMatches: 2 },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { matched: boolean; matches: Array<{ match: string }> };
      expect(data.matched).toBe(true);
      expect(data.matches).toHaveLength(2);
      expect(data.matches.map((m) => m.match)).toEqual(["1", "22"]);
    }
  });

  it("extracts only the first match without the g flag", async () => {
    const res = await regexTest.handler(
      { pattern: "\\d+", input: "a1 b22 c333", mode: "extract" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { matches: Array<{ match: string; index: number }> };
      expect(data.matches).toHaveLength(1);
      expect(data.matches[0]).toMatchObject({ match: "1", index: 1 });
    }
  });

  it("returns an empty matches array (not an error) when nothing matches", async () => {
    const res = await regexTest.handler(
      { pattern: "\\d+", input: "no digits here", flags: "g", mode: "extract" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const data = res.data as { matched: boolean; matches: unknown[] };
      expect(data.matched).toBe(false);
      expect(data.matches).toEqual([]);
    }
  });
});

describe("regex_test — bounds enforcement", () => {
  it("rejects a pattern over the length cap", async () => {
    const res = await regexTest.handler({ pattern: "a".repeat(500), input: "x" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PATTERN_TOO_LONG");
  });

  it("rejects input over the length cap", async () => {
    const res = await regexTest.handler({ pattern: "a", input: "a".repeat(50_000) }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INPUT_TOO_LONG");
  });

  it("rejects a disallowed flag", async () => {
    const res = await regexTest.handler({ pattern: "a", input: "a", flags: "y" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_FLAGS");
  });

  it("rejects an invalid regex pattern (syntax error)", async () => {
    const res = await regexTest.handler({ pattern: "(unclosed", input: "x" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_PATTERN");
  });

  it("rejects a missing pattern", async () => {
    const res = await regexTest.handler({ input: "x" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_ARGS");
  });
});

describe("regex_test — pathological pattern is killed within the deadline, not hung", () => {
  it(
    "returns a bounded REGEX_TIMEOUT error for classic catastrophic backtracking",
    async () => {
      const start = Date.now();
      // Classic ReDoS: nested quantifier `(a+)+` forces exponential
      // backtracking when the string almost-but-doesn't match.
      const res = await regexTest.handler(
        { pattern: "^(a+)+$", input: "a".repeat(35) + "!" },
        ctx,
      );
      const elapsedMs = Date.now() - start;

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("REGEX_TIMEOUT");
      // Proves the worker was actually killed rather than left running:
      // the call resolves close to the tool's own EXEC_TIMEOUT_MS deadline,
      // not after however long unbounded catastrophic backtracking would
      // take (which is effectively forever for this input length).
      expect(elapsedMs).toBeLessThan(5000);
    },
    10_000,
  );
});

describe("regex_test — tool metadata", () => {
  it("is named regex_test and is Tier-1 (no write, no confirm)", () => {
    expect(regexTest.name).toBe("regex_test");
    expect(regexTest.requiresWrite).toBe(false);
    expect(regexTest.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false input schema", () => {
    expect((regexTest.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
