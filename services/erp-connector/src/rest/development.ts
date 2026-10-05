/**
 * WARP-3535 / ADR-046 / ADR-069 §9 — the DEVELOPMENT feeds of a REST vendor
 * profile: the pull / merge requests, commits and branches a code host serves,
 * as data.
 *
 * ## Why a profile needs this beside `datasets`
 *
 * `datasets` projects a vendor row onto a CANONICAL column set and drops the
 * rest. For GitHub that is `GET /issues` → `task`, which keeps an id, a title and
 * a state and loses the one thing a development panel is for: the URL of the
 * pull request, its number, the branch it comes from, whether it merged. GitLab's
 * profile serves no merge requests at all. Widening `task` to carry them is a
 * vocabulary decision (ADR-046 §2) and would put code-host nouns in a vocabulary
 * every other track shares, so these feeds are a SECOND, typed output of the same
 * profile — read through the same connector, behind the same host guard.
 *
 * ## The admission criterion, for each field
 *
 * A field earns its place by naming a verified failure (ADR-046 §2):
 *
 *   - `repoRef.pattern` — a repository reference is spliced into a URL path. The
 *     owner picks it from a list, but the value is stored and read back later; a
 *     pattern per host, checked on every use, is what stops `acme/../../admin`.
 *   - `webHosts` — a response carries URLs that end up in an `<a href>`. The host
 *     is checked, not trusted: a compromised or misconfigured host must not be
 *     able to plant a `javascript:` link or a link to somewhere else.
 *   - `rateLimit` — GitHub says `x-ratelimit-*`, GitLab says `ratelimit-*`.
 *     Reading the wrong spelling reads nothing, silently, and the box then spends
 *     the owner's whole hour.
 *   - `stateRules` — GitHub has no `merged` state: a merged pull request is
 *     `state: closed` with `merged_at` set, and a closed draft is still
 *     `draft: true`. GitLab says `merged` outright. Order matters, so it is a
 *     list, not a map.
 *   - `newestFirst` — GitHub's `/pulls` has NO `since` filter (ADR-046, verified
 *     absent) and GitHub silently ignores unknown parameters. The only honest
 *     incremental read is newest-first with a cutoff applied here.
 *   - `urlTemplate` — GitHub's branch list carries no URL at all.
 *
 * Pure data and pure functions, like `profile.ts`: no I/O, no `fetch`, no
 * `if (provider === …)`. This module imports nothing from `connector.ts` or
 * `profile.ts` at runtime, so neither can form a cycle with it.
 */

export type DevItemState = "OPEN" | "MERGED" | "CLOSED" | "DRAFT";

export type DevelopmentFeedName =
  | "repositories"
  | "repository"
  | "pullRequestsOpen"
  | "pullRequestsRecent"
  | "commits"
  | "branches";

/** A test on one dotted path of a row. */
export type StateCondition =
  | { readonly path: string; readonly equals: string | boolean }
  | { readonly path: string; readonly oneOf: readonly string[] }
  /** `present: true` is "not null, not undefined, not empty"; `false` its negation. */
  | { readonly path: string; readonly present: boolean };

export interface StateRule {
  readonly when: StateCondition;
  readonly state: DevItemState;
}

export interface RestFeedSpec {
  /** Appended to the origin. `{repo}` is replaced by a validated repository ref. */
  readonly path: string;
  /** Constant query parameters, including the page size. */
  readonly query?: Readonly<Record<string, string>>;
  /** `true` for a feed whose body is ONE object, not an array. */
  readonly single?: boolean;
  /** Hard ceiling on pages walked. Hitting it is REPORTED (`truncated`), never silent. */
  readonly maxPages: number;
  /**
   * Rows arrive newest first by their sort key (`updatedAt` / `committedAt`), so a
   * page whose last row is older than the caller's cutoff ends the walk.
   */
  readonly newestFirst?: boolean;
  /** Feed field → dotted path into a vendor row. See `FEED_FIELDS` for the keys. */
  readonly fieldMap: Readonly<Record<string, string>>;
  /** Pull-request feeds only. First matching rule wins; no match skips the row. */
  readonly stateRules?: readonly StateRule[];
  /** Branch feed only: `{webUrl}` is the repository's web URL, `{name}` the
   *  branch name with each path segment URL-encoded. Used when `url` is unmapped. */
  readonly urlTemplate?: string;
}

