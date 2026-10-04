/**
 * WARP-823 — secret redaction for the downloadable log bundle.
 * WARP-1718 — and for structured audit params (see {@link redactSecretParams}).
 *
 * The Settings → "Download diagnostics" log bundle ships journald + container
 * logs off the box to the operator. Those logs routinely echo secret material:
 * env dumps on boot, connection strings, `Authorization: Bearer` headers a
 * proxy logged, the occasional pasted PEM. This module is the MANDATORY scrub
 * applied to every byte before it can leave the appliance (architecture-guard
 * rule 19 — no secrets in anything that leaves the box).
 *
 * Design posture: FAIL CLOSED on shape, not on enumeration. We do not try to
 * know every secret value (impossible — values are random). Instead we match
 * the SHAPES secrets take in logs and replace the value with a fixed
 * placeholder, keeping the surrounding non-secret context (key name, log
 * prefix) so the bundle is still useful for debugging.
 *
 * The same scrub runs in two places for defense in depth:
 *   1. the repo-tracked host collector script (scripts/host/droplet-collect-logs.sh)
 *      redacts as it reads journald/docker on the host, and
 *   2. here, in the orchestrator, on every chunk before it is written into the
 *      zip — so even a collector that missed something (older host script, a
 *      novel log format) cannot leak past this gate.
 *
 * This module is pure + synchronous so the planted-secret unit test
 * (`log-redaction.test.ts`) is the authoritative proof that known secrets never
 * survive, independent of any host.
 *
 * Two entry points, one shared notion of "secret" ({@link SENSITIVE_WORDS}):
 *   - {@link redactSecrets} scrubs free TEXT (the log bundle).
 *   - {@link redactSecretParams} scrubs a STRUCTURED object by key (audit
 *     params on their way into `CommandAuditLog.data`).
 */

/** The fixed marker that replaces any redacted secret value. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * The generic secret-bearing words. A key containing any of these names a value
 * we must not emit. Kept as one alternation so the log-bundle text scrub
 * ({@link redactSecrets}) and the structured-params scrub
 * ({@link redactSecretParams}) can never drift apart on what "secret" means.
 */
const SENSITIVE_WORDS =
  "PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|KEY|PSK|CREDENTIAL|AUTH";

/**
 * Env/key names whose VALUE is always a secret. Matched case-insensitively as a
 * whole word, so `JWT_SECRET`, `redis_password`, `service-token-display` etc.
 * all hit. We match on the generic suffixes ({@link SENSITIVE_WORDS}) rather
 * than enumerating every var so a NEW secret env added later is redacted with
 * no code change — the opposite of an allow-list that silently leaks the next
 * addition.
 */
const SENSITIVE_KEY_WORD = `[A-Za-z0-9_.-]*(?:${SENSITIVE_WORDS})[A-Za-z0-9_.-]*`;

/**
 * Carve-out: env keys that match {@link SENSITIVE_KEY_WORD} on `KEY` but are
 * NOT secret — a public key / key *id* is safe and is occasionally useful for
 * diagnosing a mismatch. Matched case-insensitively as a whole key. Anything
 * not on this list that ends in `KEY` is redacted (fail closed: over-redact a
 * log bundle rather than leak a private key the suffix heuristic didn't model).
 */
const SAFE_KEY_RE = /(?:PUBLIC[_-]?KEY|KEY[_-]?ID|KEYID|_PUBKEY)$/i;

/** WARP-3282 — the marker that replaces a credential in a TOOL RESULT on its
 *  way into the model context. Worded for a reader (the model relays it), not
 *  for an operator grepping a log bundle. */
export const CREDENTIAL_PLACEHOLDER = "[credential redacted]";

/**
 * WARP-3282 — the ONE list of credential VALUE SHAPES, shared by the log-bundle
 * scrub ({@link redactSecrets}, which runs it first, then its own log-only
 * rules) and the tool-result scrub ({@link redactCredentials}, which runs only
 * this list).
 *
 * Why the tool-result scrub cannot reuse the whole log list: the log rules are
 * keyed on NAMES (`sensitive-assignment` redacts the value of anything named
 * `*KEY*`, `*TOKEN*`, `*AUTH*` — `Author: Jane`, `Key: Q3 figures`, a share
 * link's `token=`), and the bare-bearer rule takes any 8 chars after "Bearer".
 * That over-redaction is right for a bundle leaving the box and wrong for a
 * business document the assistant must still be able to read. So every rule
 * HERE must match a value that is a credential by its own shape, or sits in a
 * config-shaped assignment (`UPPER_SNAKE_SECRET=`, `password=`), and must leave
 * prose, file paths, UUIDs and hex hashes alone (pinned by the negatives in
 * `credential-redaction.test.ts`).
 *
 * Each rule takes the placeholder so the two callers keep their own marker.
 * Values starting with `[` are never matched, so both scrubs are idempotent
 * over their own (and each other's) placeholder.
 */
