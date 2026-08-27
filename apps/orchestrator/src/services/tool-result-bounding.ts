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
 *   1. RECOMPUTE the cursor from what was actually delivered (exact).
 *   2. DELETE the cursor — and the whole accounting group around it, because a
 *      survivor can reconstruct the deleted cursor and the reconstruction is
 *      wrong (chunk indices are not dense; see `read-document-text.ts`).
 *   3. REFUSE, carrying zero bytes. Last resort, and logged.
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
 * tool, so they are never measured against a dynamic budget and never walked
 * by the reducer: they are small, fixed-shape, and their only variable part is
 * the advertised-tool name list. A canary test pins the real registry's
 * worst-case envelope well under this value.
 */
export const CONTROL_ENVELOPE_CAP_CHARS = 4000;

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

/** Hard iteration bound on the reduction loop. */
const MAX_REDUCTION_ITERATIONS = 16;
/** Sites fully evaluated per iteration. Each costs a short binary search. */
const MAX_PROBES_PER_ITERATION = 4;
/** Sites fully evaluated across the whole call. Bounds total work. */
const MAX_PROBES_TOTAL = 32;
/** Below this a string is not worth a `reduced[]` entry — reducing it grows. */
const MIN_REDUCIBLE_STRING = 40;
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
      if (next !== node[k]) {
        if (obj === node) obj = { ...node };
        obj[k] = next;
      }
    }

    // --- decisions, all read from the SAME pre-write snapshot ---------
    const isRoot = path.length === 0;
    const levelReductions = reductions.filter(
      (r) => r.path.length === path.length + 1 && pathKey(r.path.slice(0, -1)) === pathKey(path),
    );
    const keys = Object.keys(obj);
    const numericValues = new Set<number>();
    for (const k of keys) {
      const v = obj[k];
      if (isFiniteNumber(v)) numericValues.add(v);
    }

    const toDelete = new Set<string>();
    const toSet = new Map<string, number>();

    // (1) Cursors. Recompute is ROOT-LEVEL and needs exactly one reduction at
    //     this level; everything else is deleted. Deletion is depth-agnostic.
    const cursorKeysHere = keys.filter((k) => CURSOR_KEYS.has(k));
    for (const k of cursorKeysHere) {
      const v = obj[k];
      if (isRoot && levelReductions.length === 1) {
        const r = levelReductions[0];
        if (isFiniteNumber(v)) {
          // The identity `cursor = base + deliveredLength` held before the
          // reduction, and delivered length is the only term that changed.
          const base = v - r.from;
          if (base === 0 || numericValues.has(base)) {
            toSet.set(k, base + r.to);
            continue;
          }
        } else if (v === null) {
          // `null` means "exhausted" — the strongest over-claim there is once
          // the body is cut. Its implied numeric value is `base + from`, and
          // the base is identifiable when `base + from` equals a sibling total
          // (the file/collection length). Unique or nothing.
          const candidates = new Set<number>();
          for (const b of [0, ...numericValues]) {
            if (numericValues.has(b + r.from)) candidates.add(b);
          }
          if (candidates.size === 1) {
            toSet.set(k, [...candidates][0] + r.to);
            continue;
          }
        }
      }
      toDelete.add(k);
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
    if (cursorKeysHere.some((k) => toDelete.has(k))) {
      for (const k of keys) {
        if (PAGING_ACCOUNTING_KEYS.has(k) || CURSOR_KEYS.has(k)) {
          toSet.delete(k);
          toDelete.add(k);
        }
      }
    }

    // (4) Completeness flags cannot outlive the body they describe.
    if (levelReductions.length > 0 || cursorKeysHere.some((k) => toDelete.has(k))) {
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
    cap_chars: MODEL_TOOL_RESULT_CAP_CHARS,
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
): string {
  const reducedTree = applyReductions(root, reductions);
  const pass = applyCursorPass(reducedTree, reductions);
  const marker = buildMarker(toolName, originalChars, reductions, pass.removed, pass.recomputed);
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
): string {
  return JSON.stringify({
    [TRUNCATION_MARKER_KEY]: {
      cap_chars: MODEL_TOOL_RESULT_CAP_CHARS,
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
    const current = emit(root, reductions, toolName, originalChars);
    if (current.length <= MODEL_TOOL_RESULT_CAP_CHARS) return current;

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
      const couldFit = current.length - site.weight <= MODEL_TOOL_RESULT_CAP_CHARS;
      if (best !== null && best.length <= MODEL_TOOL_RESULT_CAP_CHARS && !couldFit) continue;
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
        emit(root, [...reductions, build(n)], toolName, originalChars).length;

      const fitting = largestFitting(
        (n) => lengthWith(n) <= MODEL_TOOL_RESULT_CAP_CHARS,
        site.len - 1,
      );
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
      const bestFits = best.length <= MODEL_TOOL_RESULT_CAP_CHARS;
      const thisFits = length <= MODEL_TOOL_RESULT_CAP_CHARS;
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

  const final = emit(root, reductions, toolName, originalChars);
  if (final.length <= MODEL_TOOL_RESULT_CAP_CHARS) return final;

  onRefusal?.({ reason: "irreducible", inputChars: originalChars });
  return refusalEnvelope(toolName, originalChars, "irreducible");
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
    return reduceToFit(text, toolName, onRefusal);
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
    return refusalEnvelope(toolName, text.length, "exception");
  }
}

/**
 * Bound one of the agent loop's OWN control envelopes (forbidden tool, unknown
 * tool, self-heal, repeated call). Deliberately a plain slice at a static cap:
 * these are loop-authored, fixed-shape, and must never be measured against a
 * dynamic budget or walked by the reducer. A canary test pins the real
 * registry's worst-case envelope well under the cap, so this never actually
 * cuts today — it is a rail, not a transform.
 */
export function boundControlEnvelopeForModel(text: string): string {
  return text.slice(0, CONTROL_ENVELOPE_CAP_CHARS);
}