/** Header NAMES, lowercase — what the host calls them. */
export interface RestRateLimitHeaders {
  readonly limit: string;
  readonly remaining: string;
  /** Epoch seconds, on both hosts. */
  readonly reset: string;
}

export interface RestDevelopmentSpec {
  readonly repoRef: { readonly pattern: string };
  /** Bare, lowercase hosts a web URL in a response may point at (https only). */
  readonly webHosts: readonly string[];
  readonly rateLimit: RestRateLimitHeaders;
  readonly repositories: RestFeedSpec;
  readonly repository: RestFeedSpec;
  readonly pullRequestsOpen: RestFeedSpec;
  readonly pullRequestsRecent: RestFeedSpec;
  readonly commits: RestFeedSpec;
  readonly branches: RestFeedSpec;
}

export interface RateLimitSnapshot {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: Date | null;
}

export interface DevRepositoryItem {
  readonly type: "repository";
  readonly externalId: string;
  readonly apiRef: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly defaultBranch: string | null;
}

export interface DevPullRequestItem {
  readonly type: "pull_request";
  readonly externalId: string;
  readonly number: number | null;
  readonly url: string;
  readonly title: string;
  /** Matched for work-item keys and never stored. */
  readonly body: string | null;
  readonly author: string | null;
  readonly branch: string | null;
  readonly state: DevItemState;
  readonly updatedAt: Date;
}

export interface DevCommitItem {
  readonly type: "commit";
  readonly externalId: string;
  readonly url: string;
  /** The whole message, for matching. */
  readonly message: string;
  /** Its first line. */
  readonly title: string;
  readonly author: string | null;
  readonly committedAt: Date;
}

export interface DevBranchItem {
  readonly type: "branch";
  readonly name: string;
  readonly url: string;
}

export type DevelopmentItem = DevRepositoryItem | DevPullRequestItem | DevCommitItem | DevBranchItem;

export interface DevelopmentFeedRequest {
  readonly feed: DevelopmentFeedName;
  /** The repository's `apiRef`. Required for every feed but `repositories`; checked
   *  against the profile's pattern before it is put in a URL. */
  readonly repo?: string;
  /** The repository's web URL — only the branch feed's `urlTemplate` reads it. */
  readonly repoWebUrl?: string;
  /** The last complete single-page representation's ETag. Sent as `If-None-Match`. */
  readonly etag?: string | null;
  /** For a newest-first feed: rows older than this are dropped and the walk ends
   *  at the first page that reaches it. Ignored by every other feed. */
  readonly cutoff?: Date;
}

export interface DevelopmentFeedResult {
  /** `not_modified`: the cached single-page representation is unchanged. */
  readonly status: "ok" | "not_modified";
  readonly items: DevelopmentItem[];
  /** A single-page representation's ETag, or null when more pages are advertised. */
  readonly etag: string | null;
  /** The page ceiling was reached with more pages behind it. */
  readonly truncated: boolean;
  /** Rows that were not an item: a missing field, a URL off the allowed hosts. */
  readonly skipped: number;
  /** What the LAST response said about the allowance. */
  readonly rateLimit: RateLimitSnapshot | null;
}

/** Per feed: the field names a `fieldMap` must carry and may carry. */
export const FEED_FIELDS: Readonly<
  Record<DevelopmentFeedName, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = {
  repositories: { required: ["externalId", "apiRef", "fullName", "webUrl"], optional: ["defaultBranch"] },
  repository: { required: ["externalId", "apiRef", "fullName", "webUrl"], optional: ["defaultBranch"] },
  pullRequestsOpen: {
    required: ["externalId", "url", "title", "updatedAt"],
    optional: ["number", "body", "author", "branch"],
  },
  pullRequestsRecent: {
    required: ["externalId", "url", "title", "updatedAt"],
    optional: ["number", "body", "author", "branch"],
  },
  commits: { required: ["externalId", "url", "message", "committedAt"], optional: ["author"] },
  branches: { required: ["name"], optional: ["url"] },
};

export const DEVELOPMENT_FEED_NAMES = Object.keys(FEED_FIELDS) as DevelopmentFeedName[];

/** Page-size ceiling for any feed. The hosts cap `per_page` at 100; a profile that
 *  asks for more than ten pages is describing a crawl, not a sync. */
