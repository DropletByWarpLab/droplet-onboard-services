import { redirect } from "next/navigation";

/**
 * /integrations/eaglesoft → /practice permanent redirect (WARP-2560, ADR-044).
 *
 * The practice surface moved out of Integrations and into the Business group.
 * The old route stays alive because three different things still name it, and
 * none of them may 404:
 *
 *   - a bookmark. This is the page a front desk opens every morning.
 *   - an older deployed build's sidebar, until the box takes the update.
 *   - `provider-descriptors.ts`, whose `open` route this ticket re-points —
 *     but a descriptor is data, and data can be stale in a cached bundle.
 *
 * Server-side redirect on the `/clips` → `/events` precedent: the page holds
 * no state worth preserving, and Next renders the redirect at request time.
 * The ORCHESTRATOR path `/api/integrations/eaglesoft/*` is untouched — it is
 * the provider's API namespace, not a human destination, and moving it would
 * be a breaking API change for no reason.
 */
export default function EaglesoftRedirect() {
  redirect("/practice");
}
