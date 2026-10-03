/**
 * WARP-3522 (ADR-069 §8) — ONE filter language for Work Suite work items.
 *
 * A filter is a tree of `{and}` / `{or}` groups over `{field, op, value}`
 * conditions. The API compiles it to a Prisma `where` (orchestrator
 * `services/pm/filter/compile.ts`), saved views persist it, automation rules
 * (WS-9) are written in it and the assistant's list tools (later) accept it:
 * four consumers, one grammar. This file is the grammar and nothing else — it
 * has no Prisma, no zod and no I/O, so the dashboard, the orchestrator and
 * tools-core can all import it. The zod adapter is `pm-filter-schema.ts`.
 *
 * ── what is in here ─────────────────────────────────────────────────────────
 *
 *   • {@link PM_FILTER_FIELDS} — the field table. One row per field says what
 *     kind of value it takes and which ops are legal. Adding a field (WS-4's
 *     `type`, an estimate, a custom property) is one row here plus one case in
 *     the compiler; nothing else enumerates the fields.
 *   • {@link validatePmFilter} — the ONLY place a filter's shape is judged. It
 *     is hand-written rather than a recursive zod schema so that its depth and
 *     size limits hold BEFORE any recursion: a request body can carry ~8 000
 *     nested groups in 100 kB, and a recursive validator that walks them first
 *     and counts afterwards is a stack overflow waiting for a caller.
 *   • {@link normalizePmFilter} — the canonical shape (single-child groups
 *     unwrapped, same-kind groups flattened).
 *   • {@link serializePmFilter} / {@link parsePmFilter} — the compact string a
 *     filter travels as in the `f=` URL parameter of a deep link. Grammar below.
 *
 * ── the compact string ──────────────────────────────────────────────────────
 *
 *     filter = ε | expr *("," expr)          a comma list at the root is an `and`
 *     expr   = group | leaf
 *     group  = ("and" | "or") "(" expr *("," expr) ")"
 *     leaf   = field "." op [ ":" item *(";" item) ]
 *     item   = *( ALPHA / DIGIT / "-" / "." / "_" / "~" HEXDIG HEXDIG )
 *
 * Everything outside `[A-Za-z0-9._-]` inside an item is written `~HH` (one per
 * UTF-8 byte). `~` is RFC 3986 "unreserved", so unlike `%` it survives a trip
 * through `URLSearchParams` untouched — a deep link never contains a
 * double-encoded `%2520`. The delimiters `( ) , ; :` are all legal in a query
 * string, so a typical link reads `f=assignee.is:me,priority.in:urgent;high`.
 *
 * ── dates ───────────────────────────────────────────────────────────────────
 *
 * Date conditions take a CALENDAR DATE token — `2026-10-03`, or a relative one
 * (`today`, `yesterday`, `tomorrow`, `-7d`, `+14d`, `-2w`). The sign is
 * required on an offset (`today` is the zero). A relative token is resolved
 * server-side in the requesting user's timezone, never in the browser and never
 * in the server's.
 */

// ── limits ──────────────────────────────────────────────────────────────────

/** Group nesting below the root group (root = depth 0). The chips UI produces
 *  depth 0 or 1; `and → or → leaf` is depth 1; 4 leaves room for hand-written
 *  and assistant-written filters without making the compiler's output a
 *  planner problem. */
export const PM_FILTER_MAX_DEPTH = 4;
/** Groups + conditions, in total. */
export const PM_FILTER_MAX_NODES = 60;
/** Entries in one `in` / `notIn` list. */
export const PM_FILTER_MAX_VALUES = 50;
/** Characters in a `text` condition (after trimming). */
export const PM_FILTER_TEXT_MAX = 200;
/** Characters in the compact string. A browser URL is good for ~2 000; this is
 *  deliberately above that so a long saved view still round-trips, and low
 *  enough that a hostile `f=` is cheap to refuse. */
export const PM_FILTER_ENCODED_MAX = 4000;

/** `assignee` / `createdBy` value meaning "the person making the request". */
export const PM_FILTER_ME = "me";
/** `assignee` / `department` value meaning "nobody". */
export const PM_FILTER_NONE = "none";

// ── the field table ─────────────────────────────────────────────────────────

export const PM_FILTER_OPS = [
  "is",
  "isNot",
  "in",
  "notIn",
  "before",
  "after",
  "between",
  "isEmpty",
  "isNotEmpty",
  "contains",
] as const;
export type PmFilterOp = (typeof PM_FILTER_OPS)[number];

