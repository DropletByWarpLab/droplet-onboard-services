/**
 * WARP-2911 — every notification recipient is a USERNAME: a source sweep.
 *
 * `sendNotification`'s recipient is `User.username` at every hop — the toast
 * topic `droplet/notifications/<username>` (ws-bridge subscribes on the
 * username only), the `PushSubscription.username` lookup and both
 * `NotificationLog.username` readers. A `User.id` there fails silently and
 * completely, and it has shipped three times:
 *
 *   WARP-2783  audit-verify selected `{ id: true }` and sent on `admin.id`
 *   WARP-2813  brain-notify's owner lookup returned the id
 *   WARP-2910  the filing digest sent on `settings.enabledById`
 *
 * WARP-2783's fix called its site "the one UUID-keyed caller in the
 * codebase"; it was not, and the claim is why the search stopped there. This
 * file replaces the claim: a file-text gate in the `tool-routes.test.ts` /
 * `tool-scope-claim-trust.guard.test.ts` idiom — no DB, default lane — over
 * every production `.ts` under `apps/orchestrator/src` and
 * `packages/tools-core/src`.
 *
 * ## What it scans
 *
 *   calls         sendNotification( / recordNotification( /
 *                 publishNotificationToast( / dispatchToUser( (web push's
 *                 own entry point; its recipient is the 2nd argument)
 *   WARP-2804     ackNotification( / ackAllNotifications( (the acting
 *                 person's username is the where-clause), countUnread( /
 *                 listNotifications( (positional, 2nd argument) — a User.id
 *                 there answers an empty inbox and a 404 on every ack
 *   direct writes notificationLog.create( / notificationLog.createMany( /
 *                 notificationLog.update( / notificationLog.updateMany( /
 *                 pushSubscription.upsert( / pushSubscription.create(
 *
 * A direct NotificationLog UPDATE that names no `username` must be keyed by
 * the row's own id (`where: { id: … }`, the delivery claim and stamps) — it
 * then cannot reach another person's rows, and it may not write the recipient
 * column. One that writes an `ack*` column (or spreads into `data`) must ALSO
 * have `username` in its `where`: only the recipient acks (review F7).
 *
 * ## What it asserts, per site
 *
 * The `username` the site passes is not:
 *   - fed from a `select` projection without `username` (the WARP-2783 shape);
 *   - an `enabledById`, a `createdById`, an `ownerId`, a `.id`, or any
 *     identifier ending in `Id`.
 * Wrappers that do not change which value flows are peeled first (`as T`, `!`,
 * `?? …` / `|| …` / a ternary — each side —, `String(…)`, `${…}`), so
 * `String(pref.userId)` is judged as `pref.userId`. A bare identifier is then
 * followed back to its binding: `const x = …`; `for (const x of …)`, through
 * an array built up with `.push(…)` from `[]` or a `.map((r) => r.id)`;
 * `for (const { username } of …)`; a same-file helper it is assigned from
 * (`const to = await ownerUsername(prisma)`, the WARP-2813 shape); and a
 * parameter, through every caller of its function — a wrapper
 * `tell(prisma, username)` fed `admin.id` is the same bug one call away. A site
 * that still passes `userId:` is red too.
 *
 * One recipient ending in `Id` IS a username and is allow-listed below with the
 * reason. The reason is not taken on trust: it is checked by following every
 * Reminder writer, and an entry that stops matching a site fails. (The second,
 * tools-core `send_notification`'s `ctx.userId`, went with WARP-3060: tools-core
 * writes no NotificationLog row at all now, and a case below keeps it so. The
 * Reminder writers once included tools-core's `ctx.userId` too — a User.id on
 * the mcp-server's HTTP transport; WARP-3101 moved them onto the route, and a
 * case below keeps tools-core out.)
 *
 * The run output enumerates every site it found (one case per site). The
 * scanner is itself tested (bottom of the file) on the shapes it must flag
 * and the idioms it must not.
 *
 * The runtime twin is `assertRecipientIsUsername` (services/notification-
 * recipient.ts), run by sendNotification, publishNotificationToast,
 * recordNotification and dispatchToUser: a UUID-shaped recipient throws
 * `NOTIFICATION_RECIPIENT_IS_ID`. This file catches the mistake before it
 * runs; that one catches whatever this misses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { packagePath, repoPath } from "./helpers/test-paths.js";

// Anchored to this test file, never the runner's cwd (WARP-2654).
const ROOTS = [
  { pkg: "orchestrator", dir: packagePath("src") },
  { pkg: "tools-core", dir: repoPath("packages", "tools-core", "src") },
] as const;

// ── Source reading ─────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * The source with every comment blanked to spaces — same length, newlines
 * kept — so offsets and line numbers still point at the original. String
 * literals are respected (a `//` inside a URL is not a comment), and a quote
 * string ends at a newline, so a quote inside a regex literal can derail at
 * most one line.
 */
function stripComments(src: string): string {
  let out = "";
  let mode: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        out += "  ";
        i++;
      } else if (c === "/" && n === "*") {
        mode = "block";
        out += "  ";
        i++;
      } else {
        if (c === "'" || c === '"' || c === "`") mode = c;
        out += c;
      }
    } else if (mode === "line") {
      if (c === "\n") mode = "code";
      out += c === "\n" || c === "\r" ? c : " ";
    } else if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        out += "  ";
        i++;
      } else out += c === "\n" || c === "\r" ? c : " ";
    } else {
      if (c === "\\") {
        out += c + (n ?? "");
        i++;
        continue;
      }
      if (c === mode || (c === "\n" && mode !== "`")) mode = "code";
      out += c;
    }
  }
  return out;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * From `start` (just past an opening bracket, or at the first character of an
 * expression), read until the first of `stops` at bracket depth 0. Strings
 * are skipped whole. Returns the end offset (exclusive).
 */
function scanTo(src: string, start: number, stops: string): number {
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (stack.length === 0 && stops.includes(c)) return i;
    if (OPEN[c]) stack.push(OPEN[c]!);
    else if (c === ")" || c === "]" || c === "}") stack.pop();
  }
  return src.length;
}

interface SourceFile {
  /** `orchestrator:services/foo.ts` — how every message names it. */
  id: string;
  code: string;
}

const PRODUCTION: SourceFile[] = ROOTS.flatMap(({ pkg, dir }) =>
  walk(dir)
    .map((full) => ({ full, rel: path.relative(dir, full).split(path.sep).join("/") }))
    .filter(({ rel }) => !rel.endsWith(".test.ts") && !rel.split("/").includes("__tests__"))
    .map(({ full, rel }) => ({ id: `${pkg}:${rel}`, code: stripComments(readFileSync(full, "utf8")) })),
);

