/**
 * WARP-3522 — the deep-link contract of the single `/projects` route (ADR-044:
 * the route is live and deep-linked, so there is no route restructure).
 *
 *   /projects?p=<IDENTIFIER>&view=<tab>&item=<KEY-123>&v=<savedViewId>&f=<filter>
 *
 *   p     the project's identifier (`INBOX`), not its id — links stay readable
 *         and survive a re-created project with the same key
 *   view  the tab: board | list | calendar | timeline | my-work | views | …
 *   item  the open work item's key; opens the drawer
 *   v     the active saved view — a row id, or a built-in slug (`mine`)
 *   f     the compact filter (`pm-filter.ts`); present only when the filter is
 *         not exactly the active view's own. `f=` (empty) is a real value:
 *         the view with its filter cleared
 *
 * The dashboard reads and writes its state through {@link parsePmUrl} /
 * {@link buildPmPath}; the orchestrator builds notification links with
 * {@link pmWorkItemPath}. One definition of the parameter names, in one place.
 */
import { PM_FILTER_ENCODED_MAX } from "./pm-filter";

export const PM_PROJECTS_PATH = "/projects";

export interface PmUrlState {
  p?: string | null;
  view?: string | null;
  item?: string | null;
  v?: string | null;
  f?: string | null;
}

/** The order parameters are written in — fixed, so equal state is an equal URL. */
const PARAM_ORDER = ["p", "view", "item", "v", "f"] as const;

const WORK_ITEM_KEY_RE = /^([A-Za-z0-9]{1,10})-(\d{1,9})$/;
const IDENTIFIER_RE = /^[A-Za-z0-9]{1,10}$/;
const VIEW_TAB_RE = /^(?:[a-z]{1,16}|my-work)$/;
const VIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `INBOX-42` → `{identifier: "INBOX", sequenceId: 42}`; `null` for anything else.
 *  Nine digits at most, so the number always fits the database's Int. */
export function parseWorkItemKey(key: string): { identifier: string; sequenceId: number } | null {
  const m = WORK_ITEM_KEY_RE.exec(key);
  if (!m) return null;
  return { identifier: m[1], sequenceId: Number(m[2]) };
}

function encodeParam(name: string, value: string): string {
  const encoded = encodeURIComponent(value);
  if (name !== "f") return encoded;
  // The compact filter's delimiters are all legal in a query string; leaving
  // them as they are keeps a shared link readable. Everything else in `f` is
  // already `[A-Za-z0-9._~-]` (see pm-filter.ts), so nothing else is touched.
  return encoded.replace(/%(2C|3B|3A|28|29)/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The path + query for a state. Empty values are omitted; values are encoded,
 *  so none can end a parameter early or start another. */
export function buildPmPath(state: PmUrlState): string {
  const parts: string[] = [];
  for (const name of PARAM_ORDER) {
    const value = state[name];
    if (value === undefined || value === null) continue;
    // An EMPTY `f` says something: "the active view, with no filter on it".
    // An ABSENT `f` says "the view's own filter". Every other empty value is
    // just absent.
    if (value === "" && name !== "f") continue;
    parts.push(`${name}=${encodeParam(name, value)}`);
  }
  return parts.length === 0 ? PM_PROJECTS_PATH : `${PM_PROJECTS_PATH}?${parts.join("&")}`;
}

/** Where a notification about one work item should take someone. */
export function pmWorkItemPath(identifier: string, key: string): string {
  return buildPmPath({ p: identifier, item: key });
}

/**
 * Read the state back out of a URL's query. Accepts `URLSearchParams` and
 * `next/navigation`'s `ReadonlyURLSearchParams` alike. A value that cannot be
 * what its parameter holds is dropped to `null` rather than passed on — a
 * hand-edited link degrades to the nearest sensible page, never to an error.
 */
export function parsePmUrl(src: { get(name: string): string | null }): Required<PmUrlState> {
  const read = (name: string, ok: (v: string) => boolean): string | null => {
    const v = src.get(name);
    return v !== null && ok(v) ? v : null;
  };
  return {
    p: read("p", (v) => IDENTIFIER_RE.test(v)),
    view: read("view", (v) => VIEW_TAB_RE.test(v)),
    item: read("item", (v) => parseWorkItemKey(v) !== null),
    v: read("v", (v) => VIEW_ID_RE.test(v)),
    // Judged for shape only here; `parsePmFilter` decides whether it means anything.
    f: read("f", (v) => v.length <= PM_FILTER_ENCODED_MAX),
  };
}