/**
 * What a field's value looks like.
 *   id      — an opaque row id (`[A-Za-z0-9_.:-]{1,64}`), or one of the field's tokens
 *   ref     — free-ish text that names a row (a department id, slug OR name)
 *   enum    — one of `options`
 *   date    — a calendar-date token, see the header
 *   text    — free text, trimmed, 1..{@link PM_FILTER_TEXT_MAX}
 *   boolean — true | false
 */
export type PmFilterValueKind = "id" | "ref" | "enum" | "date" | "text" | "boolean";

export interface PmFilterFieldSpec {
  readonly kind: PmFilterValueKind;
  /** The ops that make sense for the field, in the order a picker should offer them. */
  readonly ops: readonly PmFilterOp[];
  /** Members of an `enum` field. */
  readonly options?: readonly string[];
  /** Non-id values the field accepts and the compiler special-cases. */
  readonly tokens?: readonly string[];
}

export const PM_FILTER_FIELD_NAMES = [
  "state",
  "stateGroup",
  "priority",
  "assignee",
  "label",
  "cycle",
  "module",
  "department",
  "project",
  "dueDate",
  "startDate",
  "createdAt",
  "updatedAt",
  "createdBy",
  "text",
  "parent",
  "isArchived",
] as const;
export type PmFilterField = (typeof PM_FILTER_FIELD_NAMES)[number];

/** is / isNot / in / notIn, then empty / not-empty — for fields whose column may be null or empty. */
const SET_OPS = ["is", "isNot", "in", "notIn", "isEmpty", "isNotEmpty"] as const;
/** The same, for fields that always have a value. */
const REQUIRED_SET_OPS = ["is", "isNot", "in", "notIn"] as const;
const NULLABLE_DATE_OPS = ["is", "before", "after", "between", "isEmpty", "isNotEmpty"] as const;
const DATE_OPS = ["is", "before", "after", "between"] as const;

export const PM_STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export const PM_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

/**
 * The fields, per ADR-069 §8 / WS-6, restricted to what exists in the schema
 * today. NOT here yet, and each is one row away: `type` and `estimate` (WS-4),
 * custom properties (WS-4). `project` is not in the spec's list but cross-project
 * views (`PmSavedView.projectId = null`) cannot narrow to a set of projects
 * without it. `isNotEmpty` is an op the spec's list does not name; without it
 * "has a due date" would need a `not` node the grammar deliberately lacks.
 */
export const PM_FILTER_FIELDS: Record<PmFilterField, PmFilterFieldSpec> = {
  state: { kind: "id", ops: SET_OPS },
  stateGroup: { kind: "enum", ops: REQUIRED_SET_OPS, options: PM_STATE_GROUPS },
  priority: { kind: "enum", ops: REQUIRED_SET_OPS, options: PM_PRIORITIES },
  assignee: { kind: "id", ops: SET_OPS, tokens: [PM_FILTER_ME, PM_FILTER_NONE] },
  label: { kind: "id", ops: SET_OPS },
  cycle: { kind: "id", ops: SET_OPS },
  module: { kind: "id", ops: SET_OPS },
  department: { kind: "ref", ops: SET_OPS, tokens: [PM_FILTER_NONE] },
  project: { kind: "id", ops: REQUIRED_SET_OPS },
  dueDate: { kind: "date", ops: NULLABLE_DATE_OPS },
  startDate: { kind: "date", ops: NULLABLE_DATE_OPS },
  createdAt: { kind: "date", ops: DATE_OPS },
  updatedAt: { kind: "date", ops: DATE_OPS },
  createdBy: { kind: "id", ops: SET_OPS, tokens: [PM_FILTER_ME] },
  text: { kind: "text", ops: ["contains"] },
  parent: { kind: "id", ops: SET_OPS },
  isArchived: { kind: "boolean", ops: ["is"] },
};

// ── types ───────────────────────────────────────────────────────────────────

/** `between` carries exactly two date tokens, `[from, to]`, both inclusive. */
export type PmFilterValue = string | boolean | string[];

export interface PmFilterCondition {
  field: PmFilterField;
  op: PmFilterOp;
  /** Absent for `isEmpty` / `isNotEmpty`, required for every other op. */
  value?: PmFilterValue;
}

export type PmFilterGroup = { and: PmFilter[] } | { or: PmFilter[] };
export type PmFilter = PmFilterGroup | PmFilterCondition;

export function isPmFilterGroup(f: PmFilter): f is PmFilterGroup {
  return "and" in f || "or" in f;
}

