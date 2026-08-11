/**
 * WARP-1874 — the security half of the video-call link feature.
 *
 * A meeting link is authored by one household member and rendered as an
 * `href` to every other member of the thread. That makes the scheme check
 * the load-bearing part of this ticket, so it gets the most tests.
 */

import { describe, it, expect } from "vitest";
import { parseMeetingLink, isMeetingLink } from "./meeting-link";

describe("parseMeetingLink — scheme validation", () => {
  it("accepts an https URL", () => {
    const link = parseMeetingLink("https://zoom.us/j/1234567890");
    expect(link).not.toBeNull();
    expect(link?.url).toBe("https://zoom.us/j/1234567890");
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["mixed-case javascript:", "JavaScript:alert(1)"],
    ["javascript: with padding", "  javascript:alert(document.cookie)  "],
    // The WHATWG URL parser strips tab/CR/LF *inside* a scheme, so a
    // newline-obfuscated payload re-forms as `javascript:` — the check has
    // to run on the parsed protocol, never on the raw string.
    ["newline-split javascript:", "java\nscript:alert(1)"],
    ["tab-split javascript:", "java\tscript:alert(1)"],
    ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["file:", "file:///etc/passwd"],
    ["plain http", "http://zoom.us/j/123"],
    ["a provider app scheme", "zoommtg://zoom.us/join?confno=123"],
    ["blob:", "blob:https://evil.example/9b2c"],
    ["about:", "about:blank"],
  ])("rejects %s", (_label, hostile) => {
    expect(parseMeetingLink(hostile)).toBeNull();
    expect(isMeetingLink(hostile)).toBe(false);
  });

  it("rejects a scheme-relative URL (no base to resolve against)", () => {
    expect(parseMeetingLink("//evil.example/j/1")).toBeNull();
  });

  it("rejects free text that is not a URL at all", () => {
    expect(parseMeetingLink("Living Room")).toBeNull();
    expect(parseMeetingLink("the kitchen, 3pm")).toBeNull();
  });

  it("rejects empty, blank and non-string input", () => {
    expect(parseMeetingLink("")).toBeNull();
    expect(parseMeetingLink("   ")).toBeNull();
    expect(parseMeetingLink(null)).toBeNull();
    expect(parseMeetingLink(undefined)).toBeNull();
    expect(parseMeetingLink(42)).toBeNull();
    expect(parseMeetingLink({ url: "https://zoom.us/j/1" })).toBeNull();
  });

  it("rejects an https URL with no host", () => {
    expect(parseMeetingLink("https://")).toBeNull();
  });

  it("rejects a URL longer than the 2048-char cap", () => {
    const long = `https://zoom.us/j/${"1".repeat(2100)}`;
    expect(parseMeetingLink(long)).toBeNull();
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseMeetingLink("  https://zoom.us/j/42  ")?.url).toBe(
      "https://zoom.us/j/42",
    );
  });

  it("returns the normalized href, so what was validated is what renders", () => {
    // Stored + rendered value is the parser's own output — no second,
    // differently-parsed string can sneak between validation and the href.
    expect(parseMeetingLink("https://meet.google.com")?.url).toBe(
      "https://meet.google.com/",
    );
  });
});

describe("parseMeetingLink — provider labels", () => {
  it.each([
    ["https://zoom.us/j/1234567890", "zoom", "Join Zoom"],
    ["https://warplab.zoom.us/j/98765?pwd=abc", "zoom", "Join Zoom"],
    ["https://zoomgov.com/j/1", "zoom", "Join Zoom"],
    [
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
      "teams",
      "Join Microsoft Teams",
    ],
    ["https://teams.live.com/meet/93", "teams", "Join Microsoft Teams"],
    ["https://meet.google.com/abc-defg-hij", "meet", "Join Google Meet"],
    ["https://warplab.webex.com/meet/stefan", "webex", "Join Webex"],
  ])("labels %s as %s", (url, provider, label) => {
    const link = parseMeetingLink(url);
    expect(link?.provider).toBe(provider);
    expect(link?.label).toBe(label);
  });

  it("accepts an unrecognized https URL with a generic label", () => {
    // An allowlist that silently drops a valid link is a worse bug than
    // the one this ticket fixes.
    const link = parseMeetingLink("https://vc.warp-lab.ai/room/kitchen");
    expect(link).not.toBeNull();
    expect(link?.provider).toBe("other");
    expect(link?.label).toBe("Join video call");
  });

  it.each([
    "https://zoom.us.evil.example/j/1",
    "https://teams.microsoft.com.evil.example/j/1",
    "https://notzoom.us/j/1",
    "https://evil.example/?next=https://zoom.us/j/1",
    "https://evil.example/zoom.us/j/1",
  ])("does not label a look-alike host as a known provider: %s", (url) => {
    // Suffix matching must respect the dot boundary — a wrong provider
    // badge is a phishing assist, not a cosmetic bug.
    const link = parseMeetingLink(url);
    expect(link).not.toBeNull();
    expect(link?.provider).toBe("other");
  });

  it("matches the provider host case-insensitively", () => {
    expect(parseMeetingLink("https://ZOOM.US/j/1")?.provider).toBe("zoom");
  });
});

describe("isMeetingLink", () => {
  it("is a boolean shorthand for the same rule", () => {
    expect(isMeetingLink("https://zoom.us/j/1")).toBe(true);
    expect(isMeetingLink("Living Room")).toBe(false);
  });
});
