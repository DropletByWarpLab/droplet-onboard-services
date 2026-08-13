/**
 * Platform detection for /downloads.
 *
 * Every user-agent below is a REAL string, not a hand-simplified one —
 * the whole reason this module exists is that UA strings are full of
 * compatibility lies, and a test against tidy fixtures would prove
 * nothing about the two traps that actually bite:
 *
 *   - iPadOS 13+ reports a desktop Mac UA with no iPad token.
 *   - every Android UA also contains "Linux".
 */
import { describe, it, expect } from "vitest";
import { platformFromSignals } from "./detect-platform";

const UA = {
  windows11Chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ default ("Request Desktop Website" is ON by default):
  // indistinguishable from a Mac by UA alone.
  ipadDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  ipadLegacy:
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  androidPixel:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  ubuntuFirefox:
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("platformFromSignals — desktop", () => {
  it.each([
    ["Windows 11 Chrome", UA.windows11Chrome],
    ["Windows Edge", UA.windowsEdge],
  ])("detects Windows from %s", (_label, userAgent) => {
    expect(platformFromSignals({ userAgent })).toBe("windows");
  });

  it.each([
    ["Safari", UA.macSafari],
    ["Chrome", UA.macChrome],
  ])("detects macOS from Mac %s with no touch digitiser", (_l, userAgent) => {
    expect(platformFromSignals({ userAgent, maxTouchPoints: 0 })).toBe("macos");
  });

  it.each([
    ["Ubuntu Firefox", UA.ubuntuFirefox],
    ["Linux Chrome", UA.linuxChrome],
  ])("detects Linux from %s", (_label, userAgent) => {
    expect(platformFromSignals({ userAgent })).toBe("linux");
  });
});

describe("platformFromSignals — mobile", () => {
  it("detects iOS from an iPhone", () => {
    expect(platformFromSignals({ userAgent: UA.iphone })).toBe("ios");
  });

  it("detects iOS from a legacy iPad that still says iPad", () => {
    expect(platformFromSignals({ userAgent: UA.ipadLegacy })).toBe("ios");
  });

  it.each([
    ["Pixel", UA.androidPixel],
    ["Samsung", UA.androidSamsung],
  ])("detects Android from %s — NOT Linux", (_label, userAgent) => {
    // The ordering trap: every Android UA also contains "Linux". If the
    // Linux branch ran first, every Android phone would be offered a
    // desktop Linux build.
    expect(platformFromSignals({ userAgent })).toBe("android");
  });
});

describe("platformFromSignals — the iPadOS masquerade", () => {
  it("calls a touch-capable 'Mac' an iPad, not a Mac", () => {
    // Byte-identical UA to a real MacBook; only maxTouchPoints separates
    // them. Getting this wrong hands an iPad user a macOS installer.
    expect(
      platformFromSignals({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 }),
    ).toBe("ios");
  });

  it("still calls a real Mac a Mac", () => {
    expect(
      platformFromSignals({ userAgent: UA.macSafari, maxTouchPoints: 0 }),
    ).toBe("macos");
  });

  it("treats a single touch point as a Mac (trackpad, not a digitiser)", () => {
    expect(
      platformFromSignals({ userAgent: UA.macSafari, maxTouchPoints: 1 }),
    ).toBe("macos");
  });

  it("applies the same rule to the userAgentData hint", () => {
    expect(
      platformFromSignals({
        userAgent: UA.ipadDesktopMode,
        uaDataPlatform: "macOS",
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
  });
});

describe("platformFromSignals — the structured hint wins", () => {
  it("prefers userAgentData over the UA string", () => {
    expect(
      platformFromSignals({
        userAgent: UA.macSafari,
        uaDataPlatform: "Windows",
      }),
    ).toBe("windows");
  });

  it("falls back to the UA string when the hint is empty", () => {
    expect(
      platformFromSignals({ userAgent: UA.windows11Chrome, uaDataPlatform: "" }),
    ).toBe("windows");
  });
});

describe("platformFromSignals — unknown is a real answer", () => {
  it.each([
    ["an empty UA", ""],
    ["a bot", "curl/8.4.0"],
    ["a console", "Mozilla/5.0 (PlayStation; PlayStation 5/2.26)"],
  ])("returns null for %s rather than guessing", (_label, userAgent) => {
    // Null makes the page render every platform with no highlight, which
    // is better than confidently offering the wrong installer.
    expect(platformFromSignals({ userAgent })).toBeNull();
  });
});