interface ShapeRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (placeholder: string, match: string, ...groups: string[]) => string;
}

const whole = (placeholder: string) => placeholder;
const keepPrefix = (placeholder: string, _m: string, pre: string) => `${pre}${placeholder}`;

/** WARP-3282 — the secret-naming words of a config-shaped name. Shared by the
 *  text rule ({@link CREDENTIAL_SHAPE_RULES} `env-secret-assignment`) and the
 *  field-name test ({@link CREDENTIAL_FIELD_RE}) so the two cannot drift. */
const CONFIG_SECRET_NAME =
  "(?:[A-Z][A-Z0-9]*_)*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY)" +
  "|(?:[a-z][a-z0-9]*_)+(?:secret|token|password|passwd|api_?key|access_key|secret_key|private_key)" +
  "|(?:api|secret|access|private)_key|client_secret";

/** A quoted value's quotes survive redaction, so a redacted JSON/YAML/shell
 *  string is still a string. */
const requote = (placeholder: string, value: string): string => {
  const q = value[0];
  return q === '"' || q === "'" || q === "`" ? `${q}${placeholder}${q}` : placeholder;
};

const CREDENTIAL_SHAPE_RULES: readonly ShapeRule[] = [
  {
    // PEM blocks: -----BEGIN [X] PRIVATE KEY----- ... -----END [X] PRIVATE KEY-----
    // Collapse the whole block (delimiters + body) to a single placeholder so no
    // base64 key material survives. Runs first so a key body can't be partially
    // matched by a later single-line rule.
    name: "pem-private-key",
    pattern:
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    replace: (placeholder) => `${placeholder} (private key)`,
  },
  {
    // A PEM block with no END line: search snippets are cut at 280 chars and
    // read_file pages at 10 000, so a key block is routinely truncated. Fail
    // closed — everything from the BEGIN line to the end of the string goes.
    // Tool results are redacted per JSON string leaf ({@link redactToolResult}),
    // so "the end" is the end of THAT snippet, never a sibling field.
    name: "pem-private-key-truncated",
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*$/g,
    replace: (placeholder) => `${placeholder} (private key)`,
  },
  {
    // Credentials embedded in a URI userinfo: scheme://user:SECRET@host
    // Redacts only the password component, preserving scheme/user/host so the
    // line still tells you which service/db it was. The username class is `*`
    // (not `+`) so empty-username forms — `redis://:pw@host`, the exact shape
    // secrets.sh generates for REDIS_URL, and `postgresql://:pw@db/...` — are
    // also redacted. The trailing `@` anchor still prevents matching a plain
    // `host:port` with no userinfo. The scheme is bounded to 32 chars:
    // unbounded, every letter of a long alphanumeric run started a scan to
    // its end (quadratic — ~20 s over a 200k base64 blob). Neither class
    // crosses `"` or `\`, so in compact JSON
    // `"see http://host:8080","from":"bob@x.io"` cannot match across the
    // field boundary and eat `from`.
    name: "uri-userinfo",
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s:/@"\\]*:)([^\s@/"\\]+)(@)/g,
    replace: (placeholder, _m, pre: string, _secret: string, at: string) =>
      `${pre}${placeholder}${at}`,
  },
  {
    // WARP-3572 - a systemd LUKS recovery key (`systemd-cryptenroll
    // --recovery-key`). Defence in depth only: the primary control is that
    // droplet-luks-provision.sh never writes the key to an unattended
    // service's stdout.
    //
    // Shape, from systemd's src/shared/recovery-key.c (modhex_alphabet,
    // RECOVERY_KEY_MODHEX_RAW_LENGTH, make_recovery_key): 32 random bytes
    // rendered as 64 modhex characters from the 16-symbol alphabet
    // `cbdefghijklnrtuv` (note the `b`), printed as eight dash-separated
    // groups of eight; the same code also accepts the dash-less 64-character
    // form and upper case, so all three are matched here.
    //
    // No `\b`: `_` and digits are word characters, so `\b` would miss a key
    // glued to them. The boundary is "start, or a character outside the
    // alphabet" on each side (the same boundary as the sed rule in
    // scripts/host/droplet-collect-logs.sh - keep the two in sync). The
    // trailing boundary is a lookahead so two keys separated by one
    // character both match in a single pass.
    name: "luks-recovery-key",
    pattern:
      /(^|[^cbdefghijklnrtuvCBDEFGHIJKLNRTUV])([cbdefghijklnrtuvCBDEFGHIJKLNRTUV]{8}(?:-?[cbdefghijklnrtuvCBDEFGHIJKLNRTUV]{8}){7})(?=[^cbdefghijklnrtuvCBDEFGHIJKLNRTUV]|$)/g,
    replace: (placeholder, _m, pre: string) => `${pre}${placeholder}`,
  },
  {
    // AWS access key id (long-term AKIA, temporary ASIA): fixed 20-char shape.
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: whole,
  },
  {
    // A config-shaped assignment of a secret: `AWS_SECRET_ACCESS_KEY=…`,
    // `DB_PASSWORD: …` (YAML), `db_password=…`, `"STRIPE_API_KEY": "…"`, the
    // lowercase keys of ~/.aws/credentials. The name must be UPPER_SNAKE or
    // snake_case ending in a secret word; camelCase JSON keys
    // (`confirmationToken`, `shareToken`) and a bare lowercase `token=` (a
    // share link) never match. `=` takes any 6+ char value; `:` only when
    // the name has an underscore, so a `TOP SECRET: launch plan` heading is
    // prose. The value may be "…", '…' or `…` quoted; its class stops at a
    // quote or `\`, so the closing quote survives and JSON stays JSON.
    name: "env-secret-assignment",
    pattern: new RegExp(
      `\\b(${CONFIG_SECRET_NAME})("?[ \\t]*[:=][ \\t]*["'\`]?)(?!\\[)([^\\s"'\`\\\\,;]{6,})`,
      "g",
    ),
    replace: (placeholder, m, key: string, sep: string) =>
      sep.includes(":") && !key.includes("_") ? m : `${key}${sep}${placeholder}`,
  },
  {
    // `password=…`, `passwd: …`, `"password": "…"`, `**Password:** …`.
    // `=` is always a credential. The `:` form is where prose lives
    // ("Password: required.", "Password: 12 characters minimum"), so an
    // UNQUOTED `:` value must look like a password: 6+ chars with a digit or
    // symbol. Markdown emphasis around the label is part of the separator,
    // never mistaken for the value. A quoted value keeps its quotes.
    // `passwordProtected` never matches (word boundary after the name).
    name: "password-assignment",
    pattern:
      /\b(pass(?:word|wd|phrase))((?:\*\*|__)?"?[ \t]*[:=][ \t]*(?:\*\*|__)?[ \t]*)(?!\[)("[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[^\s"'`,;]+)/gi,
    replace: (placeholder, m, key: string, sep: string, value: string) => {
      const quoted = /^["'`]/.test(value);
      const bare = value.replace(/[.!?)]+$/, "");
      if (sep.includes(":") && !quoted && !(bare.length >= 6 && /[^A-Za-z]/.test(bare))) return m;
      return `${key}${sep}${requote(placeholder, value)}`;
    },
  },
  {
    // Provider API tokens, recognisable by prefix:
    //   OpenAI/Anthropic `sk-…` — a digit and a 20+ char alphanumeric run, so
    //     `sk-learn-notes` and a file named `sk-projects-2026-budget.xlsx`
    //     survive,
    //   Stripe `sk_/rk_/pk_` `live_`/`test_`,
    //   GitHub `ghp_/gho_/ghu_/ghs_/ghr_` and `github_pat_`,
    //   Slack `xoxb-/xoxp-/xoxa-/xoxs-`,
    //   HubSpot private-app `pat-<region>-…`,
    //   Google API key `AIza…` and OAuth access token `ya29.…`.
    // Never preceded by `/`, `\`, `.` or `-`: a path segment or a longer
    // hyphenated name is not a token.
    name: "provider-token",
    pattern:
      /(?<![/\\.-])\b(?:sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]*?[A-Za-z0-9]{20}[A-Za-z0-9_-]*|[srp]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[bpas]-[A-Za-z0-9-]{10,}|pat-[a-z]{2}\d-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9._-]{20,})/g,
    replace: whole,
  },
  {
    // JWT: header and payload are base64url JSON, so both start `eyJ`.
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replace: whole,
  },
  {
    // `Bearer <opaque token>` in free text: 20+ chars with BOTH a digit and a
    // letter, so "bearer instruments" survives. (The log list keeps its
    // broader bearer rule.)
    name: "bearer-opaque",
    pattern:
      /(\bBearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])([A-Za-z0-9._~+/=-]{20,})/gi,
    replace: keepPrefix,
  },
];

