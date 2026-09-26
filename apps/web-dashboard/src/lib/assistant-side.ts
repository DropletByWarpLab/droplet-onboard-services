/**
 * WARP-3062 — the two sides of the assistant nav layout.
 *
 *   ask       `/` and `/chat` — the conversation, with its history rail
 *   business  every other route — the sidebar layout's own nav and pages
 *
 * The side is derived from the pathname, never held in state, so Back,
 * refresh and deep links always agree with the switch: a card action that
 * opens `/calendar` lands on the business side because of where it goes,
 * not because anything flipped a flag.
 *
 * Each side remembers the last URL it showed (per tab, sessionStorage), so
 * the switch returns to the open conversation (`/chat?c=…`) and to the last
 * business page used rather than to each side's front door.
 */
import { ASSISTANT_OVERVIEW_HREF, pathMatches } from "@/components/nav-config";

export type AssistantSide = "ask" | "business";

export const ASK_HREF = "/chat";

export const SIDE_HOME: Record<AssistantSide, string> = {
  ask: ASK_HREF,
  business: ASSISTANT_OVERVIEW_HREF,
};

export const SIDE_STORAGE_KEYS: Record<AssistantSide, string> = {
  ask: "droplet-assistant-last-ask",
  business: "droplet-assistant-last-business",
};

export function sideForPath(pathname: string): AssistantSide {
  return pathname === "/" || pathMatches(pathname, ASK_HREF) ? "ask" : "business";
}

/**
 * A remembered URL is only honoured if it is a same-origin path on the side
 * it was stored for. sessionStorage is this tab's own, but the value is still
 * fed to a link, so anything that could leave the app (`//host`, `/\host`, a
 * scheme) or cross sides falls back to the side's home.
 */
export function returnHrefFor(side: AssistantSide, stored: string | null): string {
  if (!stored || !stored.startsWith("/") || stored.startsWith("//") || stored.includes("\\")) {
    return SIDE_HOME[side];
  }
  const pathname = stored.split(/[?#]/, 1)[0];
  // `/` is the Ask side's front door, not a place to return to — it only
  // forwards to `/chat`.
  if (pathname === "/" || sideForPath(pathname) !== side) return SIDE_HOME[side];
  return stored;
}
