/**
 * WARP-2203 Phase 1 — bound a tool result for the MODEL, without lying to it.
 *
 * ## The defect
 *
 * `llm-agent.service.ts` fed the model `text.slice(0, 8000)` where `text` is
 * `JSON.stringify(result.data)`. Cutting JSON at a character count yields
 * INVALID JSON and deletes every field after the cut. Paging tools put the
 * bulk text FIRST and the continuation marker LAST, so the cut deleted exactly
 * the "there is more" signal and kept the fragment that looks complete. Both
 * `read_file` and `read_document_text` were inert on the chat path while their
 * own suites were green: the cap is orchestrator-only, so no tool-boundary test
 * could see it.
 *
 * ## Why this module takes TEXT and returns TEXT
 *
 * The bounded string has exactly ONE consumer: the model's next turn. Verified
 * line ordering in the agent loop — parse, `trace.push({result: parsed})`,
 * `emit(evt)` for SSE, `extractCitedFilePaths(payload)`, and only THEN the
 * bounding step. Nothing downstream reads it; the ai-gateway explicitly
 * refuses to parse it (`services/ai-gateway/schemas.py`: "tool result content
 * must be a string" and nothing more).
 *
 * So this function is confined to the argument of that one `messages.push`. It
 * never receives, reads, or returns the `payload`/`parsed` values the trace and
 * the SSE stream hold. That makes two whole hazard classes structurally
 * impossible rather than defended against: it cannot mutate what the operator
 * trace shows, and it cannot corrupt a bare-array payload for any other reader.
 * `packages/tools-core` and `services/mcp-server` are untouched, so external
 * MCP clients stay byte-identical BY CONSTRUCTION.
 *
 * ## The honesty rule
 *
 * "Never a truncated body" and "regress nothing" are jointly unsatisfiable:
 * `read_document_text` ships `DEFAULT_MAX_CHARS = 12000`, so its default
 * payload ALWAYS exceeds the cap, and refusing would deliver zero characters
 * where today the model gets ~7900. Refusal would be the regression.
 *
 * The invariant that IS satisfiable: **no cursor may over-claim relative to
 * delivered content.** It is discharged three ways, in preference order:
 *
 *   1. RECOMPUTE the cursor from what was actually delivered. Admissible only
 *      under the conditions spelled out at the cursor pass, and only ONE of
 *      the two branches is exact: the numeric branch VERIFIES
 *      `cursor - preLength` against a base the producer itself published, so
 *      the rewrite changes only the term that changed. The null branch is an
 *      INFERENCE — a null cursor publishes no number to check — admitted only
 *      when a published base and a published total corroborate it, and only
 *      when exactly one base does. Do not read "recompute" as "exact"; read it
 *      as "checked against the producer's own numbers, or not done at all".
 *   2. DELETE the cursor — and the whole accounting group around it, because a
 *      survivor can reconstruct the deleted cursor and the reconstruction is
 *      wrong (chunk indices are not dense; see `read-document-text.ts`).
 *   3. REFUSE, carrying zero bytes. Last resort, and logged.
 *
 * What Phase 1 does NOT deliver: `read_document_text` at its shipped
 * `DEFAULT_MAX_CHARS = 12000` is now HONEST but still not RESUMABLE. The model
 * receives ~7,300 characters and loses `start_chunk`/`next_chunk`/
 * `chunks_returned`/`total_chunks` together, so resuming means re-calling from
 * chunk 0 with a smaller `max_chars` rather than continuing. Only `read_file`
 * pages to exhaustion through this step. Closing that gap is the Phase 2
 * budget rail (or a `DEFAULT_MAX_CHARS` change), not this module.
 *
 * This is NOT the rejected "keep the producer's cursor beside a shortened
 * body" variant. Here the cursor is either arithmetically correct or absent.
 *
 * ## Shape-driven, never a per-tool table
 *
 * A per-tool table is unmaintainable: 137 registered tools, and 35 of them have
 * payload shapes tools-core does not own (orchestrator routes and services).
 * So the algorithm walks the VALUE. Under the cap it returns the input
 * verbatim — the overwhelming majority path, and byte-for-byte unchanged.
 * Above it, it repeatedly reduces the largest reducible site and re-measures
 * the FULL emitted payload (reductions + cursor pass + marker) each time, so
 * the thing being compared to the cap is the thing that is actually emitted.
 */

/**
 * Characters of tool result the model may see per call.
 *
 * DELIBERATELY UNCHANGED at the value the loop has always used. Moving it is a
 * context-window change with downstream ceilings — `ai-gateway/schemas.py`
 * caps a single message at 32,000 chars and a request at 128,000 — and it is
 * what `prompt-budget.consts.ts` (`ITERATION_MIN_HEADROOM`) is calibrated
 * against: "sized so one more 8000-char tool result can't fit anyway". Changing
 * it belongs with the Phase 2 budget rail, not here.
 */
export const MODEL_TOOL_RESULT_CAP_CHARS = 8000;

/**
 * Cap for the loop's OWN control envelopes (forbidden tool, unknown tool,
 * self-heal, repeated call). These are authored by the agent loop, not by a
 * tool, so they are never measured against a dynamic budget: they are small,
 * fixed-shape, and their only variable part is the advertised-tool name list.
 * A canary test pins the real registry's worst-case envelope well under this
 * value, so the reducer never actually engages today — but when it does
 * (registry growth), the cut is the same JSON-safe bounding tool results get
 * (WARP-2525), never a raw character slice.
 */
