import { redirect } from "next/navigation";

/**
 * /clips → /events permanent redirect.
 *
 * The Clips surface was rolled into the richer Events page in Phase
 * 2.1 of the Frigate-parity rollout. We keep the route alive so any
 * old browser bookmarks, the sidebar of older deployed builds, and
 * the LLM list_clips tool's "clip_url" field (which points at
 * /api/cameras/clips/event/...) still land on something useful.
 *
 * Server-side redirect is fine here — the page has no state to
 * preserve and Next.js renders the redirect at request time.
 */
export default function ClipsRedirect() {
  redirect("/events");
}