const MAX_PAGES_CEILING = 10;

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const HEADER_NAME = /^[a-z0-9-]+$/;

// ── limits on what a response may put in a row ──────────────────────────────

export const MAX_TITLE_CHARS = 300;
export const MAX_AUTHOR_CHARS = 100;
export const MAX_REF_CHARS = 255;
export const MAX_URL_CHARS = 2000;
/** What is kept of a pull request body or commit message for matching. */
export const MAX_MATCH_TEXT_CHARS = 65_536;

// ── structural validation ───────────────────────────────────────────────────

/** Every `{name}` placeholder in a template, in order. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? "");
}

/**
 * Everything wrong with a development spec that is decidable from the spec alone.
 * Returns problems rather than throwing so this module needs no error class from
 * `profile.ts` (which imports it). An empty array is a valid spec.
 */
export function developmentSpecProblems(spec: RestDevelopmentSpec): string[] {
  const problems: string[] = [];

  try {
    new RegExp(spec.repoRef.pattern);
  } catch {
    problems.push(`repoRef.pattern "${spec.repoRef.pattern}" is not a valid regular expression`);
  }
  if (spec.webHosts.length === 0) problems.push("webHosts is empty, so no link could ever be shown");
  for (const host of spec.webHosts) {
    if (!HOST.test(host)) problems.push(`webHosts entry "${host}" must be a bare lowercase host`);
  }
  for (const [key, name] of Object.entries(spec.rateLimit)) {
    if (!HEADER_NAME.test(name)) problems.push(`rateLimit.${key} "${name}" must be a lowercase header name`);
  }

  for (const feed of DEVELOPMENT_FEED_NAMES) {
    const f = spec[feed];
    const at = (what: string) => `${feed}: ${what}`;
    if (!f.path.startsWith("/")) problems.push(at('path must start with "/"'));

    const holes = placeholders(f.path);
    const wantsRepo = feed !== "repositories";
    if (wantsRepo && !(holes.length === 1 && holes[0] === "repo")) {
      problems.push(at("path must carry exactly one {repo} placeholder and no other"));
    }
    if (!wantsRepo && holes.length > 0) problems.push(at("a feed with no repository takes no placeholder"));

    if (!Number.isInteger(f.maxPages) || f.maxPages < 1 || f.maxPages > MAX_PAGES_CEILING) {
      problems.push(at(`maxPages must be a whole number from 1 to ${MAX_PAGES_CEILING}`));
    }
    if ((feed === "repository") !== (f.single === true)) {
      problems.push(at("only the single-repository feed reads one object, and it must say so"));
    }
    if (f.single === true && f.maxPages !== 1) problems.push(at("a single-object feed has exactly one page"));

    const isPrs = feed === "pullRequestsOpen" || feed === "pullRequestsRecent";
    if (f.newestFirst === true && !(isPrs || feed === "commits")) {
      problems.push(at("newestFirst needs a sort key, which only pull-request and commit feeds have"));
    }
    if (isPrs && (!f.stateRules || f.stateRules.length === 0)) {
      problems.push(at("a pull-request feed needs stateRules, or every row is skipped"));
    }
    if (!isPrs && f.stateRules) problems.push(at("only pull-request feeds carry stateRules"));

    const { required, optional } = FEED_FIELDS[feed];
    for (const key of required) {
      if (!(key in f.fieldMap)) problems.push(at(`fieldMap does not map "${key}"`));
    }
    for (const key of Object.keys(f.fieldMap)) {
      if (!required.includes(key) && !optional.includes(key)) {
        problems.push(at(`fieldMap maps "${key}", which this feed never reads`));
      }
    }
    if (feed === "branches" && !("url" in f.fieldMap) && !f.urlTemplate) {
      problems.push(at("a branch needs a url: map one or give a urlTemplate"));
    }
    if (f.urlTemplate !== undefined) {
      if (feed !== "branches") problems.push(at("only the branch feed takes a urlTemplate"));
      for (const hole of placeholders(f.urlTemplate)) {
        if (hole !== "webUrl" && hole !== "name") problems.push(at(`urlTemplate placeholder {${hole}} is unknown`));
      }
    }
  }
  return problems;
}

// ── repository references ───────────────────────────────────────────────────