export const CONTROL_ENVELOPE_CAP_CHARS = 4000;

/**
 * The `tool` the marker names when the bounded text is a loop-authored
 * control envelope rather than a tool result (WARP-2525). Fixed vocabulary:
 * the loop is the producer, so there is no tool name to report.
 */
const CONTROL_ENVELOPE_TOOL_LABEL = "control_envelope";

/**
 * The one key this module adds. Verified collision-free across tools-core
 * handlers, orchestrator routes/services, mcp-server and the dashboard.
 *
 * It cannot be `truncated`: that is already a LIVE producer key in
 * `summarize-file.ts`, `business/profile-get.ts` and `read-file.ts`, and
 * colliding with it would overwrite a producer's own honest flag.
 */
export const TRUNCATION_MARKER_KEY = "_orchestrator_truncation";

/** Wrapper key for a root that cannot carry the marker (array/scalar/string). */
export const WRAPPED_VALUE_KEY = "value";

/**
 * Keys that mean "call again from here". EXACT match, never prefix: `data/
 * date-math.ts` emits `next_weekday`, which is a VALUE, and a prefix match
 * would silently delete it. Grounded in a grep of every producer surface —
 * both `packages/tools-core/src/handlers` and the orchestrator routes/services
 * that own the other 35 tools' shapes (`nextCursor` in `camera.service.ts` and
 * `team-chat.ts` are real cursors the narrower grep missed). The canary test
 * re-runs that grep and fails when a new cursor-shaped key appears.
 */
export const CURSOR_KEYS: ReadonlySet<string> = new Set([
  "next_offset",
  "nextOffset",
  "next_chunk",
  "nextChunk",
  "next_cursor",
  "nextCursor",
  "next_page",
  "nextPage",
  "next_page_token",
  "nextPageToken",
  "next_token",
  "nextToken",
  "next_link",
  "nextLink",
  "cursor",
  "continuation_token",
  "continuationToken",
  "resume_token",
  "resumeToken",
  "scroll_id",
  "scrollId",
  "page_token",
  "pageToken",
]);

/**
 * The accounting a cursor sits in. When a cursor is DELETED, these go with it
 * (B4): `read_document_text` emits `start_chunk` and `chunks_returned` beside
 * `next_chunk`, and deleting only the cursor-named key leaves the model able to
 * reconstruct it as `start_chunk + chunks_returned` — a reconstruction that is
 * WRONG, because chunk indices are explicitly not promised dense.
 *
 * EXACT match. `total_mb` (a disk-size fact), `start_date` and `start_time`
 * (query echoes) are deliberately absent and a prefix match would have eaten
 * all three.
 */
export const PAGING_ACCOUNTING_KEYS: ReadonlySet<string> = new Set([
  "offset",
  "start_chunk",
  "startChunk",
  "chunks_returned",
  "chunksReturned",
  "total_chunks",
  "totalChunks",
  "chars_total",
  "charsTotal",
  "bytes_total",
  "bytesTotal",
  "count",
  "total",
  "total_count",
  "totalCount",
  "returned",
  "limit",
  "page",
  "per_page",
  "perPage",
  "page_size",
  "pageSize",
]);

/**
 * Keys whose value may serve as the BASE of a cursor - the "you asked to start
 * here" number a producer publishes alongside its continuation token.
 *
 * A recompute rewrites `cursor := base + delivered`, so the base is the one
 * term we are NOT allowed to guess. Requiring it to come from a paging-NAMED
 * sibling is what stops the module inferring a base out of whatever arithmetic
 * happens to close. A payload carrying two unrelated integers,
 *
 *   { content: "A"x9000, offset: 0, next_offset: null, a: 3000, b: 12000 }
 *
 * has `3000 + 9000 === 12000`, so an "any numeric sibling may be the base" rule
 * infers base 3000 and hands the model a cursor 3,000 characters PAST the end
 * of a body it just shortened - exactly the class of lie this module exists to
 * remove. EXACT match, and a strict subset of PAGING_ACCOUNTING_KEYS.
 *
 * A bare literal 0 is NOT an allowed base: the producer has to have PUBLISHED
 * the start it is counting from. Both live paging tools do (`read_file` always
 * emits `offset`, `read_document_text` always emits `start_chunk`).
 */
export const CURSOR_BASE_KEYS: ReadonlySet<string> = new Set([
  "offset",
  "start_chunk",
  "startChunk",
]);

/**
 * Keys whose value may corroborate "the collection ends here" when a cursor is
 * `null`. A null cursor publishes no number, so the base cannot be checked
 * against it; the only remaining evidence is that `base + preLength` lands
 * exactly on a total the producer itself published.
 *
 * `bytes_total` is deliberately ABSENT. `read_file` reports it beside
 * `chars_total`, and on any non-ASCII file the two differ - a BYTE total
 * cannot corroborate a CHARACTER cursor, and letting it try would make the
 * inference silently wrong precisely on multi-byte documents.
 */
export const COLLECTION_TOTAL_KEYS: ReadonlySet<string> = new Set([
  "chars_total",
  "charsTotal",
  "total_chunks",
  "totalChunks",
  "total",
  "total_count",
  "totalCount",
  "count",
  "length",
]);

