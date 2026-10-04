/**
 * WARP-3538 — `search_cloud_files` LLM tool.
 *
 * Finds files in the calling person's OWN connected cloud drives — today their
 * OneDrive and the SharePoint document libraries Droplet reads for them
 * (Microsoft 365, ADR-041) — by file name, by where the file lives, or a
 * modified-since date. METADATA ONLY: a name, where it lives, a link, who
 * changed it and when. Contents are never read, never landed, and so are not
 * reachable from here; the description says so because a model that believes
 * otherwise will offer to "open" a file it cannot.
 *
 * ONE TOOL FOR EVERY CLOUD DRIVE (D13). Google Drive and Dropbox connectors are
 * built right after this one and land into the same provider-agnostic store, so
 * a person asks once and gets OneDrive, SharePoint, Google Drive and Dropbox
 * results together. The tool therefore carries a `provider` argument, an enum of
 * the providers that EXIST — `m365` today. A later connector's PR adds its own
 * value (and its handler tests); nothing here guesses at one in advance.
 *
 * READ THROUGH THE ORCHESTRATOR (`GET /api/cloud-files`), never `ctx.prisma`,
 * for the reason the calendar and reminder tools do (WARP-3101): the rows are
 * per person and their human-readable columns are ciphertext at rest under a
 * key only the orchestrator holds. A handler that read them itself would be
 * reading `dcv1:` blobs.
 *
 * 🔴 WHOSE FILES. The person is never an argument. The mcp-server wraps
 * `ctx.http.orchestrator` so every call carries `X-Nextcloud-User: <ctx.userId>`
 * (context.ts `withActingUser`) and the service Bearer; the route resolves that
 * header to the person (`toolActingUser`) and reads only their rows. This
 * handler therefore sends NO identity of its own — a caller's own headers are
 * merged last and would WIN over the stamp — and accepts none from the model:
 * the schema has no user, account, drive or site parameter, and a key it does
 * not name reaches nothing. `!ctx.userId` is refused before any hop.
 *
 * What the route must do for this tool to be reachable (orchestrator side,
 * `routes/cloud-files.ts`; `tools-mcp-admission.test.ts` fails until it does):
 *   - admit the `_service:mcp` principal on `GET /cloud-files`
 *     (`requireRoleOrMcpService`) and resolve the acting person with
 *     `toolActingUser(prisma, req, ["search_cloud_files"])`;
 *   - answer 200 `{ items: [{ name, isFolder, provider, location, path, webUrl,
 *     lastModifiedAt, lastModifiedBy, sizeBytes }] }`, newest first, scoped to
 *     that person, honouring `q`, `provider`, `source`, `modifiedSince`, `limit`;
 *   - answer 409 (or 404) when that person has no connected cloud drive.
 *
 * `location` (the model's word, and the word on every result) is the route's
 * `source`: the container a file was read from — a drive or a library. The
 * model never sees a source id, only the substring of a name it can say.
 *
 * `sizeBytes` is a JSON NUMBER: a BigInt column read with `Number()`, exact
 * below 2^53 (a single file of 8 PiB does not exist). A decimal string is
 * accepted too, so a route that forgets the conversion degrades to a correct
 * size and not to a silent null; anything else that is not a whole number of
 * bytes is dropped, never rounded.
 *
 * The result is a WHITELIST of those fields in the tool's own spelling, not the
 * row passed through: a field the route one day adds (a download link, an id)
 * must not reach a model's context by accident.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "../calendar/_dates.js";
import { err, refusalOf, type RouteRefusal } from "../calendar/_route.js";

/** The longest text filter sent. A file, site or library name is far shorter;
 *  past this it is not a name and the route would only refuse it. */
const MAX_FILTER_CHARS = 200;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** The providers that exist. `m365` is OneDrive and the SharePoint libraries;
 *  each later connector's PR appends its own. */
const PROVIDERS = ["m365"] as const;

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Part of the file name (case-insensitive)." },
    location: {
      type: "string",
      description: "Part of where it lives: a site, library or drive name (case-insensitive).",
    },
    // A closed `enum` on purpose, not `pattern`/`maxLength`: those are what
    // blew llama.cpp's grammar compiler (WARP-1839), while an enum expands to
    // one alternation of literals and the registry already carries dozens
    // (business/find.ts records the measurement).
    provider: {
      type: "string",
      enum: PROVIDERS,
      description: "Only this provider (m365 = OneDrive and SharePoint). Leave out to search every connected drive.",
    },
    modified_since: { type: "string", description: "ISO-8601 date: only files changed on or after it." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 25)." },
  },
  additionalProperties: false,
} as const;

/** A row as `GET /api/cloud-files` sends it (dates as ISO strings). */
interface RouteFile {
  name: string;
  isFolder: boolean;
  /** Which connector it came from: `"m365"` today. */
  provider: string;
  /** `"OneDrive"` or `"<site> › <library>"` for Microsoft 365. */
  location: string;
  /** Folders above it inside that location, root excluded. Best effort. */
  path: string | null;
  webUrl: string | null;
  lastModifiedAt: string | null;
  lastModifiedBy: string | null;
  /** A number, or a decimal string — see the header. */
  sizeBytes: number | string | null;
}

/** A text filter: the trimmed text, "" when it is missing or blank (a model
 *  fills the arguments it does not need with "", and "" is never sent), `null`
 *  when it is not text or not a plausible name. */
function textFilter(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > MAX_FILTER_CHARS ? null : text;
}

/** An ISO-8601 string, or null for anything that is not a date. Never throws:
 *  `toISOString()` raises a RangeError on an Invalid Date. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A whole number of bytes, or null. Reads the decimal string a BigInt becomes
 *  on the wire; a figure that is not a safe integer is dropped, not rounded. */