// ── dates ───────────────────────────────────────────────────────────────────

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const RELATIVE = /^([+-])(\d{1,4})([dw])$/;
const MAX_OFFSET_DAYS = 3650;
const MAX_OFFSET_WEEKS = 520;

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function isCalendarYmd(s: string): boolean {
  const m = YMD.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}

/**
 * The day offset a RELATIVE date token stands for (`today` = 0, `-7d` = -7,
 * `+2w` = 14), or `null` for an absolute `YYYY-MM-DD` — and for anything that
 * is not a date token at all, so callers check {@link isPmDateToken} first.
 */
export function relativeDateOffsetDays(token: string): number | null {
  if (token === "today") return 0;
  if (token === "yesterday") return -1;
  if (token === "tomorrow") return 1;
  const m = RELATIVE.exec(token);
  if (!m) return null;
  const n = Number(m[2]);
  if (m[3] === "d" ? n > MAX_OFFSET_DAYS : n > MAX_OFFSET_WEEKS) return null;
  const days = m[3] === "w" ? n * 7 : n;
  if (days === 0) return 0;
  return m[1] === "-" ? -days : days;
}

/** A real calendar date (`2026-10-03`, not `2026-02-30`) or a relative token. */
export function isPmDateToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  if (YMD.test(token)) return isCalendarYmd(token);
  return relativeDateOffsetDays(token) !== null;
}

// ── validation ──────────────────────────────────────────────────────────────

export type PmFilterPath = Array<string | number>;

export type PmFilterValidation =
  | { ok: true; filter: PmFilter }
  | { ok: false; error: string; path: PmFilterPath };

/** Thrown inside {@link validatePmFilter} only, as a plain marker object so the
 *  catch below can tell it from a real bug without `instanceof`. */
interface Issue {
  readonly pmFilterIssue: true;
  readonly error: string;
  readonly path: PmFilterPath;
}

function issue(error: string, path: PmFilterPath): Issue {
  return { pmFilterIssue: true, error, path };
}

function isIssue(x: unknown): x is Issue {
  return typeof x === "object" && x !== null && (x as Issue).pmFilterIssue === true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const REF_MAX = 100;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** A lone surrogate is a string `encodeURIComponent` throws on, so the
 *  serializer would crash on a value the validator had let through. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function scalar(spec: PmFilterFieldSpec, raw: unknown, path: PmFilterPath): string | boolean {
  if (spec.kind === "boolean") {
    if (typeof raw !== "boolean") throw issue("filter_value_invalid", path);
    return raw;
  }
  if (typeof raw !== "string") throw issue("filter_value_invalid", path);
  switch (spec.kind) {
    case "id":
      if (!ID_RE.test(raw)) throw issue("filter_value_invalid", path);
      return raw;
    case "enum":
      if (!spec.options || !spec.options.includes(raw)) throw issue("filter_value_invalid", path);
      return raw;
    case "date":
      if (!isPmDateToken(raw)) throw issue("filter_value_invalid", path);
      return raw;
    case "ref": {
      const v = raw.trim();
      if (v.length === 0 || v.length > REF_MAX || hasControlChar(v) || hasLoneSurrogate(v)) {
        throw issue("filter_value_invalid", path);
      }
      return v;
    }
    case "text": {
      const v = raw.trim();
      if (v.length === 0 || v.length > PM_FILTER_TEXT_MAX || hasControlChar(v) || hasLoneSurrogate(v)) {
        throw issue("filter_value_invalid", path);
      }
      return v;
    }
    default:
      throw issue("filter_value_invalid", path);
  }
}

function validateValue(
  spec: PmFilterFieldSpec,
  op: PmFilterOp,
  raw: unknown,
  path: PmFilterPath,
): PmFilterValue | undefined {
  switch (op) {
    case "isEmpty":
    case "isNotEmpty":
      if (raw !== undefined) throw issue("filter_value_unexpected", path);
      return undefined;
    case "in":
    case "notIn": {
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > PM_FILTER_MAX_VALUES) {
        throw issue("filter_value_invalid", path);
      }
      const out: string[] = [];
      raw.forEach((entry, i) => {
        const v = scalar(spec, entry, [...path, i]);
        if (typeof v !== "string") throw issue("filter_value_invalid", [...path, i]);
        if (!out.includes(v)) out.push(v);
      });
      return out;
    }
    case "between": {
      if (!Array.isArray(raw) || raw.length !== 2) throw issue("filter_value_invalid", path);
      return raw.map((entry, i) => {
        const v = scalar(spec, entry, [...path, i]);
        if (typeof v !== "string") throw issue("filter_value_invalid", [...path, i]);
        return v;
      });
    }
    default: {
      // is, isNot, before, after, contains
      if (raw === undefined) throw issue("filter_value_missing", path);
      return scalar(spec, raw, path);
    }
  }
}