/**
 * A sibling body within this factor of the reduced one makes the level
 * AMBIGUOUS, and an ambiguous cursor is deleted rather than recomputed.
 *
 * Shape alone cannot say WHICH body a cursor pages over, and the arithmetic
 * can close over the wrong one exactly:
 *
 *   { content: "C"x3000, sidecar: "S"x9000, offset: 0, next_offset: 9000 }
 *
 * `next_offset - offset === sidecar.length`, so shortening `sidecar` "closes"
 * and the model is told to resume at 4365 - skipping characters 3000-4364 of
 * `content`, which it received IN FULL. Deleting on ambiguity is the fail-safe
 * direction, and this factor only decides WHEN to fail safe.
 *
 * Calibrated against the one live shape that must keep recomputing: `read_file`
 * pairs a `path` of a few dozen characters with a `content` of 10,000 - a ratio
 * above 50 - so a competing body would have to exceed 1,250 characters before
 * it disqualified a real page. The adversarial pair above sits at a ratio of 3.
 */
const BODY_AMBIGUITY_RATIO = 8;


/**
 * Booleans that become a completeness CLAIM about a body we just cut.
 * `summarize_file` emits `truncated` to describe the input its summarizer saw;
 * beside a shortened summary the model reads it as "this summary is complete".
 * `has_more: false` is the same over-claim wearing a different name.
 */
export const COMPLETENESS_KEYS: ReadonlySet<string> = new Set([
  "truncated",
  "complete",
  "partial",
  "has_more",
  "hasMore",
]);

/** Why a bounding attempt gave up. Fixed vocabulary — never payload text. */
export type BoundingRefusalReason = "irreducible" | "exception";

export interface BoundingRefusal {
  reason: BoundingRefusalReason;
  inputChars: number;
  /** Present only for `exception`; an error MESSAGE, never payload content. */
  detail?: string;
}

/* ------------------------------------------------------------------ *
 * Internal bounds. Every one of them exists to make the loop provably
 * terminate and the marker provably small (B2).
 * ------------------------------------------------------------------ */

/**
 * Hard iteration bound on the reduction loop, and THE CONSTANT THAT BINDS.
 *
 * At most one reduction is applied per iteration, so this is also the maximum
 * number of reductions a single result can receive: a payload needing a 17th
 * is refused. Stated because the previous pairing lied - a 32-probe budget at
 * 4 probes per iteration capped the loop at EIGHT applied reductions, so the
 * iteration bound never bound, and a payload of 12 comparable large siblings
 * refused while 11 succeeded, with nothing naming 8 as the real limit.
 *
 * Refusing carries ZERO characters, and this module's own honesty argument
 * rejects refusal wherever content can be delivered instead - so the probe
 * budget below is now sized so that this constant, and only this constant,
 * decides where that cliff sits. No live registry tool emits 17 comparable
 * large siblings; the bound exists to keep the work bounded, not to filter.
 */
const MAX_REDUCTION_ITERATIONS = 16;
/** Sites fully evaluated per iteration. Each costs a short binary search. */
const MAX_PROBES_PER_ITERATION = 4;
/**
 * Sites fully evaluated across the whole call. Deliberately
 * `MAX_REDUCTION_ITERATIONS * MAX_PROBES_PER_ITERATION`, so every iteration the
 * loop is allowed to run can actually spend a full probe budget and this
 * never becomes the binding constant behind the other one's back.
 */
const MAX_PROBES_TOTAL = MAX_REDUCTION_ITERATIONS * MAX_PROBES_PER_ITERATION;
/**
 * Below this a string is not worth a `reduced[]` entry — cutting it saves less
 * than the ~45-55 characters the entry costs, so the reduction net-GROWS the
 * payload. A work bound rather than an output guard (the strict-progress rule
 * would reject such a candidate anyway), and it doubles as the threshold for
 * "is this sibling big enough to be a competing BODY" in the cursor pass.
 */
export const MIN_REDUCIBLE_STRING = 40;
/** Deeper than this we stop looking for sites (and stop copying). */
const MAX_WALK_DEPTH = 12;
/** Marker size bounds. */
const MAX_MARKER_REDUCTIONS = 6;
const MAX_MARKER_KEYS = 12;
const MAX_MARKER_KEY_CHARS = 48;
const MAX_MARKER_PATH_CHARS = 60;
const MAX_TOOL_NAME_CHARS = 64;

const REDUCED_NOTE =
  "The orchestrator shortened this tool result to fit the model's per-result " +
  "budget. Any key listed in removed_keys was deleted because it described " +
  "content that is no longer here; treat it as unknown, not as zero. To get a " +
  "complete, self-describing page, call the tool again with a smaller page " +
  "argument (for example a lower max_chars or limit).";

const REFUSED_NOTE =
  "The orchestrator could not shorten this tool result to fit the model's " +
  "per-result budget without leaving a misleading fragment, so no content is " +
  "included. Call the tool again with a smaller page argument (for example a " +
  "lower max_chars or limit), or narrow the request.";

/* ------------------------------------------------------------------ *
 * Value helpers
 * ------------------------------------------------------------------ */

type JsonPath = readonly (string | number)[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function pathKey(path: JsonPath): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("");
}

