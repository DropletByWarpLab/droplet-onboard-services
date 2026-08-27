/**
 * WARP-1480 — attribution for agent-loop tool failures.
 *
 * ## Why this module exists
 *
 * `read_file` transiently errors inside agent loops until the iteration budget
 * burns, and the failure is UNATTRIBUTED: nothing in the codebase has ever
 * LOGGED a tool failure. The envelope is preserved end to end — mcp-server's
 * `toolResultToContent` branches on `result.ok` BEFORE any unwrap, so
 * `code`/`message`/`details` reach the wire intact, and `llm-agent.service.ts`
 * parses it — but `result.isError` is only ever READ (to shape the SSE event
 * and to gate citation extraction), never recorded. That absence is the bug.
 *
 * This is the INSTRUMENTATION half of WARP-1480 only. It fixes nothing; it
 * makes the next failure diagnosable. Do not add remediation here.
 *
 * ## Why it is pure
 *
 * No logger, no config, no IO, no clock. The caller passes everything in and
 * logs the returned object itself, so the whole classification surface unit
 * tests without a single mock. The only module-scope effect is the per-process
 * fingerprint salt (see {@link SALT}).
 *
 * ## Why it takes the branded payload
 *
 * The input is a `ToolResultPayload` from `./tool-result-payload.js`, not a
 * hand-rollable object. WARP-1604's brand exists precisely because a test that
 * constructed a shape production never emits hid a contract bug for a full
 * release cycle. Every test here starts from real wire text.
 *
 * ## Privacy posture — this line LEAVES THE BOX
 *
 * `orchestrator` is in `scripts/host/droplet-collect-logs.sh` DEFAULT_SERVICES,
 * so every field below lands in the Settings → "Download Diagnostics" zip
 * (`routes/logs.ts`). THREAT_MODEL T1.8 is the precedent: a bearer-equivalent
 * value reached that bundle with nobody having written a log statement. So:
 *
 *   - every model-controlled string is shape-guarded to a fixed token set or
 *     replaced (`tool`, `arg_keys`, `error_code`),
 *   - argument VALUES are never emitted, only salted digests,
 *   - free text is emitted only for the one shape this repo authors
 *     (`envelope`), and only through the mandatory {@link redactSecrets} scrub.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import { redactSecrets } from "../lib/log-redaction.js";
import {
  toolResultPayloadValue,
  type ToolResultPayload,
} from "./tool-result-payload.js";

/**
 * The four shapes a failing tool call can actually put on the wire. Handling
 * fewer than all four leaves a second population of failures unattributed:
 *
 *   `envelope`     `{status:"error", error:{code,message}}` — every handler
 *                  error, `forbidden_tool_for_role`, and `HANDLER_THREW`.
 *   `string_error` a BARE STRING `error` with no code — mcp-server's unknown-
 *                  tool reply and the ORCH-05 `tool_dispatch_failed` envelope
 *                  the agent loop synthesizes around a thrown dispatch.
 *   `raw`          `{raw:text}` — `parseToolResultPayload`'s non-JSON fallback
 *                  (a stdio hiccup; mcp-server itself always emits JSON).
 *   `unknown`      anything else. Kept as an explicit bucket so a future wire
 *                  change shows up as a spike in one token rather than as
 *                  silence.
 */
export type ToolErrorShape = "envelope" | "string_error" | "raw" | "unknown";

/** The `agent_tool_error` log line, field for field. */
export interface ToolErrorDiagnostics {
  /** Shape-guarded tool name, or `<non-identifier>` — see {@link safeToolName}. */
  readonly tool: string;
  /**
   * Provider-generated call id. THE join key: unlike `thread_id` it is always
   * present (`thread_id` requires conversationId + assistantMessageId +
   * citationUserId to ALL be truthy, so an ephemeral or service-token turn has
   * none). Carries no user content.
   */
  readonly tool_call_id: string;
  /** Minted once per `runAgent` call — groups every failure in one turn. */
  readonly turn_id: string;
  /** Zero-based agent-loop iteration. */
  readonly iter: number;
  /** Present only when the turn is persisted. Never the sole correlation key. */
  readonly thread_id?: string;
  readonly error_shape: ToolErrorShape;
  /** Low-cardinality. NEVER raw upstream or model-supplied text. */
  readonly error_code: string;
  /** Always present, flag-independent — see {@link classifyMessage}. */
  readonly message_class: string;
  /** Length of the pre-redaction message; a discriminator on its own. */
  readonly message_len: number;
  /** `envelope` shape only, flag-gated, redacted. See {@link buildExcerpt}. */
  readonly message_excerpt?: string;
  /** Identifier-shaped argument names only, sorted, capped. */
  readonly arg_keys: readonly string[];
  /** How many keys the guard or the cap removed. Always emitted (0 is a fact). */
  readonly arg_keys_dropped: number;
  /** Salted digest of tool + canonical args — "byte-identical retry?" */
  readonly args_fingerprint: string;
  /** Salted digest of tool + NORMALIZED args — "same target, varied spelling?" */
  readonly args_identity: string;
}