/**
 * Ordered list of (pattern → replacement) rules for the LOG BUNDLE. Each
 * replacement keeps the non-secret prefix it captured (`$1`) and substitutes
 * the placeholder for the secret value. The shared value-shape rules run first
 * (PEM before anything single-line), then the name-keyed log-only rules.
 */
interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replace: (substring: string, ...groups: string[]) => string;
}

const RULES: readonly RedactionRule[] = [
  ...CREDENTIAL_SHAPE_RULES.map(
    (rule): RedactionRule => ({
      name: rule.name,
      pattern: rule.pattern,
      replace: (m, ...groups) => rule.replace(REDACTION_PLACEHOLDER, m, ...groups),
    }),
  ),
  {
    // Authorization: Bearer <token>  (and bare "Bearer <token>")
    name: "bearer-token",
    pattern: /(\bBearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi,
    replace: (_m, pre: string) => `${pre}${REDACTION_PLACEHOLDER}`,
  },
  {
    // Custom auth headers carrying a raw token value:
    //   X-Droplet-Auth: <tok>, Authorization: <tok>, X-Api-Key: <tok>
    // The value alternation matches "scheme + credential" FIRST for the known
    // schemes (`Basic`/`Bearer`/`Token`) — the bare `{6,}` arm would only
    // reach the 6-char `Bearer` word, leaving short tokens (< 8 chars, below
    // the bearer-token rule's {8,} threshold) unredacted. Naming the scheme
    // explicitly captures scheme + credential together (fail closed).
    name: "auth-header",
    pattern:
      /\b(X-Droplet-Auth|X-Nextcloud-Token|Authorization|X-Api-Key|X-Auth-Token|Proxy-Authorization)(\s*[:=]\s*)((?:Basic|Bearer|Token)\s+[^\s",;]+|[^\s",;]{6,})/gi,
    replace: (_m, header: string, sep: string) =>
      `${header}${sep}${REDACTION_PLACEHOLDER}`,
  },
  {
    // WARP-1688 — the richdocuments DIRECT-EDITING token, which lives in a URL
    // PATH SEGMENT rather than a header or an assignment: none of the shapes
    // above can see it.
    //
    // `/…/apps/richdocuments/direct/<token>` renders the editor with NO cookie
    // and NO Authorization header, so the URL IS the credential for as long as
    // it lives (docs/THREAT_MODEL.md T1.8, accepted risk R6 — "must never be
    // logged"). It lands in logs without anyone writing a log statement: the
    // gateway has no `access_log` directive so nginx logs `$request` verbatim,
    // and `nextcloud:29-apache` symlinks its Apache access log to stdout while
    // `nextcloud` sits in the collector's DEFAULT_SERVICES. A bundle pulled
    // during an active editing session would otherwise carry live credentials
    // into a downloadable ZIP.
    //
    // The ROUTE is preserved and only the token replaced — an access log with
    // the path scrubbed away is useless for the editor problem the bundle was
    // pulled for. Matches both route shapes (`/index.php/apps/…` and the
    // pretty-URL `/apps/…`); the token class stops at `?`, `#`, quote or
    // whitespace so a following query string or the access log's ` HTTP/1.1"`
    // stays readable.
    name: "richdocuments-direct-token",
    pattern: /((?:\/index\.php)?\/apps\/richdocuments\/direct\/)([^\s"'?#]+)/gi,
    replace: (_m, route: string) => `${route}${REDACTION_PLACEHOLDER}`,
  },
  {
    // Sensitive KEY=value or KEY: value (env dumps, structured logs). The value
    // may be bare, single- or double-quoted. We keep the key + the operator so
    // the line stays legible; only the value is replaced. The optional `"`
    // before the operator covers a quoted JSON key (`"x-nextcloud-token":"…"`,
    // the shape every pino line takes) — WARP-3193 SEC-DATA-2.
    name: "sensitive-assignment",
    pattern: new RegExp(
      `\\b(${SENSITIVE_KEY_WORD})("?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s"',;]+)`,
      "gi",
    ),
    replace: (whole: string, key: string, sep: string) =>
      // A public key / key-id matched on the `KEY` suffix is not secret — leave
      // it intact. Everything else loses its value.
      SAFE_KEY_RE.test(key) ? whole : `${key}${sep}${REDACTION_PLACEHOLDER}`,
  },
];

/**
 * Scrub every known secret SHAPE out of `text`, returning a copy where each
 * secret value is replaced by {@link REDACTION_PLACEHOLDER}. Non-secret context
 * (log timestamps, request lines, key names) is preserved.
 *
 * Idempotent: running it again over already-redacted output is a no-op, because
 * the placeholder contains none of the shapes the rules match.
 *
 * Pure + synchronous + never throws (a malformed line is left as-is rather than
 * aborting the whole bundle — but the rules are written so the placeholder, not
 * the raw value, is what falls through on a partial match).
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replace as (...args: string[]) => string);
  }
  return out;
}

/**
 * WARP-3282 — scrub credential VALUE SHAPES out of a tool result before it
 * enters the model context. Runs only {@link CREDENTIAL_SHAPE_RULES} (never the
 * name-keyed log rules — see that list's comment), replacing each hit with
 * {@link CREDENTIAL_PLACEHOLDER}, and reports how many it replaced so the
 * caller can log a count without the value.
 *
 * This is the RAW-TEXT scrub. Over JSON wire text it is not enough: a quoted
 * value arrives escaped (`KEY=\\"value\\"`) and slips past the value classes.
 * A tool result goes through {@link redactToolResult}, which runs this per
 * decoded string leaf.
 */
export function redactCredentials(text: string): { text: string; count: number } {
  if (!text) return { text, count: 0 };
  let count = 0;
  let out = text;
  for (const rule of CREDENTIAL_SHAPE_RULES) {
    out = out.replace(rule.pattern, (m: string, ...rest: unknown[]) => {
      // replace() appends (offset, input) after the capture groups; no rule
      // uses named groups, so the captures are everything before those two.
      const groups = rest.slice(0, -2) as string[];
      const next = rule.replace(CREDENTIAL_PLACEHOLDER, m, ...groups);
      if (next !== m) count++;
      return next;
    });
  }
  return { text: out, count };
}

/**
 * WARP-3282 — a field whose NAME says its value is a credential (`password`,
 * `DB_PASSWORD`, `client_secret`, `aws_session_token`). camelCase names
 * (`confirmationToken`, `passwordProtected`) never match.
 */
const CREDENTIAL_FIELD_RE = new RegExp(`^(?:[Pp]ass(?:word|wd|phrase)|${CONFIG_SECRET_NAME})$`);

/**
 * WARP-3282 — {@link redactCredentials} over a PARSED tool result: every
 * string leaf is scrubbed as text, and a string under a credential-named field
 * ({@link CREDENTIAL_FIELD_RE}) is replaced whole. Never mutates its input;
 * hands back the SAME reference when nothing matched.
 */
export function redactCredentialValues(value: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactCredentials(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) {
      const out = v.map(walk);
      return out.every((x, i) => x === v[i]) ? v : out;
    }
    if (v === null || typeof v !== "object") return v;
    let changed = false;
    // Null prototype: a JSON `"__proto__"` key stays an own property instead
    // of hitting the setter (which would drop it from the re-serialised text).
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, entry] of Object.entries(v as Record<string, unknown>)) {
      let next: unknown;
      if (CREDENTIAL_FIELD_RE.test(k) && typeof entry === "string" && entry !== "" && !entry.startsWith("[")) {
        count++;
        next = CREDENTIAL_PLACEHOLDER;
      } else {
        next = walk(entry);
      }
      if (next !== entry) changed = true;
      out[k] = next;
    }
    return changed ? out : v;
  };
  const out = walk(value);
  return { value: out, count };
}