/**
 * Is `ref` something that may be spliced into a URL path for this host?
 *
 * Two independent checks, because each alone has a hole: the host's pattern says
 * what a reference LOOKS like, and the segment rule refuses `.` and `..`, which
 * every sane pattern lets through (`.github` is a real repository name, `..` is
 * a traversal) and which a URL parser would collapse into a different path.
 */
export function isSafeRepoRef(ref: string, pattern: string): boolean {
  if (ref.length === 0 || ref.length > 200) return false;
  if (ref.split("/").some((segment) => segment === "." || segment === "..")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return new RegExp(pattern).test(ref);
}

// ── rate limit ──────────────────────────────────────────────────────────────

function wholeNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null;
}

/** What the last response said about the allowance, or null if it said nothing. */
export function parseRateLimit(headers: Pick<Headers, "get">, spec: RestRateLimitHeaders): RateLimitSnapshot | null {
  const limit = wholeNumber(headers.get(spec.limit));
  const remaining = wholeNumber(headers.get(spec.remaining));
  const resetSeconds = wholeNumber(headers.get(spec.reset));
  if (limit === null && remaining === null && resetSeconds === null) return null;
  return { limit, remaining, resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000) };
}

// ── text, URLs and dates a response may carry ───────────────────────────────

/** C0 controls except tab, LF and CR; DEL; and the two Unicode line separators. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;
/** A UTF-16 surrogate with no partner. JSON can carry one (`"\ud800"`) and
 *  Postgres refuses to store it, which would turn one odd title into a repository
 *  that can never sync. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Cut to `max` UTF-16 units without leaving half a surrogate pair behind. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A single line of display text: no controls, no lone surrogates, whitespace
 *  collapsed, trimmed, bounded. `null` when nothing is left. */
export function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL_CHARS, "").replace(LONE_SURROGATE, "�").replace(/\s+/g, " ").trim();
  return text === "" ? null : truncate(text, max);
}

/** Free text kept for matching (a body, a commit message): newlines survive. */
export function cleanBlock(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL_CHARS, "").replace(LONE_SURROGATE, "�").trim();
  return text === "" ? null : truncate(text, max);
}

/** An https URL on one of `webHosts`, normalised; otherwise `null`. */
export function safeWebUrl(value: unknown, webHosts: readonly string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!webHosts.includes(url.hostname.toLowerCase())) return null;
  return url.toString();
}

function instantOf(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
}

function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.length > 0 && value.length <= 200) return value;
  return null;
}

