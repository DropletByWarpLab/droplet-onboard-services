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
 *                 publishNotificationToast(
 *   direct writes notificationLog.create( / notificationLog.createMany( /
 *                 pushSubscription.upsert( / pushSubscription.create(
 *
 * ## What it asserts, per site
 *
 * The `username` the site passes is not:
 *   - fed from a `select` projection without `username` (the WARP-2783 shape);
 *   - an `enabledById`, a `createdById`, an `ownerId`, a `.id`, or any
 *     identifier ending in `Id`.
 * A bare identifier is followed back to its binding (`const x = …`,
 * `for (const x of …)`, `for (const { username } of …)`), and a same-file
 * helper it is assigned from is read (`const to = await ownerUsername(prisma)`,
 * the WARP-2813 shape), so `const owner = settings.enabledById; … { username:
 * owner }` is still red. A site that still passes `userId:` is red too.
 *
 * Two recipients ending in `Id` ARE usernames and are allow-listed below with
 * the reason. Neither reason is taken on trust: the reminders one is checked by
 * following every Reminder writer, the tools-core one is pinned to exactly
 * `ctx.userId`, and an entry that stops matching a site fails.
 *
 * The run output enumerates every site it found (one case per site).
 *
 * The runtime twin is `assertRecipientIsUsername` in notifications.service.ts:
 * a UUID-shaped recipient throws `NOTIFICATION_RECIPIENT_IS_ID`. This file
 * catches the mistake before it runs; that one catches whatever this misses.
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

const CALL = /(?<![\w$.])(sendNotification|recordNotification|publishNotificationToast)\s*\(/g;
const WRITE = /(?<![\w$])(notificationLog\.(?:createMany|create)|pushSubscription\.(?:upsert|create))\s*\(/g;

function sitesIn(file: SourceFile): Site[] {
  const out: Site[] = [];
  for (const re of [CALL, WRITE]) {
    for (const m of file.code.matchAll(re)) {
      // The three definitions are not call sites.
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
  | { kind: "value"; expr: string } // const x = <expr>
  | { kind: "element"; iterable: string } // for (const x of <iterable>)
  | { kind: "field"; source: string }; // const { x } = <source> / for (const { x } of <source>)

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The nearest declaration of `name` before `before` — a lexical-scope approximation. */
function bindingOf(code: string, name: string, before: number): Binding | null {
  const n = esc(name);
  const patterns: Array<[RegExp, (m: RegExpExecArray) => Binding]> = [
    [
      new RegExp(`(?:const|let|var)\\s+${n}\\s*(?::[^=;]+)?=(?![=>])`, "g"),
      (m) => ({ kind: "value", expr: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ";")).trim() }),
    ],
    [
      new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=(?![=>])`, "g"),
      (m) => ({ kind: "field", source: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ";")).trim() }),
    ],
    [
      new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+of\\s+`, "g"),
      (m) => ({ kind: "element", iterable: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ")")).trim() }),
    ],
    [
      new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s+of\\s+`, "g"),
      (m) => ({ kind: "field", source: code.slice(m.index + m[0].length, scanTo(code, m.index + m[0].length, ")")).trim() }),
    ],
  ];
  let best: { at: number; binding: Binding } | null = null;
  for (const [re, make] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) && m.index < before) {
      if (!best || m.index > best.at) best = { at: m.index, binding: make(m) };
    }
  }
  return best?.binding ?? null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/;

/** A `select: { … }` that projects the id and not the username. */
function idOnlyProjection(expr: string): boolean {
  return [...expr.matchAll(/select\s*:\s*\{([^{}]*)\}/g)].some(
    (m) => /\bid\s*:\s*true/.test(m[1]!) && !/\busername\b/.test(m[1]!),
  );
}

/** The problems with one value flowing into a recipient slot, followed back. */
function problemsWith(code: string, expr: string, at: number, depth = 0): string[] {
  const problems: string[] = [];
  const e = expr.replace(/^await\s+/, "").replace(/^\((.*)\)$/s, "$1").trim();
  if (/\b(enabledById|createdById|ownerId)\b/.test(e)) {
    problems.push(`\`${e}\` names an ${e.match(/\b(enabledById|createdById|ownerId)\b/)![1]} — a User.id`);
  }
  if (idOnlyProjection(e)) problems.push(`\`${e.slice(0, 80)}\` is a select projection without \`username\``);
  if (depth > 4) return problems;

  if (MEMBER.test(e)) {
    const last = e.split(/\??\./).pop()!;
    if (last === "id") problems.push(`\`${e}\` is a \`.id\` — a User.id`);
    else if (/Id$/.test(last)) problems.push(`\`${e}\` is an identifier ending in \`Id\``);
    // `row.username`: where did `row` come from?
    const head = e.split(/\??\./)[0]!;
    const b = bindingOf(code, head, at);
    if (b?.kind === "value" && idOnlyProjection(b.expr)) {
      problems.push(`\`${head}\` is fed from a \`select\` projection without \`username\``);
    }
    if (b?.kind === "element") problems.push(...problemsWithIterable(code, b.iterable, at, depth + 1));
    return problems;
  }

  if (IDENT.test(e)) {
    if (e === "id") problems.push("`id` — a User.id");
    else if (/Id$/.test(e)) problems.push(`\`${e}\` is an identifier ending in \`Id\``);
    const b = bindingOf(code, e, at);
    if (!b) {
      if (!/username/i.test(e)) problems.push(`cannot see where \`${e}\` comes from — name it \`username\` or bind it in this file`);
      return problems;
    }
    if (b.kind === "value") problems.push(...problemsWith(code, b.expr, at, depth + 1));
    else if (b.kind === "element") problems.push(...problemsWithIterable(code, b.iterable, at, depth + 1));
    else problems.push(...problemsWithIterable(code, b.source, at, depth + 1));
    return problems;
  }

  // A call or anything else: the text itself must not carry an id.
  if (/(?:^|[^\w$])\w*\.id\b(?!\s*[:(])/.test(e) && !/\bwhere\b/.test(e)) {
    problems.push(`\`${e.slice(0, 80)}\` passes a \`.id\``);
  }
  // A helper in the same file (`const to = await ownerUsername(prisma)`): read
  // its body. The WARP-2813 shape was exactly this — the lookup selected `id`.
  const callee = e.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  const decl = callee ? new RegExp(`function\\s+${esc(callee)}\\s*\\(`).exec(code) : null;
  if (decl) {
    const open = code.indexOf("{", scanTo(code, decl.index + decl[0].length, ")"));
    const body = code.slice(open + 1, scanTo(code, open + 1, "}"));
    if (idOnlyProjection(body)) problems.push(`\`${callee}()\` reads a select projection without \`username\``);
    if (/\breturn\b[^;]*\.id\b(?!\s*[:(])/.test(body)) problems.push(`\`${callee}()\` returns a \`.id\``);
  }
  return problems;
}

/** Rows or values iterated into a recipient: the source must not be an id projection. */
function problemsWithIterable(code: string, expr: string, at: number, depth: number): string[] {
  const e = expr.replace(/^await\s+/, "").trim();
  if (idOnlyProjection(e)) return [`iterates \`${e.slice(0, 80)}\`, a select projection without \`username\``];
  if (IDENT.test(e) && depth <= 4) {
    const b = bindingOf(code, e, at);
    if (b?.kind === "value") return problemsWithIterable(code, b.expr, at, depth + 1);
  }
  return [];
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
      "`Reminder.userId` is a username: every Reminder writer stores `getUser(req)` " +
      "(= req.user.username) or tools-core's `ctx.userId` — followed below",
  },
  {
    file: "tools-core:handlers/notifications/send-notification.ts",
    expr: "ctx.userId",
    reason:
      "`ToolContext.userId` is the calling user's username (routes/llm.ts, MCP `_meta.userId`) — " +
      "the same key list_notifications reads with",
  },
];

/** Sites whose argument is not an object literal — they forward an already-guarded input. */
const FORWARDERS: ReadonlyArray<{ file: string; callee: string; reason: string }> = [
  {
    file: "orchestrator:services/notifications.service.ts",
    callee: "publishNotificationToast",
    reason: "sendNotification hands its own DispatchInput to the toast half after guarding it",
  },
];

const allowed = (site: Site, expr: string) =>
  ALLOWED.some((a) => a.file === site.file.id && a.expr === expr);
const forwarded = (site: Site) =>
  FORWARDERS.some((f) => f.file === site.file.id && f.callee === site.callee);

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
      "tools-core:handlers/notifications/send-notification.ts",
    ]) {
      expect(files, `the sweep found no site in ${f}`).toContain(f);
    }
    expect(SITES.length).toBeGreaterThanOrEqual(15);
  });

  // One case per site, named for it: the run output IS the enumeration.
  it.each(SITES.map((s) => [s.label, s] as const))("%s", (_label, site) => {
    const recipients = recipientsOf(site);
    if (recipients.length === 0) {
      const legacy = site.args.match(/(?<![\w$.'"`])userId\s*:\s*([^,}\n]+)/);
      expect(
        legacy?.[0] ?? null,
        `${site.label}: passes \`${legacy?.[0]}\` — the recipient field is \`username\` and takes a ` +
          "User.username, never a User.id (WARP-2911).",
      ).toBeNull();
      expect(
        forwarded(site),
        `${site.label}: no \`username\` in the arguments. Pass an object literal so the ` +
          "recipient is visible here, or add the site to FORWARDERS with a reason.",
      ).toBe(true);
      return;
    }
    const problems = recipients.flatMap(({ expr, at }) =>
      allowed(site, expr) ? [] : problemsWith(site.file.code, expr, at).map((p) => `username: ${expr} — ${p}`),
    );
    expect(
      problems,
      `${site.label}: the recipient must be a User.username. A User.id here reaches nobody: the ` +
        "toast topic, the PushSubscription lookup and both NotificationLog readers are keyed on " +
        "the username (WARP-2783, WARP-2813, WARP-2910).",
    ).toEqual([]);
  });

  it("the tools-core send_notification site is fed from `ctx.userId` only", () => {
    const sites = SITES.filter((s) => s.file.id === "tools-core:handlers/notifications/send-notification.ts");
    expect(sites.map((s) => s.callee)).toEqual(["notificationLog.create"]);
    expect(sites.flatMap((s) => recipientsOf(s).map((r) => r.expr))).toEqual(["ctx.userId"]);
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

    const writers = PRODUCTION.flatMap((file) =>
      [...file.code.matchAll(/\breminder\.(?:createMany|create|upsert)\s*\(/g)].map((m) => {
        const from = m.index! + m[0].length;
        const args = file.code.slice(from, scanTo(file.code, from, ")"));
        const values = [...args.matchAll(/\buserId\s*:\s*([^,}\n]+)/g)].map((v) => v[1]!.trim());
        return { where: `${file.id}:${lineOf(file.code, m.index!)}`, file, values };
      }),
    );
    expect(writers.length).toBeGreaterThanOrEqual(3);
    for (const w of writers) {
      expect(w.values.length, `${w.where}: a Reminder write with no visible userId`).toBeGreaterThan(0);
      for (const v of w.values) {
        const ok =
          (w.file.id.startsWith("tools-core:") && v === "ctx.userId") ||
          (v === "getUser(req)" && /function getUser\([^)]*\)[^{]*\{[^}]*req\.user\?\.username/.test(w.file.code));
        expect(ok, `${w.where}: Reminder.userId written from \`${v}\` — the poller sends on it as a username`).toBe(true);
      }
    }
  });
});

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