/**
 * WARP-3282 — THE scrub for a tool result's wire text on its way to the model.
 *
 * JSON (every mcp-server result) is parsed, its decoded string leaves are
 * scrubbed ({@link redactCredentialValues}) and it is re-serialised — so a
 * quoted `KEY="value"`, escaped on the wire, is seen as the document had it,
 * a redaction can never break the JSON, and no rule can run across a field
 * boundary. A result with nothing to redact comes back byte-identical (the
 * confirmation envelope's token is read from these exact bytes). Non-JSON
 * text falls back to the raw scrub.
 */
export function redactToolResult(text: string): { text: string; count: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactCredentials(text);
  }
  const { value, count } = redactCredentialValues(parsed);
  return count === 0 ? { text, count: 0 } : { text: JSON.stringify(value), count };
}

// ── Structured (object) redaction — WARP-1718 ────────────────────────────────

/**
 * Whole-key form of {@link SENSITIVE_KEY_WORD}, for testing an object key
 * rather than scanning free text.
 */
const SENSITIVE_KEY_RE = new RegExp(`^${SENSITIVE_KEY_WORD}$`, "i");

/**
 * Does this object key name a secret VALUE?
 *
 * Substring match on {@link SENSITIVE_WORDS} (fail closed — `password`, `key`,
 * `encryption_key`, `psk`, `secret`, `token`, `wpa_passphrase` all hit), minus
 * the {@link SAFE_KEY_RE} carve-out so a public key / key *id* stays legible.
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key) && !SAFE_KEY_RE.test(key);
}

/**
 * Depth ceiling for {@link redactSecretParams}. Audit params are shallow; the
 * bound exists so a cyclic or pathologically nested object can't spin, and so
 * anything past it fails CLOSED (collapses to the placeholder) rather than
 * falling through unredacted.
 */
