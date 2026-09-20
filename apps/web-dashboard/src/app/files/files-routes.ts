/**
 * WARP-1548 — the header contract for the Files sub-routes, in one place.
 *
 * Before this, five sub-pages each declared their own `<ShellPage>` and spent
 * their entire `actions` slot on a byte-identical "← Files" back-link
 * (`drives/page.tsx:14-24` and the same block in `trash`, `favorites`,
 * `recents`, `shared`). The layout owns that chrome now; these are the values
 * it renders.
 *
 * Deliberately a plain data map and not a component: `app/files/layout.tsx` is
 * the only consumer, and a test can assert the contract without rendering
 * anything.
 *
 * The two dynamic headers — `/files` (computed `actions`) and `/files/devices`
 * (a paired-count `sub`) — are NOT here; they still own their own `ShellPage`.
 * See `LAYOUT_OWNED` below for why that asymmetry is deliberate and temporary.
 */

/** Icon key — resolved to a lucide glyph in the layout, which is a client
 *  component. Keeping this module free of JSX is what lets it be imported by
 *  a plain `.ts` test. */
export type FilesRouteIcon =
  | "drives"
  | "favorites"
  | "recents"
  | "shared"
  | "trash";

export interface FilesRouteHeader {
  icon: FilesRouteIcon;
  /** Slim top-bar label — the section name. */
  label: string;
  /** Big page header title (H1). */
  title: string;
  /** Big page header subtitle. */
  sub: string;
}

/**
 * The five sub-routes whose header is fully static, and therefore fully
 * owned by `app/files/layout.tsx`.
 *
 * `/files` and `/files/devices` are absent on purpose. Both compute part of
 * their header from page state, so hoisting them would need a context and an
 * effect to push the value back up — machinery worth adding when their headers
 * are redesigned (the Files packet moves `/files`'s actions into a toolbar and
 * `/files/devices` out of Files entirely), not before. Until then they keep
 * their own `ShellPage` and the layout passes them straight through.
 */
export const FILES_ROUTE_HEADERS: Record<string, FilesRouteHeader> = {
  "/files/drives": {
    icon: "drives",
    label: "Drives",
    title: "Drives",
    sub: "Storage pools and the physical volumes mounted on this Droplet.",
  },
  "/files/favorites": {
    icon: "favorites",
    label: "Favorites",
    title: "Favorites",
    sub: "Files and folders you've marked as favorites for quick access.",
  },
  "/files/recents": {
    icon: "recents",
    label: "Recents",
    title: "Recents",
    sub: "Files you've modified recently, grouped by time.",
  },
  "/files/shared": {
    icon: "shared",
    label: "Shared",
    title: "Shared",
    sub: "Files shared with you, and files you've shared with others.",
  },
  "/files/trash": {
    icon: "trash",
    label: "Trash",
    title: "Trash",
    sub: "Deleted files and folders are kept here until you restore them or empty the trash.",
  },
};

/** Routes whose `ShellPage` the layout renders. */
export const LAYOUT_OWNED = Object.keys(FILES_ROUTE_HEADERS);

/** Routes under `/files` that render their own `ShellPage`, by design. */
export const SELF_OWNED = ["/files", "/files/devices"] as const;

/** The header for a pathname, or `null` when the page owns its own chrome. */
export function headerForPath(pathname: string): FilesRouteHeader | null {
  return FILES_ROUTE_HEADERS[pathname] ?? null;
}

/**
 * Who renders the `ShellPage` for this route.
 *
 * `"unknown"` is deliberately distinct from `"page"`. Both make the layout pass
 * children through, so they behave identically — but they mean opposite things,
 * and collapsing them is how this goes wrong later: the five layout-owned pages
 * no longer carry a `ShellPage` of their own, so a sixth static sub-route added
 * without an entry in `FILES_ROUTE_HEADERS` renders with **no title, no icon and
 * no sub-line, and no error**. Naming the case is what lets the dev warning in
 * `layout.tsx` fire on it.
 *
 * `SELF_OWNED` is load-bearing here, not decorative — this is the function that
 * reads it, and it is the reason a new route is `"unknown"` rather than silently
 * assumed to bring its own chrome.
 */
export function routeOwnership(pathname: string): "layout" | "page" | "unknown" {
  if (pathname in FILES_ROUTE_HEADERS) return "layout";
  if ((SELF_OWNED as readonly string[]).includes(pathname)) return "page";
  return "unknown";
}