const LEAF_KEYS = new Set(["field", "op", "value"]);

/**
 * Judge an untrusted value (a request body, a saved view's JSON column, a
 * parsed `f=`) and return a CLEAN COPY of it: trimmed text, de-duplicated
 * lists, no keys the grammar does not name. Everything else is refused —
 * unknown fields and ops, an op a field does not take, a value of the wrong
 * shape, an empty `or`, a trees past {@link PM_FILTER_MAX_DEPTH} /
 * {@link PM_FILTER_MAX_NODES}.
 *
 * The limits are checked on the way DOWN, so a hostile tree is refused at the
 * first node past a limit rather than after it has been walked. The one empty
 * group allowed is the ROOT `and`, which is how "no filter" is written.
 */
export function validatePmFilter(input: unknown): PmFilterValidation {
  let nodes = 0;

  const visit = (raw: unknown, depth: number, path: PmFilterPath): PmFilter => {
    nodes += 1;
    if (nodes > PM_FILTER_MAX_NODES) throw issue("filter_too_large", path);
    if (!isRecord(raw)) throw issue("filter_node_invalid", path);
    const keys = Object.keys(raw);
    const groupKey = hasOwn(raw, "and") ? "and" : hasOwn(raw, "or") ? "or" : null;

    if (groupKey) {
      if (keys.length !== 1) throw issue("filter_group_invalid", path);
      if (depth > PM_FILTER_MAX_DEPTH) throw issue("filter_too_deep", path);
      const kids = raw[groupKey];
      if (!Array.isArray(kids)) throw issue("filter_group_invalid", [...path, groupKey]);
      if (kids.length === 0 && !(groupKey === "and" && depth === 0)) {
        throw issue("filter_group_empty", [...path, groupKey]);
      }
      const children = kids.map((kid, i) => visit(kid, depth + 1, [...path, groupKey, i]));
      return groupKey === "and" ? { and: children } : { or: children };
    }

    for (const k of keys) if (!LEAF_KEYS.has(k)) throw issue("filter_unknown_key", [...path, k]);
    const field = raw.field;
    if (typeof field !== "string" || !hasOwn(PM_FILTER_FIELDS, field)) {
      throw issue("filter_unknown_field", [...path, "field"]);
    }
    const spec = PM_FILTER_FIELDS[field as PmFilterField];
    const op = raw.op;
    if (typeof op !== "string" || !(spec.ops as readonly string[]).includes(op)) {
      throw issue("filter_op_not_allowed", [...path, "op"]);
    }
    const value = validateValue(spec, op as PmFilterOp, raw.value, [...path, "value"]);
    return value === undefined
      ? { field: field as PmFilterField, op: op as PmFilterOp }
      : { field: field as PmFilterField, op: op as PmFilterOp, value };
  };

  try {
    return { ok: true, filter: visit(input, 0, []) };
  } catch (err) {
    if (isIssue(err)) return { ok: false, error: err.error, path: err.path };
    throw err;
  }
}

// ── traversal + normalization ───────────────────────────────────────────────

/** Every condition in the tree, depth-first, in the order written. */
export function* pmFilterConditions(filter: PmFilter): Generator<PmFilterCondition> {
  if (isPmFilterGroup(filter)) {
    const kids = "and" in filter ? filter.and : filter.or;
    for (const kid of kids) yield* pmFilterConditions(kid);
  } else {
    yield filter;
  }
}

/**
 * The canonical shape of a (valid) filter: a group with one child is its
 * child, and a group nested directly inside a group of the SAME kind is merged
 * into it. `{and: []}` — "no filter" — stays as it is; it is only legal at the
 * root, where nothing is ever merged into it.
 */
export function normalizePmFilter(filter: PmFilter): PmFilter {
  if (!isPmFilterGroup(filter)) return filter;
  const kind: "and" | "or" = "and" in filter ? "and" : "or";
  const kids = kind === "and" ? (filter as { and: PmFilter[] }).and : (filter as { or: PmFilter[] }).or;
  const merged: PmFilter[] = [];
  for (const kid of kids) {
    const n = normalizePmFilter(kid);
    if (isPmFilterGroup(n) && kind in n) {
      merged.push(...(kind === "and" ? (n as { and: PmFilter[] }).and : (n as { or: PmFilter[] }).or));
    } else {
      merged.push(n);
    }
  }
  if (merged.length === 1) return merged[0];
  return kind === "and" ? { and: merged } : { or: merged };
}

