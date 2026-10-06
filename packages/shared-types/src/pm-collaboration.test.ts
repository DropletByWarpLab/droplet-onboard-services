/**
 * WARP-3519 (WS-2) — the vocabulary the orchestrator's write boundary and the
 * dashboard share for comment reactions and @mentions.
 *
 * The emoji allowlist is the one the spec names, byte for byte. The test pins
 * CODE POINTS, not glyphs: the heart is U+2764 U+FE0F (text heart + emoji
 * presentation selector), and a copy-paste that drops the selector produces a
 * different string that renders the same — exactly the drift a literal-vs-
 * literal comparison would never notice.
 */

import { describe, it, expect } from "vitest";
import {
  PM_ACTIVITY_VERBS,
  PM_REACTION_EMOJI,
  PM_MENTION_ATTR,
  PM_TIMELINE_MIRRORED_VERBS,
  isPmMentionId,
  normalizePmReactionEmoji,
} from "./pm-collaboration";

const codePoints = (s: string): string =>
  [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase()).join(" ");

describe("PM_REACTION_EMOJI", () => {
  it("is exactly the eight reactions the spec names, in display order", () => {
    expect(PM_REACTION_EMOJI.map(codePoints)).toEqual([
      "1F44D", // 👍
      "1F44E", // 👎
      "1F604", // 😄
      "1F389", // 🎉
      "1F615", // 😕
      "2764 FE0F", // ❤️
      "1F680", // 🚀
      "1F440", // 👀
    ]);
  });

  it("has no duplicates", () => {
    expect(new Set(PM_REACTION_EMOJI).size).toBe(PM_REACTION_EMOJI.length);
  });
});

describe("normalizePmReactionEmoji", () => {
  it.each(PM_REACTION_EMOJI.map((e) => [e]))("accepts %s unchanged", (emoji) => {
    expect(normalizePmReactionEmoji(emoji)).toBe(emoji);
  });

  it("maps the heart WITHOUT its variation selector onto the canonical heart", () => {
    // Several keyboards and OS pickers emit U+2764 alone.
    expect(normalizePmReactionEmoji("❤")).toBe("❤️");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePmReactionEmoji("  🚀 ")).toBe("🚀");
  });

  it.each([
    ["an emoji outside the allowlist", "💩"],
    ["a skin-tone variant — the list is closed, not a family", "👍🏽"],
    ["two allowed emoji glued together", "👍👍"],
    ["plain text", "thumbs up"],
    ["an HTML payload", "<img src=x onerror=alert(1)>"],
    ["the empty string", ""],
    ["whitespace only", "   "],
  ])("refuses %s", (_label, raw) => {
    expect(normalizePmReactionEmoji(raw)).toBeNull();
  });

  it("refuses non-string input rather than coercing it", () => {
    expect(normalizePmReactionEmoji(undefined as unknown as string)).toBeNull();
    expect(normalizePmReactionEmoji(5 as unknown as string)).toBeNull();
    expect(normalizePmReactionEmoji(null as unknown as string)).toBeNull();
  });
});

describe("mention vocabulary", () => {
  it("names the one attribute the sanitizer allows on a span", () => {
    expect(PM_MENTION_ATTR).toBe("data-mention-id");
  });

  it.each([
    ["a v4 uuid", "0d9c5c1e-2f4a-4b6d-8e10-3a5c7e9b1d2f"],
    ["a short id", "u-bob"],
    ["underscores", "user_1"],
  ])("accepts %s as a mention id", (_l, id) => {
    expect(isPmMentionId(id)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["a quote — would break the attribute", 'a"b'],
    ["an angle bracket", "a<b"],
    ["a space", "a b"],
    ["a colon (the MCP principal shape)", "_service:mcp"],
    ["65 characters", "a".repeat(65)],
  ])("refuses %s", (_l, id) => {
    expect(isPmMentionId(id)).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isPmMentionId(undefined)).toBe(false);
    expect(isPmMentionId(42)).toBe(false);
  });
});

describe("activity verb vocabulary", () => {
  it("has no duplicates and names every verb exactly once", () => {
    expect(new Set(PM_ACTIVITY_VERBS).size).toBe(PM_ACTIVITY_VERBS.length);
  });

  it("includes the WS-2 verbs the collaboration surface writes", () => {
    for (const verb of ["comment_edited", "comment_deleted", "watcher_added", "watcher_removed", "mentioned"]) {
      expect(PM_ACTIVITY_VERBS).toContain(verb);
    }
  });

  it("the timeline leaves out only verbs the comment entry itself already says", () => {
    expect([...PM_TIMELINE_MIRRORED_VERBS].sort()).toEqual(["commented", "mentioned"]);
    for (const v of PM_TIMELINE_MIRRORED_VERBS) expect(PM_ACTIVITY_VERBS).toContain(v);
  });
});
