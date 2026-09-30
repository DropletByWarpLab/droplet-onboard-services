/**
 * The dashboard pages a chat turn may take its user to.
 *
 * The contract between three layers:
 *
 *  - the dashboard, which DERIVES the list per viewer from `nav-config.ts`
 *    (the one definition of what the product's sections are and who may see
 *    them) and sends it with every chat turn;
 *  - the orchestrator, which validates it with {@link dashboardPagesSchema}
 *    and forwards it to the tool dispatch as `_meta.dashboardPages`;
 *  - the tools-core navigation handlers, which resolve what the person said
 *    ("voice settings") against it and hand a page back.
 *
 * Nothing in this module lists a route. A second hand-kept table of paths is
 * the drift nav-config exists to prevent (WARP-2577), and a model answering
 * `/settings/voice` — a path that has never existed — is what the absence of
 * any list looks like from the chat side.
 */
import { z } from "zod";

/** Tool names, shared so the dashboard can recognise the navigate result
 *  without depending on tools-core. */
export const FIND_DASHBOARD_PAGE_TOOL = "find_dashboard_page";
export const OPEN_DASHBOARD_PAGE_TOOL = "open_dashboard_page";

/** Every nav destination an owner can see is ~50; this leaves headroom
 *  without letting a request carry an unbounded list into every dispatch. */
export const DASHBOARD_PAGES_MAX = 120;

/**
 * An app path: one leading slash, then path characters only. No query, no
 * fragment, no scheme, no backslash, and no `//` authority — so the value is
 * a same-origin route whether it is pushed by the router or rendered as an
 * `href`.
 */
const HREF_PATTERN = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/;

// Copy is spliced into a tool result the model reads, so control characters
// (newlines included) are refused rather than stripped.
const copy = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/);

export const dashboardPageSchema = z.object({
  href: z.string().max(200).regex(HREF_PATTERN),
  /** The nav label, e.g. "Voice". */
  label: copy(80),
  /** Where it sits in the nav, e.g. "Systems" or "Settings › Advanced". */
  section: copy(80).optional(),
  /** One line on what the page is for. */
  description: copy(200).optional(),
  /** Other words people use for it, e.g. "wifi" for Network. */
  keywords: z.array(copy(40)).max(12).optional(),
});

export const dashboardPagesSchema = z
  .array(dashboardPageSchema)
  .max(DASHBOARD_PAGES_MAX);

export type DashboardPage = z.infer<typeof dashboardPageSchema>;

/** The `data` of a successful `open_dashboard_page` result. */
export interface DashboardNavigateAction {
  action: "navigate";
  href: string;
  label: string;
}

export function isDashboardNavigateAction(
  value: unknown,
): value is DashboardNavigateAction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.action === "navigate" &&
    typeof v.href === "string" &&
    HREF_PATTERN.test(v.href) &&
    typeof v.label === "string"
  );
}