function bytesOrNull(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toolFile(row: RouteFile) {
  return {
    name: row.name,
    is_folder: row.isFolder === true,
    provider: typeof row.provider === "string" ? row.provider : null,
    location: row.location,
    path: row.path ?? null,
    web_url: row.webUrl ?? null,
    modified_at: isoOrNull(row.lastModifiedAt),
    modified_by: row.lastModifiedBy ?? null,
    size_bytes: bytesOrNull(row.sizeBytes),
  };
}

/** The route's spelling of a request field, in the tool's own. A `switch`, not
 *  a lookup object: a field named `constructor` must come back as itself. */
function argOf(field: string): string {
  switch (field) {
    case "q":
      return "query";
    case "source":
      return "location";
    case "modifiedSince":
      return "modified_since";
    default:
      return field;
  }
}

/** A 400: the route's own message when it gave one, else the fields it named. */
function invalid(refusal: RouteRefusal): ToolResult {
  if (refusal.error !== "invalid_request") return err("INVALID_ARGS", refusal.error);
  return err(
    "INVALID_ARGS",
    refusal.fields.length > 0 ? `invalid ${refusal.fields.map(argOf).join(", ")}` : "invalid request",
  );
}

/** A 403. The two named refusals are the acting-user check
 *  (services/tool-acting-user.service.ts in the orchestrator). */
function forbidden(refusal: RouteRefusal): ToolResult {
  if (refusal.error === "acting_user_required") {
    return err("FORBIDDEN", "Droplet could not tell whose cloud files these are, so it did not search them.");
  }
  if (refusal.error === "forbidden_tool_for_role") {
    return err("FORBIDDEN", "This person's access does not include searching cloud files.");
  }
  return err("FORBIDDEN", "forbidden");
}

/** No connected drive to read. Not an outage and not "no such file": the person
 *  has to act, and the model is the one who can tell them where. Microsoft 365
 *  is the one connector today, so it is the one named; a later connector's PR
 *  names its own here. */
function notConnected(): ToolResult {
  return err(
    "NOT_CONNECTED",
    "No cloud drive is connected for this person yet. They can connect Microsoft 365 in Settings, on the Microsoft 365 card; until then there are no cloud files to search.",
  );
}

async function refused(res: Response): Promise<ToolResult> {
  const refusal = await refusalOf(res);
  if (res.status === 403) return forbidden(refusal);
  if (res.status === 400) return invalid(refusal);
  // 409 is the route's "nothing connected"; 404 is the same answer from a route
  // that reports a missing row that way (D10 names both).
  if (res.status === 409 || res.status === 404) return notConnected();
  // `http_<status>` is `refusalOf`'s stand-in for a body that named no reason.
  const why = refusal.error === `http_${res.status}` ? "" : `: ${refusal.error}`;
  return err("SEARCH_FAILED", `orchestrator returned ${res.status}${why}`);
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");

  const query = textFilter(args.query);
  if (query === null) return err("INVALID_ARGS", `query must be text of at most ${MAX_FILTER_CHARS} characters`);
  const location = textFilter(args.location);
  if (location === null) return err("INVALID_ARGS", `location must be text of at most ${MAX_FILTER_CHARS} characters`);

  // Refused here, naming the valid values, rather than sent to be refused by
  // the route in the route's own spelling.
  const rawProvider = textFilter(args.provider);
  const provider = rawProvider?.toLowerCase() ?? null;
  if (provider === null || (provider !== "" && !(PROVIDERS as readonly string[]).includes(provider)))
    return err("INVALID_ARGS", `provider must be one of: ${PROVIDERS.join(", ")}`);

  let modifiedSince: string | undefined;
  const rawSince = typeof args.modified_since === "string" ? args.modified_since.trim() : args.modified_since;
  if (rawSince !== undefined && rawSince !== null && rawSince !== "") {
    const since = parseModelDate(rawSince);
    if (!since) return err("INVALID_ARGS", "invalid modified_since — expected an ISO-8601 date");
    // The full timestamp, as the calendar tools send theirs: it is one a route
    // can parse whether it expects a date or a datetime.
    modifiedSince = since.toISOString();
  }

  let limit = DEFAULT_LIMIT;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT)
      return err("INVALID_ARGS", `limit must be an integer 1-${MAX_LIMIT}`);
    limit = args.limit;
  }

  // The route's own parameter names (D13): `location` is its `source`.
  const qs = new URLSearchParams();
  if (query) qs.set("q", query);
  if (location) qs.set("source", location);
  if (provider) qs.set("provider", provider);
  if (modifiedSince) qs.set("modifiedSince", modifiedSince);
  qs.set("limit", String(limit));

  const res = await ctx.http.orchestrator.get(`/api/cloud-files?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return refused(res);

  let items: unknown;
  try {
    items = ((await res.json()) as { items?: unknown } | null)?.items;
  } catch {
    items = undefined;
  }
  // A 200 that is not the route's list is a broken route, not "no such file".
  if (!Array.isArray(items)) return err("SEARCH_FAILED", "unexpected response from the orchestrator");

  // Bounded here as well as by the route: what reaches a model's context is
  // this tool's promise, not the route's.
  const files = (items as RouteFile[]).slice(0, limit).map(toolFile);
  return { ok: true, data: { type: "search_cloud_files", count: files.length, limit, files } };
}

const tool: Tool = {
  name: "search_cloud_files",
  description:
    "Search the calling person's own connected cloud files — their OneDrive and the SharePoint libraries Droplet reads for them today; other cloud drives appear here once connected — by file name or location, optionally only files changed since a date. Returns names, locations, links and modified dates; never file contents.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