export interface ToolErrorDiagnosticsInput {
  readonly tool: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly iter: number;
  readonly args: Record<string, unknown>;
  readonly payload: ToolResultPayload;
  /**
   * `config.AGENT_BLANK_TURN_DEBUG`. Gates the excerpt ONLY. Everything else on
   * this line — including {@link ToolErrorDiagnostics.message_class} — is
   * always on, because the flag parses `"0"` by default and a default eval run
   * must still attribute the failure.
   */
  readonly includeExcerpt: boolean;
  readonly threadId?: string;
}

// ── Per-process salt ─────────────────────────────────────────────────────────

/**
 * WARP-1480 review blocker 2. An UNSALTED sha256 of `tool + canonical(args)` is
 * a deterministic commitment to a file path: it survives crypto-shred and is
 * checkable against a guessed path by anyone holding the diagnostics zip. The
 * stated purpose of the fingerprint is clustering retries WITHIN one run, so
 * cross-process stability is not wanted and a fresh per-process salt costs
 * nothing.
 *
 * Module scope on purpose: one salt per process, and a `vi.resetModules()` +
 * re-import in the unit spec reproduces a second process exactly.
 */
const SALT = randomBytes(16);

/** 64 bits of a salted sha256 — ample to cluster the calls of a single run. */
function fingerprint(value: string): string {
  return createHash("sha256")
    .update(SALT)
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 16);
}

// ── Shape guards on model-controlled strings ─────────────────────────────────

/**
 * A tool name is model-controlled on the unknown-tool path (the model invents
 * names, and prompt injection can steer them), so it can be arbitrary text
 * including a file path. Anything that is not registry-shaped collapses to one
 * fixed token rather than being logged.
 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const NON_IDENTIFIER = "<non-identifier>";

function safeToolName(name: string): string {
  return TOOL_NAME_RE.test(name) ? name : NON_IDENTIFIER;
}

/**
 * WARP-1480 review blocker 1. Argument KEYS are model-controlled and
 * unvalidated: `safeParseArgs` in the agent loop is a bare `JSON.parse` and
 * nothing checks the object against the tool's `inputSchema` at either end, so
 * a key can be any string at all — a full patient file path included. Only
 * identifier-shaped keys are logged.
 */
const ARG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const MAX_ARG_KEYS = 20;

function safeArgKeys(args: Record<string, unknown>): {
  keys: string[];
  dropped: number;
} {
  let total = 0;
  const kept: string[] = [];
  for (const key of Object.keys(args)) {
    total++;
    if (ARG_KEY_RE.test(key)) kept.push(key);
  }
  kept.sort();
  return { keys: kept.slice(0, MAX_ARG_KEYS), dropped: total - Math.min(kept.length, MAX_ARG_KEYS) };
}

/**
 * `error.code` is repo-authored in every shipped handler, but a handler is free
 * to put anything there; guard it so one malformed code can't become a
 * high-cardinality field.
 */
const ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// ── Canonical + normalized argument identity ─────────────────────────────────

/**
 * Depth ceiling. A pathologically nested or cyclic model-supplied `args` can
 * RangeError inside a naive recursion (the agent loop hit this and added its
 * own guard around `canonicalCallKey`); the ceiling makes that impossible here,
 * and anything past it collapses to a fixed marker so the digest stays stable.
 */
const MAX_ARG_DEPTH = 8;
const DEEP_MARKER = '"__deep__"';

/**
 * Deterministic JSON: object keys sorted, so key insertion order cannot split a
 * cluster. Mirrors the `canonicalJson` closure in `llm-agent.service.ts`.
 */
function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_ARG_DEPTH) return DEEP_MARKER;
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Bound matching `MAX_PATH_LEN` in tools-core's `_paths.ts`. */
const MAX_NORMALIZED_LEN = 4096;

