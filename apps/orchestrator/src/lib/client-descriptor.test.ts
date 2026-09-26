/**
 * WARP-2804 — `describeClient`: what the acking client SAID it was.
 *
 * Reported, never proof: the value is stored on the ack (`ackClient`) and on
 * WARP-2978's incident ack, labelled as what the device said. So the contract
 * is about keeping it HONEST and SAFE to display, not about believing it:
 * a well-formed `X-Droplet-Client` wins, anything else falls back to a coarse
 * User-Agent label, and nothing usable is NULL.
 */
import { describe, expect, it } from "vitest";
import { describeClient, clampClientDescriptor, CLIENT_DESCRIPTOR_MAX } from "./client-descriptor.js";

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.79";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.81 Mobile Safari/537.36";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1";
const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0";

describe("describeClient — X-Droplet-Client wins when it is well-formed", () => {
  it.each([
    ["droplet-ios/1.4.0 (iOS 18.2)"],
    ["droplet-ios/1.4.0"],
    ["droplet-windows/0.2.2 (Windows 11)"],
    ["droplet-android/0.3.1+42 (Android 14)"],
  ])("%s", (header) => {
    expect(describeClient(SAFARI_IPHONE, header)).toBe(header);
  });

  it("wins over any User-Agent, and without one", () => {
    expect(describeClient(EDGE_WINDOWS, "droplet-ios/1.4.0 (iOS 18.2)")).toBe("droplet-ios/1.4.0 (iOS 18.2)");
    expect(describeClient(undefined, "droplet-ios/1.4.0")).toBe("droplet-ios/1.4.0");
  });
});

describe("describeClient — a bad header falls back to the User-Agent", () => {
  it.each([
    ["an upper-case product", "Droplet-iOS/1.4.0"],
    ["no version", "droplet-ios"],
    ["an empty version", "droplet-ios/"],
    ["a product over 32 chars", `${"a".repeat(33)}/1.0`],
    ["a version over 24 chars", `droplet-ios/${"1".repeat(25)}`],
    ["a comment over 48 chars", `droplet-ios/1.0 (${"x".repeat(49)})`],
    ["nested parentheses", "droplet-ios/1.0 (iOS (18))"],
    ["an empty comment", "droplet-ios/1.0 ()"],
    ["two spaces", "droplet-ios/1.0  (iOS 18)"],
    ["trailing text", "droplet-ios/1.0 (iOS 18) extra"],
    ["a CR/LF inside the comment", "droplet-ios/1.0 (iOS\r\n18)"],
    ["HTML", "<script>/1.0"],
    ["empty", ""],
  ])("%s", (_label, header) => {
    expect(describeClient(EDGE_WINDOWS, header)).toBe("Edge on Windows");
  });
});

describe("describeClient — the coarse User-Agent label", () => {
  it.each([
    [SAFARI_IPHONE, "Safari on iPhone"],
    [EDGE_WINDOWS, "Edge on Windows"],
    [CHROME_ANDROID, "Chrome on Android"],
    [CHROME_IOS, "Chrome on iPhone"],
    [FIREFOX_MAC, "Firefox on Mac"],
    [SAFARI_MAC, "Safari on Mac"],
    [CHROME_LINUX, "Chrome on Linux"],
    [SAFARI_IPAD, "Safari on iPad"],
    [FIREFOX_ANDROID, "Firefox on Android"],
  ])("%s → %s", (ua, label) => {
    expect(describeClient(ua)).toBe(label);
  });

  it("never echoes the raw User-Agent: only the fixed vocabulary", () => {
    const hostile = "Mozilla/5.0 (Windows NT 10.0) Chrome/1 Safari/1 Edg/1 <img src=x onerror=alert(1)>";
    expect(describeClient(hostile)).toBe("Edge on Windows");
  });
});

describe("describeClient — unknown is NULL", () => {
  it.each([
    ["no header, no User-Agent", undefined, undefined],
    ["curl", "curl/8.4.0", undefined],
    ["okhttp", "okhttp/4.12.0", undefined],
    ["a bare CFNetwork app", "Droplet/1 CFNetwork/1498.700.2 Darwin/24.2.0", undefined],
    ["empty strings", "", ""],
    ["whitespace", "   ", "  "],
  ])("%s", (_label, ua, header) => {
    expect(describeClient(ua, header)).toBeNull();
  });
});

describe("describeClient — safe to display", () => {
  it("bidi and control characters are stripped from an accepted header", () => {
    // U+202E (RLO) inside the comment would reorder everything after it on
    // the line in whatever renders the ack; U+0007 is a control character.
    const out = describeClient(undefined, "droplet-ios/1.4.0 (iOS\u202E 18.2\u0007)");
    expect(out).toBe("droplet-ios/1.4.0 (iOS 18.2)");
    expect(out).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u0000-\u001F]/);
  });

  it("a header that is nothing but unsafe characters inside its comment falls back", () => {
    expect(describeClient(EDGE_WINDOWS, "droplet-ios/1.4.0 (\u202E\u2066)")).toBe("Edge on Windows");
  });

  it(`never longer than ${CLIENT_DESCRIPTOR_MAX} characters (the column is VARCHAR(120))`, () => {
    expect(CLIENT_DESCRIPTOR_MAX).toBe(120);
    // The longest header the grammar admits, 48 astral characters in the
    // comment: it fits, whole — the grammar counts characters, not UTF-16 units.
    const longest = `${"a".repeat(32)}/${"1".repeat(24)} (${"\u{1F600}".repeat(48)})`;
    expect(describeClient(undefined, longest)).toBe(longest);
  });

  it("the clamp cuts at 120 code points, never inside a surrogate pair, after stripping", () => {
    const out = clampClientDescriptor("\u202E" + "\u{1F600}".repeat(200));
    expect([...out].length).toBe(CLIENT_DESCRIPTOR_MAX);
    expect(out.startsWith("\u{1F600}")).toBe(true);
    expect((out as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(clampClientDescriptor("a".repeat(121))).toBe("a".repeat(120));
  });

  it("a non-string header or User-Agent (a repeated header) is ignored, not thrown on", () => {
    expect(describeClient(["a", "b"] as unknown as string, ["droplet-ios/1.0"] as unknown as string)).toBeNull();
  });
});