function safeToolName(toolName: string): string {
  return toolName.slice(0, MAX_TOOL_NAME_CHARS).replace(/[^\w:.\-]/g, "_");
}

/**
 * Leading half of a surrogate pair. Cutting between the halves leaves a lone
 * surrogate, which becomes U+FFFD the moment anything UTF-8-encodes the string
 * — the character is destroyed, not merely shortened. `read_file` already
 * refuses to split one at its own page boundary; the bounding step must not
 * reintroduce the very defect the handler guards against.
 *
 * DEFENSIVE, and currently UNREACHABLE — stated plainly because a mutation
 * test cannot kill it, and the next reader deserves to know why rather than
 * deleting it as dead code. Two facts conspire. Well-formed `JSON.stringify`
 * (ES2019) escapes a lone surrogate as `\udXXX`: six characters where the
 * completed pair costs two. And `largestFitting` terminates on
 * `fits(lo) && !fits(lo + 1)`. So for any cut that would strand a high
 * surrogate, cutting ONE character further is both legal and strictly SHORTER
 * — `fits(lo + 1)` holds and the search cannot stop there. The
 * "escapes a lone surrogate" test pins the first fact; if an engine ever stops
 * escaping, this guard becomes load-bearing again with no code change.
 *
 * `largestFitting` has a SECOND exit, `if (fits(max)) return max`, which does
 * not consult `max + 1` — so the argument above does not cover it, and it
 * needs its own. `max` is `site.len - 1`: a one-character cut. Its emitted
 * length is `current - 1 + markerEntry`, the entry costs at least ~45
 * characters, and `current` is over the cap by definition when a reduction is
 * being chosen — so `fits(max)` is false for a string site and the exit is
 * unreachable for exactly the case that matters here.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function headString(s: string, n: number): string {
  let end = Math.max(0, Math.min(n, s.length));
  if (end > 0 && end < s.length && isHighSurrogate(s.charCodeAt(end - 1))) {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * Cheap serialized-size estimate, computed bottom-up in one pass. Used only to
 * RANK candidate sites, so an approximation is fine; a real `JSON.stringify`
 * per node would be O(n·depth) on every walk.
 */
