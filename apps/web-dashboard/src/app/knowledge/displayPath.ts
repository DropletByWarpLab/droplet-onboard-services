/**
 * Nextcloud paths arrive on the wire shaped like
 * `/admin/files/private/Knowledge/notes.md` — that's a server-side
 * filesystem path that the user has no business seeing. The audit
 * (WARP-294 / web-dashboard UX audit §5) flagged this as a P0 leak.
 *
 * `trimDisplayPath` strips the known internal prefixes and returns
 * the last two segments — enough for context ("Knowledge/notes.md")
 * without leaking the Nextcloud share layout.
 */
const INTERNAL_PREFIXES = ["/admin/files/", "/admin/files", "/private/", "/private"];

export function trimDisplayPath(path: string): string {
  if (!path) return "";

  let trimmed = path;

  // Strip known internal prefixes, possibly stacked
  // ("/admin/files/private/...").
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of INTERNAL_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        trimmed = trimmed.slice(prefix.length);
        changed = true;
      }
    }
  }

  // Drop any leading slash left over.
  trimmed = trimmed.replace(/^\/+/, "");

  if (!trimmed) return "";

  // Keep at most the last two segments — gives the user enough
  // context (folder + file) without leaking the full hierarchy.
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length <= 2) return segments.join("/");
  return segments.slice(-2).join("/");
}