/** A dotted path, nothing more: the development feeds need no transform. */
function pick(row: unknown, path: string): unknown {
  let cursor: unknown = row;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function conditionHolds(row: unknown, cond: StateCondition): boolean {
  const value = pick(row, cond.path);
  if ("equals" in cond) return value === cond.equals;
  if ("oneOf" in cond) return typeof value === "string" && cond.oneOf.includes(value);
  const present = value !== undefined && value !== null && value !== "";
  return present === cond.present;
}

/** The first rule that holds, or `null`. */
export function stateOf(row: unknown, rules: readonly StateRule[]): DevItemState | null {
  for (const rule of rules) {
    if (conditionHolds(row, rule.when)) return rule.state;
  }
  return null;
}

// ── mapping one row ─────────────────────────────────────────────────────────

export interface MapContext {
  readonly webHosts: readonly string[];
  readonly repoRefPattern: string;
  /** The repository's web URL, for a branch's `urlTemplate`. */
  readonly repoWebUrl?: string;
}

function mapRepository(spec: RestFeedSpec, row: unknown, ctx: MapContext): DevRepositoryItem | null {
  const externalId = idOf(pick(row, spec.fieldMap.externalId!));
  const apiRefRaw = pick(row, spec.fieldMap.apiRef!);
  const apiRef = typeof apiRefRaw === "number" ? String(apiRefRaw) : apiRefRaw;
  const fullName = cleanLine(pick(row, spec.fieldMap.fullName!), MAX_TITLE_CHARS);
  const webUrl = safeWebUrl(pick(row, spec.fieldMap.webUrl!), ctx.webHosts);
  if (!externalId || typeof apiRef !== "string" || !fullName || !webUrl) return null;
  if (!isSafeRepoRef(apiRef, ctx.repoRefPattern)) return null;
  const branchPath = spec.fieldMap.defaultBranch;
  return {
    type: "repository",
    externalId,
    apiRef,
    fullName,
    webUrl,
    defaultBranch: branchPath ? cleanLine(pick(row, branchPath), MAX_REF_CHARS) : null,
  };
}

function mapPullRequest(spec: RestFeedSpec, row: unknown, ctx: MapContext): DevPullRequestItem | null {
  const f = spec.fieldMap;
  const externalId = idOf(pick(row, f.externalId!));
  const url = safeWebUrl(pick(row, f.url!), ctx.webHosts);
  const title = cleanLine(pick(row, f.title!), MAX_TITLE_CHARS);
  const updatedAt = instantOf(pick(row, f.updatedAt!));
  const state = stateOf(row, spec.stateRules ?? []);
  if (!externalId || !url || !title || !updatedAt || !state) return null;
  const numberValue = f.number ? pick(row, f.number) : undefined;
  return {
    type: "pull_request",
    externalId,
    number: typeof numberValue === "number" && Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null,
    url,
    title,
    body: f.body ? cleanBlock(pick(row, f.body), MAX_MATCH_TEXT_CHARS) : null,
    author: f.author ? cleanLine(pick(row, f.author), MAX_AUTHOR_CHARS) : null,
    branch: f.branch ? cleanLine(pick(row, f.branch), MAX_REF_CHARS) : null,
    state,
    updatedAt,
  };
}

const SHA = /^[0-9a-f]{7,64}$/i;

function mapCommit(spec: RestFeedSpec, row: unknown, ctx: MapContext): DevCommitItem | null {
  const f = spec.fieldMap;
  const externalId = idOf(pick(row, f.externalId!));
  const url = safeWebUrl(pick(row, f.url!), ctx.webHosts);
  const message = cleanBlock(pick(row, f.message!), MAX_MATCH_TEXT_CHARS);
  const committedAt = instantOf(pick(row, f.committedAt!));
  if (!externalId || !SHA.test(externalId) || !url || !message || !committedAt) return null;
  const title = cleanLine(message.split("\n", 1)[0], MAX_TITLE_CHARS);
  if (!title) return null;
  return {
    type: "commit",
    externalId: externalId.toLowerCase(),
    url,
    message,
    title,
    author: f.author ? cleanLine(pick(row, f.author), MAX_AUTHOR_CHARS) : null,
    committedAt,
  };
}

function mapBranch(spec: RestFeedSpec, row: unknown, ctx: MapContext): DevBranchItem | null {
  const f = spec.fieldMap;
  const nameRaw = pick(row, f.name!);
  const name = cleanLine(nameRaw, MAX_REF_CHARS);
  // A name that changed under cleaning had something in it a branch cannot have,
  // and git refuses whitespace in a ref outright, so a host that sends one is
  // describing something that is not a branch.
  if (!name || name !== nameRaw || /\s/.test(name)) return null;
  let rawUrl: unknown = f.url ? pick(row, f.url) : undefined;
  if (rawUrl === undefined && spec.urlTemplate && ctx.repoWebUrl) {
    const encoded = name.split("/").map(encodeURIComponent).join("/");
    rawUrl = spec.urlTemplate.replaceAll("{webUrl}", ctx.repoWebUrl.replace(/\/+$/, "")).replaceAll("{name}", encoded);
  }
  const url = safeWebUrl(rawUrl, ctx.webHosts);
  return url ? { type: "branch", name, url } : null;
}

/**
 * Map one vendor row to the feed's item, or `null` if it is not one: a missing
 * field, a URL that fails the host check, a state no rule names. A `null` is
 * COUNTED by the caller and never turned into a half-filled item.
 */
export function mapFeedRow(
  feed: DevelopmentFeedName,
  spec: RestFeedSpec,
  row: unknown,
  ctx: MapContext,
): DevelopmentItem | null {
  switch (feed) {
    case "repositories":
    case "repository":
      return mapRepository(spec, row, ctx);
    case "pullRequestsOpen":
    case "pullRequestsRecent":
      return mapPullRequest(spec, row, ctx);
    case "commits":
      return mapCommit(spec, row, ctx);
    case "branches":
      return mapBranch(spec, row, ctx);
  }
}

/** The instant a newest-first feed is ordered by, or `null` for a feed with none. */
export function sortKeyOf(item: DevelopmentItem): Date | null {
  if (item.type === "pull_request") return item.updatedAt;
  if (item.type === "commit") return item.committedAt;
  return null;
}
