import { redirect } from "next/navigation";

/**
 * WARP-2959 — /files/drives → /settings/storage permanent redirect.
 *
 * The Drives surface moved into Settings → Storage. The route stays alive so
 * old bookmarks, the sidebar of an older deployed build, and any link written
 * down while it lived under Files still land on the thing they asked for.
 *
 * Server-side redirect: there is no state to preserve, and Next renders it at
 * request time. `files-routes.ts` lists this path as self-owned so the Files
 * layout passes it through without painting a header nobody ever sees.
 */
export default function DrivesRedirect() {
  redirect("/settings/storage");
}
