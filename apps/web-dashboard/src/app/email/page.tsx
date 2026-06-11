/**
 * WARP-837 — Email (`/email`).
 *
 * The 3-column mail-client surface (FEATURES.md §2.4): list · thread reader · AI
 * side panel. This route is the no-selection entry point; it renders the
 * workspace, which auto-selects the first account. `/email/:account` and
 * `/email/:account/:thread` deep-link into a specific account / thread via the
 * sibling catch-all route.
 *
 * All wiring (SWR hooks, selection state, the confirm-gated draft send) lives in
 * EmailWorkspace so both routes share one implementation.
 */

import { EmailWorkspace } from "@/components/email/EmailWorkspace";

export default function EmailPage() {
  return <EmailWorkspace />;
}
