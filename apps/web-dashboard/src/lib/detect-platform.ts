/**
 * Which client app is THIS browser's app.
 *
 * Pure so it can be tested against real user-agent strings without a DOM
 * — the page calls `detectPlatform()`, which reads `navigator` once and
 * delegates here. Detection is a DEFAULT, never a lock: the page always
 * renders every platform, so a wrong guess costs one click rather than
 * stranding someone on the wrong installer.
 *
 * Two traps this deliberately handles:
 *
 *   1. iPadOS 13+ lies. Safari on iPad reports a desktop Mac UA
 *      ("Macintosh; Intel Mac OS X") with no "iPad" token at all, so UA
 *      sniffing alone hands an iPad user a macOS build. The tell is
 *      touch: a real Mac reports `maxTouchPoints <= 1`, an iPad reports
 *      5. That check is the only reliable separator available client-side.
 *
 *   2. Android contains "Linux". Every Android UA carries "Linux" too,
 *      so Android MUST be tested before Linux or every phone reads as a
 *      desktop Linux box.
 */
import type { AppDownloadPlatform } from "./types";

/** What we read out of the environment. Passed explicitly so tests can
 *  supply a UA string without touching globals. */
export interface PlatformSignals {
  userAgent: string;
  /** `navigator.userAgentData.platform` when the browser supports it —
   *  a structured hint that beats parsing the UA string, when present. */
  uaDataPlatform?: string;
  /** `navigator.maxTouchPoints`. The iPadOS tell. */
  maxTouchPoints?: number;
}

/**
 * Best guess at the visitor's platform, or null when nothing matches.
 *
 * Null is a real answer (an unknown or spoofed UA) and the page renders
 * the full platform list without a highlighted recommendation rather
 * than guessing wrong.
 */
export function platformFromSignals(
  signals: PlatformSignals,
): AppDownloadPlatform | null {
  const ua = signals.userAgent ?? "";
  const uaLower = ua.toLowerCase();
  const hint = (signals.uaDataPlatform ?? "").toLowerCase();
  const touchPoints = signals.maxTouchPoints ?? 0;

  // The structured hint first — it is not spoof-proof, but it is not a
  // regex over a string designed for compatibility lies either.
  if (hint) {
    if (hint.includes("win")) return "windows";
    if (hint.includes("android")) return "android";
    // A macOS hint on a touch device is the iPadOS lie (see header).
    if (hint.includes("mac")) return touchPoints > 1 ? "ios" : "macos";
    if (hint.includes("ios") || hint.includes("iphone") || hint.includes("ipad"))
      return "ios";
    if (hint.includes("linux")) return "linux";
  }

  if (uaLower.includes("windows")) return "windows";

  // BEFORE the Linux check — every Android UA also says "Linux".
  if (uaLower.includes("android")) return "android";

  if (
    uaLower.includes("iphone") ||
    uaLower.includes("ipad") ||
    uaLower.includes("ipod")
  ) {
    return "ios";
  }

  if (uaLower.includes("mac os x") || uaLower.includes("macintosh")) {
    // iPadOS 13+ masquerading as a Mac. A desktop Mac has no touch
    // digitiser; an iPad reports 5 points.
    return touchPoints > 1 ? "ios" : "macos";
  }

  // Last, because "Linux" is the most-shared token in the UA string.
  if (uaLower.includes("linux") || uaLower.includes("x11")) return "linux";

  return null;
}

/**
 * Read the live browser environment. Returns null during SSR, where
 * `navigator` does not exist — the page must not assume a platform on
 * the server and then hydrate into a different one.
 */
export function detectPlatform(): AppDownloadPlatform | null {
  if (typeof navigator === "undefined") return null;
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  return platformFromSignals({
    userAgent: navigator.userAgent,
    uaDataPlatform: uaData?.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

/** Display names. Kept here so the page and its tests agree. */
export const PLATFORM_LABELS: Record<AppDownloadPlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iPhone & iPad",
};
