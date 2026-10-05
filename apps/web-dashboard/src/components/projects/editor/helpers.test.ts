import { describe, it, expect } from "vitest";
import {
  MAX_MENTION_ROWS,
  hasAllowedLinkScheme,
  isBlankHtml,
  matchMentionCandidates,
  parseLinkInput,
  type MentionCandidate,
} from "./helpers";

const PEOPLE: MentionCandidate[] = [
  { id: "u1", name: "Joanna Lee" },
  { id: "u2", name: "Ana Costa" },
  { id: "u3", name: "Dana Fox" },
  { id: "u4", name: "Bob Ray" },
  { id: "u5", name: "Anders Berg" },
];

describe("matchMentionCandidates", () => {
  it("matches case-insensitively and ranks names that start with the query first", () => {
    expect(matchMentionCandidates(PEOPLE, "an").map((p) => p.id)).toEqual(["u2", "u5", "u1", "u3"]);
    expect(matchMentionCandidates(PEOPLE, "AN").map((p) => p.id)).toEqual(["u2", "u5", "u1", "u3"]);
  });

  it("keeps the caller's order inside each rank", () => {
    expect(matchMentionCandidates(PEOPLE, "a").map((p) => p.id)).toEqual(["u2", "u5", "u1", "u3", "u4"]);
  });

  it("returns the first people, in order, for an empty query", () => {
    expect(matchMentionCandidates(PEOPLE, "").map((p) => p.id)).toEqual(["u1", "u2", "u3", "u4", "u5"]);
  });

  it("caps the list at eight rows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `Alex ${i}` }));
    expect(MAX_MENTION_ROWS).toBe(8);
    expect(matchMentionCandidates(many, "al")).toHaveLength(8);
    expect(matchMentionCandidates(many, "")).toHaveLength(8);
  });

  it("ignores accents so a plain keyboard still finds the name", () => {
    const people = [{ id: "z", name: "Zoë Álvarez" }];
    expect(matchMentionCandidates(people, "zoe")).toHaveLength(1);
    expect(matchMentionCandidates(people, "alv")).toHaveLength(1);
  });

  it("returns nothing when no name matches", () => {
    expect(matchMentionCandidates(PEOPLE, "zzz")).toEqual([]);
    expect(matchMentionCandidates([], "an")).toEqual([]);
  });
});

describe("parseLinkInput", () => {
  it.each(["https://example.com", "http://example.com/a?b=1#c", "HTTPS://EXAMPLE.COM", "mailto:team@example.com"])(
    "accepts %s",
    (input) => {
      expect(parseLinkInput(input)).toBe(input);
    },
  );

  it("trims the surrounding whitespace", () => {
    expect(parseLinkInput("  https://example.com \n")).toBe("https://example.com");
  });

  it.each([
    "",
    "   ",
    "example.com",
    "www.example.com",
    "//example.com",
    "javascript:x(1)",
    "JaVaScRiPt:x(1)",
    "java\tscript:x(1)",
    "data:text/html,<b>x</b>",
    "ftp://example.com",
    "tel:+15555550100",
    "https://",
    "mailto:",
    "https://exa mple.com",
  ])("rejects %j", (input) => {
    expect(parseLinkInput(input)).toBeNull();
  });
});

describe("hasAllowedLinkScheme", () => {
  it.each(["https://a.test", "http://a.test", "mailto:a@b.test", "MAILTO:a@b.test", "a.test/path", "a@b.test", "", undefined, null])(
    "allows %j",
    (url) => {
      expect(hasAllowedLinkScheme(url)).toBe(true);
    },
  );

  it.each([
    "javascript:x(1)",
    " javascript:x(1)",
    "java\nscript:x(1)",
    "java\u200bscript:x(1)",
    "data:text/html;base64,AAAA",
    "vbscript:msgbox(1)",
    "ftp://a.test",
    "tel:+15555550100",
    "file:///etc/passwd",
  ])("blocks %j", (url) => {
    expect(hasAllowedLinkScheme(url)).toBe(false);
  });
});

describe("isBlankHtml", () => {
  it.each([undefined, "", "<p></p>", "<p><br></p>", "<p>&nbsp;</p>", "<p>  </p><ul><li><p></p></li></ul>"])("treats %j as blank", (html) => {
    expect(isBlankHtml(html)).toBe(true);
  });

  it.each(["<p>x</p>", '<p><span data-mention-id="u1">@Ana</span></p>'])("treats %j as content", (html) => {
    expect(isBlankHtml(html)).toBe(false);
  });

  it("strips an unterminated tag without discarding visible or escaped angle text", () => {
    expect(isBlankHtml("<script")).toBe(true);
    expect(isBlankHtml("Visible <script")).toBe(false);
    expect(isBlankHtml("&lt;script")).toBe(false);
  });
});