function estimateSize(v: unknown, depth = 0): number {
  if (typeof v === "string") return v.length + 2;
  if (v === null) return 4;
  if (typeof v === "number" || typeof v === "boolean") return String(v).length;
  if (depth >= MAX_WALK_DEPTH) return 2;
  if (Array.isArray(v)) {
    let n = 2 + Math.max(0, v.length - 1);
    for (const item of v) n += estimateSize(item, depth + 1);
    return n;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    let n = 2 + Math.max(0, keys.length - 1);
    for (const k of keys) n += k.length + 3 + estimateSize(v[k], depth + 1);
    return n;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * Reductions
 * ------------------------------------------------------------------ */

interface Reduction {
  readonly path: JsonPath;
  readonly kind: "array" | "string";
  /** Length BEFORE the reduction — the number a producer's own count matched. */
  readonly from: number;
  /** Length ACTUALLY delivered. Not the requested `n`: a surrogate-safe string
   *  cut can give back one character less. Every recompute uses THIS. */
  readonly to: number;
}

interface Site {
  readonly path: JsonPath;
  readonly kind: "array" | "string";
  readonly len: number;
  readonly weight: number;
}

function findSites(root: unknown): Site[] {
  const sites: Site[] = [];
  const visit = (node: unknown, path: JsonPath, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (typeof node === "string") {
      if (node.length >= MIN_REDUCIBLE_STRING) {
        sites.push({ path, kind: "string", len: node.length, weight: node.length + 2 });
      }
      return;
    }
    if (Array.isArray(node)) {
      if (node.length >= 1) {
        sites.push({ path, kind: "array", len: node.length, weight: estimateSize(node) });
      }
      for (let i = 0; i < node.length; i++) visit(node[i], [...path, i], depth + 1);
      return;
    }
    if (isPlainObject(node)) {
      for (const k of Object.keys(node)) visit(node[k], [...path, k], depth + 1);
    }
  };
  visit(root, [], 0);
  return sites;
}

/**
 * Structural-sharing write. Returns a new root with `path` replaced; untouched
 * subtrees are shared, so applying a handful of reductions is cheap even on a
 * large payload. Returns the input unchanged if the path does not resolve.
 */
function setAtPath(root: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    if (!Array.isArray(root) || head < 0 || head >= root.length) return root;
    const next = setAtPath(root[head], rest, value);
    if (next === root[head]) return root;
    const copy = root.slice();
    copy[head] = next;
    return copy;
  }
  if (!isPlainObject(root) || !Object.prototype.hasOwnProperty.call(root, head)) return root;
  const next = setAtPath(root[head], rest, value);
  if (next === root[head]) return root;
  return { ...root, [head]: next };
}

function readAtPath(root: unknown, path: JsonPath): unknown {
  let node: unknown = root;
  for (const p of path) {
    if (typeof p === "number") {
      if (!Array.isArray(node) || p < 0 || p >= node.length) return undefined;
      node = node[p];
    } else {
      if (!isPlainObject(node)) return undefined;
      node = node[p];
    }
  }
  return node;
}

function reducedValue(site: Site, original: unknown, n: number): { value: unknown; to: number } {
  if (site.kind === "string") {
    const cut = headString(original as string, n);
    return { value: cut, to: cut.length };
  }
  const cut = (original as unknown[]).slice(0, Math.max(0, n));
  return { value: cut, to: cut.length };
}

function applyReductions(root: unknown, reductions: readonly Reduction[]): unknown {
  let tree = root;
  for (const r of reductions) {
    const original = readAtPath(tree, r.path);
    if (original === undefined) continue;
    const { value } =
      r.kind === "string"
        ? { value: headString(original as string, r.to) }
        : { value: (original as unknown[]).slice(0, r.to) };
    tree = setAtPath(tree, r.path, value);
  }
  return tree;
}

/* ------------------------------------------------------------------ *
 * The cursor pass — B1/B3/B4 and the completeness discharge.
 *
 * Runs INSIDE `emit`, so everything it adds or removes is part of the
 * quantity measured against the cap. The first design ran it after the
 * size check and only ever ADDED bytes, which put the flagship
 * `read_document_text` path over the cap by ~328 characters.
 * ------------------------------------------------------------------ */

interface CursorPassResult {
  tree: unknown;
  removed: string[];
  recomputed: string[];
}

function applyCursorPass(tree: unknown, reductions: readonly Reduction[]): CursorPassResult {
  const removed = new Set<string>();
  const recomputed = new Set<string>();

  const walk = (node: unknown, path: JsonPath, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH) return node;

    if (Array.isArray(node)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < node.length; i++) {
        const next = walk(node[i], [...path, i], depth + 1);
        if (next !== node[i]) {
          if (out === null) out = node.slice();
          out[i] = next;
        }
      }
      return out ?? node;
    }

    if (!isPlainObject(node)) return node;

    // Children first: a level's own decisions never depend on its subtree.
    let obj: Record<string, unknown> = node;
    for (const k of Object.keys(node)) {
      const next = walk(node[k], [...path, k], depth + 1);
      if (next === node[k]) continue;
      if (obj === node) obj = { ...node };
      // A sub-object the sweep emptied is worse than no key at all: it reads
      // as "this section exists and holds nothing", which is a claim, where
      // the truth is "this section was removed". Drop the key with it.
      if (
        isPlainObject(next) &&
        Object.keys(next).length === 0 &&
        isPlainObject(node[k]) &&
        Object.keys(node[k] as Record<string, unknown>).length > 0
      ) {
        delete obj[k];
        removed.add(k);
        continue;
      }
      obj[k] = next;
    }

    // --- decisions, all read from the SAME pre-write snapshot ---------
    const isRoot = path.length === 0;
    const levelReductions = reductions.filter(
      (r) => r.path.length === path.length + 1 && pathKey(r.path.slice(0, -1)) === pathKey(path),
    );
    // Segment-wise, never a string prefix: `pathKey` would make `.groupsExtra`
    // look like it sits under `.groups`.
    const reducedAtOrUnder = reductions.some(
      (r) => r.path.length >= path.length && path.every((seg, i) => r.path[i] === seg),
    );
    const keys = Object.keys(obj);
    const toDelete = new Set<string>();
    const toSet = new Map<string, number>();

    // (1) Cursors. RECOMPUTE is the preferred discharge, but only under the
    //     conditions below; DELETION is the fallback and is depth-agnostic.
    //
    //     Say plainly what "sound" means here, because this is the one module
    //     whose whole purpose is not lying to the model. The numeric branch is
    //     a VERIFIED rewrite: the producer published both the cursor and the
    //     base, `cursor - preLength === base` is checked against its own
    //     numbers, and the only term that changes is the one that actually
    //     changed. The null branch is an INFERENCE, not a verification - a null
    //     cursor publishes no number to check against - so it is admitted only
    //     when a published base AND a published total corroborate it, and only
    //     when exactly one base does. Anything failing either test is deleted,
    //     which can lose information but can never over-claim.
    const cursorKeysHere = keys.filter((k) => CURSOR_KEYS.has(k));
    if (cursorKeysHere.length > 0) {
      // Preconditions shared by both branches, evaluated once.
      //
      // Exactly ONE reduction at this level. Two make "which body did this
      // cursor describe" unanswerable, and the whole rewrite turns on knowing.
      //
      // Both kinds qualify. An earlier draft restricted this to STRING
      // reductions on the theory that only character offsets can close, but
      // that is wrong in the useful direction: for an array-paged collection
      // `cursor = base + deliveredRows` is exactly the producer's own
      // semantics, and `r.from`/`r.to` are already in the reduced
      // collection's own units, so the arithmetic check is unit-consistent
      // either way. The genuinely un-closable case - `read_document_text`
      // pairing a CHARACTER body with a sparse CHUNK cursor - is rejected by
      // the arithmetic itself, not by a blanket kind test.
      const r = isRoot && levelReductions.length === 1 ? levelReductions[0] : null;

      // ... and the level must hold exactly ONE body big enough to be the
      // thing the cursor pages over. See BODY_AMBIGUITY_RATIO: a comparable
      // second body lets the arithmetic close over the WRONG one, exactly.
      const reducedKey = r ? String(r.path[r.path.length - 1]) : null;
      const unambiguousBody =
        r !== null &&
        keys.every((k) => {
          if (k === reducedKey) return true;
          const v = obj[k];
          const isBody =
            (typeof v === "string" && v.length >= MIN_REDUCIBLE_STRING) ||
            (Array.isArray(v) && v.length >= 1);
          if (!isBody) return true;
          return estimateSize(v) * BODY_AMBIGUITY_RATIO < r.from;
        });

      const allowedBases = new Set<number>();
      const totalValues = new Set<number>();
      for (const k of keys) {
        const v = obj[k];
        if (!isFiniteNumber(v)) continue;
        if (CURSOR_BASE_KEYS.has(k)) allowedBases.add(v);
        if (COLLECTION_TOTAL_KEYS.has(k)) totalValues.add(v);
      }

      for (const k of cursorKeysHere) {
        const v = obj[k];
        if (r !== null && unambiguousBody) {
          if (isFiniteNumber(v)) {
            const base = v - r.from;
            if (allowedBases.has(base)) {
              toSet.set(k, base + r.to);
              continue;
            }
          } else if (v === null) {
            const candidates = new Set<number>();
            for (const b of allowedBases) {
              if (totalValues.has(b + r.from)) candidates.add(b);
            }
            if (candidates.size === 1) {
              toSet.set(k, [...candidates][0] + r.to);
              continue;
            }
          }
        }
        toDelete.add(k);
      }
    }

    // (2) B3 — delivered-count reconciliation. `count` is NOT "how many the
    //     tool found": every producer named in the spec defines it as the
    //     length of the array in the SAME payload. Left alone it is a
    //     falsehood the model will believe.
    //
    //     These are DELETED, not rewritten, and the counter-example is real:
    //     on a single-page `read_file` the file's true `chars_total` EQUALS
    //     `content.length`, so rewriting every scalar that matched the
    //     pre-reduction length would turn a true statement about the file into
    //     a false one. Absence never over-claims.
    for (const r of levelReductions) {
      for (const k of keys) {
        if (toSet.has(k) || CURSOR_KEYS.has(k)) continue;
        if (isFiniteNumber(obj[k]) && obj[k] === r.from) toDelete.add(k);
      }
    }

    // (3) B4 — the accounting group. A survivor reconstructs the cursor, and
    //     the reconstruction is wrong.
    //
    //     Gated on a reduction AT OR UNDER this level. Cursor deletion is
    //     depth-agnostic, but the accounting group around a cursor is not:
    //     without this gate, a `{ pagination: { nextCursor, total, limit,
    //     page } }` sub-object that nothing touched lost three STILL-TRUE
    //     numbers because a cursor beside them was swept.
    //
    //     Per-key, not per-level (WARP-2525): a cursor whose recompute
    //     VERIFIED against the producer's own numbers is not a casualty of
    //     its neighbours. The sweep used to delete EVERY cursor-shaped key at
    //     the level the moment ONE failed — throwing away the one still-true
    //     resume point this pass had just checked. Only the keys that
    //     actually failed go, plus the accounting group: those numbers are
    //     what would let the model reconstruct a DELETED cursor, and that
    //     reconstruction is wrong (chunk indices are not promised dense).
    if (reducedAtOrUnder && cursorKeysHere.some((k) => toDelete.has(k))) {
      for (const k of keys) {
        if (toSet.has(k)) continue; // a verified recompute survives
        if (PAGING_ACCOUNTING_KEYS.has(k) || CURSOR_KEYS.has(k)) {
          toDelete.add(k);
        }
      }
    }

    // (4) Completeness flags cannot outlive the body they describe — same
    //     gate, for the same reason: `complete: true` on an untouched
    //     sub-object is still true.
    if (
      reducedAtOrUnder &&
      (levelReductions.length > 0 || cursorKeysHere.some((k) => toDelete.has(k)))
    ) {
      for (const k of keys) {
        if (COMPLETENESS_KEYS.has(k) && typeof obj[k] === "boolean") toDelete.add(k);
      }
    }

    if (toDelete.size === 0 && toSet.size === 0) return obj;

    const out: Record<string, unknown> = obj === node ? { ...node } : obj;
    for (const k of toDelete) {
      delete out[k];
      removed.add(k);
    }
    for (const [k, v] of toSet) {
      out[k] = v;
      recomputed.add(k);
    }
    return out;
  };

  return {
    tree: walk(tree, [], 0),
    removed: [...removed].sort(),
    recomputed: [...recomputed].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * Emission
 * ------------------------------------------------------------------ */

function buildMarker(
  toolName: string,
  originalChars: number,
  reductions: readonly Reduction[],
  removed: readonly string[],
  recomputed: readonly string[],
  cap: number,
): Record<string, unknown> {
  const reduced = reductions.slice(0, MAX_MARKER_REDUCTIONS).map((r) => ({
    at: (pathKey(r.path) || "(root)").slice(0, MAX_MARKER_PATH_CHARS),
    kind: r.kind,
    from: r.from,
    to: r.to,
  }));
  const clip = (keys: readonly string[]): string[] =>
    keys.slice(0, MAX_MARKER_KEYS).map((k) => k.slice(0, MAX_MARKER_KEY_CHARS));
  return {
    cap_chars: cap,
    original_chars: originalChars,
    tool: safeToolName(toolName),
    ...(reduced.length > 0 ? { reduced } : {}),
    ...(removed.length > 0 ? { removed_keys: clip(removed) } : {}),
    ...(recomputed.length > 0 ? { recomputed_keys: clip(recomputed) } : {}),
    note: REDUCED_NOTE,
  };
}

/**
 * The measured quantity. ONE `JSON.stringify` over an object literal — never
 * string concatenation, which is how a "bounded" payload becomes invalid JSON
 * in the first place.
 */
function emit(
  root: unknown,
  reductions: readonly Reduction[],
  toolName: string,
  originalChars: number,
  cap: number,
): string {
  const reducedTree = applyReductions(root, reductions);
  const pass = applyCursorPass(reducedTree, reductions);
  const marker = buildMarker(
    toolName,
    originalChars,
    reductions,
    pass.removed,
    pass.recomputed,
    cap,
  );
  if (isPlainObject(pass.tree)) {
    return JSON.stringify({ ...pass.tree, [TRUNCATION_MARKER_KEY]: marker });
  }
  // B5 — a non-plain-object root is REACHABLE, not theoretical:
  // `list_files` returns the files API's body verbatim (a bare array), and
  // `control_device` / `get_smart_home_device` / `list_smart_home_devices`
  // return whatever the Matter sidecar handed back, statically `unknown`.
  // A scalar, an array, a string, `null` — all land here.
  return JSON.stringify({
    [WRAPPED_VALUE_KEY]: pass.tree,
    [TRUNCATION_MARKER_KEY]: marker,
  });
}

function refusalEnvelope(
  toolName: string,
  originalChars: number,
  reason: BoundingRefusalReason,
  cap: number,
): string {
  return JSON.stringify({
    [TRUNCATION_MARKER_KEY]: {
      cap_chars: cap,
      original_chars: originalChars,
      tool: safeToolName(toolName),
      refused: true,
      reason,
      note: REFUSED_NOTE,
    },
  });
}

/**
 * Largest `n` for which `fits(n)` holds, searched from BELOW so every trial
 * serializes a small tree rather than a nearly-whole one. Returns null when
 * even `n = 0` does not fit.
 */
function largestFitting(fits: (n: number) => boolean, max: number): number | null {
  if (max < 0) return null;
  if (!fits(0)) return null;
  if (fits(max)) return max;
  let lo = 0;
  let hi = 1;
  while (hi < max && fits(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi > max) hi = max;
  // Invariant: fits(lo) && !fits(hi).
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function reduceToFit(
  text: string,
  toolName: string,
  onRefusal: ((r: BoundingRefusal) => void) | undefined,
  cap: number,
): string {
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    // mcp-server always emits JSON, but a raw stdio hiccup does not. Treat the
    // whole thing as a string root rather than handing the model a cut blob —
    // it still leaves via the B5 wrapper as valid JSON.
    root = text;
  }

  const originalChars = text.length;
  const reductions: Reduction[] = [];
  const settled = new Set<string>();
  let probes = 0;

  for (let iteration = 0; iteration < MAX_REDUCTION_ITERATIONS; iteration++) {
    const current = emit(root, reductions, toolName, originalChars, cap);
    if (current.length <= cap) return current;

    const reducedTree = applyReductions(root, reductions);
    const sites = findSites(reducedTree)
      .filter((s) => !settled.has(pathKey(s.path)))
      .sort((a, b) => b.weight - a.weight);
    if (sites.length === 0) break;

    let best: { proposal: Reduction; length: number } | null = null;
    let probedHere = 0;
    for (const site of sites) {
      // A site can save at most its own serialized weight, so if cutting ALL
      // of it still leaves us over the cap it cannot beat a candidate that
      // already fits. Pruned WITHOUT a probe: on a 20,000-row payload this is
      // the difference between one binary search and twenty thousand.
      const couldFit = current.length - site.weight <= cap;
      if (best !== null && best.length <= cap && !couldFit) continue;
      if (probedHere >= MAX_PROBES_PER_ITERATION || probes >= MAX_PROBES_TOTAL) break;

      probedHere++;
      probes++;
      const original = readAtPath(reducedTree, site.path);
      if (original === undefined) {
        settled.add(pathKey(site.path));
        continue;
      }

      const build = (n: number): Reduction => {
        const { to } = reducedValue(site, original, n);
        return { path: site.path, kind: site.kind, from: site.len, to };
      };
      const lengthWith = (n: number): number =>
        emit(root, [...reductions, build(n)], toolName, originalChars, cap).length;

      const fitting = largestFitting((n) => lengthWith(n) <= cap, site.len - 1);
      const proposal = build(fitting ?? 0);
      if (proposal.to >= site.len) {
        settled.add(pathKey(site.path));
        continue;
      }
      const length = lengthWith(proposal.to);

      // B2 — STRICT progress. Each applied reduction also appends a
      // `reduced[]` entry to the marker, so reducing a SMALL site can
      // net-INCREASE the output. A candidate that does not strictly shrink the
      // emitted payload is never applied.
      //
      // Say plainly what this does and does not buy, because a mutation test
      // cannot kill it. `current` is over the cap by definition here, so any
      // candidate that FITS also strictly shrinks - which means this rule only
      // ever rejects stepping stones, and a rejected stepping stone can never
      // have been the largest site (a net-growing reduction saves less than
      // its own marker entry, so its site is smaller than that entry, so every
      // site is). A payload whose largest site is that small cannot be brought
      // under the cap by ANY combination of reductions, and refuses either
      // way. So this rule is provably OUTPUT-INVARIANT; what it buys is that
      // the loop's progress argument holds without leaning on the iteration
      // bound, and that `reduced[]` never advertises a cut that cost more than
      // it saved. The `never records a reduction that did not shrink its site`
      // test pins the observable half.
      if (length >= current.length) {
        settled.add(pathKey(site.path));
        continue;
      }

      if (best === null) {
        best = { proposal, length };
        continue;
      }
      const bestFits = best.length <= cap;
      const thisFits = length <= cap;
      if (thisFits !== bestFits) {
        if (thisFits) best = { proposal, length };
      } else if (thisFits) {
        // Both fit: prefer the one that DELIVERS MORE. Without this a payload
        // shaped `{rows: ["<9000 chars>", "a"]}` reduces the ARRAY (the
        // heaviest site) to zero elements and hands the model an empty list,
        // when shortening the one dominant element would have delivered ~7,600
        // characters of the thing it asked for.
        if (length > best.length) best = { proposal, length };
      } else if (length < best.length) {
        // Neither fits: prefer the bigger step toward the cap.
        best = { proposal, length };
      }
    }

    if (best === null) {
      // Nothing probed this pass could shrink the payload. Keep going only
      // while unprobed sites remain and the budget allows — a REJECTED site is
      // `settled`, so the next pass sees a strictly smaller candidate set and
      // the loop still terminates.
      if (probes >= MAX_PROBES_TOTAL || probedHere < MAX_PROBES_PER_ITERATION) break;
      continue;
    }
    // Only the WINNER is settled. A site that merely lost this comparison has
    // to stay eligible: `{a, b, c}` at 5 KB each needs all three, and settling
    // the two losers on the pass that reduced `a` emptied the candidate set and
    // refused a payload two reductions handle comfortably.
    settled.add(pathKey(best.proposal.path));
    reductions.push(best.proposal);
  }

  const final = emit(root, reductions, toolName, originalChars, cap);
  if (final.length <= cap) return final;

  onRefusal?.({ reason: "irreducible", inputChars: originalChars });
  return refusalEnvelope(toolName, originalChars, "irreducible", cap);
}

/**
 * Bound one tool result for the model's next turn.
 *
 * TEXT in, model-facing TEXT out. Under the cap the input is returned
 * VERBATIM — no parse, no re-serialization, no shape change. That is the
 * overwhelming majority path and it is byte-for-byte what the tool produced.
 *
 * @param text     the raw `content[0].text` mcp-server put on the wire
 * @param toolName the tool that produced it, for the marker and the refusal log
 * @param onRefusal called ONLY when zero content could be carried, so the loop
 *                  can log `agent_tool_result_refused` with its own
 *                  correlation keys. Never called on the success paths.
 */
export function boundToolResultForModel(
  text: string,
  toolName: string,
  onRefusal?: (r: BoundingRefusal) => void,
): string {
  if (text.length <= MODEL_TOOL_RESULT_CAP_CHARS) return text;
  try {
    return reduceToFit(text, toolName, onRefusal, MODEL_TOOL_RESULT_CAP_CHARS);
  } catch (err) {
    // No outer try/catch was the majors' finding, and it is what actually
    // makes "every payload the model receives is valid JSON" TRUE. The old
    // `text.slice(0, 8000)` could not throw; a multi-hundred-line walker can,
    // and a reducer bug would otherwise become a dead turn — the model gets
    // nothing back for a tool_call it must answer.
    onRefusal?.({
      reason: "exception",
      inputChars: text.length,
      detail: err instanceof Error ? err.message : String(err),
    });
    return refusalEnvelope(toolName, text.length, "exception", MODEL_TOOL_RESULT_CAP_CHARS);
  }
}

/**
 * Bound one of the agent loop's OWN control envelopes (forbidden tool, unknown
 * tool, self-heal, repeated call) at the static envelope cap.
 *
 * WARP-2525 — this was a plain `text.slice(0, 4000)`: the exact defect this
 * module exists to remove for tool results, reintroduced for the loop's own
 * envelopes. An envelope over the cap was cut mid-string into invalid JSON
 * with its tail fields deleted. Now over-cap envelopes go through the SAME
 * JSON-safe bounding as tool results, just measured against the envelope cap
 * (and the exception rail lands on a refusal envelope, never a raw cut).
 *
 * The rail-not-transform property is unchanged in practice: envelopes are
 * loop-authored and fixed-shape, and the canary test pins the real registry's
 * worst-case envelope well under the cap, so the reducer never actually
 * engages today. What changed is what happens when it someday does.
 */
export function boundControlEnvelopeForModel(text: string): string {
  if (text.length <= CONTROL_ENVELOPE_CAP_CHARS) return text;
  try {
    return reduceToFit(
      text,
      CONTROL_ENVELOPE_TOOL_LABEL,
      undefined,
      CONTROL_ENVELOPE_CAP_CHARS,
    );
  } catch {
    // Same argument as boundToolResultForModel's outer catch: a reducer bug
    // must degrade to a valid-JSON refusal, never to a dead or torn turn.
    return refusalEnvelope(
      CONTROL_ENVELOPE_TOOL_LABEL,
      text.length,
      "exception",
      CONTROL_ENVELOPE_CAP_CHARS,
    );
  }
}
