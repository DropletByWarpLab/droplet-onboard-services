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
    // Credentials embedded in a URI userinfo: scheme://user:SECRET@host
    // Redacts only the password component, preserving scheme/user/host so the
    // line still tells you which service/db it was. The username class is `*`
    // (not `+`) so empty-username forms — `redis://:pw@host`, the exact shape
    // secrets.sh generates for REDIS_URL, and `postgresql://:pw@db/...` — are
    // also redacted. The trailing `@` anchor still prevents matching a plain
    // `host:port` with no userinfo.
    name: "uri-userinfo",
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/g,
    replace: (placeholder, _m, pre: string, _secret: string, at: string) =>
      `${pre}${placeholder}${at}`,
  },
  {
    // AWS access key id (long-term AKIA, temporary ASIA): fixed 20-char shape.
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replace: whole,
  },
  {
    // Env/credentials-file assignment of a secret: `AWS_SECRET_ACCESS_KEY=…`,
    // `DB_PASSWORD=…`, `STRIPE_API_KEY=…`, and the lowercase keys of
    // ~/.aws/credentials. Deliberately narrow: an UPPER_SNAKE name ENDING in a
    // secret word, `=` only (a `TOP SECRET:` heading is prose), a 6+ char
    // value. camelCase JSON keys (`confirmationToken`, `shareToken`) never
    // match, so no loop-internal token is touched.
    // ponytail: `api_key: …` YAML/JSON configs are not covered; add a
    // `:` form here if a real document shows one.
    name: "env-secret-assignment",
    pattern:
      /\b((?:(?:[A-Z][A-Z0-9]*_)*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY)|aws_secret_access_key|aws_session_token)\s*=\s*["']?)(?!\[)([^\s"'`,;]{6,})/g,
    replace: keepPrefix,
  },
  {
    // `password=…`, `passwd: …`, `"password": "…"`. The `:` form with a bare
    // letters-only value is prose ("Password: required.", "Reset your
    // password: click …") and is left alone; `=`, a quoted value, or a value
    // with a digit/symbol is a credential. `passwordProtected` never matches
    // (word boundary after the name).
    name: "password-assignment",
    pattern:
      /\b(pass(?:word|wd|phrase))("?\s*[:=]\s*)(?!\[)("[^"\n]+"|'[^'\n]+'|[^\s"'`,;]+)/gi,
    replace: (placeholder, m, key: string, sep: string, value: string) =>
      sep.includes(":") && /^[A-Za-z]+[.!?)]*$/.test(value)
        ? m
        : `${key}${sep}${placeholder}`,
  },
  {
    // Provider API tokens, recognisable by prefix:
    //   OpenAI/Anthropic `sk-…` (20+ chars, must contain a digit — `sk-learn`),
    //   Stripe `sk_live_`/`sk_test_`/`rk_live_`/`rk_test_`,
    //   GitHub `ghp_/gho_/ghu_/ghs_/ghr_` and `github_pat_`,
    //   Slack `xoxb-/xoxp-/xoxa-/xoxs-`.
    name: "provider-token",
    pattern:
      /\b(?:sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[bpas]-[A-Za-z0-9-]{10,})/g,
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
 * Safe over a JSON wire string: no rule matches a `"` or a `\\`, so a
 * replacement never breaks the surrounding JSON string literal.
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