/**
 * WARP-1480 review blocker 3. sha256 is full-avalanche, so a digest of the RAW
 * args can never cluster "slightly varied args" — which is the exact symptom
 * the ticket names ("the model varies args slightly each retry, so the
 * repetition guard does not fire"). Without a normalized identity alongside it
 * the log cannot answer the ticket's own question.
 *
 * The normalization mirrors what the file handlers actually do — see
 * `validateNcPath` in `packages/tools-core/src/handlers/files/_paths.ts`:
 * bounded iterative percent-decode, forced leading slash, collapsed
 * separators, stripped trailing slash. Two spellings of one path therefore
 * collide DELIBERATELY.
 *
 * Two intentional deviations from the handler, both widening the collision:
 *   - leading/trailing whitespace is trimmed (the model adds it; the handler
 *     would treat it as a distinct path),
 *   - backslashes are folded to `/` (the handler only splits on them for its
 *     traversal check).
 * This value is a clustering aid in a log line, never an authorization
 * decision, so over-collision is the safe direction.
 */
function normalizePathLike(input: string): string {
  let decoded = input.trim().slice(0, MAX_NORMALIZED_LEN);
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  decoded = decoded.replace(/\\/g, "/");
  const normalized = path.posix.normalize(
    decoded.startsWith("/") ? decoded : `/${decoded}`,
  );
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/** Recursively normalize every STRING leaf; other types pass through. */
function normalizeArgs(value: unknown, depth: number): unknown {
  if (depth > MAX_ARG_DEPTH) return "__deep__";
  if (typeof value === "string") return normalizePathLike(value);
  if (Array.isArray(value)) return value.map((v) => normalizeArgs(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) out[key] = normalizeArgs(obj[key], depth + 1);
    return out;
  }
  return value;
}

/** Never throws — a getter that throws must not kill the turn being logged. */
function safeCanonical(value: unknown): string {
  try {
    return canonicalJson(value, 0);
  } catch {
    return '"__uncanonicalizable__"';
  }
}

// ── message_class ────────────────────────────────────────────────────────────

/**
 * WARP-1480 review blocker 6. `AGENT_BLANK_TURN_DEBUG` parses `"0"` by default,
 * so on a default eval run the excerpt is absent and several failure classes
 * collapse to a bare code plus a length — the discriminator would depend on a
 * default-off flag. This table is the ALWAYS-ON substitute.
 *
 * It is a fixed allowlist of KNOWN-STATIC literals, and only the TOKEN is ever
 * emitted. Upstream text is matched against it, never copied out of it, so no
 * amount of attacker-controlled message content can widen the field's value set
 * beyond the tokens written here.
 *
 * Ordered most-specific first: an errno inside an undici `terminated` message
 * must win over `terminated`.
 *
 * Accepted imprecision: a substring match can be fooled (an upstream body that
 * happens to contain "Not Found"). It is a triage hint, not evidence.
 */
const MESSAGE_CLASSES: readonly (readonly [string, string])[] = [
  // undici transport — the most discriminating values for an intermittent
  // failure, and exactly what `err.cause` carries.
  ["UND_ERR_HEADERS_TIMEOUT", "headers_timeout"],
  ["UND_ERR_BODY_TIMEOUT", "body_timeout"],
  ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
  ["UND_ERR_SOCKET", "socket_error"],
  ["UND_ERR_ABORTED", "aborted"],
  // node errno
  ["ECONNRESET", "econnreset"],
  ["ECONNREFUSED", "econnrefused"],
  ["ETIMEDOUT", "etimedout"],
  ["ENOTFOUND", "enotfound"],
  ["EAI_AGAIN", "eai_again"],
  ["EHOSTUNREACH", "ehostunreach"],
  ["ENETUNREACH", "enetunreach"],
  ["EPIPE", "epipe"],
  // socket-level phrasing
  ["socket hang up", "socket_hang_up"],
  ["other side closed", "other_side_closed"],
  ["Client network socket disconnected", "tls_socket_disconnected"],
  // repo-authored literals — `read_file`'s own READ_FAILED message is
  // `nextcloud returned ${res.status}`, so the status is a known-static string
  // and the single most useful class for the failure WARP-1480 is about.
  // Enumerated rather than pattern-matched to keep the value set fixed; the
  // bare prefix is the catch-all below them.
  ["nextcloud returned 401", "nextcloud_401"],
  ["nextcloud returned 403", "nextcloud_403"],
  ["nextcloud returned 404", "nextcloud_404"],
  ["nextcloud returned 423", "nextcloud_423_locked"],
  ["nextcloud returned 429", "nextcloud_429"],
  ["nextcloud returned 500", "nextcloud_500"],
  ["nextcloud returned 502", "nextcloud_502"],
  ["nextcloud returned 503", "nextcloud_503"],
  ["nextcloud returned 504", "nextcloud_504"],
  ["nextcloud returned ", "nextcloud_http_error"],
  // repo-authored literals — tools-core `_paths.ts` and the agent loop
  ["path traversal not allowed", "path_traversal"],
  ["malformed percent-encoding in path", "path_bad_percent_encoding"],
  ["empty path segment", "path_empty_segment"],
  ["null byte in path", "path_null_byte"],
  ["path must be a string", "path_not_string"],
  ["path too long", "path_too_long"],
  ["path is required", "path_required"],
  ["Unknown tool:", "unknown_tool"],
  ["tool_dispatch_failed", "tool_dispatch_failed"],
  ["may not call", "forbidden_for_role"],
  // JSON / parse
  ["Unexpected end of JSON input", "json_parse_error"],
  ["Unexpected token", "json_parse_error"],
  // generic undici / fetch wrappers — last, so a cause wins over the wrapper
  ["fetch failed", "fetch_failed"],
  ["The operation was aborted", "aborted"],
  ["AbortError", "aborted"],
  ["terminated", "terminated"],
  // HTTP reason phrases (whole words, not bare status numbers — "404" collides
  // with byte counts and path fragments)
  ["Unauthorized", "unauthorized"],
  ["Forbidden", "forbidden"],
  ["Not Found", "not_found"],
  ["Internal Server Error", "internal_server_error"],
  ["Bad Gateway", "bad_gateway"],
  ["Service Unavailable", "service_unavailable"],
  ["Gateway Timeout", "gateway_timeout"],
];

/** Lowercased once at module load, not per call. Order is preserved. */
const MESSAGE_CLASSES_LC: readonly (readonly [string, string])[] =
  MESSAGE_CLASSES.map(([literal, token]) => [literal.toLowerCase(), token]);

const UNCLASSIFIED_MESSAGE = "unclassified";

/**
 * Scan HEAD + TAIL rather than a single prefix: `describeThrown` in mcp-server
 * APPENDS the cause chain, so on a long base message the one value worth having
 * (`ECONNRESET`) is at the very end.
 */
const CLASSIFY_HEAD = 2048;
const CLASSIFY_TAIL = 512;

function classifyMessage(message: string): string {
  const text =
    message.length <= CLASSIFY_HEAD + CLASSIFY_TAIL
      ? message
      : `${message.slice(0, CLASSIFY_HEAD)}\n${message.slice(-CLASSIFY_TAIL)}`;
  const haystack = text.toLowerCase();
  for (const [literal, token] of MESSAGE_CLASSES_LC) {
    if (haystack.includes(literal)) return token;
  }
  return UNCLASSIFIED_MESSAGE;
}

// ── message_excerpt ──────────────────────────────────────────────────────────

const EXCERPT_LEN = 500;
/** Redaction is linear in input size; bound the scan so one giant message can't stall the loop. */
const MAX_REDACT_INPUT = 64_000;

/**
 * WARP-1480 review blocker 4. The excerpt is restricted to the `envelope`
 * shape. `string_error` and `raw` carry text this repo did NOT author — an
 * upstream response body, a URL with a live token — and can contain a
 * credential; for those the caller gets `message_len` + the synthesized code +
 * `message_class`, which is enough to attribute without shipping the text.
 *
 * Even the envelope excerpt goes through {@link redactSecrets}, the mandatory
 * scrub applied to every byte before it can leave the appliance
 * (architecture-guard rule 19). Redact BEFORE truncating, so truncation cannot
 * split a secret past the point a rule could match it.
 */
function buildExcerpt(message: string, shape: ToolErrorShape, include: boolean): string | undefined {
  if (!include || shape !== "envelope" || message.length === 0) return undefined;
  const excerpt = redactSecrets(message.slice(0, MAX_REDACT_INPUT)).slice(0, EXCERPT_LEN);
  // Belt and braces: a PEM whose END delimiter fell outside MAX_REDACT_INPUT
  // cannot be matched by the block rule, which would ship a scrap of key
  // material. Drop the excerpt entirely rather than emit it half-scrubbed.
  if (excerpt.includes("-----BEGIN")) return undefined;
  return excerpt.length > 0 ? excerpt : undefined;
}

// ── Classification ───────────────────────────────────────────────────────────

interface Classified {
  shape: ToolErrorShape;
  code: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function classify(value: unknown): Classified {
  if (isPlainObject(value)) {
    const error = value.error;

    // Shape 1 — the structured envelope. Object `error` is the discriminant;
    // `status` is not, because `confirmation_required` never reaches this
    // module (mcp-server sets isError only for status "error").
    if (isPlainObject(error)) {
      const rawCode = asString(error.code);
      const code =
        rawCode === undefined
          ? "MISSING_CODE"
          : ERROR_CODE_RE.test(rawCode)
            ? rawCode
            : NON_IDENTIFIER;
      return { shape: "envelope", code, message: asString(error.message) ?? "" };
    }

    // Shape 2 — a BARE STRING error with no code. Two producers: mcp-server's
    // unknown-tool reply and the agent loop's ORCH-05 dispatch-throw wrapper.
    // The string itself must never become the code: the unknown-tool text
    // embeds a model-supplied name, which would explode field cardinality and
    // carry model input into the diagnostics bundle.
    if (typeof error === "string") {
      const code =
        error === "tool_dispatch_failed"
          ? "TOOL_DISPATCH_FAILED"
          : error.startsWith("Unknown tool:")
            ? "UNKNOWN_TOOL"
            : "UNSTRUCTURED_ERROR";
      // `tool_dispatch_failed` puts the real text in a sibling `message`.
      return { shape: "string_error", code, message: asString(value.message) ?? error };
    }

    // Shape 3 — `parseToolResultPayload`'s non-JSON fallback.
    const raw = asString(value.raw);
    if (raw !== undefined && error === undefined) {
      return { shape: "raw", code: "NON_JSON_RESULT", message: raw };
    }
  }

  // Shape 4 — everything else, including an isError=true call whose body
  // parsed to something with no error field at all.
  return { shape: "unknown", code: "UNCLASSIFIED", message: asString(value) ?? "" };
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** Provider-generated ids are short in practice; bound the pathological case. */
const MAX_CALL_ID_LEN = 64;

/**
 * `call.id` is provider JSON cast to `ToolCall` and is never schema-validated
 * (nothing zod-parses `choices[].message.tool_calls` on the non-streaming
 * path), so a broken provider can put a non-string here. Everywhere else in the
 * loop the id is only ASSIGNED — this would be the first site to CALL a method
 * on it, and a TypeError here would kill a turn the loop could still recover.
 * Coerce, then bound.
 */
function safeCallId(id: string): string {
  return (typeof id === "string" ? id : String(id)).slice(0, MAX_CALL_ID_LEN);
}

/**
 * Build the `agent_tool_error` payload for one failed tool call.
 *
 * Total, pure and non-throwing: it is called from inside the agent loop's tool
 * dispatch, where an exception would take down a turn that was otherwise still
 * recoverable.
 */
export function describeToolError(
  input: ToolErrorDiagnosticsInput,
): ToolErrorDiagnostics {
  const value = toolResultPayloadValue(input.payload);
  const { shape, code, message } = classify(value);
  const { keys, dropped } = safeArgKeys(input.args);
  const tool = safeToolName(input.tool);
  const excerpt = buildExcerpt(message, shape, input.includeExcerpt);

  return {
    tool,
    tool_call_id: safeCallId(input.toolCallId),
    turn_id: input.turnId,
    iter: input.iter,
    ...(input.threadId !== undefined ? { thread_id: input.threadId } : {}),
    error_shape: shape,
    error_code: code,
    message_class: classifyMessage(message),
    message_len: message.length,
    ...(excerpt !== undefined ? { message_excerpt: excerpt } : {}),
    arg_keys: keys,
    arg_keys_dropped: dropped,
    args_fingerprint: fingerprint(`${tool}:${safeCanonical(input.args)}`),
    args_identity: fingerprint(
      `${tool}:${safeCanonical(normalizeArgs(input.args, 0))}`,
    ),
  };
}

/**
 * Mint the turn-scoped correlation id, once per `runAgent` call.
 *
 * Lives here so `llm-agent.service.ts` needs no crypto import and the whole
 * diagnostics surface stays in one testable module.
 */
export function newAgentTurnId(): string {
  return randomBytes(8).toString("hex");
}