const MAX_REDACTION_DEPTH = 8;

/**
 * WARP-1718 — deep-copy `value` with every secret-bearing entry replaced by
 * {@link REDACTION_PLACEHOLDER}.
 *
 * Used at the audit-logging boundary (`logNetworkCommand`), where the raw
 * command params carry household Wi-Fi passphrases that must never be
 * persisted: `set_wifi_password` → `{iface_section, password}`,
 * `create_guest_network` → `{radio, ssid, password, network}`, and
 * `camera_subnet_setup`, which forwards `req.body` wholesale.
 *
 * Two properties the audit depends on:
 *
 *  1. **The key survives.** A redacted entry keeps its key with a placeholder
 *     value, so the audit trail still proves a secret WAS set — only its value
 *     is gone. Non-secret siblings (`ssid`, `radio`, `iface_section`) stay
 *     readable, which is most of what makes the row useful.
 *  2. **A missing secret stays missing.** `undefined`/`null` under a sensitive
 *     key is left as-is rather than replaced, so an SSID-only edit (WARP-1712's
 *     `{ssid, key: undefined}` → `set_ap_wifi_ssid`) doesn't get a placeholder
 *     that falsely implies a passphrase was set.
 *
 * String values under NON-sensitive keys are still run through
 * {@link redactSecrets}, so a secret embedded in a value — a `redis://:pw@host`
 * URI, a bearer token — is caught even when the key name gives no hint.
 *
 * Pure; never mutates its input.
 */
export function redactSecretParams<T>(value: T): T {
  return redactValue(value, 0) as T;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) return REDACTION_PLACEHOLDER;

  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  // Objects that define their OWN JSON form (Date, Buffer, Prisma Decimal…)
  // serialize to something other than their own properties, so walking them
  // would corrupt the audit payload — hand those back untouched.
  //
  // Everything else IS walked, class instances included. Bailing out on
  // "not a plain object" would fail OPEN: `JSON.stringify` emits an instance's
  // own enumerable properties regardless, so a secret-bearing field would ride
  // through unredacted. Walking is also exactly faithful for those — the
  // rebuilt plain object serializes identically (as it does for Map/Set/RegExp/
  // Error, which have no own enumerable properties and no toJSON).
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      // Keep a genuinely absent secret absent — see property (2) above.
      out[key] = entry === undefined || entry === null ? entry : REDACTION_PLACEHOLDER;
    } else {
      out[key] = redactValue(entry, depth + 1);
    }
  }
  return out;
}