const lineOf = (code: string, offset: number) => code.slice(0, offset).split("\n").length;

// ── The sites ──────────────────────────────────────────────────────────────

interface Site {
  file: SourceFile;
  offset: number;
  callee: string;
  /** The text between the call's parentheses. */
  args: string;
  /** Offset of `args` in the file. */
  argsAt: number;
  label: string;
}

const CALL =
  /(?<![\w$.])(sendNotification|recordNotification|publishNotificationToast|dispatchToUser|ackNotification|ackAllNotifications|countUnread|listNotifications)\s*\(/g;
const WRITE =
  /(?<![\w$])(notificationLog\.(?:createMany|create|updateMany|update)|pushSubscription\.(?:upsert|create))\s*\(/g;

/** Positional recipients: `fn(prisma, username, …)`. */
const POSITIONAL = new Set(["dispatchToUser", "countUnread", "listNotifications"]);

function sitesIn(file: SourceFile): Site[] {
  const out: Site[] = [];
  for (const re of [CALL, WRITE]) {
    for (const m of file.code.matchAll(re)) {
      // The definitions themselves are not call sites.
      if (/function\s*$/.test(file.code.slice(Math.max(0, m.index! - 20), m.index!))) continue;
      const argsAt = m.index! + m[0].length;
      const end = scanTo(file.code, argsAt, ")");
      out.push({
        file,
        offset: m.index!,
        callee: m[1]!,
        args: file.code.slice(argsAt, end),
        argsAt,
        label: `${file.id}:${lineOf(file.code, m.index!)} ${m[1]}`,
      });
    }
  }
  return out;
}

const SITES = PRODUCTION.flatMap(sitesIn);

/** Every `username` the site passes: `username: <expr>` and shorthand `username`. */
function recipientsOf(site: Site): Array<{ expr: string; at: number }> {
  const out: Array<{ expr: string; at: number }> = [];
  if (POSITIONAL.has(site.callee)) {
    // `dispatchToUser(prisma, username, payload)`, `countUnread(db, username)`,
    // `listNotifications(prisma, username, opts)` — positional.
    const from = site.argsAt + scanTo(site.args, 0, ",") + 1;
    const end = scanTo(site.file.code, from, ",)");
    out.push({ expr: site.file.code.slice(from, end).trim(), at: from });
    return out;
  }
  for (const m of site.args.matchAll(/(?<![\w$.'"`])username\s*(:|(?=[,}\s]))/g)) {
    const keyAt = site.argsAt + m.index!;
    if (m[1] === ":") {
      const from = keyAt + m[0].length;
      const end = scanTo(site.file.code, from, ",}");
      out.push({ expr: site.file.code.slice(from, end).trim(), at: keyAt });
    } else {
      // Shorthand — only where it IS a property (`{ username, …` / `…, username }`).
      const before = site.file.code.slice(0, keyAt).trimEnd();
      if (before.endsWith("{") || before.endsWith(",")) out.push({ expr: "username", at: keyAt });
    }
  }
  return out;
}

// ── Following a value back to where it came from ───────────────────────────

type Binding =
  | { kind: "value"; at: number; expr: string } // const x = <expr>
  | { kind: "element"; at: number; iterable: string } // for (const x of <iterable>)
  | { kind: "field"; at: number; source: string } // const { x } = <source> / for (const { x } of <source>)
  | { kind: "param"; at: number; fn: string; index: number; destructured: boolean }; // function f(…, x, …)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split `s` at every top-level occurrence of one of `seps` — outside brackets
 * and strings. `angles` also treats `<…>` as brackets, for parameter lists
 * (`a: Map<string, string>, username: string`); never for expressions, where
 * `<` is a comparison.
 */
function splitTop(s: string, seps: readonly string[], angles = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c) || (angles && c === "<")) depth++;
    else if (")]}".includes(c) || (angles && c === ">" && s[i - 1] !== "=")) depth--;
    else if (depth === 0) {
      const sep = seps.find((x) => s.startsWith(x, i));
      if (sep) {
        parts.push(s.slice(last, i));
        i += sep.length - 1;
        last = i + 1;
      }
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** A top-level `cond ? a : b` (not `?.`, not `??`), as its two branches. */
function ternaryBranches(e: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  let q = -1;
  for (let i = 0; i < e.length; i++) {
    const c = e[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?" && e[i + 1] !== "." && e[i + 1] !== "?" && e[i - 1] !== "?") {
      if (q < 0) q = i;
    } else if (depth === 0 && c === ":" && q >= 0) {
      return [e.slice(q + 1, i).trim(), e.slice(i + 1).trim()];
    }
  }
  return null;
}

const STRING_LITERAL = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/;

/**
 * The parts of an expression that can BE the value, with every wrapper that
 * does not change which value flows peeled off: `await`, parentheses,
 * `as T` / `satisfies T`, `!` (trailing or mid-chain), `String(…)`,
 * `.toString()` and friends, a template's `${…}`. `a ?? b`, `a || b` and a
 * ternary yield each side. A string literal yields nothing: `"dev"` is a
 * username, never an id.
 *
 * Without this, `p.userId as string`, `p.userId ?? "dev"`, `pref!.userId`,
 * `` `${pref.userId}` `` and `String(pref.userId)` all fell through to a
 * fallback that only looked for a literal `.id` — and passed.
 */
function valueParts(expr: string, depth = 0): string[] {
  let e = expr.trim();
  for (let guard = 0; guard < 20; guard++) {
    const before = e;
    e = e.replace(/^await\s+/, "").trim();
    if (e.startsWith("(") && scanTo(e, 1, ")") === e.length - 1) e = e.slice(1, -1).trim();
    e = e.replace(/\s+(?:as|satisfies)\s+[\w$.<>[\]|&'", ]+$/, "").trim();
    e = e.replace(/!+$/, "");
    e = e.replace(/\??\.(?:toString|trim|toLowerCase|toUpperCase|normalize)\(\s*\)$/, "");
    if (/^String\s*\(/.test(e)) {
      const open = e.indexOf("(") + 1;
      if (scanTo(e, open, ")") === e.length - 1) e = e.slice(open, -1).trim();
    }
    if (e === before) break;
  }
  // A non-null assertion inside a chain: `pref!.userId` is `pref.userId`.
  e = e.replace(/!(?=\??\.|\[)/g, "");
  if (depth > 8) return [e];

  const alternatives = splitTop(e, ["??", "||"]);
  if (alternatives.length > 1) return alternatives.flatMap((a) => valueParts(a, depth + 1));
  const branches = ternaryBranches(e);
  if (branches) return branches.flatMap((b) => valueParts(b, depth + 1));
  if (STRING_LITERAL.test(e)) return [];
  if (e.startsWith("`") && e.endsWith("`")) {
    const inner: string[] = [];
    for (let i = 1; i < e.length - 1; i++) {
      if (e[i] === "\\") i++;
      else if (e[i] === "$" && e[i + 1] === "{") {
        const end = scanTo(e, i + 2, "}");
        inner.push(e.slice(i + 2, end));
        i = end;
      }
    }
    return inner.flatMap((x) => valueParts(x, depth + 1));
  }
  return [e];
}

const NOT_A_FUNCTION = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "await", "new", "async",
]);
const HEADER =
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(|(?:^|[\s,;{}])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;

/** A named function (declaration, `const f = (…) =>`, or method) whose body
 *  contains `at` and one of whose parameters is `name` — the innermost. */
function enclosingParam(code: string, name: string, at: number): Extract<Binding, { kind: "param" }> | null {
  let best: Extract<Binding, { kind: "param" }> | null = null;
  for (const m of code.matchAll(HEADER)) {
    if (m.index! >= at) break;
    const fn = m[1] ?? m[2] ?? m[3];
    if (!fn || NOT_A_FUNCTION.has(fn)) continue;
    const open = m.index! + m[0].length;
    const close = scanTo(code, open, ")");
    const after = code.slice(close + 1);
    let bodyStart: number;
    let bodyEnd: number;
    // `const f = (…) => …` has an arrow body; `const f = function (…) {…}`
    // and declarations/methods have a block.
    if (m[2] !== undefined && !/=\s*(?:async\s+)?function\b/.test(m[0])) {
      const arrow = /^\s*(?::[^={;]+)?=>\s*/.exec(after);
      if (!arrow) continue;
      bodyStart = close + 1 + arrow[0].length;
      bodyEnd = code[bodyStart] === "{" ? scanTo(code, bodyStart + 1, "}") : scanTo(code, bodyStart, ";");
    } else {
      const block = /^\s*(?::[^{=;]+)?\{/.exec(after);
      if (!block) continue;
      bodyStart = close + block[0].length;
      bodyEnd = scanTo(code, bodyStart + 1, "}");
    }
    if (!(bodyStart < at && at < bodyEnd)) continue;
    const params = splitTop(code.slice(open, close), [","], true);
    const index = params.findIndex((p) => {
      const q = p.replace(/^\.\.\./, "");
      if (q.startsWith("{")) return new RegExp(`\\b${esc(name)}\\b`).test(q.slice(0, scanTo(q, 1, "}")));
      return q.match(/^([A-Za-z_$][\w$]*)/)?.[1] === name;
    });
    if (index < 0) continue;
    if (!best || m.index! > best.at) {
      best = { kind: "param", at: m.index!, fn, index, destructured: params[index]!.replace(/^\.\.\./, "").startsWith("{") };
    }
  }
  return best;
}

/** The nearest binding of `name` before `before`: a declaration, a loop
 *  variable, or a parameter of the function it is used in. A lexical-scope
 *  approximation — the closest one wins. */
function bindingOf(code: string, name: string, before: number): Binding | null {
  const n = esc(name);
  const patterns: Array<[RegExp, (m: RegExpExecArray) => Binding]> = [
    [
      new RegExp(`(?:const|let|var)\\s+${n}\\s*(?::[^=;]+)?=(?![=>])`, "g"),
      (m) => ({ kind: "value", at: m.index, expr: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ";")).trim() }),
    ],
    [
      new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=(?![=>])`, "g"),
      (m) => ({ kind: "field", at: m.index, source: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ";")).trim() }),
    ],
    [
      new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+of\\s+`, "g"),
      (m) => ({ kind: "element", at: m.index, iterable: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ")")).trim() }),
    ],
    [
      new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s+of\\s+`, "g"),
      (m) => ({ kind: "field", at: m.index, source: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ")")).trim() }),
    ],
  ];
  let best: Binding | null = null;
  for (const [re, make] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) && m.index < before) {
      if (!best || m.index > best.at) best = make(m);
    }
  }
  const param = enclosingParam(code, name, before);
  if (param && (!best || param.at > best.at)) return param;
  return best;
}

/** Every call of `fn` in the universe, with its top-level arguments. */
function callsOf(
  fn: string,
  universe: readonly SourceFile[],
): Array<{ file: SourceFile; at: number; args: string[] }> {
  const out: Array<{ file: SourceFile; at: number; args: string[] }> = [];
  const re = new RegExp(`(?<![\\w$])${esc(fn)}\\s*\\(`, "g");
  for (const file of universe) {
    for (const m of file.code.matchAll(re)) {
      if (/function\s*\*?\s*$/.test(file.code.slice(Math.max(0, m.index! - 20), m.index!))) continue;
      const open = m.index! + m[0].length;
      const close = scanTo(file.code, open, ")");
      // A method header `fn(…) {` is a definition, not a call.
      if (/^\s*(?::[^{=;]+)?\{/.test(file.code.slice(close + 1))) continue;
      out.push({ file, at: m.index!, args: splitTop(file.code.slice(open, close), [","]) });
    }
  }
  return out;
}

/** `name` of an object literal: `{ name: <expr> }` → `<expr>`, `{ name }` → `name`. */
function propertyOf(literal: string, name: string): string | null {
  const e = literal.trim();
  if (!e.startsWith("{")) return null;
  for (const entry of splitTop(e.slice(1, scanTo(e, 1, "}")), [","])) {
    if (entry === name) return name;
    const m = new RegExp(`^${esc(name)}\\s*:\\s*`).exec(entry);
    if (m) return entry.slice(m[0].length);
  }
  return null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/;
const ID_NAMES = /\b(enabledById|createdById|ownerId)\b/;

/** A `select: { … }` that projects the id and not the username. */
function idOnlyProjection(expr: string): boolean {
  return [...expr.matchAll(/select\s*:\s*\{([^{}]*)\}/g)].some(
    (m) => /\bid\s*:\s*true/.test(m[1]!) && !/\busername\b/.test(m[1]!),
  );
}

/** `.id` / `…Id` as the LAST segment of a name. */
function idSegment(segment: string): string | null {
  if (segment === "id") return "a `.id` — a User.id";
  if (/Id$/.test(segment)) return "an identifier ending in `Id`";
  return null;
}

/** A same-file helper the value is the result of (`await ownerUsername(prisma)`,
 *  the WARP-2813 shape): read its body. */
function helperProblems(code: string, e: string): string[] {
  const callee = e.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  const decl = callee ? new RegExp(`function\\s+${esc(callee)}\\s*\\(`).exec(code) : null;
  if (!decl) return [];
  const open = code.indexOf("{", scanTo(code, decl.index + decl[0].length, ")"));
  const body = code.slice(open + 1, scanTo(code, open + 1, "}"));
  const out: string[] = [];
  if (idOnlyProjection(body)) out.push(`\`${callee}()\` reads a select projection without \`username\``);
  if (/\breturn\b[^;]*\.id\b(?!\s*[:(])/.test(body)) out.push(`\`${callee}()\` returns a \`.id\``);
  if (/\.map\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.(?:id|\w+Id)\b/.test(body)) out.push(`\`${callee}()\` maps rows to an id`);
  return out;
}

/** The problems with one value flowing into a recipient slot, followed back. */
function problemsWith(
  file: SourceFile,
  expr: string,
  at: number,
  universe: readonly SourceFile[],
  depth = 0,
): string[] {
  return valueParts(expr).flatMap((part) => partProblems(file, part, at, universe, depth));
}

function partProblems(
  file: SourceFile,
  e: string,
  at: number,
  universe: readonly SourceFile[],
  depth: number,
): string[] {
  const code = file.code;
  const problems: string[] = [];
  const named = e.match(ID_NAMES);
  if (named) problems.push(`\`${e}\` names an ${named[1]} — a User.id`);
  if (idOnlyProjection(e)) problems.push(`\`${e.slice(0, 80)}\` is a select projection without \`username\``);
  if (depth > 6) return problems;

  if (MEMBER.test(e)) {
    const segments = e.split(/\??\./);
    const why = idSegment(segments[segments.length - 1]!);
    if (why) problems.push(`\`${e}\` is ${why}`);
    // `row.username`: where did `row` come from?
    const head = segments[0]!;
    const prop = segments.slice(1).join(".");
    const b = bindingOf(code, head, at);
    if (b?.kind === "value" && idOnlyProjection(b.expr)) {
      problems.push(`\`${head}\` is fed from a \`select\` projection without \`username\``);
    }
    if (b?.kind === "element") problems.push(...iterableProblems(file, b.iterable, b.at, universe, depth + 1, prop));
    return problems;
  }

  if (IDENT.test(e)) {
    const why = idSegment(e);
    if (why) problems.push(`\`${e}\` is ${why}`);
    const b = bindingOf(code, e, at);
    if (!b) {
      if (!/username/i.test(e)) problems.push(`cannot see where \`${e}\` comes from — name it \`username\` or bind it in this file`);
      return problems;
    }
    if (b.kind === "value") problems.push(...problemsWith(file, b.expr, b.at, universe, depth + 1));
    else if (b.kind === "element") problems.push(...iterableProblems(file, b.iterable, b.at, universe, depth + 1));
    else if (b.kind === "field") problems.push(...iterableProblems(file, b.source, b.at, universe, depth + 1, e));
    else {
      // A parameter: the value is whatever each caller passes. A wrapper
      // `function tell(username) { sendNotification(…{ username }) }` fed
      // `admin.id` is the same bug one call away.
      for (const call of callsOf(b.fn, universe)) {
        const arg = b.destructured
          ? propertyOf(call.args[b.index] ?? "", e)
          : (call.args[b.index] ?? null);
        if (!arg) continue;
        problems.push(
          ...problemsWith(call.file, arg, call.at, universe, depth + 1).map(
            (p) => `via ${b.fn}(…) at ${call.file.id}:${lineOf(call.file.code, call.at)}: ${p}`,
          ),
        );
      }
    }
    return problems;
  }

  // A call or anything else. `(… ).userId` ends in an id; a literal `.id`
  // anywhere outside a `where` is one; a same-file helper is read.
  const tail = e.match(/\)\s*\??\.\s*([A-Za-z_$][\w$]*)$/);
  const tailWhy = tail ? idSegment(tail[1]!) : null;
  if (tailWhy) problems.push(`\`${e.slice(0, 80)}\` ends in ${tailWhy}`);
  else if (/(?:^|[^\w$])\w*\.id\b(?!\s*[:(])/.test(e) && !/\bwhere\b/.test(e)) {
    problems.push(`\`${e.slice(0, 80)}\` passes a \`.id\``);
  }
  problems.push(...helperProblems(code, e));
  return problems;
}

/**
 * What an iterated recipient comes from. `prop` is the property the recipient
 * reads off each element (`o.username` → "username"), or undefined when the
 * element IS the recipient.
 *
 * Follows: a `select` projection; `.map((x) => x.id)`; a same-file helper; an
 * array built up with `.push(…)` from `[]` (the shape that hid commit 5's
 * camera bug from the first version of this sweep); and a parameter, through
 * its callers.
 */
function iterableProblems(
  file: SourceFile,
  expr: string,
  at: number,
  universe: readonly SourceFile[],
  depth: number,
  prop?: string,
): string[] {
  const code = file.code;
  const e = expr.replace(/^await\s+/, "").trim();
  if (idOnlyProjection(e)) return [`iterates \`${e.slice(0, 80)}\`, a select projection without \`username\``];
  if (depth > 6) return [];
  const problems: string[] = [];

  // `rows.map((r) => r.id)` — only when the map IS the iterated value (its
  // `)` closes the expression), not a `.map` inside a query's `where`.
  const map = [...e.matchAll(/\.map\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*(?::[^)=]*)?\)?\s*=>\s*/g)].find(
    (m) => scanTo(e, m.index! + ".map(".length, ")") === e.length - 1,
  );
  if (map) {
    const body = e.slice(map.index! + map[0].length, scanTo(e, map.index! + map[0].length, ")")).trim();
    if (!body.startsWith("{")) {
      for (const part of valueParts(body)) {
        const segments = part.split(/\??\./);
        const why = MEMBER.test(part) || IDENT.test(part) ? idSegment(segments[segments.length - 1]!) : null;
        if (why) problems.push(`iterates \`${e.slice(0, 80)}\`, whose element is ${why}`);
      }
    }
  }
  problems.push(...helperProblems(code, e));

  if (!IDENT.test(e)) return problems;
  const b = bindingOf(code, e, at);
  if (b?.kind === "value") {
    if (/^(?:\[\s*\]|new\s+(?:Set|Array)\b[^;]*)$/.test(b.expr)) {
      // Built up element by element: check what was put in.
      const add = new RegExp(`(?<![\\w$.])${esc(e)}\\s*\\.\\s*(?:push|unshift|add)\\s*\\(`, "g");
      for (const m of code.matchAll(add)) {
        if (m.index! < b.at || m.index! > at) continue;
        const open = m.index! + m[0].length;
        for (const arg of splitTop(code.slice(open, scanTo(code, open, ")")), [","])) {
          const value = prop ? (propertyOf(arg, prop) ?? (IDENT.test(arg) || MEMBER.test(arg) ? `${arg}.${prop}` : null)) : arg;
          if (value) problems.push(...problemsWith(file, value, m.index!, universe, depth + 1));
        }
      }
    } else {
      problems.push(...iterableProblems(file, b.expr, b.at, universe, depth + 1, prop));
    }
  } else if (b?.kind === "param" && !b.destructured) {
    for (const call of callsOf(b.fn, universe)) {
      const arg = call.args[b.index];
      if (!arg) continue;
      problems.push(
        ...iterableProblems(call.file, arg, call.at, universe, depth + 1, prop).map(
          (p) => `via ${b.fn}(…) at ${call.file.id}:${lineOf(call.file.code, call.at)}: ${p}`,
        ),
      );
    }
  }
  return problems;
}

// ── The allow-list ─────────────────────────────────────────────────────────

/**
 * Recipients that end in `Id` and ARE usernames. Each reason is checked by a
 * test below; an entry that stops matching a site fails too, so the list
 * cannot rot into a list of things that used to be true.
 */
const ALLOWED: ReadonlyArray<{ file: string; expr: string; reason: string }> = [
  {
    file: "orchestrator:services/reminders-poller.ts",
    expr: "r.userId",
    reason:
      "`Reminder.userId` is a username: every Reminder writer stores the caller's " +
      "req.user.username or, for the assistant's tools, the acting person's username " +
      "(`toolActingUser`, WARP-3101) — followed below",
  },
];

/** Sites whose argument is not an object literal — they forward an already-guarded input. */
const FORWARDERS: ReadonlyArray<{ file: string; callee: string; reason: string }> = [
  {
    // WARP-2804 — record, then deliver: sendNotification hands its input to
    // the durable half, and deliverNotification reads the recipient back from
    // that row (`row.username`, checked below like any other site).
    file: "orchestrator:services/notifications.service.ts",
    callee: "recordNotification",
    reason: "sendNotification hands its own DispatchInput to the durable half after guarding it",
  },
];

const allowed = (site: Site, expr: string) =>
  ALLOWED.some((a) => a.file === site.file.id && a.expr === expr);

/** WARP-2804 — a NotificationLog update by the row's own id (a delivery claim or
 *  stamp): no recipient to check. `where: { id: … }` or the shorthand `{ id, … }`. */
const keyedByRowId = (site: Site) =>
  /^notificationLog\.update(Many)?$/.test(site.callee) && /\bwhere\s*:\s*\{\s*id\s*[:,}]/.test(site.args);
const forwarded = (site: Site) =>
  FORWARDERS.some((f) => f.file === site.file.id && f.callee === site.callee);

/**
 * WARP-2804 (review F7) — a NotificationLog update that writes an `ack*`
 * column acknowledges SOMEONE's notification, and only the recipient may
 * (`keyedByRowId` alone would pass an id-keyed ack of anybody's row — exactly
 * P3's "ack my own rows for this incident" done wrong). So:
 *   - `data` must be an object literal (otherwise what it writes is unseen);
 *   - if it names an `ack*` column, or spreads something that could, the
 *     `where` must be an object literal naming `username` — whose value the
 *     sweep then checks like any other recipient.
 */
function ackWriteProblems(site: Site): string[] {
  if (!/^notificationLog\.update(Many)?$/.test(site.callee)) return [];
  const arg = splitTop(site.args, [","])[0] ?? "";
  const data = propertyOf(arg, "data");
  if (data === null || !data.trim().startsWith("{")) {
    return ["a NotificationLog update whose `data` is not an object literal — the columns it writes (an ack?) cannot be seen"];
  }
  const body = data.trim().slice(1, scanTo(data.trim(), 1, "}"));
  const entries = splitTop(body, [","]);
  const writesAck = entries.some((e) => /^ack[A-Z]\w*\s*(:|$)/.test(e) || e.startsWith("..."));
  if (!writesAck) return [];
  const where = propertyOf(arg, "where");
  if (where !== null && where.trim().startsWith("{") && propertyOf(where, "username") !== null) return [];
  return [
    "writes the ack columns without `username` in its `where` — it would ack another person's notification; " +
      "only the recipient acks (WARP-2804)",
  ];
}

/**
 * Everything wrong with one site, `[]` when nothing is. The sweep below and the
 * scanner's self-test run THIS function, so a fixture the self-test proves red
 * is red for the same reason a production site would be.
 */
function siteProblems(site: Site, universe: readonly SourceFile[]): string[] {
  const acks = ackWriteProblems(site);
  if (acks.length > 0) return acks;
  const recipients = recipientsOf(site);
  if (recipients.length === 0) {
    const legacy = site.args.match(/(?<![\w$.'"`])userId\s*:\s*([^,}\n]+)/);
    if (legacy) {
      return [`passes \`${legacy[0]}\` — the recipient field is \`username\` and takes a User.username, never a User.id (WARP-2911)`];
    }
    return forwarded(site) || keyedByRowId(site)
      ? []
      : [
          "no `username` in the arguments — pass an object literal so the recipient is visible here, key a " +
            "NotificationLog update by the row's id, or add the site to FORWARDERS with a reason",
        ];
  }
  return recipients.flatMap(({ expr, at }) =>
    allowed(site, expr) ? [] : problemsWith(site.file, expr, at, universe).map((p) => `username: ${expr} — ${p}`),
  );
}

// ── The sweep ──────────────────────────────────────────────────────────────

describe("🔴 WARP-2911 every notification recipient is a username", () => {
  it("finds the sites — a sweep that finds nothing passes everything", () => {
    const files = new Set(SITES.map((s) => s.file.id));
    // Floors, not an inventory: a new sender adds a site without editing this
    // file, but losing any of these means the scanner broke.
    for (const f of [
      "orchestrator:services/notifications.service.ts",
      "orchestrator:services/filing/digest.ts",
      "orchestrator:services/audit-verify.service.ts",
      "orchestrator:services/brain/brain-notify.service.ts",
      "orchestrator:services/activity-notify.service.ts",
      "orchestrator:services/reminders-poller.ts",
      "orchestrator:routes/device-clients.ts",
      "orchestrator:routes/notifications.ts",
      // WARP-2978 — the Security alert notifier (record-then-deliver).
      "orchestrator:services/security-alerts.service.ts",
    ]) {
      expect(files, `the sweep found no site in ${f}`).toContain(f);
    }
    expect(SITES.length).toBeGreaterThanOrEqual(15);
  });

  // One case per site, named for it: the run output IS the enumeration.
  it.each(SITES.map((s) => [s.label, s] as const))("%s", (_label, site) => {
    expect(
      siteProblems(site, PRODUCTION),
      `${site.label}: the recipient must be a User.username. A User.id here reaches nobody: the ` +
        "toast topic, the PushSubscription lookup and both NotificationLog readers are keyed on " +
        "the username (WARP-2783, WARP-2813, WARP-2910).",
    ).toEqual([]);
  });

  it("WARP-2804: N1-N4 reach every username-keyed entry point with the caller's username", () => {
    const routes = SITES.filter((s) => s.file.id === "orchestrator:routes/notifications.ts");
    expect(new Set(routes.map((s) => s.callee))).toEqual(
      new Set(["sendNotification", "listNotifications", "countUnread", "ackNotification", "ackAllNotifications"]),
    );
    for (const s of routes) {
      // WARP-3060 / WARP-3099 — /send's and N1's recipient is
      // `recipientFor(prisma, req, tool)`'s: the caller, or for the
      // send_notification / list_notifications tool the person it acts for.
      for (const r of recipientsOf(s)) expect(r.expr, s.label).toMatch(/^(getUser\(req\)|username|recipient\.username)$/);
    }
    // Every direct NotificationLog update is either keyed by the recipient or by the row's own id.
    const updates = SITES.filter((s) => /^notificationLog\.update/.test(s.callee));
    expect(updates.length).toBeGreaterThanOrEqual(4);
    for (const s of updates) {
      expect(recipientsOf(s).length > 0 || keyedByRowId(s), s.label).toBe(true);
      expect(s.args, `${s.label} writes the recipient column`).not.toMatch(/\bdata\s*:\s*\{[^}]*\busername\b/);
    }
  });

  it("WARP-2978: the Security notifier records by `recipient.user.username`, from a user projection that carries the username", () => {
    const sites = SITES.filter((s) => s.file.id === "orchestrator:services/security-alerts.service.ts");
    expect(sites.map((s) => s.callee)).toEqual(["recordNotification"]);
    expect(sites.flatMap((s) => recipientsOf(s).map((r) => r.expr))).toEqual(["recipient.user.username"]);
    expect(sites[0]!.file.code).toMatch(/const USER_SELECT = \{[^}]*\busername: true/);
  });

  it("🔴 WARP-3060 tools-core writes no NotificationLog row — nothing would ever deliver it", () => {
    // `send_notification` used to insert its row through ctx.prisma with
    // `channels: ""`; no toast, no push, and (since WARP-2804) an unread item
    // for a notification that was never sent. A notification is SENT through
    // the orchestrator (POST /api/notifications/send → sendNotification), which
    // records the row and carries it in one call.
    const writes = SITES.filter((s) => s.file.id.startsWith("tools-core:") && s.callee.startsWith("notificationLog."));
    expect(writes.map((s) => s.label)).toEqual([]);
  });

  it("every allow-list entry still matches a site (no stale allowances)", () => {
    for (const a of ALLOWED) {
      const hit = SITES.some((s) => s.file.id === a.file && recipientsOf(s).some((r) => r.expr === a.expr));
      expect(hit, `ALLOWED entry ${a.file} \`${a.expr}\` matches no site — delete it`).toBe(true);
    }
    for (const f of FORWARDERS) {
      const hit = SITES.some((s) => s.file.id === f.file && s.callee === f.callee && recipientsOf(s).length === 0);
      expect(hit, `FORWARDERS entry ${f.file} ${f.callee} matches no site — delete it`).toBe(true);
    }
  });

  it("reminders-poller: `r` is a Reminder row, and every Reminder writer stores a username", () => {
    // The allowance above, checked rather than trusted.
    const poller = PRODUCTION.find((f) => f.id === "orchestrator:services/reminders-poller.ts")!;
    const site = SITES.find((s) => s.file === poller && s.callee === "sendNotification")!;
    const r = bindingOf(poller.code, "r", site.offset);
    expect(r).toMatchObject({ kind: "element", iterable: "due" });
    const due = bindingOf(poller.code, "due", site.offset);
    expect(due?.kind === "value" && due.expr).toMatch(/^await prisma\.reminder\.findMany\(/);

    const writers = reminderWriters();
    expect(writers.length).toBeGreaterThanOrEqual(1);
    for (const w of writers) {
      expect(w.values.length, `${w.where}: a Reminder write with no visible userId`).toBeGreaterThan(0);
      for (const v of w.values) {
        const acting = /^(\w+)\.username$/.exec(v);
        const bound = acting ? bindingOf(w.file.code, acting[1]!, w.at) : null;
        const ok =
          (v === "getUser(req)" && /function getUser\([^)]*\)[^{]*\{[^}]*req\.user\?\.username/.test(w.file.code)) ||
          // WARP-3101 — the acting person's username, which the case below pins.
          (bound?.kind === "value" && /^await toolActingUser\(/.test(bound.expr));
        expect(ok, `${w.where}: Reminder.userId written from \`${v}\` — the poller sends on it as a username`).toBe(true);
      }
    }
  });

  it("🔴 WARP-3101 tools-core writes no Reminder row — its ctx.userId is a User.id over the HTTP transport", () => {
    // create_reminder and set_timer used to insert through ctx.prisma with
    // `userId: ctx.userId`. Over the mcp-server's HTTP transport that is the
    // User.id: the poller stamped the reminder notified, sendNotification threw
    // NOTIFICATION_RECIPIENT_IS_ID, and the reminder was lost. Both post to
    // POST /api/reminders now, which keys the row on the acting person.
    expect(reminderWriters().filter((w) => w.file.id.startsWith("tools-core:")).map((w) => w.where)).toEqual([]);
  });

  it("WARP-3101 `toolActingUser` answers with a username only: the caller's, or the resolved person's", () => {
    // What the `<x>.username` writer above relies on. Every `ok: true` answer
    // is one of two, and the resolved one reads the row's `username` column.
    const helper = PRODUCTION.find((f) => f.id === "orchestrator:services/tool-acting-user.service.ts")!;
    const asserted = PRODUCTION.find((f) => f.id === "orchestrator:services/asserted-user.service.ts")!;
    const answers = [...helper.code.matchAll(/return\s*\{\s*ok:\s*true\s*,([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(answers.sort()).toEqual(["username", "username: resolved.user.username"]);
    expect(helper.code).toMatch(/const username = req\.user\?\.username;/);
    expect(helper.code).toMatch(/const resolved = await resolveAssertedUser\(prisma, asserted\);/);
    expect(asserted.code).toMatch(/select:\s*\{[^}]*\busername:\s*true/);
  });
});

/** Every `reminder.create/createMany/upsert` in production, with the `userId` values it writes. */
function reminderWriters() {
  return PRODUCTION.flatMap((file) =>
    [...file.code.matchAll(/\breminder\.(?:createMany|create|upsert)\s*\(/g)].map((m) => {
      const from = m.index! + m[0].length;
      const args = file.code.slice(from, scanTo(file.code, from, ")"));
      const values = [...args.matchAll(/\buserId\s*:\s*([^,}\n]+)/g)].map((v) => v[1]!.trim());
      return { where: `${file.id}:${lineOf(file.code, m.index!)}`, at: m.index!, file, values };
    }),
  );
}

// ── The fixtures ───────────────────────────────────────────────────────────

/**
 * The tests that fake a user lookup on a notification path. Each one used to
 * be able to return `{ id }` alone — agreeing with the bug, since the service
 * handed the id on and nothing downstream looked. The rows must carry a
 * `username` DISTINCT from the `id`, as production rows do.
 */
const FIXTURE_FILES = [
  "src/services/audit-verify.service.test.ts",
  "src/__tests__/brain-notify.test.ts",
  "src/services/team-chat-reminders.service.test.ts",
  "src/__tests__/filing-slice3.test.ts",
];

/** Innermost `{ … }` literals (no nested braces) whose `id` is a string literal. */
function rowLiterals(text: string): string[] {
  return [...text.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((l) => /\bid\s*:\s*["'`]/.test(l));
}

function fixtureRows(code: string): string[] {
  const rows: string[] = [];
  for (const m of code.matchAll(/(?<![\w$])user\s*:\s*\{/g)) {
    const start = m.index! + m[0].length;
    const block = code.slice(start, scanTo(code, start, "}"));
    if (!/find(First|Many|Unique)/.test(block)) continue;
    rows.push(...rowLiterals(block));
  }
  // Seeds handed to a stub that filters them (`users: [ALICE, { id, username }]`).
  for (const m of code.matchAll(/(?<![\w$])users\s*:\s*\[/g)) {
    const start = m.index! + m[0].length;
    const list = code.slice(start, scanTo(code, start, "]"));
    rows.push(...rowLiterals(list));
    for (const ident of list.match(/(?<![\w$."'`])[A-Z][A-Z0-9_]*(?![\w$])/g) ?? []) {
      const decl = code.match(new RegExp(`const\\s+${ident}\\s*=\\s*(\\{[^{}]*\\})`));
      if (decl) rows.push(decl[1]!);
    }
  }
  return rows;
}

describe("🔴 WARP-2911 user fakes on notification paths return distinct id and username", () => {
  it.each(FIXTURE_FILES)("%s", (rel) => {
    const code = stripComments(readFileSync(packagePath(rel), "utf8"));
    const rows = fixtureRows(code);
    expect(rows.length, `${rel}: no user fixture rows found — the scan broke, or the fixture moved`).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row, `${rel}: a faked User row without a username — it agrees with the bug`).toMatch(/\busername\s*:/);
      const id = row.match(/\bid\s*:\s*["'`]([^"'`]*)["'`]/)?.[1];
      const username = row.match(/\busername\s*:\s*["'`]([^"'`]*)["'`]/)?.[1];
      if (username !== undefined) {
        expect(id, `${rel}: ${row} — id and username must differ, as they do in production`).not.toBe(username);
      }
    }
  });
});

// ── The scanner's self-test ────────────────────────────────────────────────

/**
 * A sweep is only as good as the shapes it can see. Each fixture below is a
 * tiny source file with ONE recipient site. It runs through `siteProblems`, the
 * function the sweep above uses, so "the scanner flags it" means production
 * code written that way goes red.
 *
 * KNOWN_BAD holds the shapes a reviewer showed passing the first version of this
 * sweep (review of #2349), plus the three historical defects. KNOWN_GOOD holds
 * the idioms production actually uses, so the hardening cannot turn into a
 * sweep that flags everything.
 */
const KNOWN_BAD: ReadonlyArray<readonly [string, string]> = [
  [
    "`as string` on an id",
    `async function run(prisma) {
      const prefs = await prisma.cameraNotificationPref.findMany({});
      for (const p of prefs) await sendNotification(prisma, { username: p.userId as string, kind: "system", title: "t" });
    }`,
  ],
  [
    "`?? \"dev\"` after an id",
    `async function run(prisma) {
      const prefs = await prisma.cameraNotificationPref.findMany({});
      for (const p of prefs) await sendNotification(prisma, { username: p.userId ?? "dev", kind: "system", title: "t" });
    }`,
  ],
  [
    "a non-null assertion mid-chain: `pref!.userId`",
    `async function run(prisma, pref) {
      await sendNotification(prisma, { username: pref!.userId, kind: "system", title: "t" });
    }`,
  ],
  [
    "a template literal around an id",
    `async function run(prisma, pref) {
      await sendNotification(prisma, { username: \`\${pref.userId}\`, kind: "system", title: "t" });
    }`,
  ],
  [
    "`String(…)` around an id",
    `async function run(prisma, pref) {
      await sendNotification(prisma, { username: String(pref.userId), kind: "system", title: "t" });
    }`,
  ],
  [
    "dispatchToUser: `pref!.userId`",
    `async function run(prisma, pref, payload) {
      await dispatchToUser(prisma, pref!.userId, payload);
    }`,
  ],
  [
    "dispatchToUser: `String(pref.userId)`",
    `async function run(prisma, pref, payload) {
      await dispatchToUser(prisma, String(pref.userId), payload);
    }`,
  ],
  [
    "dispatchToUser: `pref.userId as string`",
    `async function run(prisma, pref, payload) {
      await dispatchToUser(prisma, pref.userId as string, payload);
    }`,
  ],
  [
    "ids pushed into an empty array, then looped (the commit-5 camera shape)",
    `async function run(prisma, payload) {
      const users = await prisma.user.findMany({ select: { id: true, role: true, username: true } });
      const allowed: string[] = [];
      for (const u of users) allowed.push(u.id);
      for (const recipient of allowed) void dispatchToUser(prisma, recipient, payload);
    }`,
  ],
  [
    "ids pushed into an empty array, then looped — sendNotification",
    `async function run(prisma) {
      const admins = await prisma.user.findMany({ where: { role: "admin" } });
      const to = [];
      for (const a of admins) to.push(a.id);
      for (const recipient of to) await sendNotification(prisma, { username: recipient, kind: "system", title: "t" });
    }`,
  ],
  [
    "rows mapped to their ids, then looped",
    `async function run(prisma) {
      const rows = await prisma.user.findMany({ where: { role: "admin" } });
      const ids = rows.map((r) => r.id);
      for (const recipient of ids) await sendNotification(prisma, { username: recipient, kind: "system", title: "t" });
    }`,
  ],
  [
    "a wrapper whose parameter is named `username`, fed an id",
    `async function tell(prisma, username: string) {
      await sendNotification(prisma, { username, kind: "system", title: "t" });
    }
    export async function run(prisma) {
      const admins = await prisma.user.findMany({ where: { role: "admin" } });
      for (const admin of admins) await tell(prisma, admin.id);
    }`,
  ],
  [
    "a wrapper whose destructured parameter is `username`, fed an id",
    `const tell = async (prisma, { username, title }: { username: string; title: string }) => {
      await sendNotification(prisma, { username, kind: "system", title });
    };
    export async function run(prisma, settings) {
      await tell(prisma, { username: settings.enabledById, title: "t" });
    }`,
  ],
  [
    "WARP-2783: a `select: { id: true }` recipient",
    `async function run(prisma) {
      const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
      for (const admin of admins) await sendNotification(prisma, { username: admin.id, kind: "system", title: "t" });
    }`,
  ],
  [
    "WARP-2813: a same-file lookup that returns the id",
    `async function ownerUsername(prisma) {
      const owner = await prisma.user.findFirst({ where: { role: "owner" }, select: { id: true } });
      return owner?.id ?? null;
    }
    async function run(prisma) {
      const to = await ownerUsername(prisma);
      await sendNotification(prisma, { username: to, kind: "ai", title: "t" });
    }`,
  ],
  [
    "WARP-2910: the digest's `settings.enabledById`",
    `async function run(prisma, settings) {
      await sendNotification(prisma, { username: settings.enabledById, kind: "ai", title: "t" });
    }`,
  ],
  [
    "a site still spelling the field `userId`",
    `async function run(prisma, admin) {
      await sendNotification(prisma, { userId: admin.id, kind: "system", title: "t" });
    }`,
  ],
  // WARP-2804 (review F7) — writing `ack*` acks SOMEONE's notification, and
  // only the recipient may: the where must carry the username. The first
  // two are exactly P3's "ack my own rows for this incident" done wrong.
  [
    "an id-keyed update that writes the ack columns (acks whoever's row it is)",
    `async function ackRow(prisma, id) {
      await prisma.notificationLog.update({ where: { id }, data: { ackState: "acked", ackedAt: new Date(), ackMethod: "incident" } });
    }`,
  ],
  [
    "an id-list updateMany that acks without the recipient in its where",
    `async function ackIncidentRows(prisma, ids, sid) {
      await prisma.notificationLog.updateMany({
        where: { id: { in: ids }, ackState: "unacked" },
        data: { ackState: "acked", ackedAt: new Date(), ackMethod: "incident", ackSessionId: sid },
      });
    }`,
  ],
  [
    "ack columns hidden behind a spread in `data`",
    `async function ackRow(prisma, id, patch) {
      await prisma.notificationLog.updateMany({ where: { id }, data: { ...patch } });
    }`,
  ],
  [
    "a `data` that is not an object literal",
    `async function ackRow(prisma, id, patch) {
      await prisma.notificationLog.update({ where: { id }, data: patch });
    }`,
  ],
];

const KNOWN_GOOD: ReadonlyArray<readonly [string, string]> = [
  // WARP-2804 (review F7) — the two NotificationLog update shapes that ARE right.
  [
    "an ack of the actor's OWN rows: the ids AND the actor's username in the where",
    `async function ackOwn(prisma, ids, username) {
      await prisma.notificationLog.updateMany({
        where: { id: { in: ids }, username, ackState: { in: ["unacked", "untracked"] } },
        data: { ackState: "acked", ackedAt: new Date(), ackMethod: "incident" },
      });
    }
    async function onAck(prisma, req, ids) {
      await ackOwn(prisma, ids, req.user.username);
    }`,
  ],
  [
    "a delivery stamp keyed by the row's id writes no ack column",
    `async function stamp(prisma, id) {
      await prisma.notificationLog.update({ where: { id }, data: { channels: "toast", deliveredAt: new Date(), error: null } });
    }`,
  ],
  [
    "a username selected and destructured in the loop",
    `async function run(prisma) {
      const users = await prisma.user.findMany({ where: { role: "admin" }, select: { username: true } });
      for (const { username } of users) await sendNotification(prisma, { username, kind: "system", title: "t" });
    }`,
  ],
  [
    "`row.username`, with a literal fallback",
    `async function run(prisma, row) {
      await sendNotification(prisma, { username: row.username ?? "dev", kind: "system", title: "t" });
    }`,
  ],
  [
    "the session's username through a same-file getter",
    `function getUser(req) { return req.user?.username || "dev"; }
    async function run(prisma, req) {
      const username = getUser(req);
      await dispatchToUser(prisma, username, { title: "t", body: "b" });
    }`,
  ],
  [
    "rows pushed into an array, their `.username` dialled (the fixed camera shape)",
    `async function run(prisma, payload) {
      const users = await prisma.user.findMany({ select: { id: true, role: true, username: true } });
      const allowed: typeof users = [];
      for (const u of users) allowed.push(u);
      for (const recipient of allowed) void dispatchToUser(prisma, recipient.username, payload);
    }`,
  ],
  [
    "a wrapper whose parameter is named `username`, fed a username",
    `async function tell(prisma, username: string) {
      await sendNotification(prisma, { username, kind: "system", title: "t" });
    }
    export async function run(prisma) {
      const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { username: true } });
      for (const admin of admins) await tell(prisma, admin.username);
    }`,
  ],
  [
    "object literals pushed, their `username` recorded (the activity-notify shape)",
    `async function claim(tx, outgoing) {
      for (const o of outgoing) await recordNotification(tx, { username: o.username, kind: "event", title: o.title });
    }
    async function sweep(prisma, users) {
      const outgoing = [];
      for (const u of users) {
        const username = u.username;
        outgoing.push({ username, title: "t" });
      }
      await claim(prisma, outgoing);
    }`,
  ],
];

function fixture(name: string, source: string): SourceFile {
  return { id: `fixture:${name}`, code: stripComments(source) };
}

describe("🔴 WARP-2911 the sweep's scanner, tested on the shapes it must see", () => {
  it.each(KNOWN_BAD)("flags: %s", (name, source) => {
    const file = fixture(name, source);
    const sites = sitesIn(file);
    expect(sites, `${name}: the scanner found no site at all`).toHaveLength(1);
    expect(siteProblems(sites[0]!, [file]), `${name}: the scanner let it through`).not.toEqual([]);
  });

  it.each(KNOWN_GOOD)("passes: %s", (name, source) => {
    const file = fixture(name, source);
    const sites = sitesIn(file);
    expect(sites, `${name}: the scanner found no site at all`).toHaveLength(1);
    expect(siteProblems(sites[0]!, [file])).toEqual([]);
  });
});