// ── the compact string ──────────────────────────────────────────────────────

function esc(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!~*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%/g, "~");
}

const ITEM_RE = /^(?:[A-Za-z0-9._-]|~[0-9A-Fa-f]{2})+$/;

function unesc(item: string): string | null {
  if (!ITEM_RE.test(item)) return null;
  try {
    return decodeURIComponent(item.replace(/~/g, "%"));
  } catch {
    return null;
  }
}

function writeValue(value: PmFilterValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(esc).join(";");
  return esc(value);
}

function writeExpr(node: PmFilter): string {
  if (isPmFilterGroup(node)) {
    const kind = "and" in node ? "and" : "or";
    const kids = "and" in node ? node.and : node.or;
    return `${kind}(${kids.map(writeExpr).join(",")})`;
  }
  const head = `${node.field}.${node.op}`;
  return node.value === undefined ? head : `${head}:${writeValue(node.value)}`;
}

/**
 * The compact string for a (valid) filter. Normalizes first, so two filters
 * that mean the same tree write the same string; the root `and` is written as
 * a bare comma list, and "no filter" as the empty string.
 */
export function serializePmFilter(filter: PmFilter): string {
  const n = normalizePmFilter(filter);
  if (isPmFilterGroup(n) && "and" in n) return n.and.map(writeExpr).join(",");
  return writeExpr(n);
}

/** Two filters mean the same tree (compared by canonical string). */
export function pmFiltersEqual(a: PmFilter, b: PmFilter): boolean {
  return serializePmFilter(a) === serializePmFilter(b);
}

const PARSE_FAIL = { parseFail: true } as const;

/**
 * Read a compact string back into a filter, or `null`. `null` for every
 * malformed string — bad escapes, a stray delimiter, a missing value — and for
 * every well-formed string that says something {@link validatePmFilter}
 * refuses; a deep link with a broken `f=` must degrade to "no filter", never
 * to an error page, so the caller never has to tell the two apart.
 */
export function parsePmFilter(src: string): PmFilter | null {
  if (typeof src !== "string" || src.length > PM_FILTER_ENCODED_MAX) return null;
  if (src.length === 0) return { and: [] };

  let i = 0;
  const fail = (): never => {
    throw PARSE_FAIL;
  };
  const isAlpha = (c: string | undefined): boolean => c !== undefined && /[A-Za-z]/.test(c);

  const ident = (): string => {
    const start = i;
    while (i < src.length && isAlpha(src[i])) i += 1;
    if (i === start) fail();
    return src.slice(start, i);
  };

  const leaf = (field: string, op: string, value: string | undefined): unknown => {
    if (value === undefined) return { field, op };
    const items = value.split(";").map(unesc);
    if (items.some((x) => x === null)) return fail();
    const list = items as string[];
    if (op === "in" || op === "notIn" || op === "between") return { field, op, value: list };
    if (list.length !== 1) return fail();
    const spec = hasOwn(PM_FILTER_FIELDS, field) ? PM_FILTER_FIELDS[field as PmFilterField] : undefined;
    if (spec?.kind === "boolean") {
      if (list[0] === "true") return { field, op, value: true };
      if (list[0] === "false") return { field, op, value: false };
      return fail();
    }
    return { field, op, value: list[0] };
  };

  // `depth` only bounds the recursion; the exact limits are validatePmFilter's.
  const expr = (depth: number): unknown => {
    if (depth > PM_FILTER_MAX_DEPTH + 1) return fail();
    const name = ident();
    if (src[i] === "(") {
      if (name !== "and" && name !== "or") return fail();
      i += 1;
      const kids: unknown[] = [expr(depth + 1)];
      while (src[i] === ",") {
        i += 1;
        kids.push(expr(depth + 1));
      }
      if (src[i] !== ")") return fail();
      i += 1;
      return { [name]: kids };
    }
    if (src[i] !== ".") return fail();
    i += 1;
    const op = ident();
    let value: string | undefined;
    if (src[i] === ":") {
      i += 1;
      const start = i;
      while (i < src.length && src[i] !== "," && src[i] !== ")") i += 1;
      value = src.slice(start, i);
    }
    return leaf(name, op, value);
  };

  try {
    const exprs: unknown[] = [expr(1)];
    while (src[i] === ",") {
      i += 1;
      exprs.push(expr(1));
    }
    if (i !== src.length) return null;
    const res = validatePmFilter(exprs.length === 1 ? exprs[0] : { and: exprs });
    return res.ok ? res.filter : null;
  } catch (err) {
    if (err === PARSE_FAIL) return null;
    throw err;
  }
}
