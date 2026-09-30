/**
 * WARP-3116 — the navigation tools exist only where there is a screen to move.
 *
 * `find_dashboard_page` / `open_dashboard_page` resolve against the page list
 * the web dashboard sends with a chat turn (`dashboardPages`). A turn without
 * one — voice, a phone, a background run — has nothing for them to act on,
 * and advertising a tool that can only refuse costs schema tokens on every
 * such turn and invites a small model to call it anyway.
 */
import {
  FIND_DASHBOARD_PAGE_TOOL,
  OPEN_DASHBOARD_PAGE_TOOL,
} from "@droplet/shared-types";

export const DASHBOARD_NAVIGATION_TOOLS: ReadonlySet<string> = new Set([
  FIND_DASHBOARD_PAGE_TOOL,
  OPEN_DASHBOARD_PAGE_TOOL,
]);

const NOTHING_WITHHELD: ReadonlySet<string> = new Set();

/**
 * The tools a turn withholds for want of a page list.
 *
 * Applied where the pool is BUILT — the agent loop's advertisement and the
 * chat route's budget estimate, both branches of each — rather than by
 * rewriting `allowed_tools`. Rewriting would mean materialising the owner's
 * `undefined` ("the default chat scope") into an explicit list, and an
 * explicit list skips `EXCLUDED_FROM_CHAT_TOOLS` in the loop: every
 * non-dashboard owner turn would quietly gain the specialist tools that
 * list keeps out of chat. The tool-guidance composer reads the same set, so
 * no prompt line names a tool the turn does not carry (WARP-642).
 */
export function navigationToolsWithheld(hasDashboardPages: boolean): ReadonlySet<string> {
  return hasDashboardPages ? NOTHING_WITHHELD : DASHBOARD_NAVIGATION_TOOLS;
}
